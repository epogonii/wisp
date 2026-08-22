// SPDX-License-Identifier: GPL-2.0-or-later

// Asking again for somebody who has already been let in once.
//
// The way an account reaches snapper's snapshots is by being named in a
// config's ALLOW_USERS, and that is a permanent arrangement: it survives
// reboots, it applies to every program running as that account, and there is
// no expiry on it. Which is the right shape for a listing that has to work
// without a password, and the wrong shape for a laptop left open on a desk.
//
// So this is a lock on the menu rather than on the snapshots. It does not
// pretend to be more than that: anything running as this account can still
// talk to snapperd directly, and nothing an extension does can change that.
// What it buys is that a passer-by cannot read the list, or press delete on
// it, without the same password polkit would ask for anyway - and on a
// machine whose PAM stack has a fingerprint reader set up, without the finger.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {run, have} from './exec.js';

// polkit's own action for running something as somebody else. It is the one
// every desktop has, its wording says what unlocking here leads to - snapper,
// as root - and the check is only ever made to reach the authentication: the
// answer is thrown away.
const ACTION = 'org.freedesktop.policykit.exec';

export const NEVER = 'never';
export const AFTER_IDLE = 'after-idle';
export const ALWAYS = 'always';

/**
 * Whether locking the menu is possible here at all.
 *
 * The lock is a polkit check and nothing else, so a machine without polkit's
 * command line tools has no way to ask and no way to answer. On one of those
 * the lock stays open rather than shut: a lock that cannot be unlocked is not
 * security, it is a menu nobody can use.
 *
 * @returns {boolean} true when there is something here to ask with
 */
export function available() {
    return have('pkcheck');
}

export class Lock {
    /**
     * @param {Gio.Settings} settings - where the two settings behind this live
     */
    constructor(settings) {
        this._settings = settings;
        this._at = 0;
        this._wallAt = 0;
        this._available = available();
    }

    /**
     * @returns {boolean} whether the next look at the list has to be paid for
     */
    get engaged() {
        if (!this._available)
            return false;

        const mode = this._settings.get_string('lock');
        if (mode === NEVER)
            return false;
        if (this._at === 0)
            return true;
        if (mode === ALWAYS)
            return false;

        // Two clocks, because neither one alone measures an idle machine.
        // The monotonic clock stands still while the machine is suspended, so
        // a laptop unlocked and closed comes back still unlocked however long
        // it was shut. The wall clock counts that time, but it is the clock
        // NTP moves, and a step backwards would hold the lock open past its
        // minutes. Whichever says more time has passed is the one to believe:
        // a step forwards then locks early, which is the direction a lock is
        // allowed to be wrong in.
        const minutes = this._settings.get_int('lock-timeout');
        const since = Math.max(GLib.get_monotonic_time() - this._at,
            GLib.get_real_time() - this._wallAt);
        return since > minutes * 60 * 1000 * 1000;
    }

    /**
     * Asks polkit to make sure of who is at the keyboard.
     *
     * The subject of the check is this process, named by the connection it
     * already holds on the system bus, so polkit is asking about the shell
     * rather than about the short-lived program doing the asking.
     *
     * @returns {Promise<boolean>} whether it was answered
     */
    async unlock() {
        const name = Gio.DBus.system.get_unique_name();
        const argv = ['pkcheck', '--action-id', ACTION, '--allow-user-interaction'];
        if (name)
            argv.push('--system-bus-name', name);
        else
            argv.push('--process', `${pid()}`);

        const {status} = await run(argv);
        if (status !== 0)
            return false;

        this._at = GLib.get_monotonic_time();
        this._wallAt = GLib.get_real_time();
        return true;
    }

    /** Puts it back, for the mode that only ever opens once. */
    relock() {
        if (this._settings.get_string('lock') === ALWAYS) {
            this._at = 0;
            this._wallAt = 0;
        }
    }
}

/**
 * @returns {number} this process's own id, for the systems where the bus
 *   connection has no name to go by
 */
function pid() {
    try {
        return new Gio.Credentials().get_unix_pid();
    } catch {
        // Falls through to the answer that asks polkit about nothing in
        // particular, which it will refuse - which is the safe way to fail.
    }
    return 0;
}
