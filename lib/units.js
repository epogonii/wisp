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
// Both go through systemd's own D-Bus API. Reading the state costs nothing,
// and for a change systemd asks polkit itself, so nothing here runs as root.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS_NAME = 'org.freedesktop.systemd1';
const OBJECT_PATH = '/org/freedesktop/systemd1';
const MANAGER = 'org.freedesktop.systemd1.Manager';

export const TIMELINE = 'snapper-timeline.timer';
export const CLEANUP = 'snapper-cleanup.timer';
export const BOOT = 'snapper-boot.timer';

export const SNAPPER_TIMERS = [TIMELINE, CLEANUP, BOOT];

/**
 * One call to systemd's manager on the system bus.
 *
 * A change is allowed to wait for polkit: the flag lets systemd raise the
 * password dialog, and the timeout is as long as the user takes to answer it.
 *
 * @param {string} method - method name on the manager interface
 * @param {GLib.Variant|null} params - arguments, already packed
 * @param {string|null} replyType - signature of the reply
 * @param {boolean} [interactive] - false for a read, which asks nothing and
 *   keeps the default timeout
 * @returns {Promise<GLib.Variant>} the reply
 */
function call(method, params, replyType, interactive = true) {
    const flags = interactive
        ? Gio.DBusCallFlags.ALLOW_INTERACTIVE_AUTHORIZATION
        : Gio.DBusCallFlags.NONE;
    const timeout = interactive ? GLib.MAXINT32 : -1;
    return new Promise((resolve, reject) => {
        Gio.DBus.system.call(BUS_NAME, OBJECT_PATH, MANAGER, method, params,
            replyType ? new GLib.VariantType(replyType) : null,
            flags, timeout, null, (connection, result) => {
                try {
                    resolve(connection.call_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
    });
}

/**
 * @param {string} unit - a unit name
 * @returns {Promise<{enabled: boolean, known: boolean, state: string}>}
 *   whether it runs on its own, and whether systemd has heard of it at all -
 *   a distribution that packages snapper without the timers, or a machine
 *   where snapper is not installed, has no unit to enable
 */
export async function state(unit) {
    let said;
    try {
        [said] = (await call('GetUnitFileState',
            new GLib.Variant('(s)', [unit]), '(s)', false)).deepUnpack();
    } catch (error) {
        // No systemd on this machine is the same answer as no such unit on
        // it: there is nothing here to switch on or off.
        return {enabled: false, known: false, state: error.message};
    }

    return {
        enabled: said === 'enabled' || said === 'enabled-runtime' || said === 'static',
        known: true,
        state: said,
    };
}

/**
 * Switches a timer on or off, now and from the next boot, as
 * systemctl enable --now would.
 *
 * systemd asks polkit for each of the two steps, and may ask twice.
 * A refusal comes back as a rejected promise.
 *
 * @param {string} unit - a unit name
 * @param {boolean} on - what it should be
 */
export async function setEnabled(unit, on) {
    if (on) {
        await call('EnableUnitFiles',
            new GLib.Variant('(asbb)', [[unit], false, false]), '(ba(sss))');
        await call('StartUnit', new GLib.Variant('(ss)', [unit, 'replace']), '(o)');
    } else {
        await call('DisableUnitFiles',
            new GLib.Variant('(asb)', [[unit], false]), '(a(sss))');
        await call('StopUnit', new GLib.Variant('(ss)', [unit, 'replace']), '(o)');
    }
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
