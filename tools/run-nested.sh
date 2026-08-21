#!/bin/bash
# Opens GNOME Shell in a window of its own with the current source installed.
# A running shell imports an extension's JavaScript once and keeps it for as
# long as the process lives, so code changes never reach the session that is
# already up; a nested shell is a new process.
#
# Shell 50 changed both halves of how this used to be run. --nested is gone
# and --devkit is what asks for a nested shell now; plain --wayland reaches
# for the seat and is refused, the session already having it. And the nested
# shell will not start on a bus where org.gnome.Shell is taken, which on the
# session bus it always is, so it gets a bus of its own.
#
# The bus of its own is a session bus, and snapperd answers on the system bus,
# so the snapshots and everything done to them are the real ones. Which is the
# other half of what this is for and the half to be careful with: a delete
# pressed twice in here deletes for good.
#
# Without the mutter-devkit package installed there is no window and the shell
# runs headless. It still loads, so its state and its log still say whether the
# code is sound, but nothing can be looked at or clicked.
set -euo pipefail

src=$(cd "$(dirname "$0")/.." && pwd)
"$src/tools/install-local.sh"

exec dbus-run-session -- gnome-shell --devkit \
    --wayland-display "${NESTED_DISPLAY:-wisp-nested}"
