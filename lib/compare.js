// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {WispDialog, Card, actionRow, pill, enable} from './dialog.js';
import {attachEditing, is} from './keys.js';
import {AuthDialog, OK} from './privileged.js';
import {CURRENT, isDenied} from './snapper.js';
import * as Toast from './toast.js';

// Past this many changed files the list is not worth building: nobody is going
// to read a hundred thousand rows, and carrying them over the bus and into the
// shell's own address space costs more than the answer is worth. The count is
// still shown, which is the part that says something.
const TOO_MANY = 20000;

// How many rows are drawn at once. Searching narrows the list; this keeps the
// dialog from having to lay out more actors than a screen can hold.
const SHOWN = 300;

// Long enough that a search does not rebuild the list on every keystroke.
const SEARCH_DELAY = 150;

// Under this many seconds, a wait this config took before is not worth a line
// about how much of it is left: it would be read after the answer arrived.
const WAIT_QUIET = 10;

// How far past what it took last time the estimate is still worth showing. A
// cold page cache makes the same walk several times slower, so past this the
// guess was wrong and the honest thing to show is what it has taken so far.
const WAIT_OVER = 1.5;

// How long a wait nobody has timed yet goes without a word. Short waits are
// over inside this, and a count that appears and vanishes is worse than none.
const WAIT_LATE = 3;

// How long the last comparison of each config took, in seconds. snapperd
// answers a comparison in one call and says nothing until it has the answer,
// so there is no progress to read and the only figure to go by is the last
// one. It is kept in the extension's settings, which no dialog is handed -
// see the same arrangement in toast.js.
let settings = null;

export function watch(theSettings) {
    settings = theSettings;
}

export function forget() {
    settings = null;
}

/**
 * How long this config took last time.
 *
 * @param {string} config - the config being compared
 * @returns {number} seconds, or 0 if it has never been timed
 */
function timed(config) {
    return settings?.get_value('compare-seconds').deepUnpack()[config] ?? 0;
}

/**
 * Remembers how long it took, for the next comparison to go by.
 *
 * @param {string} config - the config that was compared
 * @param {number} seconds - how long the answer took
 */
function remember(config, seconds) {
    if (!settings)
        return;

    const known = settings.get_value('compare-seconds').deepUnpack();
    if (known[config] === seconds)
        return;

    known[config] = seconds;
    settings.set_value('compare-seconds', new GLib.Variant('a{si}', known));
}

/**
 * @param {Error} error - what a call came back with
 * @returns {boolean} whether it came back only because we stopped waiting
 */
function isCancelled(error) {
    return error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) === true;
}

/**
 * One changed file: what happened to it, and where.
 */
const FileRow = GObject.registerClass({
    Signals: {'open': {}},
}, class FileRow extends St.Button {
    _init(file, selected) {
        super._init({
            style_class: 'wisp-file',
            x_expand: true,
            can_focus: true,
            reactive: true,
        });

        this.file = file;

        const box = new St.BoxLayout({x_expand: true});
        box.add_child(new St.Icon({
            icon_name: file.created ? 'list-add-symbolic'
                : file.deleted ? 'list-remove-symbolic' : 'document-edit-symbolic',
            style_class: file.created ? 'wisp-file-added'
                : file.deleted ? 'wisp-file-removed' : 'wisp-file-changed',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const label = new St.Label({
            text: file.path,
            style_class: 'wisp-file-path',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // The end of a path says which file it is; the front of it says where
        // the file was, which matters less and is what there is not room for.
        label.clutter_text.ellipsize = Pango.EllipsizeMode.START;
        box.add_child(label);

        // Reactive, so the press lands on the button and not on the row: a
        // look at a file must not also toggle whether it is restored.
        this._open = new St.Button({
            style_class: 'wisp-file-open',
            child: new St.Icon({icon_name: 'document-open-symbolic'}),
            accessible_name: _('Open the file'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._open.connect('clicked', () => this.emit('open'));
        box.add_child(this._open);

        // Only the row under the pointer, or walked onto with the keyboard,
        // carries the button: one on every row would be a column of them down
        // the whole list. It goes invisible rather than away, so the check
        // marks keep their straight column as the pointer moves.
        const reveal = () => {
            const shown = this.hover || this.has_key_focus() ||
                this._open.has_key_focus();
            this._open.opacity = shown ? 255 : 0;
            this._open.reactive = shown;
            this._open.can_focus = shown;
        };
        reveal();
        this.connect('notify::hover', reveal);
        for (const actor of [this, this._open]) {
            actor.connect('key-focus-in', reveal);
            actor.connect('key-focus-out', reveal);
        }

        this._check = new St.Icon({
            icon_name: 'object-select-symbolic',
            style_class: 'wisp-file-check',
            y_align: Clutter.ActorAlign.CENTER,
            opacity: selected ? 255 : 0,
        });
        box.add_child(this._check);

        this.set_child(box);
    }

    set selected(selected) {
        this._check.opacity = selected ? 255 : 0;
        if (selected)
            this.add_style_pseudo_class('selected');
        else
            this.remove_style_pseudo_class('selected');
    }
});

/**
 * What changed between two snapshots, and an offer to put some of it back.
 *
 * Putting it back is snapper's own undochange, run as root. It is not a copy
 * of the file: undochange restores what was deleted, deletes what was created,
 * and carries permissions, ownership and extended attributes across, none of
 * which a copy from the snapshot directory would do.
 */
export const CompareDialog = GObject.registerClass(
class CompareDialog extends WispDialog {
    _init(snapper, config, {from, to, title, description}) {
        super._init(title, description);

        this._snapper = snapper;
        this._config = config;
        this._from = from;
        this._to = to;
        this._files = [];
        // What the search is letting through, and the rows built for the part
        // of it that is on screen. Picking a run of files or all of them is
        // done against these rather than against the whole comparison.
        this._matching = [];
        this._rows = [];
        this._selected = new Set();
        // The last row pressed on its own, which is where a Shift-press
        // measures its run from.
        this._anchor = null;
        this._searchId = 0;
        // The comparison outlives the dialog unless it is stopped, and a
        // dialog closed after ten seconds of waiting is somebody saying they
        // are not going to wait.
        this._cancellable = new Gio.Cancellable();

        this.connect('destroy', () => this._onDestroy());

        this._search = new St.Entry({
            style_class: 'wisp-search',
            hint_text: _('Search these files'),
            can_focus: true,
            x_expand: true,
        });
        this._search.set_primary_icon(new St.Icon({
            icon_name: 'system-search-symbolic',
            style_class: 'wisp-search-icon',
        }));
        this._search.clutter_text.connect('text-changed', () => this._searchLater());
        attachEditing(this._search);
        this._search.visible = false;
        this.contentLayout.insert_child_at_index(this._search, 1);

        // The controls for picking files sit above the list, where they stay
        // put as it is scrolled. Both of them work on what the search is
        // showing: narrowing to a directory and then taking all of it is how a
        // directory gets put back.
        this._tools = new St.BoxLayout({style_class: 'wisp-tools', x_expand: true});
        this._tools.add_child(new St.Widget({x_expand: true}));
        this._all = pill(_('Select all'), 'edit-select-all-symbolic',
            () => this._selectAll());
        this._none = pill(_('Clear'), 'edit-clear-symbolic',
            () => this._clearSelection());
        this._tools.add_child(this._all);
        this._tools.add_child(this._none);
        this._tools.visible = false;
        this.contentLayout.insert_child_at_index(this._tools, 2);

        // Ctrl+A and Ctrl+Shift+A are what a list of files is expected to
        // answer to. The two buttons above the list are the same thing for
        // somebody who was never told about the keys.
        this.connect('key-press-event', (_actor, event) => this._onKey(event));

        this._list = new Card();
        this.body.add_child(this._list);

        this.addButton({
            label: _('Close'),
            key: Clutter.KEY_Escape,
            action: () => this.close(),
        });
        this._restore = this.addButton({
            label: _('Restore'),
            action: () => this._restore_selected(),
        });
        this._restore.reactive = false;
        this._restore.visible = false;

        this._load().catch(error => {
            this.stopWait();
            if (!isCancelled(error))
                this.note(error.message, true);
        });
    }

    async _load() {
        // Monotonic on purpose: a laptop suspended in the middle of a
        // comparison did not spend those hours walking the subvolume, and the
        // next comparison should not be told that it did.
        const started = GLib.get_monotonic_time();
        const before = timed(this._config);
        this.wait(_('Looking for what changed. snapper reads every file in the subvolume to answer, and reading changes nothing.'),
            () => this._howLong(started, before));

        let count;
        try {
            count = await this._snapper.compare(this._config, this._from, this._to,
                this._cancellable);
        } catch (error) {
            this.stopWait();
            if (isCancelled(error))
                return;
            this.note(isDenied(error)
                ? _('This config is not readable by your account.')
                : error.message, true);
            return;
        }

        // The walk is what the wait is: how many files it turned up, and
        // whether they were worth listing, does not change what the next one
        // will cost.
        remember(this._config,
            Math.round((GLib.get_monotonic_time() - started) / GLib.USEC_PER_SEC));

        if (count === 0) {
            this.stopWait();
            this.note(_('Nothing changed.'));
            return;
        }

        if (count > TOO_MANY) {
            this.stopWait();
            // Almost always caches and state files under a home directory. The
            // number is the useful part; the list is not, and asking for it
            // would mean carrying a few dozen megabytes of paths into the
            // shell to build rows nobody will scroll through.
            this.note(ngettext('%d file changed. That is too many to list here.',
                '%d files changed. That is too many to list here.', count).format(count));
            this._list.addRow(actionRow(_('See them in a terminal'), {
                subtitle: `snapper -c ${this._config} status ${this._from}..${this._to}`,
                icon: 'edit-copy-symbolic',
                onActivate: () => {
                    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD,
                        `snapper -c ${this._config} status ${this._from}..${this._to}`);
                    Toast.announce(_('Command copied'));
                },
            }));
            return;
        }

        this._files = await this._snapper.comparedFiles(this._config, this._from,
            this._to, this._cancellable);
        this.stopWait();
        this._search.visible = this._files.length > SHOWN;
        this._restore.visible = true;
        this._fill();
    }

    /**
     * Counts the wait out loud.
     *
     * Answering means walking every file in the subvolume, which on a root
     * subvolume is most of a minute, and a line of text that never changes
     * looks exactly like a dialog that has died. The seconds are the proof
     * that it has not.
     *
     * How many of them are left can only come from the last comparison of the
     * same config, and the same walk over a cold page cache takes several
     * times longer, so the line says where the number came from rather than
     * pretending to know. Once it is past what it took last time there is
     * nothing left to promise, and the count of what it has taken so far is
     * all that is honest.
     *
     * @param {number} started - when the wait began, monotonic
     * @param {number} before - what the last comparison of this config took
     * @returns {string} the line, or '' for no line
     */
    _howLong(started, before) {
        const gone = Math.round((GLib.get_monotonic_time() - started) /
            GLib.USEC_PER_SEC);

        if (before >= WAIT_QUIET) {
            const left = before - gone;
            if (left >= 1) {
                return ngettext('About %d second left, going by the last time',
                    'About %d seconds left, going by the last time', left).format(left);
            }
            if (gone < before * WAIT_OVER)
                return _('Any moment now');
        }

        if (gone < WAIT_LATE)
            return '';

        return ngettext('%d second so far', '%d seconds so far', gone).format(gone);
    }

    /**
     * Rebuilds the list a moment after the typing stops.
     */
    _searchLater() {
        if (this._searchId)
            GLib.source_remove(this._searchId);
        this._searchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DELAY, () => {
            this._searchId = 0;
            this._fill();
            return GLib.SOURCE_REMOVE;
        });
    }

    _fill() {
        const needle = this._search.text.toLowerCase();
        const matching = needle
            ? this._files.filter(f => f.path.toLowerCase().includes(needle))
            : this._files;

        this._matching = matching;
        this._rows = [];
        this._list.clear();
        for (const file of matching.slice(0, SHOWN)) {
            const row = new FileRow(file, this._selected.has(file.path));
            row.connect('clicked', () => this._pressed(row));
            row.connect('open', () => this._openFile(file));
            this._rows.push(row);
            this._list.addRow(row);
        }

        const said = [];
        if (matching.length > SHOWN) {
            said.push(ngettext('%d file changed, showing the first %d. Search to narrow it down.',
                '%d files changed, showing the first %d. Search to narrow it down.',
                matching.length).format(matching.length, SHOWN));
        } else {
            said.push(ngettext('%d file changed.', '%d files changed.',
                matching.length).format(matching.length));
        }
        if (matching.length > 1)
            said.push(_('Ctrl+A takes all of them, Shift-click a run of them.'));
        this.note(said.join(' '));

        this._tools.visible = matching.length > 1;
        this._updateRestore();
    }

    /**
     * A press on a row, with whatever was held down at the time.
     *
     * St.Button says which mouse button it was and nothing about the keyboard,
     * so what was held comes from the pointer's own state, which is still the
     * state it was pressed in.
     *
     * @param {FileRow} row - the row pressed
     */
    _pressed(row) {
        const [, , modifiers] = global.get_pointer();
        const shift = (modifiers & Clutter.ModifierType.SHIFT_MASK) !== 0;

        if (shift && this._anchor !== null)
            this._selectRun(this._anchor, row.file.path);
        else
            this._toggle(row);

        this._anchor = row.file.path;
    }

    _toggle(row) {
        const path = row.file.path;
        if (this._selected.has(path))
            this._selected.delete(path);
        else
            this._selected.add(path);
        row.selected = this._selected.has(path);
        this._updateRestore();
    }

    /**
     * Everything between two rows, the way a file manager does it: the run is
     * read off the list as it is showing, and it adds to what is already
     * picked rather than replacing it.
     *
     * @param {string} from - path of the row the run starts at
     * @param {string} to - path of the row it ends at
     */
    _selectRun(from, to) {
        const first = this._rows.findIndex(row => row.file.path === from);
        const last = this._rows.findIndex(row => row.file.path === to);
        // The row a run was measured from can have been searched away since.
        if (first < 0 || last < 0)
            return;

        for (let i = Math.min(first, last); i <= Math.max(first, last); i++) {
            this._selected.add(this._rows[i].file.path);
            this._rows[i].selected = true;
        }
        this._updateRestore();
    }

    /**
     * Everything the search is letting through, which is more than the list
     * has rows for once there are thousands of them.
     */
    _selectAll() {
        for (const file of this._matching)
            this._selected.add(file.path);
        for (const row of this._rows)
            row.selected = true;
        this._updateRestore();
    }

    /**
     * Drops the lot, including anything picked before the search narrowed the
     * list: what the button says is what it does.
     */
    _clearSelection() {
        this._selected.clear();
        this._anchor = null;
        for (const row of this._rows)
            row.selected = false;
        this._updateRestore();
    }

    _onKey(event) {
        if (!(event.get_state() & Clutter.ModifierType.CONTROL_MASK))
            return Clutter.EVENT_PROPAGATE;

        // Which key it is has to be asked rather than read off the event: a
        // Cyrillic layout puts Cyrillic_ef on the key that Ctrl+A lives on, and
        // Shift is then read from the modifiers rather than from the letter
        // having turned into its capital.
        if (!is(event, Clutter.KEY_a))
            return Clutter.EVENT_PROPAGATE;

        if (event.get_state() & Clutter.ModifierType.SHIFT_MASK)
            this._clearSelection();
        else
            this._selectAll();
        return Clutter.EVENT_STOP;
    }

    _updateRestore() {
        const n = this._selected.size;
        this._restore.reactive = n > 0;
        this._restore.label = n > 0
            ? ngettext('Restore %d file', 'Restore %d files', n).format(n)
            : _('Restore');
        enable(this._none, n > 0);
    }

    /**
     * Shows one file the way the comparison saw it.
     *
     * A changed or deleted file is opened out of the snapshot, since the old
     * copy is the one this dialog exists to get at - the file as it is now
     * can be opened from any file manager. A created file has no old copy,
     * so for it the new one opens.
     *
     * The dialog stays up: the comparison in snapperd dies with it, and a
     * minute of walking the subvolume again is a lot to pay for a look at
     * one file. What opens sits behind this dialog until it is closed.
     *
     * @param {object} file - a ChangedFile out of the list
     */
    async _openFile(file) {
        try {
            let root, said;
            if (file.created) {
                if (this._to === CURRENT) {
                    const {subvolume} = await this._snapper.getConfig(this._config);
                    root = subvolume === '/' ? '' : subvolume;
                    said = _('Opened it as it is now');
                } else {
                    root = await this._snapper.mountPoint(this._config, this._to);
                    said = _('Opened it as snapshot %d had it').format(this._to);
                }
            } else {
                root = await this._snapper.mountPoint(this._config, this._from);
                said = _('Opened it as snapshot %d had it').format(this._from);
            }
            if (!this.alive)
                return;

            // A snapshot keeps the permissions every file had, and a good few
            // of them are root's alone, so this often says no. That is not a
            // reason to refuse: the file manager and the editor both ask for a
            // password of their own and then show the file, which is the way
            // through. Saying so before the prompt appears is all the check is
            // for. Asking only for an access attribute never fails over
            // permissions - it is an access() call, not a read.
            const target = Gio.File.new_for_path(root + file.path);
            let readable = false;
            try {
                readable = target
                    .query_info(Gio.FILE_ATTRIBUTE_ACCESS_CAN_READ,
                        Gio.FileQueryInfoFlags.NONE, null)
                    .get_attribute_boolean(Gio.FILE_ATTRIBUTE_ACCESS_CAN_READ);
            } catch {
                // Gone, or somewhere nothing can be told about. Let whatever
                // opens it be the one to say so.
            }

            Gio.AppInfo.launch_default_for_uri(target.get_uri(), null);
            Toast.announce(readable ? said
                : _('%s. Only root can read this copy, so what opens it may ask for a password.').format(said));
        } catch (error) {
            if (!this.alive)
                return;
            this.note(this._openTrouble(error), true);
        }
    }

    /**
     * Puts what went wrong into words the message can carry.
     *
     * @param {Error} error - what the open threw
     * @returns {string} what to say about it
     */
    _openTrouble(error) {
        // Nothing on the system has claimed this kind of file. Binary logs are
        // the usual one: wtmp, btmp, journal files.
        if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_SUPPORTED))
            return _('Nothing installed here opens this kind of file.');

        // The comparison is a moment old and the file it named is not there any
        // more, or the whole snapshot directory is closed to this account.
        if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.PERMISSION_DENIED))
            return _('Snapshot files are not readable by this account. SYNC_ACL=yes on the config is what opens them up.');
        if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return _('That file is not there any more.');

        return error.message;
    }

    /**
     * Hands the chosen paths to snapper, as root.
     *
     * The list goes in a file rather than on the command line: a few hundred
     * paths is an ordinary selection and an argument list has a limit.
     */
    async _restore_selected() {
        const {subvolume} = await this._snapper.getConfig(this._config);
        const prefix = subvolume === '/' ? '' : subvolume;
        const paths = [...this._selected].map(path => prefix + path);

        // mkstemp makes it, so it is the user's own and mode 0600, and /tmp
        // being sticky means no other account can put its own file in its
        // place. The dialog says when snapper can no longer be reading it.
        const [file, stream] = Gio.File.new_tmp('wisp-XXXXXX');
        stream.get_output_stream().write_all(`${paths.join('\n')}\n`, null);
        stream.close(null);

        const n = paths.length;
        new AuthDialog({
            title: ngettext('Restore %d file?', 'Restore %d files?', n).format(n),
            description: _('snapper will put these files back as snapshot %d had them, overwriting what is there now. Files it created since will be removed.').format(this._from),
            argv: ['snapper', '-c', this._config, 'undochange',
                `${this._from}..${this._to}`, '-i', file.get_path()],
            confirmLabel: ngettext('Restore file', 'Restore files', n),
            danger: true,
            cleanup: () => file.delete_async(GLib.PRIORITY_DEFAULT, null, null),
            onDone: result => {
                if (result !== OK)
                    return;
                Main.notify(_('Wisp'),
                    ngettext('%d file restored.', '%d files restored.', n).format(n));
                this.close();
            },
        }).open();
    }

    _onDestroy() {
        if (this._searchId)
            GLib.source_remove(this._searchId);
        this._searchId = 0;
        this._cancellable.cancel();
        // snapperd holds a comparison until it is told not to, and it is the
        // biggest thing the extension makes it keep.
        this._snapper.forgetComparison(this._config, this._from, this._to);
    }
});
