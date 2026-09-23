// SPDX-License-Identifier: GPL-2.0-or-later

// Reading and writing /etc/snapper/configs/<name>, from either side of the
// extension. Nothing in here belongs to the shell or to Gtk.
//
// The reading side costs nothing. ListConfigs is the one snapperd method that
// answers anybody: it hands back every config's name, its subvolume and the
// whole of its config file without asking who wants to know, even for a
// config whose snapshots that same caller is refused. So every setting shown
// in the preferences window is read without a password.
//
// The writing side needs root. SetConfig, CreateConfig and DeleteConfig are
// refused for everybody but root - being named in a config's own ALLOW_USERS
// buys the right to take and delete snapshots in it, not the right to change
// what it is - so a change is shown as snapper's command line, for the user
// to run. Which is why the window collects changes into one command.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {commandLine} from './exec.js';

const BUS_NAME = 'org.opensuse.Snapper';
const OBJECT_PATH = '/org/opensuse/Snapper';

// How many of each age the timeline keeps, in the order they are shown.
export const TIMELINE_LIMITS = [
    'TIMELINE_LIMIT_HOURLY',
    'TIMELINE_LIMIT_DAILY',
    'TIMELINE_LIMIT_WEEKLY',
    'TIMELINE_LIMIT_MONTHLY',
    'TIMELINE_LIMIT_QUARTERLY',
    'TIMELINE_LIMIT_YEARLY',
];

/**
 * One call to snapperd on the system bus.
 *
 * @param {string} method - method name on the snapper interface
 * @param {GLib.Variant|null} params - arguments, already packed
 * @param {string|null} replyType - signature of the reply, if there is one
 * @returns {Promise<GLib.Variant|null>} the reply
 */
function call(method, params, replyType) {
    return new Promise((resolve, reject) => {
        Gio.DBus.system.call(BUS_NAME, OBJECT_PATH, BUS_NAME, method, params,
            replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
                try {
                    resolve(connection.call_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
    });
}

/**
 * Every config snapper manages, with the contents of its config file.
 *
 * @returns {Promise<{name: string, subvolume: string, values: object}[]>} what
 *   it has, in the order it lists them
 */
export async function listConfigs() {
    const [rows] = (await call('ListConfigs', null, '(a(ssa{ss}))')).deepUnpack();
    return rows.map(([name, subvolume, values]) => ({name, subvolume, values}));
}

/**
 * @param {string} config - the config to change
 * @param {object} values - only the keys that are actually being changed:
 *   snapper writes what it is handed and some of these keys hold syntax a
 *   spin button cannot represent, so a value nobody touched is never rewritten
 * @returns {string[]} the command that would do it
 */
export function setConfigArgv(config, values) {
    return ['snapper', '-c', config, 'set-config',
        ...Object.entries(values).map(([key, value]) => `${key}=${value}`)];
}

/**
 * @param {string} config - the name it will be known by
 * @param {string} subvolume - the path it will take snapshots of
 * @returns {string[]} the command that would do it
 */
export function createConfigArgv(config, subvolume) {
    return ['snapper', '-c', config, 'create-config', subvolume];
}

/**
 * @param {string} config - the config to remove
 * @returns {string[]} the command that would do it
 */
export function deleteConfigArgv(config) {
    return ['snapper', '-c', config, 'delete-config'];
}

/**
 * @param {string} allowUsers - a config's current ALLOW_USERS
 * @returns {string[]} the accounts named in it
 */
export function allowedUsers(allowUsers) {
    return (allowUsers ?? '').split(' ').filter(name => name.length > 0);
}

/**
 * Adds an account to a config's list without disturbing the rest of it.
 *
 * @param {string} allowUsers - the config's current ALLOW_USERS
 * @param {string} user - the account to add
 * @returns {string} what ALLOW_USERS should become
 */
export function withUser(allowUsers, user = GLib.get_user_name()) {
    const users = allowedUsers(allowUsers);
    if (!users.includes(user))
        users.push(user);
    return users.join(' ');
}

export {commandLine};
