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

// Not an exit status either: whoever asked has stopped waiting - the window
// being filled was closed - and the command was ended rather than left to
// finish into nothing.
export const CANCELLED = -3;

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
 * A cancellable ends the command as well as the wait for it. Cancelling only
 * the wait would leave the program running, and snapper asking btrfs to count
 * a whole filesystem is minutes of work that would then be spent for nobody -
 * and worse, spent in the way of the next window that asks the same question,
 * since snapperd answers one caller at a time.
 *
 * @param {string[]} argv - program and arguments, never a shell line
 * @param {Gio.Cancellable} [cancellable] - what says the answer is no longer
 *   wanted; the command is killed and the status comes back as CANCELLED
 * @returns {Promise<{status: number, stdout: string, stderr: string}>} how it
 *   went, with a non-zero status left for the caller to read rather than
 *   thrown: a command that failed for a reason worth showing is not an error
 *   in the code that ran it
 */
export function run(argv, cancellable = null) {
    return new Promise((resolve, reject) => {
        if (!have(argv[0])) {
            resolve({
                status: MISSING,
                stdout: '',
                stderr: `${argv[0]}: not installed`,
            });
            return;
        }

        if (cancellable?.is_cancelled()) {
            resolve({status: CANCELLED, stdout: '', stderr: ''});
            return;
        }

        try {
            const proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            const cancelId = cancellable
                ? cancellable.connect(() => proc.force_exit())
                : 0;
            proc.communicate_utf8_async(null, cancellable, (p, result) => {
                if (cancelId)
                    cancellable.disconnect(cancelId);

                try {
                    const [, stdout, stderr] = p.communicate_utf8_finish(result);
                    resolve({
                        status: p.get_exit_status(),
                        stdout: stdout ?? '',
                        stderr: stderr ?? '',
                    });
                } catch (error) {
                    // Being cancelled is not a fault to report: it is this
                    // code's own doing, and the caller already knows why.
                    if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        resolve({status: CANCELLED, stdout: '', stderr: ''});
                        return;
                    }

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
    return run(['pkexec', ...argv]);
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
    if (status === CANCELLED)
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
