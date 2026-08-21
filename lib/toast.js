// SPDX-License-Identifier: GPL-2.0-or-later

// A word about something that has just happened, said and then dropped.
//
// The shell's own OSD says it near the foot of the screen, which is where a
// volume or a brightness change belongs; a snapshot was asked for in the panel,
// and the answer reads better where the question was put. This is the same pill
// wearing the shell's own theme classes, so it matches the volume and
// brightness ones under any theme, placed under the panel instead of above the
// dock.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {wispIcon} from './icon.js';

// How long the pill stays up once it has arrived, in milliseconds, and how long
// it takes to arrive and to go. Long enough to be read on the way past, short
// enough that it is gone before it is in the way.
const LINGER = 2500;
const FADE = 200;

// How far it slides down as it arrives, in pixels. Small: it is coming from
// behind the panel, not across the screen.
const TRAVEL = 12;

// How far under the panel it sits.
const GAP = 12;

// One pill, kept and reused. Two snapshots taken one after the other are two
// messages in the same place, not two pills stacked up.
let toast = null;

// Where the messages go is the user's to choose, so the setting has to be
// readable from the dialogs that send them - none of which is handed the
// extension's settings, and none of which should have to be.
let settings = null;

/**
 * @param {Gio.Settings} theSettings - the extension's own, while it is enabled
 */
export function watch(theSettings) {
    settings = theSettings;
}

/**
 * Says something the way this session asked for it to be said.
 *
 * @param {string} message - what to say
 * @param {Gio.Icon} [icon] - the icon in front of it, where there is a pill
 */
export function announce(message, icon = null) {
    if (settings?.get_string('message-style') === 'notification') {
        Main.notify(_('Wisp'), message);
        return;
    }

    show(message, icon);
}

/**
 * Says something briefly under the top panel.
 *
 * @param {string} message - what to say
 * @param {Gio.Icon} [icon] - the icon in front of it
 */
export function show(message, icon = null) {
    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor)
        return;

    if (!toast)
        toast = build();

    toast.label.text = message;
    toast.icon.gicon = icon ?? wispIcon();

    // How wide the pill is depends on what it says, so where it starts can only
    // be worked out once it is holding the message.
    toast.actor.remove_all_transitions();
    toast.actor.show();
    toast.actor.ensure_style();
    const [, width] = toast.actor.get_preferred_width(-1);
    toast.actor.set_position(
        Math.round(monitor.x + (monitor.width - width) / 2),
        Math.round(monitor.y + Main.layoutManager.panelBox.height + GAP));

    toast.actor.opacity = 0;
    toast.actor.translation_y = -TRAVEL;
    toast.actor.ease({
        opacity: 255,
        translation_y: 0,
        duration: FADE,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });

    if (toast.timer)
        GLib.source_remove(toast.timer);
    toast.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LINGER, () => {
        toast.timer = 0;
        hide();
        return GLib.SOURCE_REMOVE;
    });
}

/**
 * Takes the pill away, if there is one. Called when the extension is switched
 * off, since a message left on the screen by an extension that is no longer
 * running would have nothing behind it.
 */
export function destroy() {
    settings = null;
    if (!toast)
        return;

    if (toast.timer)
        GLib.source_remove(toast.timer);
    Main.layoutManager.removeChrome(toast.actor);
    toast.actor.destroy();
    toast = null;
}

/**
 * @returns {object} the pill, its icon and its label
 */
function build() {
    const actor = new St.BoxLayout({
        style_class: 'osd-window wisp-toast',
        // It is a message and not a control: a click on it belongs to whatever
        // is underneath.
        reactive: false,
    });
    const icon = new St.Icon({y_align: Clutter.ActorAlign.CENTER});
    const label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
    actor.add_child(icon);
    actor.add_child(label);
    actor.hide();

    // Above every window, including popups. Nothing is said about the input
    // region: the shell works that out from what is reactive, and this is not.
    Main.layoutManager.addTopChrome(actor);
    return {actor, icon, label, timer: 0};
}

/**
 * Fades the pill back out and leaves it built, ready for the next message.
 */
function hide() {
    toast.actor.remove_all_transitions();
    toast.actor.ease({
        opacity: 0,
        translation_y: -TRAVEL,
        duration: FADE,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => toast?.actor.hide(),
    });
}
