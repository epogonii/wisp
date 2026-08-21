// SPDX-License-Identifier: GPL-2.0-or-later

// What the filesystem underneath the snapshots is doing, and the housekeeping
// it is scheduled for.
//
// A btrfs filesystem hands out more than a free-space figure and the
// difference matters here: snapshots share their blocks with the subvolume
// they were taken from, so deleting one frees whatever it alone still held and
// nothing else, and a filesystem can be short of room for metadata while a df
// still reads comfortable. Both numbers come out of sysfs, which is readable
// by anybody, so this costs no password at all.
//
// Balance, scrub, defrag and trim are not snapper's business and not this
// extension's either. They are one file of settings that the btrfsmaintenance
// package reads, world-readable, and a path unit that regenerates its timers
// whenever the file changes. Showing them next to the snapshot schedule is
// worth a page; running them is not, since each takes hours and wants a
// progress report this window has no business owning.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {run, pkexec} from './exec.js';

const SYSFS = '/sys/fs/btrfs';

// btrfsmaintenance keeps its settings in one shell-style file, and where that
// file lives is the distribution's choice: /etc/sysconfig on Fedora and
// openSUSE, /etc/default on Debian and Arch. Whichever is there is the one.
const MAINTENANCE_PATHS = [
    '/etc/sysconfig/btrfsmaintenance',
    '/etc/default/btrfsmaintenance',
];

/**
 * @returns {string|null} the settings file this system has, if it has one
 */
function maintenancePath() {
    for (const path of MAINTENANCE_PATHS) {
        if (GLib.file_test(path, GLib.FileTest.EXISTS))
            return path;
    }
    return null;
}

// The chunk types btrfs allocates separately, in the order they are shown.
export const CHUNKS = ['data', 'metadata', 'system'];

// What btrfsmaintenance can be told to do, and how often it is allowed to.
export const PERIODS = ['none', 'daily', 'weekly', 'monthly'];

export const JOBS = [
    {key: 'BTRFS_BALANCE_PERIOD', unit: 'btrfs-balance.timer'},
    {key: 'BTRFS_SCRUB_PERIOD', unit: 'btrfs-scrub.timer'},
    {key: 'BTRFS_DEFRAG_PERIOD', unit: 'btrfs-defrag.timer'},
    {key: 'BTRFS_TRIM_PERIOD', unit: 'btrfs-trim.timer'},
];

/**
 * @param {string} path - a file to read as one string
 * @returns {number|null} what it held, when that was a number
 */
function readNumber(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        const value = Number.parseInt(new TextDecoder().decode(bytes).trim(), 10);
        return Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
}

/**
 * The filesystem a path is on, as btrfs sees it.
 *
 * @param {string} path - anywhere on the filesystem
 * @returns {Promise<object|null>} its uuid, its size, and how much of it has
 *   been handed to each kind of chunk, or null when the path is not on btrfs
 */
export async function usage(path = '/') {
    const {status, stdout} = await run(['findmnt', '-no', 'UUID,FSTYPE', '--target', path]);
    if (status !== 0)
        return null;

    const [uuid, fstype] = stdout.trim().split(/\s+/);
    if (fstype !== 'btrfs' || !uuid)
        return null;

    const chunks = {};
    for (const chunk of CHUNKS) {
        chunks[chunk] = {
            total: readNumber(`${SYSFS}/${uuid}/allocation/${chunk}/total_bytes`),
            used: readNumber(`${SYSFS}/${uuid}/allocation/${chunk}/bytes_used`),
        };
    }

    // The device sizes add up to the filesystem's size. A single-device
    // filesystem is the common case and a multi-device one still answers.
    let size = 0;
    const devices = Gio.File.new_for_path(`${SYSFS}/${uuid}/devices`);
    try {
        const list = devices.enumerate_children('standard::name',
            Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = list.next_file(null)) !== null) {
            // sysfs counts a device in 512-byte sectors.
            const sectors = readNumber(`${SYSFS}/${uuid}/devices/${info.get_name()}/size`);
            if (sectors)
                size += sectors * 512;
        }
    } catch {
        size = 0;
    }

    const allocated = CHUNKS.reduce((sum, chunk) => sum + (chunks[chunk].total ?? 0), 0);
    const used = CHUNKS.reduce((sum, chunk) => sum + (chunks[chunk].used ?? 0), 0);

    return {uuid, size, allocated, used, chunks};
}

/**
 * The btrfsmaintenance settings, as the file has them now.
 *
 * @returns {object|null} every BTRFS_ key it sets, or null when the package
 *   that reads them is not installed
 */
export function maintenance() {
    const path = maintenancePath();
    if (!path)
        return null;

    let text;
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        text = new TextDecoder().decode(bytes);
    } catch {
        return null;
    }

    const values = {};
    for (const line of text.split('\n')) {
        const match = /^(BTRFS_[A-Z_]+)="?([^"]*)"?\s*$/.exec(line.trim());
        if (match)
            values[match[1]] = match[2];
    }
    return values;
}

/**
 * @param {object} values - the keys being changed
 * @returns {string[]} the command that would do it
 */
export function setMaintenanceArgv(values) {
    // One sed expression per key, so the file keeps its comments and its
    // order and only the lines being changed are touched. The path unit
    // shipped with btrfsmaintenance notices the write and regenerates the
    // timers on its own, so nothing else has to be run afterwards.
    const expressions = Object.entries(values).flatMap(([key, value]) =>
        ['-e', `s|^${key}=.*|${key}="${value}"|`]);
    return ['sed', '-i', ...expressions, maintenancePath()];
}

/**
 * @param {object} values - the keys being changed
 * @returns {Promise<{status: number, stdout: string, stderr: string}>} how it went
 */
export function setMaintenance(values) {
    return pkexec(setMaintenanceArgv(values));
}

/**
 * @param {number|null} bytes - a size
 * @returns {string} the same size, for reading
 */
export function size(bytes) {
    if (bytes === null || bytes === undefined)
        return '-';
    return GLib.format_size_full(bytes, GLib.FormatSizeFlags.IEC_UNITS);
}
