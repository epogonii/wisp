# extensions.gnome.org review

Read against the review guidelines at
<https://gjs.guide/extensions/review-guidelines/review-guidelines.html> on
2026-08-22. Every rule below is quoted from that page; what follows each one is
what Wisp does about it and where to look.

The short answer: Wisp meets the rules as written. The one part a reviewer is
likely to stop on is that it runs `snapper`, and runs it through `pkexec` for
the things only root can do. That is the whole of the risk, and the case for it
is in [Spawning processes](#spawning-processes) below.

---

## The rules, one at a time

**"Extensions MUST NOT create any objects, connect any signals, add any main
loop sources or modify GNOME Shell during initialization."**

`WispExtension` has no constructor. Everything starts in `enable()`
(`extension.js`): the settings object, the two module-level settings
references, the panel button, and two `changed::` connections.

**"Any objects or widgets created by an extension MUST be destroyed in
`disable()`."**

`disable()` closes any open dialog first (`closeAll()` in `lib/dialog.js`, which
walks a registry every `WispDialog` adds itself to), then disconnects its
settings handlers, destroys the panel button, and clears the two module-level
references. `Indicator.destroy()` disconnects its own handlers and calls
`Snapper.destroy()`, which cancels the cancellable, drops the settle timeout,
cancels every file monitor and disconnects the proxy signals. `Toast.destroy()`
removes the pill from the chrome and its timer with it.

The dialogs are the reason the registry exists: a modal dialog holds the
pointer and the keyboard, and one left on screen by an extension that is no
longer running would hold them against nothing. `close()` is what hands the
grab back, so that is what the registry calls.

**"Any signal connections made by an extension MUST be disconnected in
`disable()`."**

The connections that outlive a single object are the ones listed above.
Everything shorter-lived is connected to an actor and goes when the actor is
destroyed, or is made with `connectObject`.

**"Any main loop sources created MUST be removed in `disable()`, even if the
callback function will eventually return `false`."**

Seven sources are created in the whole extension - one per debounce or tick -
and each is held in a field, removed before it is replaced, and removed again by
the `destroy()` of whatever owns it.

**"Extensions MUST NOT import deprecated modules"** (`ByteArray`, `Lang`,
`Mainloop`)

None of the three appears anywhere.

**"Extensions MUST NOT import `Gdk`, `Gtk` or `Adw` in the GNOME Shell
process"** and **"MUST NOT import `Clutter`, `Meta`, `St` or `Shell` in the
preferences process"**

The shell side (`extension.js` and the modules it pulls in) imports Clutter,
Gio, GLib, GObject, Pango and St. `prefs.js` imports Adw, Gdk, Gio, GLib,
GObject and Gtk. Six modules are shared by both - `lib/authorization.js`,
`lib/btrfs.js`, `lib/configs.js`, `lib/exec.js`, `lib/packages.js` and
`lib/units.js` - and none of them imports a toolkit at all, which is what makes
them shareable.

**"Extension MUST NOT print excessively to the log."**

Seven `logError` calls, all of them in a `catch`, and nothing else. No `log()`,
no `console.log`.

**"Extensions MUST NOT include binary executables or libraries."**

The zip is JavaScript, JSON, CSS, one SVG, the schema XML, the compiled schema
that `glib-compile-schemas` makes from it, and the compiled translations.
`tools/files.txt` is the list; `tools/pack.sh` builds the zip from it and
nothing else.

**"The Schema ID MUST use `org.gnome.shell.extensions` as a base ID"** and
**"The Schema XML file MUST be included in the extension ZIP file."**

`org.gnome.shell.extensions.wisp`, and the XML is in `tools/files.txt`.

**metadata.json "should be well-formed and accurately reflect the extension
without using any unnecessary keys"**

`uuid`, `name`, `description`, `shell-version`, `version-name`, `url`,
`donations`, `settings-schema`, `gettext-domain`. No `session-modes`, since
Wisp only runs in `user` mode. No `version`: extensions.gnome.org assigns that
on upload.

`shell-version` is 46 through 50, all of them stable releases.

**"Extensions MUST be distributed under compatible terms"**

GPL-2.0-or-later. Every file carries an SPDX line and `LICENSE` is in the zip.

**"Extensions MUST NOT use any telemetry tools to track users."**

Nothing is sent anywhere. There is no network code: no libsoup, no `fetch`. The
only outward-facing calls are `Gio.AppInfo.launch_default_for_uri` for the
project page and the two donation links, each behind a button the user presses.

**"Extension code MUST be readable and reviewable JavaScript."**

Plain ES modules, no build step, no bundler, no minification. What is in the
repository is what is in the zip.

---

## Spawning processes

The rule:

> Use of external scripts and binaries is strongly discouraged. [...]
> Processes MUST be spawned carefully and exit cleanly. [...] Spawning
> privileged subprocesses should be avoided at all costs. If absolutely
> necessary, the subprocess MUST be run with `pkexec` and MUST NOT be an
> executable or script that can be modified by a user process.

Wisp is a front end for snapper, so snapper is the program it is made of. Where
snapper answers over D-Bus, that is what is used: `lib/snapper.js` talks to
`org.opensuse.Snapper` on the system bus, and everything the menu shows -
listing snapshots, taking one, deleting one, comparing two - goes that way,
under the user's own account, with no subprocess at all.

The rest is what snapperd does not expose. Each of those is one program, run
with an argument vector and never a shell line (`run()` in `lib/exec.js`),
never with a program from inside the extension. Run under the user's own
account, not through `pkexec`:

- `snapper -c <config> --csvout get-config` - the retention settings
- `systemctl is-enabled <unit>` - whether a timer runs on its own
- `findmnt -no UUID,FSTYPE --target <path>` - what filesystem a path is on
- `pkcheck --action-id org.freedesktop.policykit.exec --allow-user-interaction`
  - the lock in front of the menu, when it is switched on. This one does ask,
  and that is the point of it: it is polkit's own prompt, raised in advance so
  that the menu opens already authorised

And through `pkexec`, each one behind a dialog that names the command before it
runs:

- `snapper -c <config> {create,delete,rollback,undochange,set-config,
  create-config,delete-config,setup-quota}`
- `systemctl {enable,disable} --now snapper-{timeline,cleanup,boot}.timer`
- `sed -i -e 's|^BTRFS_<job>_PERIOD=.*|BTRFS_<job>_PERIOD="<period>"|'
  <btrfsmaintenance config>` - `/etc/sysconfig/btrfsmaintenance` or
  `/etc/default/btrfsmaintenance`, whichever the package installed. The four
  periods come from a fixed list (`PERIODS` in `lib/btrfs.js`), not from
  anything typed

Every one of those is a program the distribution installed and only root can
write to; none is shipped, generated, or written to disk by Wisp. `pkexec`
resolves the program itself and shows its full path in polkit's own prompt, in
a sanitised environment, and the password is polkit's business - it never
reaches the extension. The user is shown the same command beforehand and can
copy it and run it in a terminal instead; that button is on every one of those
dialogs.

Processes exit cleanly: `Gio.Subprocess` with both pipes,
`communicate_utf8_async`, and the exit status read and reported rather than
thrown. A program that is not installed is not spawned at all - `have()` checks
first and the caller says which package to install (`lib/packages.js` maps eleven
os-release IDs to their install command).

Why not avoid it entirely: snapperd is the only D-Bus surface snapper has, and
it deliberately does not offer the config file, the timers, or a rollback. An
extension that dropped them would be a viewer, not the management surface this
is meant to be. What it can do instead is what it does: nothing privileged
happens without being named first, and nothing privileged happens through a
path Wisp controls.

---

## Where a reviewer may still push back

**"It runs snapper on the command line, and snapper has a D-Bus API."** True of
the reads that snapperd answers, and those go over D-Bus. The list above is
what snapperd has no method for.

**`pkexec sed`** is the one that looks worst read out of context. It edits
`/etc/sysconfig/btrfsmaintenance`, a shell-syntax config file, and it edits it
in place so the file keeps its comments and its order. The keys are four fixed
names, the values are four fixed words, and the path comes from wherever the
package put the file. The alternative - reading, rewriting and moving a whole
file as root - is more code with the same authority.

**Reading `/etc/fstab` and sysfs.** Both are read directly with
`GLib.file_get_contents` for facts the D-Bus API cannot give: whether a
rollback will be overruled by an fstab entry, and how much of the filesystem
btrfs has handed out. Read-only, both of them world-readable.

**The polkit action used for the lock** is `org.freedesktop.policykit.exec`,
which every desktop has. Wisp does not ship a policy file, and the check's
answer is thrown away: the point of it is the authentication, not the
permission.

---

## What still has to be done before uploading

- The listing wants screenshots. `docs/screenshots/` has four; a fifth showing
  the menu with snapper missing would say what the extension does when the
  system is not set up.

---

## The submission text

Suggested description for the listing:

> Wisp lists the snapshots snapper has already taken, takes one on demand, and
> deletes the ones no longer wanted - from the top bar, without a terminal.
>
> Each config gets its own section in the menu, newest first, with the age or
> the date, the description snapper recorded, and the rule that decides when
> snapper will remove it on its own. Opening a snapshot shows what it is
> holding on disk, what changed in it, and what has changed since - and can put
> individual files back or roll the whole system over to it.
>
> The preferences window is the rest of snapper: the retention limits each
> config cleans up by, its timers, btrfsmaintenance's scrub and balance, and
> what the filesystem underneath is doing. Wisp reads everything it can as your
> own account. Anything that needs root says so, shows the exact command, and
> asks polkit - the same prompt anything else on the machine uses. There is
> also a lock, if the list of snapshots is not something you want a click away.
>
> Needs snapper, and a filesystem it manages. GNOME 46 and later.
