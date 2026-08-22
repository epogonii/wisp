# Changelog

## 1.0.3

- Adding up what a snapshot is holding on to is gone, and so is the button that
  turned btrfs quotas on for a config. The figure is a quota rescan of the whole
  filesystem: 560 seconds from the command line here, 810 over snapper's own
  bus, and snapperd answers one caller at a time, so a second request left
  everything else asked of it waiting behind the first. The Storage page keeps
  what btrfs answers at once - the size, what it has handed out to chunks, what
  is written and what is free.
- Closing the preferences window while a page is still filling itself no longer
  writes into a window that is no longer there. Closing one sends
  `close-request`, not `destroy` - a window the process exits with is never
  disposed of - so the flag those checks all read was never set on the way
  anybody actually closes a window.
- A restore keeps its list of files until snapper has read it. The list used to
  go the moment the authorization window did, which for an extension switched
  off while polkit was still asking meant a restore that failed with nothing
  said.
- `po/wisp.pot` carries the 262 strings the extension shows, and
  `tools/update-po.sh` keeps a language up to date with it. No language is
  translated yet.

## 1.0.2

- Switching the extension off closes any window it still has open. One left
  behind held the keyboard and the pointer on behalf of an extension that was
  no longer running.
- The snapshot directories are watched by monitors that are kept and reused.
  Reading the configs happens on every menu open and after every change the
  watching itself reports, and each of those used to cancel every monitor and
  make it again, the one that had just fired included.
- A distribution that drives snapper from cron instead of a timer has the jobs
  it found named on the Schedule page. Timers alone used to read as nothing
  being scheduled at all.
- Every string the extension shows can be translated: `po/wisp.pot` carries all
  280 of them and `tools/update-po.sh` keeps a language up to date with it. No
  language is translated yet.

## 1.0.1

- The lock's idle window is measured against the wall clock as well as the
  monotonic one, which does not run while the machine is suspended. A laptop
  unlocked and then closed for the night used to come back unlocked.
- A middle click set to take a snapshot opens the menu when the lock is on,
  where it can be answered, instead of going around it.
- Cancelling an authorization window while polkit is still asking no longer
  lets the answer, when it arrives, be reported a second time or written into
  a window that has gone.

## 1.0.0

First release.

- Every config's snapshots in the top bar, newest first, with the pair snapper
  takes either side of a package transaction shown as the one event it was.
- Take one with a description that no cleanup rule will remove, delete one after
  a confirmation that says what goes, or open one in Files and read the system
  as it was.
- A snapshot's own window: rename it, mark it important, change its cleanup
  rule, turn read-only off, and add up what it alone is holding on to.
- Everything that has changed since a snapshot, searchable, with the files to
  put back picked out of the list - and for a package transaction, exactly what
  that transaction changed.
- Roll the root filesystem back, with a word first when `/etc/fstab` is going to
  overrule the subvolume the rollback sets as the default.
- Preferences over the rest of snapper: timeline and numbered limits per config,
  a new config or the removal of one, snapper's timers, btrfsmaintenance's jobs,
  and what btrfs has handed out to chunks.
- Reads a config without asking for a password, by offering to add the account to
  its `ALLOW_USERS` once; an optional polkit lock in front of the menu for anyone
  who wants one.
- Follows the snapshots live, whoever changed them; names a missing package with
  the line that installs it; follows the light and dark theme.
- GNOME Shell 46 to 50, Wayland and X11.
