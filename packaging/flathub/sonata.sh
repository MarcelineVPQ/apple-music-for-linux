#!/bin/sh
# Launch the bundled castlabs Electron through zypak (provided by
# org.electronjs.Electron2.BaseApp), which brokers Chromium's sandbox
# inside the Flatpak. Electron loads the app from resources/app.
exec zypak-wrapper /app/sonata/electron "$@"
