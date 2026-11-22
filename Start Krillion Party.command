#!/bin/bash
# Double-click this file to start Krillion Party.
cd "$(dirname "$0")" || exit 1
echo "🦐  Starting Krillion Party..."
echo

pause_and_exit() { echo; read -n 1 -s -r -p "Press any key to close this window."; exit 1; }

if ! command -v node >/dev/null 2>&1; then
  echo "Krillion Party needs Node.js (a free helper program) and it isn't installed yet."
  echo "A web page is opening: download the LTS version, install it, then double-click this file again."
  open "https://nodejs.org/en/download"
  pause_and_exit
fi

if [ "$(node -p 'parseInt(process.versions.node)')" -lt 20 ]; then
  echo "Your Node.js is too old. Krillion Party needs version 20 or newer."
  echo "A web page is opening: download the LTS version, install it, then double-click this file again."
  open "https://nodejs.org/en/download"
  pause_and_exit
fi

if [ ! -d "/Applications/Google Chrome.app" ]; then
  echo "Note: Google Chrome was not found. Krillion Party plays the game through Chrome."
  echo "Opening the Chrome download page. Install it, then start this again if the game can't begin."
  echo
  open "https://www.google.com/chrome/"
fi

if [ ! -d node_modules/playwright-core ] || [ ! -d node_modules/qrcode ]; then # also repairs an interrupted first setup
  echo "First start: setting things up (about a minute)..."
  npm install --omit=dev --no-audit --no-fund || { echo "Setup failed. Are you connected to the internet?"; pause_and_exit; }
  echo
fi

node src/index.js
echo
read -n 1 -s -r -p "Krillion Party has stopped. Press any key to close this window."
