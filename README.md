<p align="center">
  <img src="docs/icon.png" width="112" alt="Wisp">
</p>

<h1 align="center">Wisp</h1>

<p align="center">
  The snapshots snapper has already taken, in the top bar.
</p>

<p align="center">
  <img alt="GNOME Shell 46 to 50" src="https://img.shields.io/badge/GNOME%20Shell-46%20to%2050-5c5cf5?logo=gnome&logoColor=white">
  <img alt="License GPL-2.0-or-later" src="https://img.shields.io/badge/license-GPL--2.0--or--later-8f33c7">
  <a href="https://github.com/sponsors/epogonii"><img alt="Sponsor" src="https://img.shields.io/badge/sponsor-GitHub-ea4aaa?logo=githubsponsors&logoColor=white"></a>
</p>

## What does this extension do?

snapper is what most btrfs installations use to take snapshots: one an hour on a
timeline, one either side of every package transaction, and whatever else has
been asked for. Reading them back means the command line or a separate
application. This puts them in the top bar.

> [!TIP]
> **Simple, minimal and good-looking, and still the whole of snapper.**
> A menu of snapshots and a settings window, both quiet enough to forget about.
> Behind them is everything snapper can be asked to do, including the parts that
> otherwise mean a terminal: comparing a snapshot with the system as it is now,
> putting single files back, rolling the machine back, setting a config up, and
> the timers that keep all of it going.

The name is the faint light that hangs over a bog at night. A snapshot is the
same sort of thing: the shape the system had, still there after the moment it
belonged to.

---

## What has to be installed first

The extension manages snapshots, it does not take over from what takes them. One
package is required and the rest are what a particular page needs:

| | |
| --- | --- |
| `snapper` | **Required.** Nothing here works without it, and it is not installed by default on most distributions |
| One snapper config | **Required.** A config is one subvolume snapper snapshots. There is nothing to list until there is one |
| `polkit` | Everything that belongs to root: taking or deleting a snapshot for a config this account may not change, putting files back, rolling back, and the lock in front of the menu, which needs `pkcheck` from the same package |
| `util-linux` | `findmnt`, which is how the Storage page works out what the filesystem is |
| `btrfs-progs` | The Storage page, and the size of a single snapshot, which also wants btrfs quotas switched on |
| `btrfsmaintenance` | Balance, scrub, defrag and trim on the Schedule page. snapper does not need it, and without it that half of the page says so |

GNOME Shell 46 or newer, on Wayland or X11. polkit and util-linux are on
practically every desktop install already; snapper usually is not.

```sh
sudo dnf install snapper       # Fedora, RHEL, CentOS
sudo apt install snapper       # Debian, Ubuntu
sudo pacman -S snapper         # Arch
sudo zypper install snapper    # openSUSE, where it is there from the start
```

Then one config for whatever should be snapshotted, and the timers that make
snapper act on its own:

```sh
sudo snapper -c root create-config /
sudo systemctl enable --now snapper-timeline.timer snapper-cleanup.timer
```

Neither of those has to be typed. When snapper is missing the menu says so and
hands over the line that installs it, worked out for the distribution it is
running on; a config can be set up from the settings window, and the timers are
switches on the Schedule page.

---

## Features

- The menu lists what each config holds, newest first: the number, what the
  snapshot is for, and how long ago it was taken or the date and time it was
- A snapshot either side of a package transaction is shown as the one event it
  was rather than as two rows
- Take a snapshot, with a description, that no cleanup rule will remove; from
  the menu or a middle click on the indicator
- Delete one, after a confirmation that says which snapshots go
- Open a snapshot in Files and read it as it was
- Rename a snapshot, mark it important so snapper's cleanup leaves it alone,
  change which cleanup algorithm may remove it, turn read-only off
- Work out what one snapshot alone is holding on to, where btrfs quotas allow it
- Every file that has changed since a snapshot was taken, searchable, and for a
  package transaction exactly what the transaction changed
- Put chosen files back, which is snapper's own `undochange`; Ctrl+A for all of
  them, Shift-click for a run
- Roll the root filesystem back, and a word before the reboot when
  `/etc/fstab` is going to overrule it
- The timeline per config: whether snapper keeps one, and how many hourly,
  daily, weekly, monthly, quarterly and yearly snapshots survive the cleanup
- Set up a new config, or delete one with everything in it
- snapper's own timers as three switches, and btrfsmaintenance's jobs as how
  often each one runs
- What the filesystem is doing: its size, what btrfs has handed out to chunks,
  what is written, what is free, and the same per chunk type
- Access without a password: rather than a prompt every time it lists something,
  it offers to add the account to the config once
- A lock in front of the menu if you want one - never, after a while, or every
  time - asked for by polkit
- Live: whatever changes the snapshots, the menu is already showing it
- Configs can be kept out of the menu
- Whatever is missing is named, with the line that installs it on this
  distribution
- Ctrl+A, Ctrl+C, Ctrl+X and Ctrl+V work on any keyboard layout, not only a
  Latin one
- Follows the system light and dark theme and switches with it

---

## How to install

#### From extensions.gnome.org

Not there yet.

#### From a release

Every tag builds a zip:

```sh
gnome-extensions install --force wisp.zip
gnome-extensions enable wisp@epogonii.github.io
```

#### From the sources

```sh
tools/install-local.sh     # into the running session
tools/pack.sh              # the zip, from the same file list
```

Log out and back in first (X11: `Alt+F2`, then `r`): a running shell keeps an
extension's JavaScript in memory for the life of the process, so new code needs
a new shell. Preferences apply immediately.

---

## Permissions

snapperd does not use polkit. Each config carries its own `ALLOW_USERS` and
`ALLOW_GROUPS` in `/etc/snapper/configs/<name>`, and both are empty until
somebody fills them in, so a fresh install refuses to tell an ordinary account
anything at all.

Rather than ask for a password every time it lists something, Wisp offers to add
the account to the config once. That runs

```sh
sudo snapper -c <config> set-config ALLOW_USERS=<you> SYNC_ACL=yes
```

through `pkexec`, which is polkit's own program: polkit puts up the password
prompt, and the password is never handled by the extension. `SYNC_ACL` is what
puts an ACL on the snapshot directory, without which the snapshots are listed
but their files still cannot be opened.

Everything after that - listing, taking, deleting, editing, comparing - goes
straight to snapperd over D-Bus as the user. Restoring files and rolling back
are the exception: those are `snapper undochange` and `snapper rollback`, they
are root's either way, and each one asks. So are the settings that live in
`/etc/snapper/configs` and the systemd timers, and both windows show the command
they are about to run before running it.

---

## Rollback

`snapper rollback` works by pointing btrfs at a different default subvolume, so
it takes effect at the next boot and not before. It also does nothing at all if
`/etc/fstab` names the subvolume it mounts at `/`, which overrules the default;
where that is the case Wisp says so instead of letting the reboot say it.

---

## Preferences

```sh
gnome-extensions prefs wisp@epogonii.github.io
```

Five pages, in the order the window shows them.

### Appearance

| Setting | Meaning |
| --- | --- |
| Position | Which end of the top bar the indicator sits at |
| Place | Counted from that end; zero is outermost |
| Show the indicator | Always, or only when snapper is set up |
| Middle click | Nothing, take a snapshot, or open these settings |
| Snapshots listed | How many of the newest each config shows |
| Dates | How long ago, or the date and time |
| Show the cleanup rule | What decides when snapper removes each snapshot on its own |
| Ask before showing the list | Never, when it has been a while, or every time |
| Ask again after | Minutes since the menu was last unlocked |

### Snapshots

| Setting | Meaning |
| --- | --- |
| Configs | One row per config, with the subvolume it snapshots; a new one can be set up and an existing one deleted |
| Show in the menu | Keep a config out of the top bar without changing anything about it |
| This account may use it | Whether the config is readable without a password, and the button that makes it so |
| Timeline snapshots | Whether snapper keeps a timeline, and how many hourly, daily, weekly, monthly, quarterly and yearly ones survive |
| Keep a fixed number | For the pairs taken around installs and upgrades; the ones marked important are counted separately |

### Schedule

| Setting | Meaning |
| --- | --- |
| Take timeline snapshots | `snapper-timeline.timer`, one an hour |
| Clear out old snapshots | `snapper-cleanup.timer`, which is what enforces the limits |
| Snapshot at boot | `snapper-boot.timer`, one the first time the machine comes up each day |
| Balance, scrub, defragment, trim | How often btrfsmaintenance runs each one |

### Storage

| Reading | Meaning |
| --- | --- |
| Size, handed out to chunks, written, free | What the filesystem under each config is doing |
| Data, metadata, system | The same per chunk type, which is where a full-but-not-full btrfs shows itself |

### About

The version, the project page, where to report something, and the links below.

---

## Reporting issues

Include, please:

- Extension version
- GNOME Shell version and your distribution
- `snapper --version`, and whether `systemctl status snapperd.service` says it
  is answering
- `journalctl --user -b 0 -o cat /usr/bin/gnome-shell | grep -i wisp`
- A screenshot where it makes sense

---

## Support

The extension is free and stays free. If it earned a coffee:

<p align="center">
  <a href="https://github.com/sponsors/epogonii"><img alt="Sponsor on GitHub" src="https://img.shields.io/badge/%E2%9D%A4%20Sponsor%20on%20GitHub-ea4aaa?style=for-the-badge&logo=githubsponsors&logoColor=white"></a>
  <a href="https://www.paypal.com/paypalme/pogonii"><img alt="Buy me a coffee" src="https://img.shields.io/badge/%E2%98%95%20Buy%20me%20a%20coffee-003087?style=for-the-badge&logo=paypal&logoColor=white"></a>
</p>

| | |
| --- | --- |
| GitHub Sponsors | **[github.com/sponsors/epogonii](https://github.com/sponsors/epogonii)**, monthly or one time |
| PayPal | **[paypal.me/pogonii](https://www.paypal.com/paypalme/pogonii)** |
| Bitcoin | `18KtJEw8gt2oyicszwMUkbAKMHHXS9nwKR` |
| Ethereum | `0x4f2fb6a154526a72d612afa2e3a8129e30ca0996` |
| Cardano | `DdzFFzCqrhsmpnmUqivufj3TmDzksP4HKzcksRUNVr8xA4Gbj7PngV6TfkZuqUqeeKxp138t2Ftd1HypLFkUQ8F1hGtEmyhTP9VnZcUt` |

The same links sit on the About page of the extension's preferences.

---

## License

GPL-2.0-or-later, see [LICENSE](LICENSE).
