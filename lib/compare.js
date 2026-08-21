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
import {isDenied} from './snapper.js';

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
const FileRow = GObject.registerClass(
class FileRow extends St.Button {
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
        this.wait(_('Looking for what changed. snapper reads every file in the subvolume to answer, and reading changes nothing.'));

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
                    Main.notify(_('Wisp'), _('Command copied.'));
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
     * Hands the chosen paths to snapper, as root.
     *
     * The list goes in a file rather than on the command line: a few hundred
     * paths is an ordinary selection and an argument list has a limit.
     */
    async _restore_selected() {
        const {subvolume} = await this._snapper.getConfig(this._config);
        const prefix = subvolume === '/' ? '' : subvolume;
        const paths = [...this._selected].map(path => prefix + path);

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
            onDone: result => {
                file.delete_async(GLib.PRIORITY_DEFAULT, null, null);
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
