// SPDX-License-Identifier: GPL-2.0-or-later

// The extension's own icon, wanted in the panel and in the pill that says a
// snapshot has been taken. It ships with the extension rather than being looked
// up by name, so it is the same drawing on a machine whose icon theme has never
// heard of it - and being a file, it has to be found relative to wherever the
// extension was installed.

import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const ICON = 'icons/hicolor/scalable/actions/wisp-symbolic.svg';

/**
 * @returns {Gio.Icon} the extension's own symbolic icon, or the nearest thing
 *   the icon theme has if the extension cannot be found from here
 */
export function wispIcon() {
    const extension = Extension.lookupByURL(import.meta.url);
    return extension
        ? Gio.icon_new_for_string(`${extension.path}/${ICON}`)
        : new Gio.ThemedIcon({name: 'drive-harddisk-symbolic'});
}
