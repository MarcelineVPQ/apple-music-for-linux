# Changelog

Release notes for Sonata. A tag's GitHub release takes its notes from the
section named after its version (`## [X.Y.Z] — Short title`; the title after
the dash becomes the release title), or from `[Unreleased]` when there is none.
See docs/RELEASING.md.

## [Unreleased]

## [0.15.15] — Signed updates, Development channel, bigger album art

### Added

- **Update channel** (Settings → Updates): **Stable** (the default) gets tested releases; **Development** also gets newer development builds (`X.Y.Z-dev.N`) as soon as they're out. Stable never sees development builds.
- **Estimated word timing:** songs that only have line timing now follow the words too, with each line spread across its words. Marked "Word timing estimated"; Settings → *Estimated word timing* turns it off.

### Changed

- **Signed updates.** Sonata now only installs an update whose feed is signed with the project's Ed25519 key and whose download matches the feed's size and SHA-512. Anything else is refused and the reason is shown.
- **The album art is now a little vinyl record** in the lyrics window: bigger, your cover fills the middle with a grooved vinyl rim and a spindle hole, inside the progress ring.
- **Record speed** for *Spin album art like a record*: **Relaxed** (default, a calm turn) or **True** (33⅓ rpm for albums, 45 for singles and EPs, like the vinyl).
- Releases are published by the release workflow (development builds as prereleases), and the update feeds are generated and signed in CI, never by hand.

