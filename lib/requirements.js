// SPDX-License-Identifier: GPL-2.0-or-later

// Nothing here works without snapper, and snapper is not installed by default
// on most of the distributions this will be installed on. A menu that only
// said it could not find any snapshots would be telling the truth and helping
// nobody, so the panel says what is missing and hands over the line that fixes
// it.

import GLib from 'gi://GLib';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {installCommand as commandFor} from './packages.js';

/**
 * The command this distribution installs snapper with.
 *
 * @returns {string} a line that can be copied into a terminal
 */
export function installCommand() {
    return commandFor('snapper') ??
        _('Install the snapper package for your distribution');
}

// What is wrong, when something is.
export const MISSING = 'missing';
export const UNREACHABLE = 'unreachable';
export const NO_CONFIGS = 'no-configs';

/**
 * What stands between the extension and a list of snapshots.
 *
 * @param {object} snapper - the snapper client, already constructed
 * @param {string[]} configs - what it managed to list, which may be nothing
 * @returns {{problem: string, message: string, command: string}|null} the
 *   first thing that needs doing, or null when there is nothing to do
 */
export function check(snapper, configs) {
    if (!GLib.find_program_in_path('snapper')) {
        return {
            problem: MISSING,
            message: _('Wisp shows the snapshots snapper takes, and snapper is not installed.'),
            command: installCommand(),
        };
    }

    if (!snapper.ready) {
        return {
            problem: UNREACHABLE,
            message: _('snapper is installed but its service is not answering on the system bus.'),
            command: 'systemctl status snapperd.service',
        };
    }

    if (configs.length === 0) {
        return {
            problem: NO_CONFIGS,
            message: _('snapper has nothing set up yet. One config per subvolume is what it takes snapshots of.'),
            command: 'sudo snapper -c root create-config /',
        };
    }

    return null;
}

/**
 * Whether the system can be asked for a password at all. Everything root here
 * goes through pkexec, and on a machine without polkit installed there is no
 * point offering.
 *
 * @returns {boolean} true when pkexec is there to be run
 */
export function canAskForRoot() {
    return GLib.find_program_in_path('pkexec') !== null;
}
