// SPDX-License-Identifier: GPL-2.0-or-later

// Rolling back where snapper will not.
//
// snapper rolls back by pointing btrfs at a different default subvolume, and
// refuses where the default is not one of its snapshots. Fedora as installed
// is like that: the default is the top of the filesystem, and the root is
// mounted by subvolume name. There the same can be done by renaming. A
// writable copy of the snapshot takes the root's name, the snapshots move
// across to it, and the system as it was becomes one of them.
//
// This works out that command from what any account may read. It runs
// nothing, and the words around the command are the dialog's.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {commandLine, have} from './exec.js';

// Where the top of the filesystem is mounted while the names change.
const TOP = '/mnt';

// The top directory of a subvolume has inode 256. A snapshot has an empty
// directory with inode 2 where the original had a subvolume of its own.
const SUBVOLUME = 256;
const STAND_IN = 2;

// Subvolumes systemd makes inside the root, moved across like .snapshots.
const NESTED = ['var/lib/machines', 'var/lib/portables'];

/**
 * Waits for one of Gio's asynchronous calls.
 *
 * @param {Function} start - starts the call, given the callback
 * @param {string} finish - the method that finishes it
 * @returns {Promise<*>} what that method returns
 */
function call(start, finish) {
    return new Promise((resolve, reject) => {
        start((source, result) => {
            try {
                resolve(source[finish](result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

/**
 * @param {string} path - a file
 * @returns {Promise<string>} what is in it
 */
async function read(path) {
    const file = Gio.File.new_for_path(path);
    const [, bytes] = await call(done => file.load_contents_async(null, done),
        'load_contents_finish');
    return new TextDecoder().decode(bytes);
}

/**
 * @param {string} path - anything
 * @returns {Promise<number>} its inode, or 0 when it is not there or cannot
 *   be looked at
 */
async function inode(path) {
    const file = Gio.File.new_for_path(path);
    try {
        const info = await call(done => file.query_info_async('unix::inode',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, null, done),
        'query_info_finish');
        return info.get_attribute_uint64('unix::inode');
    } catch {
        return 0;
    }
}

/**
 * @param {string} path - a directory
 * @returns {Promise<string[]>} the names in it
 */
async function names(path) {
    const directory = Gio.File.new_for_path(path);
    const children = await call(done => directory.enumerate_children_async('standard::name',
        Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, done),
    'enumerate_children_finish');

    const found = [];
    for (;;) {
        const infos = await call(done => children.next_files_async(64,
            GLib.PRIORITY_DEFAULT, null, done), 'next_files_finish');
        if (infos.length === 0)
            return found;
        found.push(...infos.map(info => info.get_name()));
    }
}

/**
 * @returns {Promise<string[]>} the version of each kernel in /boot, rescue
 *   images left out
 */
async function kernels() {
    return (await names('/boot'))
        .map(name => /^vmlinuz-(.+)$/.exec(name)?.[1])
        .filter(version => version && !version.includes('rescue'));
}

/**
 * The command that rolls the root back to a snapshot by renaming.
 *
 * @param {number} number - the snapshot to go back to
 * @param {string} done - what the command says at the end, once all of it
 *   has worked
 * @returns {Promise<?object>} null when the system is not laid out for it.
 *   Otherwise the command, the subvolume it replaces, the snapshot the old
 *   one is kept as, and the kernel to start when not every one in /boot can,
 *   with whether the command sets it. The command is null when no kernel in
 *   /boot can start the snapshot.
 */
export async function swap(number, done) {
    const [mountinfo, cmdline, fstab] = await Promise.all(
        ['/proc/self/mountinfo', '/proc/cmdline', '/etc/fstab'].map(read));

    // id parent major:minor root mount-point options ... - type source options
    const mounts = mountinfo.split('\n').filter(line => line !== '').map(line => {
        const [left, right] = line.split(' - ');
        const fields = left.split(' ');
        const [type, source] = right.split(' ');
        return {root: fields[3], point: fields[4], type, source};
    });
    const root = mounts.findLast(mount => mount.point === '/');
    if (root?.type !== 'btrfs' || root.root === '/')
        return null;
    const subvolume = root.root.slice(1);

    // The kernel and fstab both have to ask for the root by name. A rename
    // does nothing to one that asks by id.
    const flags = cmdline.trim().split(/\s+/)
        .filter(word => word.startsWith('rootflags='))
        .pop()?.slice('rootflags='.length).split(',') ?? [];
    if (!flags.includes(`subvol=${subvolume}`) && !flags.includes(`subvol=/${subvolume}`))
        return null;
    if (flags.some(flag => flag.startsWith('subvolid=')))
        return null;
    for (const line of fstab.split('\n')) {
        const fields = line.trim().split(/\s+/);
        if (!fields[0].startsWith('#') && fields[1] === '/' &&
            /(^|,)subvolid=/.test(fields[3] ?? ''))
            return null;
    }

    // .snapshots has to be a subvolume inside the root, as snapper makes it,
    // and not one mounted there from elsewhere.
    if (mounts.some(mount => mount.point === '/.snapshots') ||
        await inode('/.snapshots') !== SUBVOLUME)
        return null;

    // What is in the snapshot decides the rest, so it has to be readable.
    const snapshot = `/.snapshots/${number}/snapshot`;
    if (await inode(snapshot) !== SUBVOLUME)
        return null;

    // The system as it is now is kept as a snapshot, under a number snapper
    // has not used yet.
    const used = await names('/.snapshots').catch(() => null);
    if (used === null)
        return null;
    const backup = Math.max(0, ...used.filter(name => /^\d+$/.test(name)).map(Number)) + 1;

    const moved = ['.snapshots'];
    for (const path of NESTED) {
        if (await inode(`/${path}`) === SUBVOLUME &&
            await inode(`${snapshot}/${path}`) === STAND_IN)
            moved.push(path);
    }

    // A /boot of its own does not go back with the rest. A kernel there whose
    // modules the snapshot does not have would start without them. Only the
    // kernels the running system has modules for count. Where the names are
    // not versions, as on Arch, or root alone may read /boot, none do.
    let kernel = null;
    if (mounts.some(mount => mount.point === '/boot')) {
        const versions = [];
        const fit = [];
        for (const version of await kernels().catch(() => [])) {
            if (await inode(`/usr/lib/modules/${version}`) === 0)
                continue;
            versions.push(version);
            if (await inode(`${snapshot}/usr/lib/modules/${version}`) !== 0)
                fit.push(version);
        }
        if (fit.length === 0 && versions.length > 0)
            return {line: null};
        if (fit.length < versions.length)
            kernel = fit.sort((a, b) => a.localeCompare(b, undefined, {numeric: true})).at(-1);
    }

    // Named after the time, so a second go never runs into what the first
    // left behind.
    const now = GLib.DateTime.new_now_local();
    const kept = `${subvolume}.${now.format('%Y%m%d-%H%M%S')}`;
    const fresh = `${kept}.new`;
    const at = path => `${TOP}/${path}`;

    // What snapper writes for the backup its own rollback keeps: cleaned up
    // by number, among the important ones.
    const info = at(`${subvolume}/.snapshots/${backup}`);
    const xml = `<snapshot><type>single</type><num>${backup}</num>` +
        `<date>${now.to_utc().format('%Y-%m-%d %H:%M:%S')}</date>` +
        '<description>rollback backup</description><cleanup>number</cleanup>' +
        '<userdata><key>important</key><value>yes</value></userdata></snapshot>';

    // The number is taken and the copy made before anything is renamed, so a
    // failure up to there leaves the system as it was.
    const grubby = kernel !== null && have('grubby');
    const steps = [
        ['mount', '-o', 'subvolid=5', root.source, TOP],
        ['mkdir', info],
        `${commandLine(['echo', xml])} > ${commandLine([`${info}/info.xml`])}`,
        ...grubby ? [['grubby', '--set-default', `/boot/vmlinuz-${kernel}`]] : [],
        ['btrfs', 'subvolume', 'snapshot', at(`${subvolume}${snapshot}`), at(fresh)],
        ['rmdir', ...moved.map(path => at(`${fresh}/${path}`))],
        ['mv', '-T', at(subvolume), at(kept)],
        ['mv', '-T', at(fresh), at(subvolume)],
        ...moved.map(path => ['mv', '-T', at(`${kept}/${path}`), at(`${subvolume}/${path}`)]),
        ['mv', '-T', at(kept), `${info}/snapshot`],
        ['umount', TOP],
        ['echo', done],
    ];

    // One command, so that whatever runs it as root runs every step as root.
    const line = commandLine(['sh', '-c', steps.map(step =>
        typeof step === 'string' ? step : commandLine(step)).join(' &&\n')]);
    return {line, subvolume, backup, kernel, grubby};
}
