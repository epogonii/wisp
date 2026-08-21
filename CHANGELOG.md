# Changelog

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
