# Changelog

Release notes for Sonata. A tag's GitHub release takes its notes from the
section named after its version (`## [X.Y.Z] — Short title`; the title after
the dash becomes the release title), or from `[Unreleased]` when there is none.
See docs/RELEASING.md.

## [Unreleased]

### Added

- **Update channel** (Settings → Updates): **Stable** (the default) gets tested releases; **Development** also gets newer development builds (`X.Y.Z-dev.N`, GitHub prereleases) as soon as they're out. Stable never sees development builds. Switching checks for updates right away.

### Changed

- **Signed updates.** The self-updater reads a signed feed (`latest.json`, or `latest-dev.json` on Development) and refuses an update whose feed signature (Ed25519) doesn't verify or whose download doesn't match the feed's size and SHA-512; the log says why, and *Check for Updates…* shows it. Until the signing key is in the app (a later release), it keeps using the old update path, so nothing changes for you yet.
- Releases are published by the release workflow (development builds as prereleases), and the update feeds are generated and signed in CI, never by hand.
