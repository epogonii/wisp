// SPDX-License-Identifier: GPL-2.0-or-later

// Running other programs, and spelling out the ones the user runs as root.
//
// This module is imported by both halves of the extension, the one that runs
// inside gnome-shell and the one that runs in the preferences window, so it
// holds nothing that belongs to either: no St, no Adw, no gettext. Nothing in
// here runs anything as root.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Not an exit status at all: nothing ran, because the program this machine
// was asked for is not on it. Exit statuses are 0 to 255, so a negative
// number cannot be mistaken for one.
export const MISSING = -2;

/**
 * Whether a program is installed.
 *
 * @param {string} program - its name, or an absolute path to it
 * @returns {boolean} true when it is there and executable
 */
export function have(program) {
    return GLib.find_program_in_path(program) !== null;
}

/**
 * Runs one program and waits for it.
 *
 * A program that is not installed is not a failure of this code either. Not
 * every distribution has findmnt, or snapper itself, and a machine missing one
 * of them should be told so rather than watched from behind an exception; that
 * comes back as MISSING.
 *
 * @param {string[]} argv - program and arguments, never a shell line
 * @returns {Promise<{status: number, stdout: string, stderr: string}>} how it
 *   went, with a non-zero status left for the caller to read rather than
 *   thrown: a command that failed for a reason worth showing is not an error
 *   in the code that ran it
 */
export function run(argv) {
    return new Promise((resolve, reject) => {
        if (!have(argv[0])) {
            resolve({
                status: MISSING,
                stdout: '',
                stderr: `${argv[0]}: not installed`,
            });
            return;
        }

        try {
            const proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (p, result) => {
                try {
                    const [, stdout, stderr] = p.communicate_utf8_finish(result);
                    resolve({
                        status: p.get_exit_status(),
                        stdout: stdout ?? '',
                        stderr: stderr ?? '',
                    });
                } catch (error) {
                    reject(error);
                }
            });
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * The command as it would be typed, for the people who would rather type it.
 *
 * The line is the command alone. How it is run as root is the user's choice,
 * and the words shown next to it say that it needs root.
 *
 * @param {string[]} argv - program and arguments
 * @returns {string} one shell line
 */
export function commandLine(argv) {
    return argv
        .map(word => /^[\w@%+=:,./-]+$/.test(word) ? word : GLib.shell_quote(word))
        .join(' ');
}
