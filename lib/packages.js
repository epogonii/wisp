// SPDX-License-Identifier: GPL-2.0-or-later

// How this machine installs a package.
//
// Neither snapper nor btrfsmaintenance is installed by default on most of the
// distributions this extension will land on, and a window that only said a
// setting was unavailable would be telling the truth and helping nobody. So
// both halves of the extension can ask here for the line that fixes it.
//
// Nothing in this module is translated and nothing is imported from either
// half, because the two halves get their gettext from different places; the
// caller says what to show when the answer is null.

import GLib from 'gi://GLib';

// Keyed by ID and by ID_LIKE from os-release, so a derivative that does not
// name itself here is still matched through the family it says it belongs to.
const INSTALL = {
    fedora: 'sudo dnf install %s',
    rhel: 'sudo dnf install %s',
    centos: 'sudo dnf install %s',
    debian: 'sudo apt install %s',
    ubuntu: 'sudo apt install %s',
    arch: 'sudo pacman -S %s',
    opensuse: 'sudo zypper install %s',
    suse: 'sudo zypper install %s',
    gentoo: 'sudo emerge %s',
    void: 'sudo xbps-install -S %s',
    alpine: 'sudo apk add %s',
};

// Where a package is not simply called what it is called everywhere else.
// Gentoo wants the category. Nothing is guessed here: a package whose name
// differs somewhere this list does not mention would be an install line that
// does not work, which is worse than none.
const NAMES = {
    snapper: {gentoo: 'app-backup/snapper'},
    btrfsmaintenance: {gentoo: 'sys-fs/btrfsmaintenance'},
};

/**
 * @returns {string[]} what this system calls itself, most specific first
 */
function families() {
    const ids = [];
    for (const key of ['ID', 'ID_LIKE']) {
        const value = GLib.get_os_info(key);
        if (value)
            ids.push(...value.split(' '));
    }
    return ids;
}

/**
 * The command this distribution installs something with.
 *
 * @param {string} pkg - the package, by the name it usually goes by
 * @returns {string|null} a line that can be copied into a terminal, or null
 *   on a distribution this does not know
 */
export function installCommand(pkg) {
    for (const id of families()) {
        if (INSTALL[id])
            return INSTALL[id].replace('%s', NAMES[pkg]?.[id] ?? pkg);
    }
    return null;
}
