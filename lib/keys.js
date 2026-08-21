// SPDX-License-Identifier: GPL-2.0-or-later

// A key press carries the symbol the active layout put on the key, so Ctrl+C
// typed on a Russian layout arrives as Cyrillic_es and matches nothing. GTK
// looks a shortcut up in every layout the keyboard has; the shell does not,
// and an extension cannot ask it to, so what is used instead is where the key
// sits. These are the two halves of that: is() for a shortcut of our own, and
// attachEditing() for the ones St.Entry was supposed to handle.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

// Keycodes as X counts them, which is the evdev code plus eight. The letters
// here are the four that editing shortcuts live on.
const POSITIONS = new Map([
    [Clutter.KEY_a, 38],
    [Clutter.KEY_c, 54],
    [Clutter.KEY_v, 55],
    [Clutter.KEY_x, 53],
]);

// The distance from a lower-case ASCII letter to its capital, which is what
// Shift turns the symbol into.
const CAPITAL = 32;

/**
 * Whether a key press is the given Latin letter, whatever layout typed it.
 *
 * @param {Clutter.Event} event - the key press
 * @param {number} keyval - the lower-case Latin key it is being compared to
 * @returns {boolean} whether the two are the same key
 */
export function is(event, keyval) {
    const symbol = event.get_key_symbol();
    if (symbol === keyval || symbol === keyval - CAPITAL)
        return true;

    // A symbol inside Latin-1 came off a Latin layout, and there the letter
    // that was typed is the letter that was meant even if the key sits
    // somewhere unusual - Dvorak is not Cyrillic, and Ctrl+. on it must stay
    // Ctrl+. rather than becoming the paste that lives on that key elsewhere.
    // Only a symbol from another script falls back to the position.
    return symbol > 0xff && event.get_key_code() === POSITIONS.get(keyval);
}

/**
 * Gives an entry the usual editing shortcuts on any keyboard layout.
 *
 * St.Entry and ClutterText match Ctrl+A, Ctrl+C, Ctrl+X and Ctrl+V against the
 * symbol as well, so on a non-Latin layout none of the four do anything at all.
 * All four are done here instead, on every layout and the same way the shell
 * does them, rather than half here and half there.
 *
 * @param {St.Entry} entry - the entry to fix
 */
export function attachEditing(entry) {
    const text = entry.clutter_text;

    text.connect('key-press-event', (_actor, event) => {
        if (!(event.get_state() & Clutter.ModifierType.CONTROL_MASK))
            return Clutter.EVENT_PROPAGATE;

        switch (true) {
        case is(event, Clutter.KEY_a):
            text.set_selection(0, -1);
            return Clutter.EVENT_STOP;
        case is(event, Clutter.KEY_c):
            copy(text);
            return Clutter.EVENT_STOP;
        case is(event, Clutter.KEY_x):
            copy(text);
            text.delete_selection();
            return Clutter.EVENT_STOP;
        case is(event, Clutter.KEY_v):
            paste(text);
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    });
}

/**
 * @param {Clutter.Text} text - the text being edited
 */
function copy(text) {
    const selection = text.get_selection();
    if (selection)
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, selection);
}

/**
 * @param {Clutter.Text} text - the text being edited
 */
function paste(text) {
    St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_clipboard, pasted) => {
        if (!pasted)
            return;

        // These fields are all one line long, and a clipboard holding several
        // would otherwise put the rest of them somewhere they cannot be seen.
        text.delete_selection();
        text.insert_text(pasted.replace(/\s*[\r\n]+\s*/g, ' '), text.get_cursor_position());
    });
}
