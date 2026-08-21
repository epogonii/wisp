// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension, gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {CreateDialog, DetailsDialog} from './lib/details.js';
import {VERTICAL, ConfirmDialog, pill, wrap} from './lib/dialog.js';
import {Snapper, isDenied} from './lib/snapper.js';
import {check, canAskForRoot} from './lib/requirements.js';
import {requestAccess} from './lib/privileged.js';
import {Lock} from './lib/authorization.js';
import {wispIcon} from './lib/icon.js';
import * as Toast from './lib/toast.js';
import * as Format from './lib/format.js';

const PANEL_BOXES = ['left', 'center', 'right'];

// How long a snapshot counts as one that was just taken, in seconds. Long
// enough to find the row again after the menu has been reopened, short enough
// that the mark means what it says.
const FRESH = 120;

// How many rows one press on the older-snapshots row can add. A config nobody
// has ever cleaned up holds thousands of them, and a thousand rows built in one
// go is a menu that arrives late.
const MORE = 100;

// A middle click is heard by the panel button and by the menu both, and how
// long after one of them heard it the other one saying the same thing is still
// the same click and not a second one, in microseconds.
const DOUBLE_HEARD = 250 * 1000;

/**
 * @param {string} cleanup - the cleanup algorithm snapper wrote on a snapshot
 * @returns {string} what it means for how long the snapshot will last
 */
function cleanupLabel(cleanup) {
    switch (cleanup) {
    case 'timeline':
        return _('timeline');
    case 'number':
        return _('numbered');
    case 'empty-pre-post':
        return _('paired');
    default:
        // Nothing will remove it but somebody deciding to.
        return _('kept');
    }
}

/**
 * One snapshot in the menu: what it is, when it was taken, and a way to
 * delete it without going any further in.
 */
const SnapshotItem = GObject.registerClass(
class SnapshotItem extends PopupMenu.PopupBaseMenuItem {
    _init(snapper, config, entry, {dateStyle = 'relative', showCleanup = false} = {}) {
        super._init({style_class: 'wisp-snapshot'});

        this._snapper = snapper;
        this._config = config;
        this._entry = entry;
        this._freshId = 0;

        this.add_child(new St.Label({
            text: String(entry.number),
            style_class: 'wisp-number',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const description = new St.Label({
            text: entry.description || _('no description'),
            style_class: 'wisp-description',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // A description is whatever was typed into it, and a long one used to
        // stretch the whole menu to fit. It takes a second line instead; the
        // width it wraps at is the max-width the stylesheet puts on it.
        wrap(description);
        this.add_child(description);

        if (entry.important) {
            this.add_child(new St.Icon({
                icon_name: 'starred-symbolic',
                style_class: 'wisp-kept',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        // Which cleanup rule owns a snapshot is what decides when snapper
        // will take it away again, and it is the one thing about a row that
        // cannot be worked out by looking at it.
        if (showCleanup) {
            this.add_child(new St.Label({
                text: cleanupLabel(entry.cleanup),
                style_class: 'wisp-cleanup',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        this.add_child(new St.Label({
            text: dateStyle === 'absolute'
                ? Format.fullDate(entry.dateTime)
                : Format.ago(entry.dateTime),
            style_class: 'wisp-age',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        // Reactive, so the press lands on the button and not on the row: a
        // delete that also opened what it was deleting would be a poor button.
        this._delete = new St.Button({
            style_class: 'wisp-delete',
            child: new St.Icon({icon_name: 'window-close-symbolic'}),
            can_focus: true,
            reactive: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._delete.connect('clicked', () => this._onDelete());
        this.add_child(this._delete);

        // A delete button on every row is a column of them down the whole
        // list, each one two presses away from something that cannot be
        // undone. Only the row being pointed at or walked onto carries one.
        // Hover is bound to active, and taking the key focus sets it too, so
        // the pointer and the keyboard both arrive here. It goes invisible
        // rather than away: the space it takes is kept, so the columns do not
        // shift about as the pointer moves down the list.
        this._reveal(false);
        this.connect('notify::active', () => this._reveal(this.active));

        this._markFresh();
        this.connect('destroy', () => {
            if (this._freshId)
                GLib.source_remove(this._freshId);
            this._freshId = 0;
        });
    }

    /**
     * Marks a snapshot taken in the last couple of minutes, and takes the mark
     * off again once it is no longer true.
     *
     * The one worth pointing at in a list where every other row is a timeline
     * snapshot from hours back is the one that has just been made, and after
     * that it is an ordinary row like the rest.
     */
    _markFresh() {
        if (!this._entry.dateTime)
            return;

        const age = GLib.DateTime.new_now_local().difference(this._entry.dateTime) /
            GLib.TIME_SPAN_SECOND;
        if (age < 0 || age >= FRESH)
            return;

        this.add_style_class_name('wisp-fresh');
        this._freshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            Math.ceil(FRESH - age), () => {
                this._freshId = 0;
                this.remove_style_class_name('wisp-fresh');
                return GLib.SOURCE_REMOVE;
            });
    }

    /**
     * Shows or hides the delete button.
     *
     * An invisible button must not be clickable, or a press on empty space
     * would hit it, and must not be reachable by Tab either.
     *
     * @param {boolean} shown - whether this is the row being used
     */
    _reveal(shown) {
        this._delete.opacity = shown ? 255 : 0;
        this._delete.reactive = shown;
        this._delete.can_focus = shown;
    }

    /**
     * Asks, and then deletes. The button used to arm itself on the first press
     * and delete on the second, which is a question nobody could see being
     * asked: the icon changed, the pointer moved off the row, and it changed
     * back. A snapshot does not come back either, so it is worth a dialog that
     * says which snapshot and waits for an answer.
     */
    _onDelete() {
        const numbers = this._entry.numbers;

        // A modal dialog and an open popup menu cannot both have the pointer,
        // so the menu goes first.
        this._getTopMenu().close();

        new ConfirmDialog({
            title: numbers.length > 1
                ? _('Delete snapshots %d and %d?').format(...numbers)
                : _('Delete snapshot %d?').format(numbers[0]),
            description: [
                [
                    this._config,
                    Format.fullDate(this._entry.dateTime),
                    this._entry.description || _('no description'),
                ].join(' · '),
                _('There is no undoing this.'),
            ].join('\n'),
            confirmLabel: numbers.length > 1 ? _('Delete both') : _('Delete'),
            danger: true,
            onConfirm: () => this._delete_now(),
        }).open();
    }

    /**
     * @returns {void} nothing; what went wrong is said in a notification,
     *   since by this point the menu the row was in has been closed
     */
    _delete_now() {
        this._snapper.delete(this._config, this._entry.numbers)
            .catch(error => {
                Main.notifyError(_('Wisp'), isDenied(error)
                    ? _('Your account is not allowed to change the %s config.').format(this._config)
                    : error.message);
            });
    }

    activate(event) {
        // A modal dialog and an open popup menu cannot both have the pointer,
        // so the menu goes first.
        this._getTopMenu().close();
        new DetailsDialog(this._snapper, this._config, this._entry).open();
        super.activate(event);
    }
});

/**
 * The line a config's rows sit under: the name of the config, the rule that
 * separates it from the block above, and the offer to add one more snapshot
 * to it.
 *
 * The offer belongs up here rather than at the foot of the block because the
 * rows in between can be dozens deep, and a control at the foot of a list
 * that long is one that has to be scrolled back to.
 */
const ConfigHeader = GObject.registerClass({
    Signals: {'take': {}},
}, class ConfigHeader extends PopupMenu.PopupSeparatorMenuItem {
    _init(config, {takeable = true} = {}) {
        super._init(config);

        // Nothing to offer for a config whose snapshots this account cannot
        // even read: the row underneath is the offer of access instead.
        if (!takeable)
            return;

        this._take = pill(_('Take a snapshot'), 'list-add-symbolic',
            () => this.emit('take'));
        this.add_child(this._take);
    }
});

/**
 * The row that shows the rest of a config's snapshots, or puts them away
 * again.
 *
 * Activating a menu item closes the menu it sits in, which is right for every
 * other row here and wrong for this one: what the menu looks like afterwards
 * is the whole point of it. Closing is what the activate signal asks for, so
 * this row never emits it and says so in its own signal instead.
 */
const ExpandItem = GObject.registerClass({
    Signals: {'expand': {}},
}, class ExpandItem extends PopupMenu.PopupImageMenuItem {
    _init(...args) {
        super._init(...args);

        this._pending = 0;
        this.connect('destroy', () => {
            if (this._pending)
                GLib.source_remove(this._pending);
            this._pending = 0;
        });
    }

    activate(_event) {
        // Filling the list again is what this row is for, and doing it destroys
        // the row, which the click is not finished with: the gesture that
        // recognised it goes on to take the pressed look back off, and by then
        // the row it is written to has been disposed of. So the click is let go
        // of first. Switching the gesture off unpresses the row while it is
        // still there to be unpressed, and the refill waits for an idle below
        // anything the gesture may have queued for itself, whichever way round
        // the two would otherwise have run.
        if (this._pending)
            return;

        if (this._clickGesture)
            this._clickGesture.enabled = false;

        this._pending = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._pending = 0;
            this.emit('expand');
            return GLib.SOURCE_REMOVE;
        });
    }
});

/**
 * Takes a row out of every "this is the row that is lit up" the shell keeps.
 *
 * There is one of those on the section the row belongs to and one on each menu
 * above it. The shell clears the section's when the row is destroyed; the rest
 * it keeps in step through the signal a row emits when it stops being active,
 * and by the time the row is being destroyed that signal has already been
 * disconnected. So they are cleared here instead. Left alone, the next row to
 * light up asks the one before it to stop, and the one before it has been
 * disposed of.
 *
 * @param {PopupMenu.PopupBaseMenuItem} row - the row to be forgotten
 * @param {PopupMenu.PopupMenuBase[]} menus - the section and the menus above it
 */
function forgetActive(row, menus) {
    row.connect('destroy', () => {
        for (const menu of menus) {
            if (menu._activeMenuItem === row)
                menu._activeMenuItem = null;
        }
    });
}

/**
 * A line saying what is missing, with the command that would fix it. The
 * command is not run from here: installing a package is not something an
 * extension should be doing behind a menu, and a line that can be read before
 * it is pasted is the honest way round.
 */
const Advice = GObject.registerClass(
class Advice extends PopupMenu.PopupBaseMenuItem {
    _init(message, command) {
        super._init({reactive: command !== null, style_class: 'wisp-advice'});

        const box = new St.BoxLayout({
            ...VERTICAL,
            x_expand: true,
        });
        box.add_child(wrap(new St.Label({
            text: message,
            style_class: 'wisp-advice-text',
        })));

        if (command) {
            const line = wrap(new St.Label({text: command, style_class: 'wisp-command'}));
            line.clutter_text.selectable = true;
            box.add_child(line);
            box.add_child(new St.Label({
                text: _('Click to copy'),
                style_class: 'wisp-advice-hint',
            }));
        }

        this.add_child(box);
        this._command = command;
    }

    activate(event) {
        if (this._command) {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._command);
            Main.notify(_('Wisp'), _('Command copied.'));
        }
        super.activate(event);
    }
});

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, _('Wisp'));

        this.add_style_class_name('wisp-indicator');

        this._extension = extension;
        this._settings = extension.getSettings();
        this._snapper = new Snapper();
        this._lock = new Lock(this._settings);
        this._generation = 0;
        // How many rows a config is showing, where somebody has asked for
        // more than the setting. Cleared when the menu closes: asking for the
        // older snapshots is something done once, looking for a snapshot, and
        // not a setting the menu should remember.
        this._shown = new Map();

        this.add_child(new St.Icon({
            gicon: wispIcon(),
            style_class: 'system-status-icon',
        }));

        this._middleAt = 0;
        this.connect('button-press-event', (_actor, event) =>
            this._clicked(event.get_button())
                ? Clutter.EVENT_STOP
                : Clutter.EVENT_PROPAGATE);

        // From GNOME 49 the panel button opens its menu from a Clutter
        // gesture instead of from the press, and that gesture accepts any
        // button by default - so a middle click would open the menu before
        // this class ever heard about it. Told which button it is for, the
        // gesture cancels itself on the others and the press carries on to
        // the handler above, the way it did on every earlier shell.
        if (this._clickGesture?.set_required_button)
            this._clickGesture.set_required_button(Clutter.BUTTON_PRIMARY);
        else
            this._clickGesture?.connect('recognize', gesture =>
                this._clicked(gesture.get_button?.() ?? Clutter.BUTTON_PRIMARY));

        this._changedId = this._snapper.connect('changed', () => {
            // An open menu has to follow what happens while it is open: a
            // snapshot taken by the timer, or one deleted from another
            // program, should come and go in front of whoever is looking at
            // it.
            //
            // A shut menu is rebuilt on the way open, so there is nothing
            // worth doing for one here - building rows nobody is looking at
            // costs a round trip to snapperd every hour, and snapperd stops
            // itself when nothing asks it anything. The exception is an
            // indicator hidden for having nothing to show, where noticing
            // that it now has something is the only thing that brings it back.
            if (this.menu.isOpen || !this.visible)
                this._rebuild();
        });

        // A timeline snapshot, or one either side of a package transaction,
        // can reach the filesystem through libsnapper without snapperd being
        // the one that made it, and then there is no signal. Opening the menu
        // is the moment the list has to be right, so the list is fetched then.
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._rebuild();
            } else {
                this._shown.clear();
                this._lock.relock();
            }
        });

        this._settingIds = [];
        for (const key of ['snapshot-count', 'hidden-configs', 'date-style',
            'show-cleanup', 'indicator-visibility', 'lock']) {
            this._settingIds.push(this._settings.connect(`changed::${key}`,
                () => this._rebuild()));
        }

        this._rebuild();
    }

    /**
     * Builds the menu again, and keeps something in it whatever happens.
     *
     * A menu with no items in it cannot be opened at all: PopupMenu.open
     * gives up on an empty menu. So a build that dies halfway would leave a
     * panel button that does nothing at all until the next login, and the
     * one thing this must never do is throw its way out of the menu.
     */
    _rebuild() {
        this._build().catch(error => {
            logError(error, 'Wisp: cannot build the menu');
            try {
                this.menu.removeAll();
                this.menu.addMenuItem(new Advice(
                    _('Something went wrong while reading the snapshots.'),
                    'journalctl --user -b -g Wisp'));
                this._addSettings();
            } catch (worse) {
                logError(worse, 'Wisp: cannot even say what went wrong');
            }
        });
    }

    /**
     * Asks snapper what it has and turns the answer into menu items.
     *
     * Everything is fetched before anything is drawn. The menu has to be
     * emptied to be rebuilt, and it cannot be opened while it is empty, so
     * the window where it holds nothing is kept to the moment between the
     * last reply arriving and the new items going in.
     *
     * The fetching is asynchronous and the menu can be opened again while it
     * is in flight, so each pass takes a number and a pass that finds a newer
     * one has been overtaken and drops what it was building.
     */
    async _build() {
        const generation = ++this._generation;

        let details = [];
        try {
            details = await this._snapper.listConfigDetails();
        } catch (error) {
            logError(error, 'Wisp: cannot list configs');
        }
        if (generation !== this._generation)
            return;

        // ListConfigs answers anybody, so what a config was set to is known
        // even for one whose snapshots this account cannot read. That is what
        // makes the offer of access an informed one: the list it would be
        // added to is already in hand.
        this._values = new Map(details.map(({name, values}) => [name, values]));

        const configs = details.map(({name}) => name);
        // The snapshot directories are watched rather than only asked about:
        // the hourly snapshots and the ones taken around a package
        // transaction never go through snapperd, so its signals do not cover
        // them, and neither does anything another program deletes.
        this._snapper.watch(details);

        const problem = check(this._snapper, configs);
        this._usable = problem === null;
        this._applyVisibility();

        if (problem) {
            this.menu.removeAll();
            this.menu.addMenuItem(new Advice(problem.message, problem.command));
            this._addSettings();
            return;
        }

        // Locked, nothing is fetched at all: the list is not built and then
        // hidden, it is not asked for.
        if (this._lock.engaged) {
            this.menu.removeAll();
            const unlock = new PopupMenu.PopupImageMenuItem(
                _('Unlock to see the snapshots'), 'changes-prevent-symbolic');
            unlock.connect('activate', () => this._unlock());
            this.menu.addMenuItem(unlock);
            this._addSettings();
            return;
        }

        const hidden = this._settings.get_strv('hidden-configs');
        const shown = configs.filter(config => !hidden.includes(config));

        const listings = [];
        for (const config of shown) {
            try {
                listings.push({
                    config,
                    entries: await this._snapper.listSnapshots(config),
                });
            } catch (error) {
                listings.push({config, error});
            }
            if (generation !== this._generation)
                return;
        }

        this._first = shown[0] ?? null;

        this.menu.removeAll();

        // The list of snapshots is the one part of the menu that can outgrow
        // the screen. PanelMenu.Button caps the menu at the height of the work
        // area, and a capped menu can only give that height back if something
        // inside it is willing to be shorter than its contents; a scroll view
        // is. Settings is added after it, outside, so it cannot be scrolled
        // away from.
        const list = new PopupMenu.PopupMenuSection();
        const scroll = new St.ScrollView({
            style_class: 'wisp-list',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        scroll.set_child(list.box);
        // A section presents itself to the menu as its actor, and the menu
        // finds its way back through the actor's delegate. Swapping both makes
        // the scroll view the section, which keeps everything the menu does
        // with a section - the signals, the destroy - working as it is.
        list.actor = scroll;
        scroll._delegate = list;
        this.menu.addMenuItem(list);

        this._scroll = scroll;
        this._list = list;

        for (const {config, entries, error} of listings) {
            // A section of its own for each config, so that asking one of
            // them for its older snapshots can fill that section again and
            // leave the rest of the list - and where the list is scrolled
            // to - as it was.
            const part = new PopupMenu.PopupMenuSection();
            list.addMenuItem(part);
            this._fill(part, config, entries, error);
        }

        this._addSettings();
    }

    /**
     * One config's block of the list: its name, its rows, and whatever the
     * length of the list calls for underneath.
     *
     * @param {PopupMenu.PopupMenuSection} part - the config's own section
     * @param {string} config - the config being shown
     * @param {object[]} entries - what it holds, newest first
     * @param {?Error} error - why it could not be read, if it could not be
     */
    _fill(part, config, entries, error = null) {
        part.removeAll();

        const header = new ConfigHeader(config, {takeable: !error});
        header.connect('take', () => {
            this.menu.close();
            new CreateDialog(this._snapper, config).open();
        });
        part.addMenuItem(header);

        if (error)
            this._addLocked(part, config, error);
        else
            this._addSnapshots(part, config, entries);

        // Arrow keys walk the selection down the list, and a row below the
        // fold has to bring itself into view when it takes the focus, or the
        // selection carries on somewhere the eye cannot follow it. This is the
        // same helper, and the same signal, the shell scrolls its own search
        // results and notifications with. Hovering a row takes the key focus
        // as well - a menu item grabs it whenever it becomes active - and that
        // one must not scroll: the row is under the pointer, so it is in view
        // already, and scrolling it would slide the next row under a pointer
        // that never moved and set the list running on its own.
        const scroll = this._scroll;
        const menus = [part, this._list, this.menu];
        for (const row of part.box.get_children()) {
            forgetActive(row, menus);

            row.connect('key-focus-in', () => {
                if (row.hover)
                    return;
                ensureActorVisibleInScrollView(scroll, row);
            });
        }
    }

    /**
     * One config's worth of rows.
     *
     * A row is built from whatever snapper put in the snapshot, and a
     * snapshot with something strange in it should cost its own line and not
     * the rest of the menu, so each one is built on its own.
     *
     * @param {PopupMenu.PopupMenuSection} section - what to add the rows to
     * @param {string} config - the config the snapshots belong to
     * @param {object[]} entries - what it holds, newest first
     */
    _addSnapshots(section, config, entries) {
        if (entries.length === 0) {
            section.addMenuItem(new Advice(
                _('No snapshots of %s yet.').format(config), null));
        }

        const count = this._shown.get(config) ??
            this._settings.get_int('snapshot-count');
        const style = {
            dateStyle: this._settings.get_string('date-style'),
            showCleanup: this._settings.get_boolean('show-cleanup'),
        };
        for (const entry of entries.slice(0, count)) {
            try {
                section.addMenuItem(
                    new SnapshotItem(this._snapper, config, entry, style));
            } catch (error) {
                logError(error,
                    `Wisp: cannot show snapshot ${entry.number} of ${config}`);
            }
        }

        // Timeline snapshots are taken every hour, so a config holds more of
        // them than a menu should try to show. The ones left out are worth a
        // line of their own twice over: a list that stops at five without
        // saying so looks like a config holding nothing but those five, and
        // the line is how the rest of them are asked for.
        const rest = entries.length - count;
        if (rest > 0) {
            const more = new ExpandItem(
                ngettext('%d older snapshot', '%d older snapshots', rest).format(rest),
                'pan-down-symbolic');
            more.label.add_style_class_name('wisp-more');
            more.connect('expand', () => {
                this._shown.set(config, count + Math.min(rest, MORE));
                this._fill(section, config, entries);
            });
            section.addMenuItem(more);
        } else if (this._shown.has(config)) {
            const fewer = new ExpandItem(_('Show fewer'), 'pan-up-symbolic');
            fewer.label.add_style_class_name('wisp-more');
            fewer.connect('expand', () => {
                this._shown.delete(config);
                this._fill(section, config, entries);
            });
            section.addMenuItem(fewer);
        }
    }

    /**
     * What to show for a config the user has not been given. Every config
     * starts out this way: ALLOW_USERS is empty until somebody fills it in.
     *
     * @param {PopupMenu.PopupMenuSection} section - what to add the row to
     * @param {string} config - the config that was refused
     * @param {Error} error - what the refusal arrived as
     */
    _addLocked(section, config, error) {
        if (!isDenied(error)) {
            section.addMenuItem(new Advice(error.message, null));
            return;
        }

        const allowUsers = this._values?.get(config)?.['ALLOW_USERS'] ?? '';
        const users = allowUsers.split(' ').filter(name => name.length > 0);
        if (!users.includes(GLib.get_user_name()))
            users.push(GLib.get_user_name());

        if (!canAskForRoot()) {
            section.addMenuItem(new Advice(
                _('These snapshots belong to root.'),
                `sudo snapper -c ${config} set-config ALLOW_USERS='${users.join(' ')}' SYNC_ACL=yes`));
            return;
        }

        const item = new PopupMenu.PopupImageMenuItem(
            _('Give this account access…'), 'changes-allow-symbolic');
        item.connect('activate', () => {
            this.menu.close();
            requestAccess(config, {allowUsers, onGranted: () => this._rebuild()});
        });
        section.addMenuItem(item);
    }

    _addSettings() {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // The way out to the settings is the one thing down here that is not
        // about a snapshot, so it is a button on its own line rather than one
        // more row in the list. The colours come from the shell: .button
        // .default is the class its own theme fills in the accent colour, and
        // a shell too old to know that class paints an ordinary button, which
        // is still a button.
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'wisp-settings-row',
        });
        const button = new St.Button({
            style_class: 'button default wisp-settings',
            label: _('Settings'),
            can_focus: true,
            x_expand: true,
        });
        // A button is not a menu item, so nothing closes the menu for it, and
        // a settings window opening behind an open menu would be a window
        // nobody can see.
        button.connect('clicked', () => {
            this.menu.close();
            this._extension.openPreferences();
        });
        item.add_child(button);
        this.menu.addMenuItem(item);
    }

    /**
     * Asks polkit who is at the keyboard, and opens the menu again if it
     * liked the answer. The polkit dialog takes the focus and shuts the menu
     * on its way up, so there is nothing left to put the list into.
     */
    async _unlock() {
        this.menu.close();
        if (await this._lock.unlock())
            this.menu.open();
    }

    /**
     * Hides the indicator when there is nothing it could show, if that is
     * what it has been asked to do. It is only ever hidden, never destroyed:
     * snapper being installed, or answering, or given its first config is a
     * thing that happens while the session is running, and the indicator has
     * to be there to notice.
     */
    _applyVisibility() {
        this.visible = this._usable ||
            this._settings.get_string('indicator-visibility') === 'always';
    }

    /**
     * Middle click, wherever the shell delivered it from.
     *
     * On a shell where both the press and the gesture are heard, the second
     * of the two is the same click and not another one.
     *
     * @param {number} button - which button was pressed
     * @returns {boolean} whether it was dealt with here
     */
    _clicked(button) {
        if (button !== Clutter.BUTTON_MIDDLE)
            return false;

        const action = this._settings.get_string('middle-click');
        if (action === 'none')
            return false;

        // Whatever the gesture did with the menu, this click was not asking
        // for it. This happens before the check below because the two can
        // arrive either way round, and the one that arrives second is the one
        // that may have just opened the menu.
        this.menu.close();

        const now = GLib.get_monotonic_time();
        if (now - this._middleAt < DOUBLE_HEARD)
            return true;
        this._middleAt = now;

        switch (action) {
        case 'take-snapshot':
            if (this._first)
                new CreateDialog(this._snapper, this._first).open();
            break;
        case 'settings':
            this._extension.openPreferences();
            break;
        }
        return true;
    }

    destroy() {
        this._snapper.disconnect(this._changedId);
        for (const id of this._settingIds)
            this._settings.disconnect(id);
        this._settingIds = [];
        this._snapper.destroy();
        super.destroy();
    }
});

export default class WispExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._place();
        this._placeIds = ['panel-box', 'panel-index'].map(key =>
            this._settings.connect(`changed::${key}`, () => this._place()));
    }

    disable() {
        for (const id of this._placeIds)
            this._settings.disconnect(id);
        this._placeIds = [];
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
        Toast.destroy();
    }

    /**
     * Puts the indicator in the box it has been asked for. A button can only
     * be added to the panel once under one role, so moving it means building a
     * new one.
     */
    _place() {
        this._indicator?.destroy();
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator,
            this._settings.get_int('panel-index'),
            PANEL_BOXES[this._settings.get_enum('panel-box')]);
    }
}
