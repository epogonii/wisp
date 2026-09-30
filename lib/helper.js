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

// A rollback done from here waits for the restart, and so does the shell.
let rolledBack = false;

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

/**
 * The lines from the helper's README, for where it has a package.
 *
 * @param {boolean} old - whether it is there and only needs updating
 * @returns {string[]} commands to run as root one after another, or none
 */
export function installCommands(old) {
    const id = GLib.get_os_info('ID');
    const version = GLib.get_os_info('VERSION_ID') ?? '';
    // dnf copr picks the build by the distribution's name, so a derivative
    // gets only the link.
    if (id === 'fedora' && Number(version) >= 43) {
        return old ? ['dnf upgrade wisp-helper']
            : ['dnf copr enable swink/wisp-helper', 'dnf install wisp-helper'];
    }

    let repo = null;
    if (id === 'opensuse-tumbleweed')
        repo = 'openSUSE_Tumbleweed';
    else if (id === 'opensuse-leap' && version === '16.0')
        repo = '16.0';
    if (!repo)
        return [];
    return old ? ['zypper update wisp-helper'] : [
        `zypper addrepo https://download.opensuse.org/repositories/home:swink/${repo}/home:swink.repo`,
        'zypper install wisp-helper',
    ];
}

function run(method, params, replyType = null, timeout = TIMEOUT) {
    return call(NAME, PATH, NAME, method, params, replyType,
        Gio.DBusCallFlags.ALLOW_INTERACTIVE_AUTHORIZATION, timeout);
}

async function dict(method, params, timeout) {
    const [values] = (await run(method, params, '(a{sv})', timeout)).recursiveUnpack();
    return values;
}

/**
 * @returns {Promise<object>} version, distro, rollback (native, swap or
 *   none), rollback_why, pending and maintenance
 */
export function info() {
    return dict('GetInfo', null);
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
 * @param {string} config - the config to change
 * @param {object} values - only the keys being changed, as snapper names them
 * @returns {Promise} settled once snapper has written them
 */
export function setConfig(config, values) {
    return run('SetConfig', new GLib.Variant('(sa{ss})', [config, values]));
}

/**
 * Nothing is asked for this one.
 *
 * @returns {Promise<string[]>} the mounted subvolumes a new config can be
 *   made for
 */
export async function listSubvolumes() {
    const [subvolumes] = (await run('ListSubvolumes', null, '(as)')).deepUnpack();
    return subvolumes;
}

/**
 * @param {string} config - the name it will be known by
 * @param {string} subvolume - one of what listSubvolumes() gave
 * @returns {Promise} settled once snapper has made it
 */
export function createConfig(config, subvolume) {
    return run('CreateConfig', new GLib.Variant('(ss)', [config, subvolume]));
}

/**
 * @param {string} config - the config to remove, with every snapshot in it
 * @returns {Promise} settled once snapper has removed it
 */
export function deleteConfig(config) {
    return run('DeleteConfig', new GLib.Variant('(s)', [config]));
}

/**
 * @param {object} values - the BTRFS_*_PERIOD keys being changed
 * @returns {Promise} settled once the file is written and the timers follow it
 */
export function setMaintenance(values) {
    return run('SetMaintenance', new GLib.Variant('(a{ss})', [values]));
}

/**
 * Puts files back as the first snapshot had them, the way snapper's
 * undochange does.
 *
 * @param {string} config - the config the files are in
 * @param {number} from - the snapshot to take them from
 * @param {number} to - the later snapshot, or 0 for the files as they are now
 * @param {string[]} paths - whole paths, escaped as snapperd sends them
 * @returns {Promise} settled once snapper is done with them
 */
export function undoChange(config, from, to, paths) {
    // Like a rollback, it is not stopped halfway.
    return run('UndoChange', new GLib.Variant('(suuas)', [config, from, to, paths]),
        null, GLib.MAXINT32);
}

/**
 * What a rollback to the snapshot would do. Nothing is asked for this one.
 *
 * @param {string} config - the config of /
 * @param {number} number - the snapshot
 * @returns {Promise<object>} mode, backup, kernel, refused (a reason code or
 *   ''), nested and nested_more
 */
export function planRollback(config, number) {
    return dict('PlanRollback', new GLib.Variant('(su)', [config, number]));
}

/**
 * @param {string} config - the config of /
 * @param {number} number - the snapshot to boot into next time
 * @returns {Promise<object>} mode, backup and kernel
 */
export async function rollback(config, number) {
    // A swap is not stopped halfway, so the reply is waited for however long
    // it takes.
    const done = await dict('Rollback', new GLib.Variant('(su)', [config, number]), GLib.MAXINT32);
    rolledBack = true;
    return done;
}

/**
 * @returns {boolean} whether a rollback from here waits for the restart
 */
export function waitsForRestart() {
    return rolledBack;
}

/**
 * @param {Error} error - what a call to the helper failed with
 * @returns {boolean} whether a rollback waits for the restart
 */
export function isPending(error) {
    return error instanceof GLib.Error &&
        Gio.DBusError.get_remote_error(error) === `${NAME}.Error.Pending`;
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
