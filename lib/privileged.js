// SPDX-License-Identifier: GPL-2.0-or-later

// Everything that needs root goes through here.
//
// snapperd has no polkit integration: it decides what a caller may do from
// ALLOW_USERS and ALLOW_GROUPS in /etc/snapper/configs/<name>, both empty
// until somebody sets them, and refuses everything else. So a config the user
// has not been given - which on a fresh install is every one of them - cannot
// be read at all, let alone written to.
//
// An extension cannot ship a polkit policy of its own, and a password typed
// into a window an extension drew would be a password typed into the shell's
// own process. What happens instead is that snapper's command line runs under
// pkexec: the dialog here says what is about to happen and why, polkit's own
// dialog asks for the password, and the password never comes near this code.
//
// The one thing worth spending a password on is the grant itself. pkexec's
// action is auth_admin rather than auth_admin_keep, so nothing is remembered
// between calls and a config reached this way would ask again for every
// refresh. Named in ALLOW_USERS once, the account talks to snapperd directly
// from then on and is never asked again.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {WispDialog, wrap} from './dialog.js';
import {DISMISSED, REFUSED, commandLine, pkexec} from './exec.js';

export {commandLine};

export const OK = 'ok';
export const CANCELLED = 'cancelled';
export const FAILED = 'failed';

/**
 * The window that explains itself before polkit asks for a password.
 *
 * It shows the command that is about to run, because a request for
 * administrator rights that will not say what it is going to do with them
 * deserves to be turned down, and because the same line can be copied and run
 * by hand by anyone who would rather not be asked at all.
 */
export const AuthDialog = GObject.registerClass(
class AuthDialog extends WispDialog {
    _init({title, description, argv, confirmLabel, danger = false, onDone = null}) {
        super._init(title, description);

        this._argv = argv;
        this._onDone = onDone;

        const command = new St.Label({
            text: commandLine(argv),
            style_class: 'wisp-command',
        });
        wrap(command);
        command.clutter_text.selectable = true;
        this.body.add_child(command);

        this.note(_('You will be asked for your password by the system, not by this window.'));

        this._cancel = this.addButton({
            label: _('Cancel'),
            key: Clutter.KEY_Escape,
            action: () => this._finish(CANCELLED),
        });
        this._confirm = this.addButton({
            label: confirmLabel,
            default: true,
            action: () => this._run(),
        });
        if (danger)
            this._confirm.add_style_class_name('wisp-danger');
    }

    async _run() {
        this._confirm.reactive = false;
        this._confirm.label = _('Waiting for authorization…');
        this.note(_('The system is asking for your password.'));

        try {
            const {status, stderr} = await pkexec(this._argv);
            if (status === 0) {
                this._finish(OK);
            } else if (status === DISMISSED || status === REFUSED) {
                // Nothing went wrong: the answer was no. The dialog stays up
                // so that the same button can be pressed again.
                this._confirm.reactive = true;
                this._confirm.label = _('Try again');
                this.note(_('Not authorized.'), true);
            } else {
                this._failed(stderr.trim() || _('snapper exited with status %d').format(status));
            }
        } catch (error) {
            this._failed(error.message);
        }
    }

    _failed(message) {
        this._confirm.reactive = true;
        this._confirm.label = _('Try again');
        this.note(message, true);
    }

    _finish(result) {
        this._onDone?.(result);
        this.close();
    }
});

/**
 * Asks for the one privilege the extension keeps: a place in the config's
 * ALLOW_USERS, which is what snapperd reads before it answers anything.
 *
 * SYNC_ACL goes with it. It tells snapper to put an ACL on the .snapshots
 * directory for the users it allows, without which the snapshots are listed
 * but their files still cannot be opened.
 *
 * @param {string} config - the config to be let into
 * @param {Function} [onGranted] - called once it has worked
 */
/**
 * Asks for this account to be added to a config's own list of who may use it.
 *
 * @param {string} config - the config that refused
 * @param {object} options - what is known about the config already
 * @param {string} options.allowUsers - the config's current ALLOW_USERS, so
 *   that the account is added to the list rather than put in place of it
 * @param {Function|null} options.onGranted - called once it worked
 * @returns {AuthDialog} the dialog, already open
 */
export function requestAccess(config, {allowUsers = '', onGranted = null} = {}) {
    const user = GLib.get_user_name();

    // snapper separates the names with spaces. Anyone already on the list
    // stays on it: this is one account asking to be let in, not a decision
    // about everybody else's access.
    const users = allowUsers.split(' ').filter(name => name.length > 0);
    if (!users.includes(user))
        users.push(user);

    const dialog = new AuthDialog({
        title: _('Give this account access?'),
        description: _('The %s snapshots belong to root and cannot be read by anyone else. This adds your account to the list snapper checks, once, so that Wisp can list them without asking again.').format(config),
        argv: ['snapper', '-c', config, 'set-config',
            `ALLOW_USERS=${users.join(' ')}`, 'SYNC_ACL=yes'],
        confirmLabel: _('Give access'),
        onDone: result => {
            if (result === OK)
                onGranted?.();
        },
    });
    dialog.open();
    return dialog;
}
