#!/bin/bash
# Rebuilds po/wisp.pot from the sources, and brings every translation up to it.
#
# The list of sources is tools/files.txt, the same list the install and the zip
# are built from, filtered down to the JavaScript in it. Keeping one list means
# a new file is translatable as soon as it ships, and there is no second list
# to forget to add it to.
#
# Run it after changing any string, and commit the pot and the merged po files
# with the change.
set -euo pipefail

cd "$(dirname "$0")/.."

version=$(python3 -c 'import json; print(json.load(open("metadata.json"))["version-name"])')
mapfile -t sources < <(grep -v '^\s*\(#\|$\)' tools/files.txt | grep '\.js$')

# xgettext writes a header full of placeholders - SOME DESCRIPTIVE TITLE, and
# a fuzzy marker that makes msgfmt skip the whole file - so it is replaced
# below. It cannot simply be left out: with no header there is no charset line,
# and xgettext then writes the pot as ASCII and drops every typographic
# apostrophe and ellipsis in the strings.
xgettext \
    --from-code=UTF-8 \
    --language=JavaScript \
    --keyword=_ \
    --keyword=ngettext:1,2 \
    --add-comments=TRANSLATORS \
    --sort-by-file \
    --package-name=Wisp \
    --package-version="$version" \
    --msgid-bugs-address=https://github.com/epogonii/wisp/issues \
    --output=po/wisp.pot \
    "${sources[@]}"

python3 - <<'PYTHON'
import re

with open('po/wisp.pot', encoding='utf-8') as f:
    header, body = f.read().split('\n\n', 1)

created = re.search(r'"POT-Creation-Date:.*?\\n"', header).group(0)
fields = re.search(r'"Project-Id-Version:.*?\\n"', header).group(0)
bugs = re.search(r'"Report-Msgid-Bugs-To:.*?\\n"', header).group(0)

with open('po/wisp.pot', 'w', encoding='utf-8') as f:
    f.write('\n'.join([
        '# Wisp, a GNOME Shell extension for snapper snapshots.',
        '# This file is distributed under the same terms as Wisp itself.',
        '#',
        'msgid ""',
        'msgstr ""',
        fields,
        bugs,
        created,
        '"Last-Translator: NAME <EMAIL>\\n"',
        '"Language-Team: none\\n"',
        '"Language: \\n"',
        '"MIME-Version: 1.0\\n"',
        '"Content-Type: text/plain; charset=UTF-8\\n"',
        '"Content-Transfer-Encoding: 8bit\\n"',
        '"Plural-Forms: nplurals=INTEGER; plural=EXPRESSION;\\n"',
        '',
        body,
    ]))
PYTHON

shopt -s nullglob
for po in po/*.po; do
    msgmerge --quiet --update --backup=none --previous "$po" po/wisp.pot
    # -c is the reason this runs here: it catches a translation whose %d or %s
    # do not match the original, which would otherwise be a crash in whichever
    # language it is.
    msgfmt -c --statistics -o /dev/null "$po"
done

printf 'po/wisp.pot: %d messages\n' "$(grep -c '^msgid "' po/wisp.pot)"
