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
