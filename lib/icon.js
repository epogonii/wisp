// SPDX-License-Identifier: GPL-2.0-or-later

// The extension's own icon, wanted in the panel and in the pill that says a
// snapshot has been taken. It ships with the extension rather than being looked
// up by name, so it is the same drawing on a machine whose icon theme has never
// heard of it - and being a file, it has to be found relative to wherever the
// extension was installed.
//
// Which directory that is, only the extension object knows, and there is no
// asking it from here: an extension is meant to hand its own path down rather
// than have the shell look the extension back up by URL. So enable() says
// where, disable() takes it back, the same way the pill and the comparison
// window are told about the settings.

import Gio from 'gi://Gio';

const ICON = 'icons/hicolor/scalable/actions/wisp-symbolic.svg';

let path = null;

/**
 * @param {string} where - the directory the extension was installed in
 */
export function watch(where) {
    path = where;
}

/** Forgets it, for the next enable() to say again. */
export function forget() {
    path = null;
}

/**
 * @returns {Gio.Icon} the extension's own symbolic icon, or the nearest thing
 *   the icon theme has if nobody has said where to find it
 */
export function wispIcon() {
    return path
        ? Gio.icon_new_for_string(`${path}/${ICON}`)
        : new Gio.ThemedIcon({name: 'drive-harddisk-symbolic'});
}
