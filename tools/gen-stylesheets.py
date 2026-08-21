#!/usr/bin/env python3
"""Write the light and dark variants of stylesheet.css.

GNOME Shell 47 and later load stylesheet-light.css or stylesheet-dark.css in
place of stylesheet.css, and swap between them when the system does. A variant
replaces the base file rather than adding to it, so each one is written out in
full; the only lines that differ are the ones carrying a /* sh-var: NAME */
comment. An older shell finds no variant and keeps the neutral base.
"""

import re
import sys
from pathlib import Path

VARIANTS = {
    'dark': {
        'dim': 'rgba(255, 255, 255, 0.6)',
        'hover': 'rgba(255, 255, 255, 0.14)',
        'sunken': 'rgba(255, 255, 255, 0.08)',
        'line': 'rgba(0, 0, 0, 0.2)',
        'text': 'rgba(255, 255, 255, 0.95)',
        'danger': '#f85149',
        'destructive': '#c01c28',
        'added': '#57e389',
        'fresh': 'rgba(87, 227, 137, 0.14)',
        'accent': '#78aeed',
    },
    'light': {
        'dim': 'rgba(0, 0, 0, 0.55)',
        'hover': 'rgba(0, 0, 0, 0.1)',
        'sunken': 'rgba(0, 0, 0, 0.05)',
        'line': 'rgba(0, 0, 0, 0.1)',
        'text': 'rgba(0, 0, 0, 0.85)',
        'danger': '#cf222e',
        'destructive': '#e01b24',
        'added': '#2ec27e',
        'fresh': 'rgba(46, 194, 126, 0.16)',
        'accent': '#1c71d8',
    },
}

MARKER = re.compile(r'/\* sh-var: (\w+) \*/')
COLOUR = re.compile(r'rgba\([^)]*\)|#[0-9a-fA-F]{6}')

root = Path(__file__).resolve().parent.parent
base = (root / 'stylesheet.css').read_text(encoding='utf-8')

names = set(MARKER.findall(base))
if not names:
    sys.exit('stylesheet.css carries no sh-var markers')

for variant, colours in VARIANTS.items():
    missing = names - colours.keys()
    if missing:
        sys.exit(f'{variant}: no colour for {sorted(missing)}')

    lines = []
    for line in base.splitlines():
        marker = MARKER.search(line)
        if marker:
            line = COLOUR.sub(colours[marker.group(1)], line, count=1)
        lines.append(line)

    out = root / f'stylesheet-{variant}.css'
    out.write_text('/* Generated from stylesheet.css by tools/gen-stylesheets.py.\n'
                   '   Edit the base file, then run the script. */\n\n'
                   + '\n'.join(lines) + '\n', encoding='utf-8')
    print(f'wrote {out.name}')
