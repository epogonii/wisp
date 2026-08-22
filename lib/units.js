// SPDX-License-Identifier: GPL-2.0-or-later

// The systemd timers that take snapshots and clear them out again.
//
// snapper itself does nothing on a schedule. The hourly snapshots, the
// thinning out of old ones and the pair taken around a boot are three timers
// shipped with the package, and a machine where they are switched off has a
// snapper that only ever acts when told to. Which of them are on is worth
// showing next to the retention settings they carry out, since one without
// the other explains nothing.
//
// Reading the state costs nothing: systemctl answers is-enabled for anybody.
// Changing it costs a password.

import Gio from 'gi://Gio';

import {run, pkexec, MISSING} from './exec.js';

export const TIMELINE = 'snapper-timeline.timer';
export const CLEANUP = 'snapper-cleanup.timer';
export const BOOT = 'snapper-boot.timer';

export const SNAPPER_TIMERS = [TIMELINE, CLEANUP, BOOT];

/**
 * @param {string} unit - a unit name
 * @returns {Promise<{enabled: boolean, known: boolean, state: string}>}
 *   whether it runs on its own, and whether systemd has heard of it at all -
 *   a distribution that packages snapper without the timers, or a machine
 *   where snapper is not installed, has no unit to enable
 */
export async function state(unit) {
    const {status, stdout, stderr} = await run(['systemctl', 'is-enabled', unit]);
    const said = (stdout + stderr).trim();

    // No systemd on this machine is the same answer as no such unit on it:
    // there is nothing here to switch on or off.
    if (status === MISSING)
        return {enabled: false, known: false, state: said};

    return {
        enabled: said === 'enabled' || said === 'enabled-runtime' || said === 'static',
        known: !said.includes('No such file') && said.length > 0,
        state: said,
    };
}

// Where a cron job would be, on a machine where snapper is driven by one.
const CRON = [
    '/etc/cron.hourly',
    '/etc/cron.daily',
    '/etc/cron.weekly',
    '/etc/cron.monthly',
    '/etc/cron.d',
];

/**
 * The cron jobs, if there are any, that run snapper on this machine.
 *
 * The timers above are how the package ships on most distributions, but not
 * all of them: snapper builds either way, and a machine without systemd - or
 * one whose packager chose cron - has the same schedules as files in the cron
 * directories instead. Those are worth naming rather than saying nothing runs,
 * which is what the absent timers on their own would say. The file names
 * differ between distributions, so what is in the directories is read rather
 * than assumed.
 *
 * @returns {string[]} the paths, one per job, in the order they were found
 */
export function cronJobs() {
    const found = [];

    for (const dir of CRON) {
        let children;
        try {
            children = Gio.File.new_for_path(dir).enumerate_children(
                'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        } catch {
            // No such directory, or one this account cannot read. Either way
            // there is nothing here to report.
            continue;
        }

        let info;
        while ((info = children.next_file(null))) {
            const name = info.get_name();
            if (name.includes('snapper'))
                found.push(`${dir}/${name}`);
        }
        children.close(null);
    }

    return found;
}

/**
 * @param {string} unit - a unit name
 * @param {boolean} on - what it should be
 * @returns {string[]} the command that would do it
 */
export function setEnabledArgv(unit, on) {
    return ['systemctl', on ? 'enable' : 'disable', '--now', unit];
}

/**
 * @param {string} unit - a unit name
 * @param {boolean} on - what it should be
 * @returns {Promise<{status: number, stdout: string, stderr: string}>} how it went
 */
export function setEnabled(unit, on) {
    return pkexec(setEnabledArgv(unit, on));
}
