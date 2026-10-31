<!-- Thank you! One focused change per pull request, against the dev branch. CONTRIBUTING.md has the details. -->

## What this changes

<!-- What it does and why, in a few lines. Link the issue if there is one (Fixes #123). -->

## How it was checked

- [ ] `npm test` passes (unit tests, plain Node)
- [ ] `npm run gates` passes (verdicts, AST passes, hardcodes, version, documentation gates)
- [ ] A fix comes with a test that fails without it
- [ ] New loops, timers, listeners, catches and caches in shipped files carry their verdict comments
- [ ] User-facing changes update CHANGELOG.md `[Unreleased]`, the README and the in-app help they touch
- [ ] Checks that start the app ran on an isolated copy (`tools/isolated.sh`)

## Systems tried

<!-- Distribution and version, desktop (KDE, GNOME, …), Wayland or X11, and the graphics card if it matters. -->

By opening this pull request you agree that your contribution is released under this repository's licence (GPL-3.0, LICENSE).
