#!/bin/bash
# Builds the zip that goes to extensions.gnome.org.
#
# The zip holds the extension and nothing else: no measuring tools, no
# overnight reader, no test stand, no repository furniture. A reviewer reads
# every line of what is uploaded, and every line that is not the extension is
# a line of their time spent on something that does not run.
set -euo pipefail

src=$(cd "$(dirname "$0")/.." && pwd)
out=$src/wisp.zip
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cd "$src"
python3 tools/gen-stylesheets.py >/dev/null

while read -r f; do
    mkdir -p "$work/$(dirname "$f")"
    cp "$f" "$work/$f"
done < <(grep -v '^\s*\(#\|$\)' tools/files.txt)

# The site compiles the schemas itself, and a stale gschemas.compiled in the
# zip is one of the things it will refuse. The source xml is what goes.
glib-compile-schemas --strict --dry-run schemas

shopt -s nullglob
for po in po/*.po; do
    lang=$(basename "$po" .po)
    mkdir -p "$work/locale/$lang/LC_MESSAGES"
    msgfmt "$po" -o "$work/locale/$lang/LC_MESSAGES/wisp.mo"
done

rm -f "$out"
(cd "$work" && zip -q -r -X "$out" .)

printf '%s\n' "$out"
unzip -l "$out" | tail -n +4 | head -n -2 | awk '{print "  " $4}'
printf '%s\n' "$(du -h "$out" | cut -f1)"
