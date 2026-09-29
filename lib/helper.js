// SPDX-License-Identifier: GPL-2.0-or-later

// wisp-helper is a separate package that does what needs root. It listens on
// the system bus and asks polkit first, and the shell draws the password
// dialog. Nothing in here belongs to the shell or to Gtk.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const NAME = 'io.github.epogonii.WispHelper';
const PATH = '/io/github/epogonii/WispHelper';

// The helper's API version this Wisp is written against.
const VERSION = 1;

// Long enough to type a password.
const TIMEOUT = 10 * 60 * 1000;

export const INSTALL_URL = 'https://github.com/epogonii/wisp-helper#install';

// Asking for the version starts the helper as root. Once it has been new
// enough, it is not started again only to be asked.
let ready = false;

function call(name, path, iface, method, params, replyType, flags, timeout) {
    return new Promise((resolve, reject) => {
        Gio.DBus.system.call(name, path, iface, method, params,
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
 * @returns {Promise<string>} 'missing' when the helper is not installed,
 *   'old' when it is older than this Wisp needs, 'ready' otherwise
 */
export async function state() {
    try {
        // The bus answers this one itself, so nothing is started for it.
        const [names] = (await call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListActivatableNames', null, '(as)',
            Gio.DBusCallFlags.NONE, -1)).deepUnpack();
        if (!names.includes(NAME))
            return 'missing';
        if (ready)
            return 'ready';
    } catch (error) {
        logError(error, 'Wisp: cannot list what the system bus can start');
        return 'missing';
    }

    try {
        const [version] = (await call(NAME, PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [NAME, 'Version']), '(v)',
            Gio.DBusCallFlags.NONE, -1)).recursiveUnpack();
        if (version < VERSION)
            return 'old';
        ready = true;
        return 'ready';
    } catch (error) {
        // Installed and not answering. Installing it again is the fix.
        logError(error, 'Wisp: wisp-helper does not answer');
        return 'old';
    }
}

function run(method, params) {
    return call(NAME, PATH, NAME, method, params, null,
        Gio.DBusCallFlags.ALLOW_INTERACTIVE_AUTHORIZATION, TIMEOUT);
}

/**
 * Adds this account to the config's ALLOW_USERS and turns SYNC_ACL on. The
 * helper works out who is asking, so there is no user to pass.
 *
 * @param {string} config - the config to be let into
 * @returns {Promise} settled once snapper has written the config
 */
export function grantAccess(config) {
    return run('GrantAccess', new GLib.Variant('(s)', [config]));
}

/**
 * @param {Error} error - what a call to the helper failed with
 * @returns {?string} what to tell the user, or null when polkit said no or
 *   the password dialog was closed
 */
export function complaint(error) {
    if (!(error instanceof GLib.Error))
        return error.message;
    if (Gio.DBusError.get_remote_error(error) === `${NAME}.Error.NotAuthorized`)
        return null;
    Gio.DBusError.strip_remote_error(error);
    return error.message;
}
