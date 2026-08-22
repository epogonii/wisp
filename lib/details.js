// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {WispDialog, Card, ConfirmDialog, actionRow, entryRow, switchRow} from './dialog.js';
import {AuthDialog, OK} from './privileged.js';
import {CompareDialog} from './compare.js';
import {CURRENT, PRE, isDenied} from './snapper.js';
import * as Format from './format.js';
import * as Toast from './toast.js';

// snapper's cleanup algorithms, in the order the row cycles through them. An
// empty rule is snapper's way of saying the snapshot is nobody's to remove.
const CLEANUPS = ['', 'number', 'timeline'];
const TRANSACTION_CLEANUPS = [...CLEANUPS, 'empty-pre-post'];

/**
 * @param {string} cleanup - a snapper cleanup algorithm, or an empty string
 * @returns {string} what it does, in a few words
 */
function cleanupLabel(cleanup) {
    switch (cleanup) {
    case 'number':
        return _('Oldest go first');
    case 'timeline':
        return _('Thinned out over time');
    case 'empty-pre-post':
        return _('Dropped if nothing changed');
    default:
        return _('Kept until deleted');
    }
}

/**
 * Whether /etc/fstab names the subvolume that is mounted at root.
 *
 * snapper rollback works by pointing btrfs at a different default subvolume.
 * An fstab that asks for subvol=root by name overrules that, so the rollback
 * is written, reported and then quietly ignored at the next boot. It is worth
 * saying so before somebody reboots expecting otherwise.
 *
 * @returns {boolean} true when a rollback would not take effect
 */
function rootSubvolumePinned() {
    try {
        const [, contents] = Gio.File.new_for_path('/etc/fstab').load_contents(null);
        for (const line of new TextDecoder().decode(contents).split('\n')) {
            if (line.trimStart().startsWith('#'))
                continue;
            const fields = line.split(/\s+/).filter(f => f !== '');
            if (fields[1] !== '/' || fields[2] !== 'btrfs')
                continue;
            return /(^|,)subvol=/.test(fields[3] ?? '');
        }
    } catch (error) {
        logError(error, 'Wisp: cannot read /etc/fstab');
    }
    return false;
}

/**
 * Everything there is to do to one snapshot.
 *
 * The menu keeps four things - list, take, open, delete - and this has the
 * rest. A popup menu wide enough for all of it would be a popup menu nobody
 * could find anything in.
 */
export const DetailsDialog = GObject.registerClass(
class DetailsDialog extends WispDialog {
    _init(snapper, config, entry) {
        const numbers = entry.numbers;
        const title = numbers.length > 1
            ? _('Snapshots %d and %d').format(...numbers)
            : _('Snapshot %d').format(numbers[0]);

        super._init(title, [
            config,
            Format.fullDate(entry.dateTime),
            entry.description || _('no description'),
        ].join(' · '));

        this._snapper = snapper;
        this._config = config;
        this._entry = entry;
        this._cleanup = entry.cleanup;
        this._cleanups = entry.type === PRE ? TRANSACTION_CLEANUPS : CLEANUPS;

        this._buildAbout();
        this._buildContents();
        this._buildRemoval();

        this.addButton({
            label: _('Done'),
            key: Clutter.KEY_Escape,
            default: true,
            action: () => this.close(),
        });

        // The description is written when the dialog goes rather than on every
        // keystroke, which would mean a bus call per letter.
        this.connect('destroy', () => this._saveDescription());
    }

    _buildAbout() {
        const card = new Card();

        this._description = entryRow(_('Description'), {
            text: this._entry.description,
            hint: _('What this snapshot is for'),
            onActivate: () => this._saveDescription(),
        });
        card.addRow(this._description);

        card.addRow(switchRow(_('Keep this snapshot'), {
            subtitle: _('Marks it important, which is what snapper\'s cleanup leaves alone'),
            state: this._entry.important,
            onToggle: state => this._write(
                () => this._snapper.setImportant(this._config, this._entry, state)),
        }));

        this._cleanupRow = actionRow(_('Cleanup'), {
            subtitle: cleanupLabel(this._cleanup),
            icon: 'view-refresh-symbolic',
            onActivate: () => this._cycleCleanup(),
        });
        card.addRow(this._cleanupRow);

        this._readOnly = switchRow(_('Read-only'), {
            subtitle: _('Snapper takes snapshots read-only. Turning this off lets anything with root change one.'),
            state: true,
            onToggle: state => this._write(() => Promise.all(
                this._entry.numbers.map(n => this._snapper.setReadOnly(this._config, n, state)))),
        });
        card.addRow(this._readOnly);
        this._snapper.isReadOnly(this._config, this._entry.number)
            .then(readOnly => {
                if (this.alive)
                    this._readOnly.toggle.state = readOnly;
            })
            .catch(() => {
                if (this.alive)
                    this._readOnly.reactive = false;
            });

        this._sizeRow = actionRow(_('Disk space'), {
            subtitle: _('Work out what this snapshot alone is holding on to'),
            icon: 'accessories-calculator-symbolic',
            onActivate: () => this._measure(),
        });
        card.addRow(this._sizeRow);

        this.body.add_child(card);
    }

    _buildContents() {
        const card = new Card(_('Contents'));

        card.addRow(actionRow(_('Browse the files'), {
            subtitle: _('Opens the snapshot in Files, read-only'),
            icon: 'folder-symbolic',
            onActivate: () => this._browse(),
        }));

        if (this._entry.type === PRE) {
            const [from, to] = this._entry.range;
            card.addRow(actionRow(_('What this transaction changed'), {
                subtitle: _('Compares the snapshot before it with the one after'),
                icon: 'view-list-symbolic',
                onActivate: () => this._compare(from, to,
                    _('Changed by snapshot %d').format(from)),
            }));
        }

        card.addRow(actionRow(_('What has changed since'), {
            subtitle: _('Compares this snapshot with the system as it is now, and can put files back'),
            icon: 'edit-undo-symbolic',
            onActivate: () => this._compare(this._entry.number, CURRENT,
                _('Changed since snapshot %d').format(this._entry.number)),
        }));

        this.body.add_child(card);
    }

    _buildRemoval() {
        const card = new Card();

        const n = this._entry.numbers.length;
        card.addRow(actionRow(
            ngettext('Delete this snapshot', 'Delete both snapshots', n), {
                subtitle: _('There is no undoing this'),
                icon: 'user-trash-symbolic',
                styleClass: 'wisp-row-danger',
                onActivate: () => this._delete(),
            }));

        this.body.add_child(card);

        // Only the config that holds the root filesystem can be rolled back:
        // snapper does it by changing which subvolume btrfs boots from, and
        // for /home there is nothing to boot. Which config that is has to be
        // asked, since the names are whatever the person who made them chose,
        // and the row is built once the answer is in rather than built hidden -
        // an empty row still leaves the line above it behind.
        this._snapper.getConfig(this._config)
            .then(({subvolume}) => {
                if (!this.alive || subvolume !== '/')
                    return;

                const rollback = new Card();
                rollback.addRow(actionRow(_('Roll back to this snapshot'), {
                    subtitle: _('Asks snapper to boot from it next time'),
                    icon: 'view-refresh-symbolic',
                    styleClass: 'wisp-row-danger',
                    onActivate: () => this._rollback(),
                }));
                this.body.insert_child_below(rollback, card);
            })
            .catch(() => {});
    }

    /**
     * Runs one change and says what happened to it, since every row here
     * writes straight through to snapperd rather than waiting for an Apply.
     *
     * @param {Function} change - what to do
     */
    _write(change) {
        Promise.resolve()
            .then(change)
            .then(() => this.note(''))
            .catch(error => this.note(isDenied(error)
                ? _('Your account is not allowed to change this config.')
                : error.message, true));
    }

    _saveDescription() {
        const description = this._description.entry.text;
        if (description === this._entry.description)
            return;

        const {number, cleanup, userdata} = this._entry.primary;
        this._write(async () => {
            await this._snapper.edit(this._config, number, {description, cleanup, userdata});
            this._entry.primary.description = description;
        });
    }

    _cycleCleanup() {
        const next = this._cleanups[(this._cleanups.indexOf(this._cleanup) + 1) % this._cleanups.length];
        const {number, userdata} = this._entry.primary;

        this._write(async () => {
            await this._snapper.edit(this._config, number, {
                description: this._description.entry.text,
                cleanup: next,
                userdata,
            });
            this._cleanup = next;
            this._entry.primary.cleanup = next;
            this._cleanupRow.row.subtitle = cleanupLabel(next);
        });
    }

    _measure() {
        this._sizeRow.reactive = false;
        this._sizeRow.row.subtitle = _('Adding it up…');
        this._snapper.usedSpace(this._config, this._entry.number)
            .then(bytes => {
                if (!this.alive)
                    return;
                this._sizeRow.row.subtitle = bytes === null
                    ? _('btrfs quotas are not set up, so snapper cannot say')
                    : Format.size(bytes);
            })
            .catch(error => {
                if (this.alive)
                    this._sizeRow.row.subtitle = error.message;
            });
    }

    _browse() {
        this._snapper.mountPoint(this._config, this._entry.number)
            .then(path => {
                // Closed while snapperd was working out where the snapshot is
                // mounted is somebody who has changed their mind, and a file
                // manager opening after that is a window nobody asked for.
                if (!this.alive)
                    return;
                const uri = Gio.File.new_for_path(path).get_uri();
                Gio.AppInfo.launch_default_for_uri(uri, null);
                this.close();
            })
            .catch(error => this.note(error.message, true));
    }

    _compare(from, to, title) {
        new CompareDialog(this._snapper, this._config, {
            from,
            to,
            title,
            description: to === CURRENT
                ? _('In %s, against the files as they are now').format(this._config)
                : _('In %s, between the snapshot before it and the one after').format(this._config),
        }).open();
    }

    _delete() {
        const numbers = this._entry.numbers;
        const n = numbers.length;

        // One number or two, and never more: the pair is a pre and post
        // snapshot shown as one row. Not ngettext, because the two are not the
        // same sentence with a different count in it - one takes a number and
        // the other takes both - and a language with more than two plural
        // forms has nothing to put in the ones between.
        const title = n > 1
            ? _('Delete snapshots %d and %d?').format(...numbers)
            : _('Delete snapshot %d?').format(numbers[0]);

        new ConfirmDialog({
            title,
            description: _('The snapshot goes and the space it was holding comes back. Nothing here brings it back.'),
            confirmLabel: _('Delete'),
            danger: true,
            onConfirm: () => {
                this._snapper.delete(this._config, numbers)
                    .then(() => {
                        if (this.alive)
                            this.close();
                    })
                    .catch(error => {
                        // Refused only because the config is somebody else's;
                        // snapper's own command line can still do it as root.
                        if (!isDenied(error)) {
                            this.note(error.message, true);
                            return;
                        }
                        new AuthDialog({
                            title,
                            description: _('Your account is not allowed to change the %s config, so snapper will do it as root.').format(this._config),
                            argv: ['snapper', '-c', this._config, 'delete',
                                ...numbers.map(number => String(number))],
                            confirmLabel: _('Delete'),
                            danger: true,
                            onDone: result => {
                                if (result === OK)
                                    this.close();
                            },
                        }).open();
                    });
            },
        }).open();
    }

    _rollback() {
        const number = this._entry.number;
        const pinned = rootSubvolumePinned();

        const dialog = new AuthDialog({
            title: _('Roll back to snapshot %d?').format(number),
            description: _('snapper takes a snapshot of the system as it is, makes a writable copy of snapshot %d and points btrfs at it. Nothing changes until the machine is restarted.').format(number),
            argv: ['snapper', '-c', this._config, 'rollback', String(number)],
            confirmLabel: _('Roll back'),
            danger: true,
            onDone: result => {
                if (result === OK) {
                    Main.notify(_('Wisp'),
                        _('Rolled back to snapshot %d. Restart to boot into it.').format(number));
                    this.close();
                }
            },
        });

        if (pinned) {
            dialog.note(_('/etc/fstab mounts this filesystem by subvolume name, which overrules the default subvolume snapper is about to set. The rollback will be reported as done and the machine will boot into the same system as before. Swapping the subvolumes by hand from a live image is the way round it.'), true);
        }

        dialog.open();
    }
});

/**
 * Taking one by hand.
 *
 * The cleanup rule is left empty, which is snapper's way of saying no
 * algorithm may remove it. A snapshot taken deliberately, a minute before
 * something is changed on purpose, is exactly the one that should not be
 * thinned out an hour later by the timeline.
 */
export const CreateDialog = GObject.registerClass(
class CreateDialog extends WispDialog {
    _init(snapper, config) {
        super._init(_('Take a snapshot of %s').format(config),
            _('It records the subvolume as it is now. Nothing is copied, so it takes about a second and almost no disk until the files start to differ.'));

        this._snapper = snapper;
        this._config = config;

        const card = new Card();
        this._description = entryRow(_('Description'), {
            text: '',
            hint: _('Before I change something'),
            onActivate: () => this._create(),
        });
        card.addRow(this._description);
        this.body.add_child(card);

        this.addButton({
            label: _('Cancel'),
            key: Clutter.KEY_Escape,
            action: () => this.close(),
        });
        this._confirm = this.addButton({
            label: _('Take snapshot'),
            default: true,
            action: () => this._create(),
        });

        this.setInitialKeyFocus(this._description.entry.clutter_text);
    }

    _create() {
        this._confirm.reactive = false;
        const description = this._description.entry.text.trim() || _('Taken by hand');

        this._snapper.create(this._config, description)
            .then(number => {
                // A pill under the panel by default rather than a
                // notification: this is the answer to something asked a second
                // ago from up there, and it is not worth keeping in the message
                // list afterwards. message-style is there for whoever disagrees.
                Toast.announce(_('Snapshot %d taken').format(number));
                if (this.alive)
                    this.close();
            })
            .catch(error => {
                if (!this.alive)
                    return;
                this._confirm.reactive = true;
                if (!isDenied(error)) {
                    this.note(error.message, true);
                    return;
                }
                this.close();
                new AuthDialog({
                    title: _('Take a snapshot of %s?').format(this._config),
                    description: _('Your account is not allowed to change the %s config, so snapper will do it as root.').format(this._config),
                    argv: ['snapper', '-c', this._config, 'create',
                        '--description', description],
                    confirmLabel: _('Take snapshot'),
                    // snapper prints the number it gave the snapshot, but what
                    // came back from pkexec is not worth parsing for it: the
                    // message is that there is one.
                    onDone: status => {
                        if (status === OK)
                            Toast.announce(_('Snapshot taken'));
                    },
                }).open();
            });
    }
});
