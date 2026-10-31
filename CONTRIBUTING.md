# Contributing

Thank you for wanting to help. Sonata is free and stays free, and it is built to a high standard: word timing is
measured, not eyeballed, and every change passes the same gates.

- **Bugs:** open an issue with the bug form. Starting Sonata from a terminal (`./Sonata.AppImage`) and pasting what
  it prints helps most; for word-timing problems, add About → For the Curious → *Copy for a bug report*.
- **Ideas:** open an issue and describe what you'd like. Ideas are collected in BACKLOG.md, the project's one list,
  and built when they fit the app's direction.
- **Security problems:** report them privately, never in a public issue (SECURITY.md).
- **Pull requests:** small and focused, one change each, against the `dev` branch. Before opening one:
  - `npm test` (the unit tests, plain Node: no Electron, display or sound) and `npm run gates` (the verdict, AST,
    hardcode, version and documentation gates) must pass; CI runs both on every push and pull request.
    `git config core.hooksPath .hooks` runs the quick code gates before each commit;
  - a fix comes with a test that fails without it;
  - every loop, timer, listener, catch and cache in a shipped file carries its verdict comment
    (`// loop:`, `// lifetime:`, `// error:`, `// cache:`; CLAUDE.md, Verdicts);
  - colours come only from the theme system (`--s-*` tokens from theme.js), and a version or name shown to people
    comes only from version-display.js;
  - a change people can notice updates CHANGELOG.md `[Unreleased]`, the README and the in-app help it touches;
  - a new app file is added to `build.files` in package.json, or the AppImage won't load it;
  - checks that start the app run on an isolated copy (`tools/isolated.sh`), never on your everyday profile;
  - the rest of the project's conventions are in CLAUDE.md.
- Reviews can take some days. Changes that don't fit the app's direction may be declined, with a reason.

By contributing you agree that your contribution is released under this repository's licence (GPL-3.0, LICENSE).
