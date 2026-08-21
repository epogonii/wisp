// SPDX-License-Identifier: GPL-2.0-or-later

// The preferences window, which is also the place snapper itself gets set up.
//
// snapper's own settings live in root's files and its daemon refuses to change
// them for anybody else, so the usual way to reach them is a text editor and
// sudo. Everything they say, though, is readable without a password:
// ListConfigs hands out every config file to any caller that asks, systemd
// answers is-enabled for anybody, and btrfs writes its allocation into sysfs.
// So this window shows the whole picture for free and only asks for a password
// at the moment something is actually being changed - once per change, not
// once per keystroke, which is why the retention rows collect what they were
// told and wait for Apply.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Btrfs from './lib/btrfs.js';
import * as Configs from './lib/configs.js';
import * as Units from './lib/units.js';
import {commandLine, failure, have} from './lib/exec.js';
import {available as canLock} from './lib/authorization.js';
import {installCommand} from './lib/packages.js';

const PANEL_BOXES = ['left', 'center', 'right'];
const VISIBILITY = ['always', 'when-usable'];
const MIDDLE_CLICK = ['none', 'take-snapshot', 'settings'];
const DATE_STYLES = ['relative', 'absolute'];
const LOCKS = ['never', 'after-idle', 'always'];

const PROJECT_URL = 'https://github.com/epogonii/wisp';
const ISSUES_URL = 'https://github.com/epogonii/wisp/issues';
const SPONSORS_URL = 'https://github.com/sponsors/epogonii';
const PAYPAL_URL = 'https://www.paypal.com/paypalme/pogonii';
const WALLETS = [
    ['Bitcoin', '18KtJEw8gt2oyicszwMUkbAKMHHXS9nwKR'],
    ['Ethereum', '0x4f2fb6a154526a72d612afa2e3a8129e30ca0996'],
    ['Cardano', 'DdzFFzCqrhsmpnmUqivufj3TmDzksP4HKzcksRUNVr8xA4Gbj7PngV6TfkZuqUqeeKxp138t2Ftd1HypLFkUQ8F1hGtEmyhTP9VnZcUt'],
];

/**
 * @param {string} key - one of Configs.TIMELINE_LIMITS
 * @returns {string} how often that many are kept
 */
function timelineLabel(key) {
    switch (key) {
    case 'TIMELINE_LIMIT_HOURLY':
        return _('Hourly');
    case 'TIMELINE_LIMIT_DAILY':
        return _('Daily');
    case 'TIMELINE_LIMIT_WEEKLY':
        return _('Weekly');
    case 'TIMELINE_LIMIT_MONTHLY':
        return _('Monthly');
    case 'TIMELINE_LIMIT_QUARTERLY':
        return _('Quarterly');
    default:
        return _('Yearly');
    }
}

/**
 * @param {string} unit - one of Units.SNAPPER_TIMERS
 * @returns {{title: string, subtitle: string}} what it does, in a sentence
 */
function timerLabel(unit) {
    switch (unit) {
    case Units.TIMELINE:
        return {
            title: _('Take timeline snapshots'),
            subtitle: _('One an hour, for every config with the timeline switched on'),
        };
    case Units.CLEANUP:
        return {
            title: _('Clear out old snapshots'),
            subtitle: _('Applies the limits below. Without this they are only ever counted, never enforced'),
        };
    default:
        return {
            title: _('Snapshot at boot'),
            subtitle: _('One taken the first time the machine comes up each day'),
        };
    }
}

/**
 * @param {string} key - one of the BTRFS_*_PERIOD keys
 * @returns {{title: string, subtitle: string}} what the job is for
 */
function jobLabel(key) {
    switch (key) {
    case 'BTRFS_BALANCE_PERIOD':
        return {
            title: _('Balance'),
            subtitle: _('Packs half-empty chunks together and hands the room back'),
        };
    case 'BTRFS_SCRUB_PERIOD':
        return {
            title: _('Scrub'),
            subtitle: _('Reads everything back and checks it against its checksums'),
        };
    case 'BTRFS_DEFRAG_PERIOD':
        return {
            title: _('Defragment'),
            subtitle: _('Rewrites scattered files. Costs space where snapshots share their blocks'),
        };
    default:
        return {
            title: _('Trim'),
            subtitle: _('Tells an SSD which blocks are no longer in use'),
        };
    }
}

/**
 * @param {string} period - a value of one of the BTRFS_*_PERIOD keys
 * @returns {number} which of Btrfs.PERIODS it is, or the length of that list
 *   when it is something systemd understands and this window does not
 */
function periodIndex(period) {
    const known = Btrfs.PERIODS.indexOf(period);
    return known === -1 ? Btrfs.PERIODS.length : known;
}

// What snapper is willing to call a config, and what stays a file name and
// not a path once it is written under /etc/snapper/configs.
const CONFIG_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * A row of buttons at the foot of a group: what has been changed but not yet
 * written, with the two ways of writing it.
 *
 * Nothing here writes as it is typed. snapper refuses every change to a
 * config for anyone but root, so each write is a password, and a spin button
 * held down would be a password a second. What the rows do instead is
 * remember, and this is where the remembering is spent.
 */
const ApplyRow = GObject.registerClass(
class ApplyRow extends Adw.ActionRow {
    _init({onApply, onRevert, onCopy}) {
        super._init({title: _('Not saved yet')});

        this._copy = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            tooltip_text: _('Copy the command that would do this'),
            valign: Gtk.Align.CENTER,
        });
        this._copy.connect('clicked', () => onCopy());
        this.add_suffix(this._copy);

        this._revert = new Gtk.Button({
            label: _('Revert'),
            valign: Gtk.Align.CENTER,
        });
        this._revert.connect('clicked', () => onRevert());
        this.add_suffix(this._revert);

        this._apply = new Gtk.Button({
            label: _('Apply'),
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        this._apply.connect('clicked', () => onApply());
        this.add_suffix(this._apply);

        this.visible = false;
    }

    /**
     * @param {string[]} keys - what has been changed and not written
     */
    update(keys) {
        this.visible = keys.length > 0;
        this.subtitle = keys.length > 0
            // Translators: the list is snapper's own setting names.
            ? _('Needs administrator rights: %s').format(keys.join(', '))
            : '';
    }

    set busy(busy) {
        this._apply.sensitive = !busy;
        this._revert.sensitive = !busy;
        this._copy.sensitive = !busy;
    }
});

/**
 * One snapper config: what it takes snapshots of, who may use it, how many of
 * them it keeps, and the way to be rid of it.
 */
const ConfigRow = GObject.registerClass(
class ConfigRow extends Adw.ExpanderRow {
    _init({config, settings, window, onChanged}) {
        super._init({
            title: config.name,
            subtitle: config.subvolume,
        });

        this._config = config;
        this._settings = settings;
        this._window = window;
        this._onChanged = onChanged;
        this._dirty = new Map();
        this._widgets = [];
        this._loading = true;

        this._addVisibility();
        this._addAccess();
        this._addTimeline();
        this._addNumber();

        this._apply = new ApplyRow({
            onApply: () => this._write(),
            onRevert: () => this._revert(),
            onCopy: () => this._copy(),
        });
        this.add_row(this._apply);

        this._addDelete();

        this._loading = false;
    }

    /** Whether the config shows up in the menu at all. This one is ours to
     *  set, not snapper's, so it is written the moment it is switched. */
    _addVisibility() {
        const row = new Adw.SwitchRow({
            title: _('Show in the menu'),
            active: !this._settings.get_strv('hidden-configs').includes(this._config.name),
        });
        row.connect('notify::active', () => {
            const hidden = this._settings.get_strv('hidden-configs')
                .filter(name => name !== this._config.name);
            if (!row.active)
                hidden.push(this._config.name);
            this._settings.set_strv('hidden-configs', hidden);
        });
        this.add_row(row);
    }

    /**
     * Who snapper lets near this config. Being on the list is what buys the
     * right to list, take and delete snapshots without a password every time,
     * so an account that is not on it is the one thing worth offering to fix
     * from here.
     */
    _addAccess() {
        const {values} = this._config;
        const users = Configs.allowedUsers(values['ALLOW_USERS']);
        const groups = Configs.allowedUsers(values['ALLOW_GROUPS']);
        const me = GLib.get_user_name();
        const mine = users.includes(me);

        const parts = [];
        if (users.length > 0)
            parts.push(_('Accounts: %s').format(users.join(', ')));
        if (groups.length > 0)
            parts.push(_('Groups: %s').format(groups.join(', ')));

        const row = new Adw.ActionRow({
            title: mine ? _('This account may use it') : _('Root only'),
            subtitle: parts.length > 0
                ? parts.join(' · ')
                : _('Nobody but root is named in ALLOW_USERS, so nothing here is readable without a password'),
        });
        row.add_prefix(new Gtk.Image({
            icon_name: mine ? 'changes-allow-symbolic' : 'changes-prevent-symbolic',
        }));

        if (!mine) {
            const button = new Gtk.Button({
                label: _('Add This Account'),
                valign: Gtk.Align.CENTER,
            });
            button.connect('clicked', () => {
                this._set('ALLOW_USERS', Configs.withUser(values['ALLOW_USERS']));
                this._set('SYNC_ACL', 'yes');
                button.sensitive = false;
            });
            row.add_suffix(button);
        }

        this.add_row(row);
    }

    /** The hourly snapshots, and how many of each age survive. */
    _addTimeline() {
        const {values} = this._config;

        const timeline = new Adw.SwitchRow({
            title: _('Timeline snapshots'),
            subtitle: _('One an hour, thinned out as they age'),
            active: values['TIMELINE_CREATE'] === 'yes',
        });
        timeline.connect('notify::active', () =>
            this._set('TIMELINE_CREATE', timeline.active ? 'yes' : 'no'));
        this.add_row(timeline);
        this._widgets.push(['TIMELINE_CREATE', timeline, 'active',
            v => v === 'yes']);

        for (const key of Configs.TIMELINE_LIMITS) {
            const row = this._numberRow(timelineLabel(key), null, key, 0, 9999);
            if (row)
                timeline.bind_property('active', row, 'sensitive',
                    GObject.BindingFlags.SYNC_CREATE);
        }
    }

    /** The set kept by count rather than by age, which is what the snapshots
     *  taken around a package transaction belong to. */
    _addNumber() {
        const {values} = this._config;

        const cleanup = new Adw.SwitchRow({
            title: _('Keep a fixed number'),
            subtitle: _('For the pairs taken around installs and upgrades'),
            active: values['NUMBER_CLEANUP'] === 'yes',
        });
        cleanup.connect('notify::active', () =>
            this._set('NUMBER_CLEANUP', cleanup.active ? 'yes' : 'no'));
        this.add_row(cleanup);
        this._widgets.push(['NUMBER_CLEANUP', cleanup, 'active', v => v === 'yes']);

        for (const [key, title, subtitle] of [
            ['NUMBER_LIMIT', _('Keep'), _('How many of them survive the cleanup')],
            ['NUMBER_LIMIT_IMPORTANT', _('Keep marked important'),
                _('Counted separately, so a starred snapshot is not pushed out by ordinary ones')],
        ]) {
            const row = this._numberRow(title, subtitle, key, 0, 9999);
            if (row)
                cleanup.bind_property('active', row, 'sensitive',
                    GObject.BindingFlags.SYNC_CREATE);
        }
    }

    /**
     * A spin row for a key that holds a number - and a plain line for one
     * that does not.
     *
     * NUMBER_LIMIT is allowed to say "2-10", meaning a range snapper narrows
     * as the filesystem fills up. A spin button cannot hold that, and rounding
     * it to one of the two ends would quietly throw away a setting somebody
     * chose on purpose, so a value this window cannot represent is shown and
     * left alone.
     *
     * @param {string} title - what the row is called
     * @param {string|null} subtitle - the sentence under it, if any
     * @param {string} key - snapper's own name for it
     * @param {number} lower - smallest allowed
     * @param {number} upper - largest allowed
     * @returns {Adw.SpinRow|null} the row, when it turned out to be editable
     */
    _numberRow(title, subtitle, key, lower, upper) {
        const raw = this._config.values[key] ?? '';
        const asNumber = /^\d+$/.test(raw.trim())
            ? Number.parseInt(raw, 10)
            : null;

        if (asNumber === null) {
            const row = new Adw.ActionRow({
                title,
                subtitle: _('Set to %s, which this window leaves as it is').format(raw || '-'),
            });
            row.add_suffix(new Gtk.Label({
                label: raw || '-',
                css_classes: ['dim-label', 'numeric'],
            }));
            this.add_row(row);
            return null;
        }

        const row = new Adw.SpinRow({
            title,
            subtitle: subtitle ?? '',
            adjustment: new Gtk.Adjustment({
                lower,
                upper,
                step_increment: 1,
                page_increment: 10,
                value: asNumber,
            }),
        });
        row.connect('notify::value', () => this._set(key, String(row.value)));
        this.add_row(row);
        this._widgets.push([key, row, 'value', v => Number.parseInt(v, 10) || 0]);
        return row;
    }

    /** The one thing here that cannot be taken back. */
    _addDelete() {
        // destructive-action paints a button and nothing else, so what wears
        // the class is a button. Adw.ButtonRow would carry one in a single
        // line, but it arrived in libadwaita 1.6 and the oldest GNOME this
        // extension supports ships 1.4.
        const button = new Gtk.Button({
            label: _('Delete this config…'),
            css_classes: ['destructive-action', 'pill'],
            halign: Gtk.Align.CENTER,
            margin_top: 6,
            margin_bottom: 6,
        });
        button.connect('clicked', () => this._confirmDelete());

        this.add_row(new Adw.PreferencesRow({
            activatable: false,
            selectable: false,
            focusable: false,
            child: button,
        }));
    }

    _confirmDelete() {
        const dialog = new Adw.AlertDialog({
            heading: _('Delete the %s config?').format(this._config.name),
            body: _('This removes the config and the .snapshots subvolume it keeps, and every snapshot in it. %s itself is left alone. None of it can be undone.').format(this._config.subvolume),
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('delete', _('Delete'));
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');

        dialog.connect('response', (_dialog, response) => {
            if (response === 'delete')
                this._delete();
        });
        dialog.present(this._window);
    }

    async _delete() {
        const result = await Configs.deleteConfig(this._config.name);
        const said = failure(result);
        if (said) {
            this._toast(said);
            return;
        }
        if (result.status === 0)
            this._onChanged();
    }

    /**
     * Remembers a change without writing it.
     *
     * @param {string} key - snapper's own name for it
     * @param {string} value - what it should become
     */
    _set(key, value) {
        if (this._loading)
            return;

        if ((this._config.values[key] ?? '') === value)
            this._dirty.delete(key);
        else
            this._dirty.set(key, value);

        this._apply.update([...this._dirty.keys()]);
    }

    /** Puts every row back to what the config file still says. */
    _revert() {
        this._loading = true;
        for (const [key, widget, property, parse] of this._widgets)
            widget[property] = parse(this._config.values[key] ?? '');
        this._loading = false;

        this._dirty.clear();
        this._apply.update([]);
    }

    _copy() {
        const argv = Configs.setConfigArgv(this._config.name,
            Object.fromEntries(this._dirty));
        this._window.get_clipboard().set(commandLine(argv));
        this._toast(_('Command copied. It does the same thing as Apply.'));
    }

    async _write() {
        const values = Object.fromEntries(this._dirty);

        this._apply.busy = true;
        const result = await Configs.setConfig(this._config.name, values);
        this._apply.busy = false;

        const said = failure(result);
        if (said) {
            this._toast(said);
            return;
        }
        if (result.status !== 0)
            return;

        // What was asked for is now what the file says, so the rows are
        // already right and only the record of what is unsaved has to catch up.
        Object.assign(this._config.values, values);
        this._dirty.clear();
        this._apply.update([]);
        this._toast(_('Saved to %s.').format(`/etc/snapper/configs/${this._config.name}`));
    }

    _toast(message) {
        this._window.add_toast?.(new Adw.Toast({title: message, timeout: 6}));
    }
});

export default class WispPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings();
        this._window = window;

        window.add(this._appearancePage());

        this._configsPage = new Adw.PreferencesPage({
            title: _('Snapshots'),
            icon_name: 'document-open-recent-symbolic',
        });
        window.add(this._configsPage);

        this._schedulePage = new Adw.PreferencesPage({
            title: _('Schedule'),
            icon_name: 'alarm-symbolic',
        });
        window.add(this._schedulePage);

        this._storagePage = new Adw.PreferencesPage({
            title: _('Storage'),
            icon_name: 'drive-harddisk-symbolic',
        });
        window.add(this._storagePage);
        window.add(this._aboutPage());

        this._reload();
    }

    /** Everything that is the extension's own business rather than snapper's. */
    _appearancePage() {
        const settings = this._settings;
        const page = new Adw.PreferencesPage({
            title: _('Appearance'),
            icon_name: 'preferences-desktop-appearance-symbolic',
        });

        const panel = new Adw.PreferencesGroup({title: _('Panel')});
        page.add(panel);

        panel.add(this._combo({
            title: _('Position'),
            subtitle: _('Which end of the top bar the indicator sits at'),
            labels: [_('Left'), _('Centre'), _('Right')],
            key: 'panel-box',
            values: PANEL_BOXES,
        }));

        const index = new Adw.SpinRow({
            title: _('Place'),
            subtitle: _('Counted from that end. Zero is outermost'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 20,
                step_increment: 1,
                value: settings.get_int('panel-index'),
            }),
        });
        index.connect('notify::value', () =>
            settings.set_int('panel-index', index.value));
        panel.add(index);

        panel.add(this._combo({
            title: _('Show the indicator'),
            subtitle: _('Hidden when unusable, it comes back as soon as snapper does'),
            labels: [_('Always'), _('Only when snapper is set up')],
            key: 'indicator-visibility',
            values: VISIBILITY,
        }));

        panel.add(this._combo({
            title: _('Middle click'),
            subtitle: _('Uses the first config shown in the menu'),
            labels: [_('Nothing'), _('Take a snapshot'), _('Open these settings')],
            key: 'middle-click',
            values: MIDDLE_CLICK,
        }));

        const menu = new Adw.PreferencesGroup({title: _('Menu')});
        page.add(menu);

        const count = new Adw.SpinRow({
            title: _('Snapshots listed'),
            subtitle: _('How many of the newest each config shows'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 50,
                step_increment: 1,
                value: settings.get_int('snapshot-count'),
            }),
        });
        count.connect('notify::value', () =>
            settings.set_int('snapshot-count', count.value));
        menu.add(count);

        menu.add(this._combo({
            title: _('Dates'),
            subtitle: _('An age reads faster; a date and time is what matches a snapshot against something else'),
            labels: [_('How long ago'), _('Date and time')],
            key: 'date-style',
            values: DATE_STYLES,
        }));

        const cleanup = new Adw.SwitchRow({
            title: _('Show the cleanup rule'),
            subtitle: _('What decides when snapper removes each snapshot on its own'),
            active: settings.get_boolean('show-cleanup'),
        });
        cleanup.connect('notify::active', () =>
            settings.set_boolean('show-cleanup', cleanup.active));
        menu.add(cleanup);

        const protection = new Adw.PreferencesGroup({
            title: _('Lock'),
            description: _('Being allowed to read a config is granted once and belongs to the account from then on, so nothing here can take that back. What it can do is put a lock in front of the menu, asked for by polkit - the same password, or the same finger, that authorising anything else on this machine takes.'),
        });
        page.add(protection);

        const lock = this._combo({
            title: _('Ask before showing the list'),
            subtitle: _('Locked, nothing is read at all until it is unlocked'),
            labels: [_('Never'), _('When it has been a while'), _('Every time')],
            key: 'lock',
            values: LOCKS,
        });
        protection.add(lock);

        const timeout = new Adw.SpinRow({
            title: _('Ask again after'),
            subtitle: _('Minutes since it was last unlocked'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 240,
                step_increment: 1,
                page_increment: 15,
                value: settings.get_int('lock-timeout'),
            }),
        });
        timeout.connect('notify::value', () =>
            settings.set_int('lock-timeout', timeout.value));
        protection.add(timeout);

        const followLock = () => {
            timeout.sensitive = settings.get_string('lock') === 'after-idle';
        };
        followLock();
        settings.connect('changed::lock', followLock);

        // The lock is a polkit check and nothing else. Without polkit's
        // command line tools there is nothing to ask with, so rather than
        // offer a setting that would do nothing, the group says why.
        if (!canLock()) {
            protection.description = _('Not available here: this needs pkcheck, from polkit. Install polkit and the lock can be switched on.');
            lock.sensitive = false;
            timeout.sensitive = false;
        }

        return page;
    }

    /**
     * @param {object} options - what the row is for
     * @param {string} options.title - the row's name
     * @param {string} options.subtitle - the sentence under it
     * @param {string[]} options.labels - what to show, in order
     * @param {string} options.key - the setting behind it
     * @param {string[]} options.values - the setting's own words, same order
     * @returns {Adw.ComboRow} the row, already wired up
     */
    _combo({title, subtitle, labels, key, values}) {
        const row = new Adw.ComboRow({
            title,
            subtitle,
            model: new Gtk.StringList({strings: labels}),
            selected: Math.max(0, values.indexOf(this._settings.get_string(key))),
        });
        row.connect('notify::selected', () =>
            this._settings.set_string(key, values[row.selected]));
        return row;
    }

    /** Reads everything again and rebuilds the pages that came from it. */
    /**
     * Where the extension came from, and a place to say thanks from. Nothing on
     * this page has anything to do with the extension working, and nothing on
     * it asks for anything.
     */
    _aboutPage() {
        const page = new Adw.PreferencesPage({
            title: _('About'),
            icon_name: 'help-about-symbolic',
        });

        const about = new Adw.PreferencesGroup({
            title: _('Wisp %s').format(this.metadata['version-name'] ?? ''),
            description: _('Snapper snapshots, from the top bar'),
        });
        page.add(about);
        about.add(this._linkRow(_('Project page'), PROJECT_URL, PROJECT_URL));
        about.add(this._linkRow(_('Report a problem'),
            _('Whatever it does that it should not'), ISSUES_URL));

        const support = new Adw.PreferencesGroup({
            title: _('Support'),
            description: _('The extension is free and stays free. If it earned a coffee ☕'),
        });
        page.add(support);
        support.add(this._linkRow(_('GitHub Sponsors'),
            _('Monthly or one time'), SPONSORS_URL));
        support.add(this._linkRow(_('PayPal'), PAYPAL_URL, PAYPAL_URL));

        for (const [name, address] of WALLETS) {
            const row = new Adw.ActionRow({
                title: name,
                subtitle: address,
                subtitle_selectable: true,
            });

            const copy = new Gtk.Button({
                icon_name: 'edit-copy-symbolic',
                tooltip_text: _('Copy the address'),
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            copy.connect('clicked', () => {
                this._clipboard(address);
                this._toast(_('%s address copied').format(name));
            });
            row.add_suffix(copy);
            support.add(row);
        }

        return page;
    }

    /**
     * A row that opens something in a browser.
     *
     * @param {string} title - what it is
     * @param {string} subtitle - the line under it, often the address itself
     * @param {string} url - where it goes
     * @returns {Adw.ActionRow} the row
     */
    _linkRow(title, subtitle, url) {
        const row = new Adw.ActionRow({title, subtitle, activatable: true});
        row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        row.connect('activated', () =>
            Gio.AppInfo.launch_default_for_uri(url, null));
        return row;
    }

    /**
     * Puts text on the clipboard. Gdk wants a GValue for that rather than a
     * string.
     *
     * @param {string} text - what to copy
     */
    _clipboard(text) {
        const value = new GObject.Value();
        value.init(GObject.TYPE_STRING);
        value.set_string(text);
        Gdk.Display.get_default()?.get_clipboard().set_value(value);
    }

    _reload() {
        this._fillConfigs().catch(error => this._failed(this._configsPage, error));
        this._fillSchedule().catch(error => this._failed(this._schedulePage, error));
        this._fillStorage().catch(error => this._failed(this._storagePage, error));
    }

    /**
     * @param {Adw.PreferencesPage} page - the page that has nothing to show
     * @param {Error} error - why
     */
    _failed(page, error) {
        const group = new Adw.PreferencesGroup();
        group.add(new Adw.ActionRow({
            title: _('Could not read this'),
            subtitle: error.message,
        }));
        page.add(group);
    }

    /**
     * @param {Adw.PreferencesPage} page - the page to empty
     */
    _clear(page) {
        let child = page.get_first_child();
        const groups = [];
        // The page keeps its groups inside a scrolled box rather than as
        // children of its own, so they are collected by walking what Adw made
        // rather than by asking the page.
        const walk = widget => {
            for (let w = widget.get_first_child(); w; w = w.get_next_sibling()) {
                if (w instanceof Adw.PreferencesGroup)
                    groups.push(w);
                else
                    walk(w);
            }
        };
        while (child) {
            walk(child);
            child = child.get_next_sibling();
        }
        for (const group of groups)
            page.remove(group);
    }

    async _fillConfigs() {
        this._clear(this._configsPage);

        // Without snapper there is nothing on this page to read or to change,
        // and a page that said no configs were set up would be blaming the
        // wrong thing.
        if (!GLib.find_program_in_path('snapper')) {
            this._configsPage.add(this._absent(_('snapper is not installed'),
                _('Wisp manages the snapshots snapper takes, and there is no snapper on this system taking any. Everything in this window waits on it.'),
                'snapper'));
            return;
        }

        const configs = await Configs.listConfigs();

        const group = new Adw.PreferencesGroup({
            title: _('Configs'),
            description: _('One config per subvolume, kept in /etc/snapper/configs. Everything here is readable without a password; changing it is root’s, so changes wait for Apply and go out together.'),
        });

        const add = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: _('Set up a new config'),
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        add.connect('clicked', () => this._newConfig());
        group.set_header_suffix(add);
        this._configsPage.add(group);

        if (configs.length === 0) {
            group.add(new Adw.ActionRow({
                title: _('snapper has no configs yet'),
                subtitle: _('Nothing is being snapshotted. The button above sets the first one up'),
            }));
            return;
        }

        for (const config of configs) {
            group.add(new ConfigRow({
                config,
                settings: this._settings,
                window: this._window,
                onChanged: () => this._reload(),
            }));
        }
    }

    /** Asks for a name and a path, and lets snapper judge the path. */
    _newConfig() {
        const name = new Adw.EntryRow({title: _('Name')});
        const path = new Adw.EntryRow({
            title: _('Subvolume'),
            text: '/',
        });
        const browse = new Gtk.Button({
            icon_name: 'folder-open-symbolic',
            tooltip_text: _('Pick a folder'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        browse.connect('clicked', () => this._pickSubvolume(path));
        path.add_suffix(browse);

        const group = new Adw.PreferencesGroup();
        group.add(name);
        group.add(path);

        const dialog = new Adw.AlertDialog({
            heading: _('New config'),
            body: _('snapper takes snapshots of one subvolume per config, and keeps them in a .snapshots subvolume it makes underneath it.'),
            extra_child: group,
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('create', _('Create'));
        dialog.set_response_appearance('create', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response('create');
        dialog.set_close_response('cancel');

        dialog.connect('response', (_dialog, response) => {
            if (response !== 'create')
                return;
            const chosen = name.text.trim();
            const where = path.text.trim();
            if (chosen.length === 0 || where.length === 0)
                return;
            // The name becomes a file name under /etc/snapper/configs, so it
            // is checked here rather than trusted to snapper: a name with a
            // slash or a leading dot in it would be a path, and this window
            // has no business writing one.
            if (!CONFIG_NAME.test(chosen)) {
                this._toast(_('A config name can hold letters, digits, dots, dashes and underscores.'));
                return;
            }
            this._createConfig(chosen, where);
        });
        dialog.present(this._window);
    }

    /**
     * Fills the subvolume field in from a folder picked on disk.
     *
     * Typing stays the quicker way in for the few paths worth a config, and
     * the picker is for every path that has to be found first.
     *
     * @param {Adw.EntryRow} row - the field to write the choice into
     */
    _pickSubvolume(row) {
        const dialog = new Gtk.FileDialog({
            title: _('Pick a subvolume'),
            modal: true,
        });

        const typed = Gio.File.new_for_path(row.text.trim() || '/');
        if (typed.query_exists(null))
            dialog.initial_folder = typed;

        dialog.select_folder(this._window, null, (self, result) => {
            let folder = null;
            try {
                folder = self.select_folder_finish(result);
            } catch {
                // Closing the picker without choosing anything ends up here,
                // and leaving the field as it was is the right answer to it.
                return;
            }
            if (folder)
                row.text = folder.get_path();
        });
    }

    async _createConfig(name, subvolume) {
        const result = await Configs.createConfig(name, subvolume);
        const said = failure(result);
        if (said) {
            this._toast(said);
            return;
        }
        if (result.status !== 0)
            return;

        this._toast(_('%s set up. Nothing has been snapshotted yet.').format(name));
        this._reload();
    }

    /** The timers that make snapper act on its own, and the housekeeping the
     *  filesystem underneath is scheduled for. */
    async _fillSchedule() {
        this._clear(this._schedulePage);

        const group = new Adw.PreferencesGroup({
            title: _('snapper'),
            description: _('snapper does nothing on a schedule by itself. These are the timers that make it, and the limits on the previous page are only enforced while the second one runs.'),
        });
        this._schedulePage.add(group);

        for (const unit of Units.SNAPPER_TIMERS) {
            const {enabled, known, state} = await Units.state(unit);
            const {title, subtitle} = timerLabel(unit);

            if (!known) {
                group.add(new Adw.ActionRow({
                    title,
                    subtitle: _('%s is not installed on this system').format(unit),
                }));
                continue;
            }

            const row = new Adw.SwitchRow({title, subtitle, active: enabled});
            if (state === 'static') {
                row.sensitive = false;
                row.subtitle = _('%s is always on: the package does not let it be switched off').format(unit);
            }
            row.connect('notify::active', () => this._toggle(unit, row));
            group.add(row);
        }

        const maintenance = Btrfs.maintenance();
        if (!maintenance) {
            this._schedulePage.add(this._absent(_('Filesystem upkeep'),
                _('Scrub, balance, defrag and trim are kept by btrfsmaintenance, which is a separate package and is not installed. snapper does not need it; these settings are all it would add.'),
                'btrfsmaintenance'));
            return;
        }

        const upkeep = new Adw.PreferencesGroup({
            title: _('Filesystem upkeep'),
            description: _('btrfsmaintenance keeps these, not snapper. Each one takes hours and runs in the background; how often is all there is to decide.'),
        });
        this._schedulePage.add(upkeep);

        const pending = new Map();
        const apply = new ApplyRow({
            onApply: async () => {
                const values = Object.fromEntries(pending);
                apply.busy = true;
                const result = await Btrfs.setMaintenance(values);
                apply.busy = false;
                const said = failure(result);
                if (said) {
                    this._toast(said);
                    return;
                }
                if (result.status !== 0)
                    return;
                pending.clear();
                apply.update([]);
                this._toast(_('Saved. The timers are rebuilt from the file on their own.'));
            },
            onRevert: () => this._reload(),
            onCopy: () => {
                this._window.get_clipboard().set(
                    commandLine(Btrfs.setMaintenanceArgv(Object.fromEntries(pending))));
                this._toast(_('Command copied. It does the same thing as Apply.'));
            },
        });

        const labels = [_('Never'), _('Daily'), _('Weekly'), _('Monthly')];
        for (const {key} of Btrfs.JOBS) {
            const current = maintenance[key] ?? 'none';
            const {title, subtitle} = jobLabel(key);
            const index = periodIndex(current);

            // A frequency the file spells in systemd's own calendar syntax is
            // something somebody wrote on purpose. It is shown as it stands
            // and the row is left alone.
            if (index === Btrfs.PERIODS.length) {
                upkeep.add(new Adw.ActionRow({
                    title,
                    subtitle: _('Set to %s, which this window leaves as it is').format(current),
                }));
                continue;
            }

            const row = new Adw.ComboRow({
                title,
                subtitle,
                model: new Gtk.StringList({strings: labels}),
                selected: index,
            });
            row.connect('notify::selected', () => {
                const chosen = Btrfs.PERIODS[row.selected];
                if (chosen === current)
                    pending.delete(key);
                else
                    pending.set(key, chosen);
                apply.update([...pending.keys()]);
            });
            upkeep.add(row);
        }

        upkeep.add(apply);
    }

    /**
     * @param {string} unit - the timer being switched
     * @param {Adw.SwitchRow} row - the row it was switched from
     */
    async _toggle(unit, row) {
        row.sensitive = false;
        const result = await Units.setEnabled(unit, row.active);
        row.sensitive = true;

        const said = failure(result);
        if (said)
            this._toast(said);

        // Whether it worked or not, the switch has to end up showing what
        // systemd actually says rather than what it was clicked to.
        const {enabled} = await Units.state(unit);
        if (row.active !== enabled) {
            row.freeze_notify();
            row.active = enabled;
            row.thaw_notify();
        }
    }

    /** What the snapshots are stored on, since that is what runs out. */
    async _fillStorage() {
        this._clear(this._storagePage);

        const configs = await Configs.listConfigs().catch(() => []);

        // One panel per filesystem, named after every config that lives on it.
        // Which filesystem a config is on is a question for its subvolume
        // rather than for the look of its path: / and /home are usually two
        // subvolumes of one btrfs, and one filesystem's figures said twice
        // would be two panels saying the same thing.
        const found = new Map();
        const add = async (path, name = null) => {
            const fs = await Btrfs.usage(path);
            if (!fs)
                return;

            if (!found.has(fs.uuid))
                found.set(fs.uuid, {path, fs, names: []});

            const panel = found.get(fs.uuid);
            if (name && !panel.names.includes(name))
                panel.names.push(name);
        };

        // The root filesystem first, so that it is the one whose path names the
        // panel even where no config sits directly on it.
        await add('/');
        for (const {name, subvolume} of configs)
            await add(subvolume, name);

        for (const {path, fs, names} of found.values())
            this._storagePage.add(this._storageGroup(path, fs, names));

        if (found.size === 0) {
            const group = new Adw.PreferencesGroup();
            // Not being on btrfs and not being able to find out are different
            // answers, and the second one is a missing package rather than a
            // fact about the disk.
            group.add(new Adw.ActionRow(have('findmnt') ? {
                title: _('Nothing here is on btrfs'),
                subtitle: _('snapper can drive LVM thin volumes too, and this page only knows how to read btrfs'),
            } : {
                title: _('Cannot tell what this is on'),
                subtitle: _('findmnt, from util-linux, is what this page asks, and it is not installed'),
            }));
            this._storagePage.add(group);
        }
    }

    /**
     * @param {string} path - somewhere on the filesystem
     * @param {object} fs - what Btrfs.usage found
     * @param {string[]} names - the configs living on it
     * @returns {Adw.PreferencesGroup} one filesystem, described
     */
    _storageGroup(path, fs, names) {
        const group = new Adw.PreferencesGroup({
            title: names.length > 0
                ? _('%s - %s').format(path, names.join(', '))
                : path,
            description: fs.uuid,
        });

        group.add(this._reading(_('Size'), Btrfs.size(fs.size)));
        group.add(this._reading(_('Handed out to chunks'), Btrfs.size(fs.allocated)));
        group.add(this._reading(_('Written'), Btrfs.size(fs.used)));
        // btrfs can hand out more chunks as long as there is unallocated room
        // left, so what is actually free is everything nothing has written to
        // yet, whether it has been handed out or not.
        group.add(this._reading(_('Free'), Btrfs.size(fs.size - fs.used)));

        // Data and metadata run out separately, and a filesystem out of
        // metadata room stops accepting writes while its data bar still looks
        // half empty. Which is the number worth showing to somebody whose
        // snapshots are what filled it.
        for (const chunk of Btrfs.CHUNKS) {
            const {total, used} = fs.chunks[chunk];
            if (!total)
                continue;

            const row = new Adw.ActionRow({
                title: chunk === 'data'
                    ? _('Data')
                    : chunk === 'metadata' ? _('Metadata') : _('System'),
                subtitle: _('%s of %s').format(Btrfs.size(used), Btrfs.size(total)),
            });
            const bar = new Gtk.LevelBar({
                min_value: 0,
                max_value: 1,
                value: used / total,
                valign: Gtk.Align.CENTER,
                width_request: 160,
            });
            row.add_suffix(bar);
            group.add(row);
        }

        return group;
    }

    /**
     * A group that is not there, and what to type to make it be there.
     *
     * @param {string} title - what would be here
     * @param {string} description - why it is not
     * @param {string} pkg - the package that would bring it
     * @returns {Adw.PreferencesGroup} the group, with a copyable command in it
     */
    _absent(title, description, pkg) {
        const group = new Adw.PreferencesGroup({title, description});
        const command = installCommand(pkg);
        if (!command) {
            group.add(new Adw.ActionRow({
                title: _('Install the %s package for your distribution').format(pkg),
            }));
            return group;
        }

        const row = new Adw.ActionRow({title: command, css_classes: ['monospace']});
        const copy = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            tooltip_text: _('Copy'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        copy.connect('clicked', () => {
            this._window.get_clipboard().set(command);
            this._toast(_('Command copied.'));
        });
        row.add_suffix(copy);
        group.add(row);
        return group;
    }

    /**
     * @param {string} title - what the number is
     * @param {string} value - the number
     * @returns {Adw.ActionRow} a line that only says something
     */
    _reading(title, value) {
        const row = new Adw.ActionRow({title});
        row.add_suffix(new Gtk.Label({
            label: value,
            css_classes: ['dim-label', 'numeric'],
        }));
        return row;
    }

    _toast(message) {
        this._window.add_toast?.(new Adw.Toast({title: message, timeout: 6}));
    }
}
