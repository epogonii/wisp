// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

const BUS_NAME = 'org.opensuse.Snapper';
const OBJECT_PATH = '/org/opensuse/Snapper';

// Most calls are answered in milliseconds and the default timeout would do,
// but deleting a large snapshot or adding up what one occupies is real work on
// the filesystem and a minute of it is not a sign that anything is wrong.
const TIMEOUT = 120 * 1000;

// Comparing two snapshots walks both trees. Between two snapshots a few hours
// apart /home came to four hundred thousand changed files, most of them in
// caches, and that is a long way from the worst case.
const COMPARE_TIMEOUT = 30 * 60 * 1000;

// How long the snapshot directories have to sit still before the menu is
// rebuilt. Taking a snapshot is a handful of writes in a row and rebuilding
// on each one would be a menu that flickers.
const SETTLE = 700;

// Only the calls the extension makes. snapperd's interface is wider than this,
// and a method listed here is a method a reviewer has to account for.
const IFACE = `
<node>
  <interface name="org.opensuse.Snapper">
    <method name="ListConfigs">
      <arg type="a(ssa{ss})" direction="out" name="configs"/>
    </method>
    <method name="GetConfig">
      <arg type="s" direction="in" name="config"/>
      <arg type="(ssa{ss})" direction="out" name="data"/>
    </method>
    <method name="SetConfig">
      <arg type="s" direction="in" name="config"/>
      <arg type="a{ss}" direction="in" name="values"/>
    </method>
    <method name="ListSnapshots">
      <arg type="s" direction="in" name="config"/>
      <arg type="a(uquxussa{ss})" direction="out" name="snapshots"/>
    </method>
    <method name="SetSnapshot">
      <arg type="s" direction="in" name="config"/>
      <arg type="u" direction="in" name="number"/>
      <arg type="s" direction="in" name="description"/>
      <arg type="s" direction="in" name="cleanup"/>
      <arg type="a{ss}" direction="in" name="userdata"/>
    </method>
    <method name="CreateSingleSnapshot">
      <arg type="s" direction="in" name="config"/>
      <arg type="s" direction="in" name="description"/>
      <arg type="s" direction="in" name="cleanup"/>
      <arg type="a{ss}" direction="in" name="userdata"/>
      <arg type="u" direction="out" name="number"/>
    </method>
    <method name="DeleteSnapshots">
      <arg type="s" direction="in" name="config"/>
      <arg type="au" direction="in" name="numbers"/>
    </method>
    <method name="IsSnapshotReadOnly">
      <arg type="s" direction="in" name="config"/>
      <arg type="u" direction="in" name="number"/>
      <arg type="b" direction="out" name="readOnly"/>
    </method>
    <method name="SetSnapshotReadOnly">
      <arg type="s" direction="in" name="config"/>
      <arg type="u" direction="in" name="number"/>
      <arg type="b" direction="in" name="readOnly"/>
    </method>
    <method name="GetActiveSnapshot">
      <arg type="s" direction="in" name="config"/>
      <arg type="b" direction="out" name="found"/>
      <arg type="u" direction="out" name="number"/>
    </method>
    <method name="CalculateUsedSpace">
      <arg type="s" direction="in" name="config"/>
    </method>
    <method name="GetUsedSpace">
      <arg type="s" direction="in" name="config"/>
      <arg type="u" direction="in" name="number"/>
      <arg type="u" direction="out" name="bytes"/>
    </method>
    <method name="GetMountPoint">
      <arg type="s" direction="in" name="config"/>
      <arg type="u" direction="in" name="number"/>
      <arg type="s" direction="out" name="path"/>
    </method>
    <method name="CreateComparison">
      <arg type="s" direction="in" name="config"/>
      <arg type="u" direction="in" name="from"/>
      <arg type="u" direction="in" name="to"/>
      <arg type="u" direction="out" name="count"/>
    </method>
    <method name="DeleteComparison">
      <arg type="s" direction="in" name="config"/>
      <arg type="u" direction="in" name="from"/>
      <arg type="u" direction="in" name="to"/>
    </method>
    <method name="GetFiles">
      <arg type="s" direction="in" name="config"/>
      <arg type="u" direction="in" name="from"/>
      <arg type="u" direction="in" name="to"/>
      <arg type="a(su)" direction="out" name="files"/>
    </method>
    <signal name="SnapshotCreated">
      <arg type="s" name="config"/>
      <arg type="u" name="number"/>
    </signal>
    <signal name="SnapshotModified">
      <arg type="s" name="config"/>
      <arg type="u" name="number"/>
    </signal>
    <signal name="SnapshotsDeleted">
      <arg type="s" name="config"/>
      <arg type="au" name="numbers"/>
    </signal>
    <signal name="ConfigCreated">
      <arg type="s" name="config"/>
    </signal>
    <signal name="ConfigModified">
      <arg type="s" name="config"/>
    </signal>
    <signal name="ConfigDeleted">
      <arg type="s" name="config"/>
    </signal>
  </interface>
</node>`;

const SnapperProxy = Gio.DBusProxy.makeProxyWrapper(IFACE);

// The three kinds of snapshot snapper keeps. A timeline or a hand-made
// snapshot is SINGLE; a package transaction leaves a PRE and a POST with the
// POST pointing back at the PRE by number.
export const SINGLE = 0;
export const PRE = 1;
export const POST = 2;

// Snapshot zero is not a snapshot: it stands for the running system, and
// snapper lists it with a date of -1 so that a comparison can name it.
export const CURRENT = 0;

// What changed about a file between two snapshots, as snapperd packs it into
// one number. There are bits for permissions, owner, group, xattrs and acl as
// well; a file that has one of those and none of these is still there and
// something about it moved, which is all a list of changes needs to say.
const CREATED = 1;
const DELETED = 2;
const CONTENT = 8;

// A snapshot worth keeping is marked the way snapper's own tools mark it, in
// userdata, so that the mark means the same thing from the command line.
const IMPORTANT = 'important';

/**
 * Whether a call failed because the config is out of this user's reach.
 *
 * snapperd does not use polkit. Each config in /etc/snapper/configs carries
 * ALLOW_USERS and ALLOW_GROUPS, empty by default, and everything but
 * ListConfigs is refused to anyone not named there. The refusal arrives as a
 * plain Error.Failed, so the reason has to be read out of the message.
 *
 * @param {Error} error - the error a proxy call rejected with
 * @returns {boolean} true when the user is simply not allowed
 */
export function isDenied(error) {
    return error?.message?.includes('no_permissions') ?? false;
}

/**
 * One file, as a comparison between two snapshots describes it.
 */
export class ChangedFile {
    constructor(path, status) {
        // Relative to the config's subvolume, with a leading slash.
        this.path = path;
        this.status = status;
    }

    get created() {
        return (this.status & CREATED) !== 0;
    }

    get deleted() {
        return (this.status & DELETED) !== 0;
    }

    get content() {
        return (this.status & CONTENT) !== 0;
    }

    get name() {
        return GLib.path_get_basename(this.path);
    }
}

/**
 * One snapshot, with the fields worth showing. snapper hands them over as a
 * bare tuple: number, type, the pre it belongs to, the date in seconds, the
 * user that asked for it, its description, its cleanup rule and its userdata.
 */
class Snapshot {
    constructor([number, type, preNumber, date, uid, description, cleanup, userdata]) {
        this.number = number;
        this.type = type;
        this.preNumber = preNumber;
        this.date = date;
        this.uid = uid;
        this.description = description;
        this.cleanup = cleanup;
        this.userdata = userdata;
    }

    get numbers() {
        return [this.number];
    }

    // What to read and write when the menu shows one row: for a plain
    // snapshot, itself. A transaction answers this with its pre.
    get primary() {
        return this;
    }

    get dateTime() {
        return this.date < 0 ? null : GLib.DateTime.new_from_unix_local(this.date);
    }

    get important() {
        return this.userdata[IMPORTANT] === 'yes';
    }
}

/**
 * A pre and its post shown as one thing. A package transaction is one event to
 * the person who ran it, and two rows in the menu would be two ways to undo
 * half of it.
 */
class Transaction {
    constructor(pre, post) {
        this.pre = pre;
        this.post = post;
    }

    get number() {
        return this.pre.number;
    }

    get numbers() {
        return this.post ? [this.pre.number, this.post.number] : [this.pre.number];
    }

    get primary() {
        return this.pre;
    }

    get type() {
        return PRE;
    }

    get description() {
        return this.pre.description;
    }

    get cleanup() {
        return this.pre.cleanup;
    }

    get userdata() {
        return this.pre.userdata;
    }

    get dateTime() {
        return this.pre.dateTime;
    }

    get important() {
        return this.pre.important;
    }

    /**
     * What the transaction changed: the state before it against the state
     * after it, rather than against the running system.
     *
     * @returns {number[]} the pair to compare, older first
     */
    get range() {
        return this.post ? [this.pre.number, this.post.number] : [this.pre.number, CURRENT];
    }
}

export const Snapper = GObject.registerClass({
    Signals: {
        // snapperd said something changed under this config, or the daemon
        // itself came or went and what is on screen can no longer be trusted.
        'changed': {param_types: [GObject.TYPE_STRING]},
    },
}, class Snapper extends GObject.Object {
    constructor() {
        super();

        this._proxy = null;
        this._signalIds = [];
        this._monitors = [];
        this._settleId = 0;
        this._cancellable = new Gio.Cancellable();

        // snapperd is started by the bus on the first call and stops itself
        // again once it has been idle a while. The proxy is made against the
        // well-known name rather than a unique one, so it survives that and
        // picks the daemon up again when the next call wakes it.
        new SnapperProxy(Gio.DBus.system, BUS_NAME, OBJECT_PATH, (proxy, error) => {
            if (error) {
                logError(error, 'Wisp: cannot reach snapperd');
                return;
            }

            proxy.set_default_timeout(TIMEOUT);
            this._proxy = proxy;
            for (const name of ['SnapshotCreated', 'SnapshotModified', 'SnapshotsDeleted']) {
                this._signalIds.push(proxy.connectSignal(name,
                    (_p, _s, [config]) => this.emit('changed', config)));
            }
            for (const name of ['ConfigCreated', 'ConfigModified', 'ConfigDeleted']) {
                this._signalIds.push(proxy.connectSignal(name,
                    (_p, _s, [config]) => this.emit('changed', config)));
            }
            this.emit('changed', '');
        }, this._cancellable);
    }

    get ready() {
        return this._proxy !== null;
    }

    /**
     * A call that may take as long as it takes.
     *
     * The proxy carries one timeout for everything it does, and comparing two
     * snapshots can outlast any figure that would be reasonable for the rest,
     * so those go straight down the connection with a timeout of their own.
     *
     * @param {string} method - method name on the snapper interface
     * @param {GLib.Variant} params - arguments, already packed
     * @param {string} replyType - signature the reply is expected to have
     * @param {number} timeout - how long to wait, in milliseconds
     * @param {?Gio.Cancellable} cancellable - what stops the waiting, where
     *   the caller has something of its own to stop it with
     * @returns {Promise<GLib.Variant>} the reply
     */
    _callSlowly(method, params, replyType, timeout, cancellable = null) {
        return new Promise((resolve, reject) => {
            Gio.DBus.system.call(BUS_NAME, OBJECT_PATH, BUS_NAME, method, params,
                new GLib.VariantType(replyType), Gio.DBusCallFlags.NONE, timeout,
                cancellable ?? this._cancellable, (connection, result) => {
                    try {
                        resolve(connection.call_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                });
        });
    }

    /**
     * Every config with the contents of its config file.
     *
     * ListConfigs is the one call snapperd answers for anybody: it hands out
     * the name, the subvolume and the whole of /etc/snapper/configs/<name>
     * without checking who is asking, even for a config that same caller is
     * not allowed to read a single snapshot of. So the settings a config was
     * given - including the list of who may use it - can be shown, and
     * checked, without a password.
     *
     * @returns {Promise<{name: string, subvolume: string, values: object}[]>}
     *   what snapper manages, in the order it lists them
     */
    async listConfigDetails() {
        if (!this._proxy)
            return [];

        const [configs] = await this._proxy.ListConfigsAsync();
        return configs.map(([name, subvolume, values]) =>
            ({name, subvolume, values}));
    }

    /**
     * Everything set in /etc/snapper/configs for one config. Reading it needs
     * the same permission as the rest, so this is refused for a config the
     * user has not been given.
     *
     * @param {string} config - config name
     * @returns {Promise<{subvolume: string, values: object}>} what it holds
     */
    async getConfig(config) {
        const [[, subvolume, values]] = await this._proxy.GetConfigAsync(config);
        return {subvolume, values};
    }

    /**
     * Changes settings in a config, leaving everything not named alone.
     *
     * @param {string} config - config name
     * @param {object} values - the keys to set, as strings
     * @returns {Promise<void>} settled once written
     */
    async setConfig(config, values) {
        await this._proxy.SetConfigAsync(config, values);
    }

    /**
     * The snapshots under one config, newest first, with each pre and post
     * paired up and the running system left out.
     *
     * @param {string} config - config name, as listConfigDetails returns them
     * @returns {Promise<Array<Snapshot|Transaction>>} what to put in the menu
     */
    async listSnapshots(config) {
        const [rows] = await this._proxy.ListSnapshotsAsync(config);
        const snapshots = rows.map(row => new Snapshot(row))
            .filter(s => s.number !== CURRENT);

        // A post is only ever reached through its pre, so the posts are set
        // aside by the pre they close and the pres pick them up again.
        const posts = new Map();
        for (const s of snapshots) {
            if (s.type === POST)
                posts.set(s.preNumber, s);
        }

        const entries = [];
        for (const s of snapshots) {
            if (s.type === POST)
                continue;
            entries.push(s.type === PRE ? new Transaction(s, posts.get(s.number)) : s);
        }

        return entries.sort((a, b) => b.number - a.number);
    }

    /**
     * Where a snapshot's files can be read. For btrfs this is a directory that
     * is already there - .snapshots/<n>/snapshot under the subvolume - and
     * asking snapper for it beats assembling the path here, which would be
     * wrong the moment a config points somewhere unusual.
     *
     * @param {string} config - config the snapshot belongs to
     * @param {number} number - snapshot number
     * @returns {Promise<string>} path to the snapshot's root
     */
    async mountPoint(config, number) {
        const [path] = await this._proxy.GetMountPointAsync(config, number);
        return path;
    }

    /**
     * How much disk a snapshot is holding on to on its own: the space that
     * would come back if it went. snapper works this out for the whole config
     * at once and from btrfs quota groups, which have to be enabled for the
     * figure to mean anything.
     *
     * @param {string} config - config name
     * @param {number} number - snapshot number
     * @returns {Promise<number|null>} bytes, or null if quotas are not set up
     */
    async usedSpace(config, number) {
        try {
            await this._callSlowly('CalculateUsedSpace', new GLib.Variant('(s)', [config]),
                '()', COMPARE_TIMEOUT);
            const [bytes] = (await this._proxy.GetUsedSpaceAsync(config, number));
            return bytes;
        } catch (error) {
            if (isDenied(error))
                throw error;
            return null;
        }
    }

    /**
     * Takes a snapshot now.
     *
     * The cleanup rule is left empty by default. A snapshot taken by hand is
     * taken because something is about to be changed, and one that snapper's
     * number or timeline cleanup could throw away an hour later would not be
     * there when it was wanted.
     *
     * @param {string} config - config to snapshot
     * @param {string} description - what it is for, as snapper will list it
     * @param {object} [userdata] - snapper userdata to set on it
     * @returns {Promise<number>} the new snapshot's number
     */
    async create(config, description, userdata = {}) {
        const [number] = await this._proxy.CreateSingleSnapshotAsync(
            config, description, '', userdata);
        return number;
    }

    /**
     * Rewrites what a snapshot says about itself. Its contents are not
     * touched; this is the description, the cleanup rule and the userdata.
     *
     * @param {string} config - config it belongs to
     * @param {number} number - snapshot number
     * @param {object} fields - description, cleanup and userdata to write
     * @returns {Promise<void>} settled once snapperd has done it
     */
    async edit(config, number, {description, cleanup, userdata}) {
        await this._proxy.SetSnapshotAsync(config, number, description, cleanup, userdata);
    }

    /**
     * Marks a snapshot as one to keep, or stops marking it. The mark lives in
     * userdata under the key snapper's own cleanup algorithms read, so a
     * snapshot marked here is spared there.
     *
     * @param {string} config - config it belongs to
     * @param {Snapshot|Transaction} entry - the entry a row stands for
     * @param {boolean} important - whether to mark it
     * @returns {Promise<void>} settled once written
     */
    async setImportant(config, entry, important) {
        for (const number of entry.numbers) {
            const userdata = {...entry.userdata};
            if (important)
                userdata[IMPORTANT] = 'yes';
            else
                delete userdata[IMPORTANT];
            await this.edit(config, number,
                {description: entry.description, cleanup: entry.cleanup, userdata});
        }
    }

    /**
     * Whether a snapshot can still be written to. snapper takes them read-only
     * and there is rarely a reason to change that, but a snapshot that is
     * about to be edited in place has to be turned writable first.
     *
     * @param {string} config - config it belongs to
     * @param {number} number - snapshot number
     * @returns {Promise<boolean>} true when read-only
     */
    async isReadOnly(config, number) {
        const [readOnly] = await this._proxy.IsSnapshotReadOnlyAsync(config, number);
        return readOnly;
    }

    /**
     * @param {string} config - config it belongs to
     * @param {number} number - snapshot number
     * @param {boolean} readOnly - what to set it to
     * @returns {Promise<void>} settled once set
     */
    async setReadOnly(config, number, readOnly) {
        await this._proxy.SetSnapshotReadOnlyAsync(config, number, readOnly);
    }

    /**
     * How many files differ between two snapshots. Snapshot zero stands for
     * the running system, so comparing against it says what has happened
     * since.
     *
     * This is the expensive half - both trees are walked - and it is asked
     * first because the answer decides whether the list is worth fetching.
     * Two snapshots of /home a few hours apart came to four hundred thousand
     * files, and there is no reading of that.
     *
     * @param {string} config - config name
     * @param {number} from - the older snapshot
     * @param {number} to - the newer snapshot, or zero for the running system
     * @returns {Promise<number>} how many files changed
     */
    async compare(config, from, to, cancellable = null) {
        const reply = await this._callSlowly('CreateComparison',
            new GLib.Variant('(suu)', [config, from, to]), '(u)', COMPARE_TIMEOUT,
            cancellable);
        return reply.deepUnpack()[0];
    }

    /**
     * The files a comparison found, once it has been made.
     *
     * @param {string} config - config name
     * @param {number} from - the older snapshot
     * @param {number} to - the newer snapshot
     * @param {?Gio.Cancellable} cancellable - what stops the waiting
     * @returns {Promise<ChangedFile[]>} what changed, in snapper's order
     */
    async comparedFiles(config, from, to, cancellable = null) {
        const reply = await this._callSlowly('GetFiles',
            new GLib.Variant('(suu)', [config, from, to]), '(a(su))', COMPARE_TIMEOUT,
            cancellable);
        return reply.deepUnpack()[0].map(([path, status]) => new ChangedFile(path, status));
    }

    /**
     * Lets snapperd forget a comparison it is holding in memory.
     *
     * @param {string} config - config name
     * @param {number} from - the older snapshot
     * @param {number} to - the newer snapshot
     * @returns {Promise<void>} settled once dropped
     */
    async forgetComparison(config, from, to) {
        try {
            await this._proxy.DeleteComparisonAsync(config, from, to);
        } catch {
            // Nothing was cached, or the daemon has been and gone since. There
            // is nothing to do about it and nothing to say.
        }
    }

    /**
     * Deletes snapshots. Nothing here brings them back.
     *
     * @param {string} config - config they belong to
     * @param {number[]} numbers - snapshot numbers to delete
     * @returns {Promise<void>} settled once snapperd has done it
     */
    async delete(config, numbers) {
        await this._proxy.DeleteSnapshotsAsync(config, numbers);
    }

    /**
     * Watches the directories the snapshots are actually in.
     *
     * snapperd announces what it did itself, and a good deal of what happens
     * to snapshots is not that. The hourly ones come from
     * /usr/libexec/snapper/systemd-helper, which goes through libsnapper and
     * never touches the bus; the pair around a package transaction comes from
     * a plugin doing the same; and another program deleting a snapshot - or
     * somebody doing it by hand with btrfs - says nothing to anybody.
     *
     * What all of them have in common is the directory. A snapshot is a
     * numbered subdirectory of the config's .snapshots, so watching that
     * directory catches every one of those cases, and SYNC_ACL has already
     * put this account on its ACL for the configs it is allowed to read.
     *
     * @param {{subvolume: string}[]} configs - what to watch, as listConfigDetails
     *   gives them
     */
    watch(configs) {
        this._unwatch();

        for (const {subvolume} of configs) {
            const path = subvolume === '/'
                ? '/.snapshots'
                : `${subvolume}/.snapshots`;
            try {
                const monitor = Gio.File.new_for_path(path)
                    .monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
                monitor.connect('changed', () => this._settle());
                this._monitors.push(monitor);
            } catch (error) {
                // A config whose snapshots this account cannot read has a
                // directory it cannot watch either. That is the same refusal
                // the listing already reported, and not worth reporting twice.
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.PERMISSION_DENIED))
                    logError(error, `Wisp: cannot watch ${path}`);
            }
        }
    }

    /**
     * Taking a snapshot is several changes to the directory in quick
     * succession, and rebuilding a menu for each one would be a menu that
     * flickers. This waits for the writing to stop first.
     */
    _settle() {
        if (this._settleId)
            GLib.source_remove(this._settleId);

        this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE, () => {
            this._settleId = 0;
            this.emit('changed', '');
            return GLib.SOURCE_REMOVE;
        });
    }

    _unwatch() {
        for (const monitor of this._monitors)
            monitor.cancel();
        this._monitors = [];
    }

    destroy() {
        this._cancellable.cancel();
        if (this._settleId)
            GLib.source_remove(this._settleId);
        this._settleId = 0;
        this._unwatch();
        for (const id of this._signalIds)
            this._proxy?.disconnectSignal(id);
        this._signalIds = [];
        this._proxy = null;
    }
});
