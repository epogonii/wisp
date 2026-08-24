#!/bin/bash
# Draws the QR code for every wallet address the About page shows.
#
# The addresses are read out of prefs.js, so they are written down once and the
# code and the text under it cannot drift apart. The codes are files rather
# than something drawn at runtime: an encoder is a few hundred lines of
# arithmetic that nobody reviewing the extension wants to read, and a wrong
# module in a QR code is money sent nowhere.
#
# The white background and the four-module quiet zone are in the file itself,
# so the code still scans on a dark theme and wherever the picture is shown
# without its plate.
#
# Run it after changing an address, and commit the SVGs with the change.
set -euo pipefail

cd "$(dirname "$0")/.."

mapfile -t wallets < <(sed -n '/^const WALLETS = \[/,/^\];/p' prefs.js \
    | sed -n "s/^\s*\['\([^']*\)', *'\([^']*\)'\].*$/\1\t\2/p")

if [[ ${#wallets[@]} -eq 0 ]]; then
    echo "no addresses found in prefs.js" >&2
    exit 1
fi

mkdir -p icons/qr

for wallet in "${wallets[@]}"; do
    name=${wallet%%$'\t'*}
    address=${wallet#*$'\t'}
    file="icons/qr/$(echo "$name" | tr '[:upper:] ' '[:lower:]-').svg"

    qrencode --type=SVG --level=M --size=8 --margin=4 \
        --foreground=000000 --background=FFFFFF \
        --output="$file" -- "$address"

    # The white behind the code is one rectangle the size of the whole drawing.
    # Rounding it is what keeps a hard white square off a dark settings page,
    # and it belongs in the file rather than in a stylesheet the picture may or
    # may not be shown under.
    sed -i 's|\(<rect x="0" y="0" width="[0-9]*" height="[0-9]*"\) fill="#ffffff"|\1 rx="2" fill="#ffffff"|' "$file"

    # What matters is what a phone reads off the shipped file, not what was
    # handed to the encoder, so the check goes through the SVG itself.
    if command -v magick >/dev/null && command -v zbarimg >/dev/null; then
        read_back=$(magick "$file" png:- | zbarimg --quiet --raw - | head -1)
        if [[ $read_back != "$address" ]]; then
            echo "$file does not read back as the $name address" >&2
            exit 1
        fi
        echo "$file  $name  scans"
    else
        echo "$file  $name  (install ImageMagick and zbar to have it checked)"
    fi
done
