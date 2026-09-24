// SPDX-License-Identifier: GPL-2.0-or-later

// What needs root is not run from here. The extension lives in the shell's
// own process, so anything it would do as root it shows as a command instead,
// for the user to run in a terminal.
//
// snapperd answers an account named in a config's ALLOW_USERS without a
// password, so once that is set the menu works without root. What is left -
// the grant itself, a rollback, putting files back - goes through here.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {WispDialog, wrap} from './dialog.js';
import {commandLine} from './exec.js';
import * as Toast from './toast.js';

export {commandLine};

/**
 * Shows a command to be run as root, with a button that copies it.
 */
export const CommandDialog = GObject.registerClass(
class CommandDialog extends WispDialog {
    _init({title, description, argv, danger = false}) {
        super._init(title, description);

        const line = commandLine(argv);
        const command = new St.Label({
            text: line,
            style_class: 'wisp-command',
        });
        wrap(command);
        command.clutter_text.selectable = true;
        this.body.add_child(command);

        this.note(_('Wisp does not run commands as root. Run this one as root in a terminal.'));

        this.addButton({
            label: _('Close'),
            key: Clutter.KEY_Escape,
            action: () => this.close(),
        });
        const copy = this.addButton({
            label: _('Copy command'),
            default: true,
            action: () => {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, line);
                Toast.announce(_('Command copied'));
                this.close();
            },
        });
        if (danger)
            copy.add_style_class_name('wisp-danger');
    }
});
