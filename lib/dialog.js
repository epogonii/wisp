// SPDX-License-Identifier: GPL-2.0-or-later

// The pieces the extension's dialogs are made of. The shell gives a modal
// dialog a frame, a place for content and a row of buttons, and nothing for
// what goes between; these are that, in the shape libadwaita uses for the
// same job so that a dialog raised from the panel looks like one raised from
// Settings.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {attachEditing} from './keys.js';

// St.BoxLayout was laid out by a plain boolean until GNOME 48 named the
// property after Clutter's orientation enum. Spread this instead of writing
// either one, so the same box works on both.
export const VERTICAL = 'orientation' in St.BoxLayout.prototype
    ? {orientation: Clutter.Orientation.VERTICAL}
    : {vertical: true};

// How long the stripe in a waiting bar takes to cross it. Long enough to read
// as movement rather than as a flicker, short enough that it is back where it
// started before anybody wonders whether it has stopped.
const WAIT_CYCLE = 1400;

// How much of the bar the stripe takes up.
const WAIT_STRIPE = 0.35;

// How short the stripe is allowed to get, in pixels, for a bar narrow enough
// that a share of it would be a dot.
const WAIT_MIN = 24;

/**
 * Makes a label take a second line rather than make the window wider.
 *
 * Two things have to be said for that and not one. St.Label ellipsizes by
 * default and Pango honours an ellipsis before it honours a wrap, so the
 * ellipsis goes first; and the wrap has to be allowed to break inside a word,
 * because a description here is a snapper description and nothing says it
 * holds a space - the long ones tend not to.
 *
 * @param {St.Label} label - the label to wrap
 * @returns {St.Label} the same label, so it can be wrapped where it is made
 */
export function wrap(label) {
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    return label;
}

/**
 * A small button that reads as one: an icon, a word, and a background of its
 * own. For the offers that sit beside something else rather than in a row of
 * their own - taking a snapshot next to a config's name, picking or dropping a
 * selection over a list of files.
 *
 * @param {string} label - what it says
 * @param {string} iconName - the icon in front of it
 * @param {Function} onClick - what pressing it does
 * @returns {St.Button} the button
 */
export function pill(label, iconName, onClick) {
    const box = new St.BoxLayout();
    box.add_child(new St.Icon({
        icon_name: iconName,
        y_align: Clutter.ActorAlign.CENTER,
    }));
    box.add_child(new St.Label({
        text: label,
        y_align: Clutter.ActorAlign.CENTER,
    }));

    const button = new St.Button({
        style_class: 'wisp-pill',
        child: box,
        can_focus: true,
        reactive: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    button.connect('clicked', () => onClick());
    return button;
}

/**
 * Turns a button on or off, including the look of it: St leaves the greyed-out
 * state to whoever set the button unreactive.
 *
 * @param {St.Button} button - the button
 * @param {boolean} on - whether it can be pressed
 */
export function enable(button, on) {
    button.reactive = on;
    button.can_focus = on;
    if (on)
        button.remove_style_pseudo_class('insensitive');
    else
        button.add_style_pseudo_class('insensitive');
}

/**
 * The bar under a dialog that is waiting for an answer.
 *
 * snapper answers a comparison in one call and says nothing at all until it
 * has the answer, so there is no progress to report and nothing honest to fill
 * a bar up with. What the stripe says is that the wait is still going, which
 * for a call that can take the better part of a minute is what somebody
 * looking at a still dialog wants to know.
 */
const WaitBar = GObject.registerClass(
class WaitBar extends St.Widget {
    _init() {
        super._init({
            style_class: 'wisp-wait',
            x_expand: true,
            layout_manager: new Clutter.BinLayout(),
        });

        this._stripe = new St.Widget({
            style_class: 'wisp-wait-stripe',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.FILL,
        });
        this.add_child(this._stripe);

        this._span = -1;
        this.connect('destroy', () => this._stripe.remove_all_transitions());
    }

    // How wide the bar is, is up to the dialog, and an actor laid out by its
    // parent hears about that at allocation and nowhere else: the width is not
    // one anybody set on it, so there is no notification to listen for. Waiting
    // for one is what left the stripe standing still - it was sized once, before
    // the bar had a width to take a share of, and so had nothing to slide
    // across. The stripe is handed a box rather than a width because setting a
    // width in the middle of a layout only asks for the layout to be done again.
    vfunc_allocate(box) {
        super.vfunc_allocate(box);

        const track = Math.floor(box.get_width());
        if (track <= 0)
            return;

        const stripe = Math.max(WAIT_MIN, Math.round(track * WAIT_STRIPE));
        this._stripe.allocate(new Clutter.ActorBox({
            x1: 0,
            y1: 0,
            x2: stripe,
            y2: box.get_height(),
        }));

        // Being laid out again at the same width must not start the slide over,
        // or the stripe stands at one end for as long as the wait lasts.
        const span = track - stripe;
        if (span === this._span)
            return;

        this._span = span;
        this._stripe.remove_all_transitions();
        this._stripe.translation_x = 0;
        this._slide(true);
    }

    _slide(forward) {
        this._stripe.ease({
            translation_x: forward ? this._span : 0,
            duration: WAIT_CYCLE,
            mode: Clutter.AnimationMode.EASE_IN_OUT_CUBIC,
            onComplete: () => this._slide(!forward),
        });
    }
});

/**
 * A group of rows, drawn as one rounded block.
 */
export const Card = GObject.registerClass(
class Card extends St.BoxLayout {
    _init(title = null) {
        super._init({...VERTICAL, x_expand: true});

        if (title) {
            this.add_child(new St.Label({
                text: title,
                style_class: 'wisp-card-title',
                x_align: Clutter.ActorAlign.START,
            }));
        }

        this._rows = new St.BoxLayout({
            ...VERTICAL,
            style_class: 'wisp-card',
            x_expand: true,
        });
        this.add_child(this._rows);
    }

    /**
     * Puts a row at the bottom of the block, with a hairline above it once
     * there is something for it to be separated from. St has no selector for
     * "every row but the first", so the line is an actor like any other.
     *
     * @param {Clutter.Actor} row - what to add
     * @returns {Clutter.Actor} the row, for the caller to keep
     */
    addRow(row) {
        if (this._rows.get_n_children() > 0)
            this._rows.add_child(new St.Widget({style_class: 'wisp-separator'}));
        this._rows.add_child(row);
        return row;
    }

    /**
     * Empties the block, leaving the title where it is.
     */
    clear() {
        this._rows.destroy_all_children();
    }
});

/**
 * A row: something named on the left, something to do about it on the right.
 */
export const Row = GObject.registerClass(
class Row extends St.BoxLayout {
    _init(title, {subtitle = null, control = null, styleClass = ''} = {}) {
        super._init({
            style_class: `wisp-row ${styleClass}`.trim(),
            x_expand: true,
        });

        const text = new St.BoxLayout({
            ...VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        text.add_child(new St.Label({
            text: title,
            style_class: 'wisp-row-title',
            x_align: Clutter.ActorAlign.START,
        }));
        if (subtitle) {
            this._subtitle = new St.Label({
                text: subtitle,
                style_class: 'wisp-row-subtitle',
                x_align: Clutter.ActorAlign.START,
            });
            wrap(this._subtitle);
            text.add_child(this._subtitle);
        }
        this.add_child(text);

        if (control) {
            control.y_align = Clutter.ActorAlign.CENTER;
            this.add_child(control);
        }
        this.control = control;
    }

    set subtitle(text) {
        if (this._subtitle)
            this._subtitle.text = text;
    }
});

/**
 * A row that is a switch, and reads as one to the whole row's worth of
 * pointer: a two-word label is a small target and the row is not.
 *
 * @param {string} title - what the switch is for
 * @param {object} options - subtitle, starting state and what to call
 * @returns {St.Button} the row
 */
export function switchRow(title, {subtitle = null, state = false, onToggle} = {}) {
    const toggle = new PopupMenu.Switch(state);
    const row = new Row(title, {subtitle, control: toggle});
    const button = new St.Button({
        child: row,
        style_class: 'wisp-row-button',
        x_expand: true,
        can_focus: true,
        reactive: true,
    });

    button.connect('clicked', () => {
        toggle.state = !toggle.state;
        onToggle?.(toggle.state);
    });
    button.toggle = toggle;
    button.row = row;
    return button;
}

/**
 * A row that is a line of text to be edited. The label sits above the entry
 * rather than beside it: a description is a sentence and wants the width.
 *
 * @param {string} title - what the text is
 * @param {object} options - the text to start from and what to call on change
 * @returns {St.BoxLayout} the row, with the entry on it
 */
export function entryRow(title, {text = '', hint = '', onActivate = null} = {}) {
    const row = new St.BoxLayout({
        ...VERTICAL,
        style_class: 'wisp-row wisp-row-entry',
        x_expand: true,
    });
    row.add_child(new St.Label({
        text: title,
        style_class: 'wisp-row-title',
        x_align: Clutter.ActorAlign.START,
    }));

    const entry = new St.Entry({
        style_class: 'wisp-entry',
        text,
        hint_text: hint,
        can_focus: true,
        x_expand: true,
    });
    if (onActivate)
        entry.clutter_text.connect('activate', () => onActivate(entry.text));
    attachEditing(entry);
    row.add_child(entry);

    row.entry = entry;
    return row;
}

/**
 * A row that does something when it is pressed.
 *
 * @param {string} title - what pressing it does
 * @param {object} options - subtitle, an icon for the right-hand side, action
 * @returns {St.Button} the row
 */
export function actionRow(title, {subtitle = null, icon = 'go-next-symbolic', styleClass = '', onActivate} = {}) {
    const row = new Row(title, {
        subtitle,
        control: icon ? new St.Icon({icon_name: icon, style_class: 'wisp-row-icon'}) : null,
        styleClass,
    });
    const button = new St.Button({
        child: row,
        style_class: 'wisp-row-button',
        x_expand: true,
        can_focus: true,
        reactive: true,
    });
    button.connect('clicked', () => onActivate?.());
    button.row = row;
    return button;
}

/**
 * The frame every dialog here shares: a heading, a body that can be scrolled
 * once it outgrows the screen, and the shell's own row of buttons.
 */
export const WispDialog = GObject.registerClass(
class WispDialog extends ModalDialog.ModalDialog {
    _init(title, description = null) {
        super._init({styleClass: 'wisp-dialog'});

        const heading = new Dialog.MessageDialogContent({title, description});
        // The shell wraps both of these already, but only between words, and
        // the description here carries a snapshot's own: one long word runs off
        // the side of the dialog instead of taking a second line.
        for (const label of heading.get_children()) {
            if (label instanceof St.Label)
                wrap(label);
        }
        this.contentLayout.add_child(heading);

        // A snapshot's file list has no useful upper bound, so the body of a
        // dialog scrolls rather than growing until it is off the screen.
        this._scroll = new St.ScrollView({
            style_class: 'wisp-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        this.body = new St.BoxLayout({
            ...VERTICAL,
            style_class: 'wisp-body',
            x_expand: true,
        });
        this._scroll.set_child(this.body);
        this.contentLayout.add_child(this._scroll);

        // A write started from a row can finish after the dialog has gone -
        // saving the description on the way out is the everyday case - and its
        // reply then has nowhere to be shown.
        this.connect('destroy', () => (this._gone = true));
    }

    /**
     * Clicking away from the dialog is another way of saying Escape.
     *
     * It says Escape rather than closing by itself, because Escape is not
     * always only a close: the dialog that waits for a password cancels what it
     * is waiting for, and a dialog that saves what was typed into it saves on
     * the way out. Whatever the dialog does when asked to go, it does here too.
     *
     * The press arrives here because the dialog covers the screen and a press
     * anywhere on it that nothing else took ends up on it; where it landed has
     * to be measured, because a press inside the dialog that nothing answered
     * arrives the same way.
     *
     * @param {Clutter.Event} event - the press
     * @returns {boolean} whether the press has been dealt with
     */
    vfunc_button_press_event(event) {
        const [x, y] = event.get_coords();
        const [left, top] = this.dialogLayout.get_transformed_position();
        const [width, height] = this.dialogLayout.get_transformed_size();
        if (x >= left && x < left + width && y >= top && y < top + height)
            return Clutter.EVENT_PROPAGATE;

        const escape = this.dialogLayout._buttonKeys?.[Clutter.KEY_Escape];
        if (escape?.action && escape.button.reactive)
            escape.action();
        else
            this.close();

        return Clutter.EVENT_STOP;
    }

    /**
     * Whether the dialog is still there.
     *
     * A reply from snapperd can arrive after it has been closed - saving a
     * description on the way out is the everyday case - and what the reply was
     * going to be written into has gone by then.
     *
     * @returns {boolean} whether anything here can still be written to
     */
    get alive() {
        return !this._gone;
    }

    /**
     * Says what is being waited for, and keeps a bar moving under it while the
     * wait lasts.
     *
     * @param {string} text - what is being waited for
     */
    wait(text) {
        if (this._gone)
            return;

        this.note(text);
        if (!this._wait) {
            this._wait = new WaitBar();
            this.contentLayout.insert_child_below(this._wait, this._note);
        }
    }

    /**
     * Takes the bar away. The note stays: what replaces it is the answer.
     */
    stopWait() {
        if (this._wait && !this._gone)
            this._wait.destroy();
        this._wait = null;
    }

    /**
     * A note under the body, for what went wrong or what is being waited for.
     *
     * @param {string} text - what to say
     * @param {boolean} [warning] - whether to say it in the warning colour
     */
    note(text, warning = false) {
        if (this._gone)
            return;

        if (!this._note) {
            this._note = new St.Label({style_class: 'wisp-note'});
            wrap(this._note);
            this.contentLayout.add_child(this._note);
        }
        this._note.text = text;
        this._note.visible = text !== '';
        if (warning)
            this._note.add_style_class_name('wisp-note-warning');
        else
            this._note.remove_style_class_name('wisp-note-warning');
    }
});

/**
 * Asks once, before something that cannot be taken back.
 */
export const ConfirmDialog = GObject.registerClass(
class ConfirmDialog extends WispDialog {
    _init({title, description, confirmLabel, danger = false, onConfirm}) {
        super._init(title, description);

        this.addButton({
            label: _('Cancel'),
            key: Clutter.KEY_Escape,
            action: () => this.close(),
        });
        const confirm = this.addButton({
            label: confirmLabel,
            action: () => {
                this.close();
                onConfirm();
            },
        });
        if (danger)
            confirm.add_style_class_name('wisp-danger');
    }
});
