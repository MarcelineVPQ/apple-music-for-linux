#!/usr/bin/env bash
# Launch Apple Music for Linux.
# Ubuntu's AppArmor blocks Chromium's unprivileged-userns sandbox, so unless
# chrome-sandbox is setuid root (sudo chown root:root && chmod 4755), fall
# back to running with the sandbox disabled.
cd "$(dirname "$(readlink -f "$0")")"

ELECTRON=./node_modules/electron/dist/electron
SANDBOX_HELPER=./node_modules/electron/dist/chrome-sandbox

if [ ! -u "$SANDBOX_HELPER" ] || [ "$(stat -c %U "$SANDBOX_HELPER")" != "root" ]; then
  export ELECTRON_DISABLE_SANDBOX=1
fi

exec "$ELECTRON" .
