#!/bin/bash
# Installs the extension into the live session. Every file lands under a
# temporary name first and is then renamed into place: a rename swaps the inode
# instead of rewriting bytes, so a shell that is running the old copy - and has
# schemas/gschemas.compiled memory-mapped - keeps a consistent view until it is
# restarted. Overwriting those bytes in place corrupts that view, and a lookup
# that then fails aborts the whole session.
set -euo pipefail

uuid=wisp@epogonii.github.io
src=$(cd "$(dirname "$0")/.." && pwd)
dst=${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid

install_file() {
    local from=$1 to=$2
    mkdir -p "$(dirname "$to")"
    cp "$from" "$to.tmp"
    mv -f "$to.tmp" "$to"
}

python3 "$src/tools/gen-stylesheets.py" >/dev/null

# tools/files.txt is the list, shared with the packing script so that the copy
# installed here and the copy uploaded are made of the same files. LICENSE is
# among them: the copy on disk should carry the terms it is given under.
while read -r f; do
    install_file "$src/$f" "$dst/$f"
done < <(grep -v '^\s*\(#\|$\)' "$src/tools/files.txt")

glib-compile-schemas --targetdir "$src/schemas" "$src/schemas"
install_file "$src/schemas/gschemas.compiled" "$dst/schemas/gschemas.compiled"

# Translations, for whichever languages have been finished. A language with no
# po file at all is the usual case at the moment and leaves the loop empty.
shopt -s nullglob
for po in "$src"/po/*.po; do
    lang=$(basename "$po" .po)
    msgfmt "$po" -o "$src/po/$lang.mo"
    install_file "$src/po/$lang.mo" "$dst/locale/$lang/LC_MESSAGES/wisp.mo"
    rm -f "$src/po/$lang.mo"
done

echo "installed to $dst"
echo "log out and back in - a running shell keeps the old code in memory"
