// SPDX-License-Identifier: GPL-2.0-or-later

// Running other programs, and running them as root.
//
// This module is imported by both halves of the extension, the one that runs
// inside gnome-shell and the one that runs in the preferences window, so it
// holds nothing that belongs to either: no St, no Adw, no gettext. The dialog
// that explains a privileged command before it runs lives in privileged.js,
// which is the shell's side of the same idea.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// pkexec's own exit codes, for the two endings that are not the program's.
export const DISMISSED = 126;
export const REFUSED = 127;

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
 * every distribution has systemd, or polkit's command line tools, or snapper
 * itself, and a machine missing one of them should be told so rather than
 * watched from behind an exception; that comes back as MISSING.
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
 * The same, with polkit asking for a password first.
 *
 * @param {string[]} argv - program and arguments, never a shell line
 * @returns {Promise<{status: number, stdout: string, stderr: string}>} how it went
 */
export function pkexec(argv) {
    // Resolve a bare name here rather than leaving it to pkexec, so the
    // shell's PATH decides which program runs and the dialog shows that one.
    const [program, ...rest] = argv;
    return run(['pkexec', GLib.find_program_in_path(program) ?? program, ...rest]);
}

/**
 * What a failed command should be shown as.
 *
 * @param {{status: number, stderr: string}} result - what run gave back
 * @returns {string|null} the line worth showing, or null when it worked
 */
export function failure({status, stderr}) {
    if (status === 0)
        return null;
    if (status === DISMISSED)
        return null;
    if (status === REFUSED)
        return null;

    // snapper says what went wrong on stderr, usually in one line and
    // sometimes after a usage summary, so the last line is the useful one.
    const said = stderr.trim().split('\n').filter(line => line.trim()).pop();
    return said || `exit ${status}`;
}

/**
 * The command as it would be typed, for the people who would rather type it.
 *
 * @param {string[]} argv - program and arguments
 * @returns {string} one shell line
 */
export function commandLine(argv) {
    return ['sudo', ...argv]
        .map(word => /^[\w@%+=:,./-]+$/.test(word) ? word : GLib.shell_quote(word))
        .join(' ');
}
