// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * How long ago something happened, short enough for a menu row.
 *
 * @param {GLib.DateTime} when - when it happened
 * @returns {string} something like "3 hours ago"
 */
export function ago(when) {
    if (!when)
        return '';

    const seconds = GLib.DateTime.new_now_local().difference(when) / GLib.TIME_SPAN_SECOND;

    if (seconds < MINUTE)
        return _('just now');
    if (seconds < HOUR) {
        const n = Math.round(seconds / MINUTE);
        return ngettext('%d minute ago', '%d minutes ago', n).format(n);
    }
    if (seconds < DAY) {
        const n = Math.round(seconds / HOUR);
        return ngettext('%d hour ago', '%d hours ago', n).format(n);
    }
    if (seconds < WEEK) {
        const n = Math.round(seconds / DAY);
        return ngettext('%d day ago', '%d days ago', n).format(n);
    }

    // Further back than that a date says more than a count does.
    return when.format('%e %b');
}

/**
 * The date in full, for the one place there is room for it.
 *
 * @param {GLib.DateTime} when - when it happened
 * @returns {string} the date and the time, in the locale's own order
 */
export function fullDate(when) {
    return when ? when.format('%A, %e %B %Y at %H:%M') : _('unknown');
}

/**
 * @param {number} bytes - a size
 * @returns {string} the same size in units a person reads
 */
export function size(bytes) {
    return GLib.format_size(bytes);
}
