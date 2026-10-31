# Security

## Supported versions

Only the latest release gets security fixes: the newest Stable release, and on the Development channel the newest
development build. Sonata updates itself, so staying current is the default.

## Getting Sonata safely

- Download the AppImage only from the [sonata-releases](https://github.com/MarcelineVPQ/sonata-releases/releases)
  repository. Every release is built by GitHub Actions and carries a build attestation
  (`gh attestation verify FILE -R MarcelineVPQ/sonata-releases`; docs/RELEASING.md, Build attestations).
- The app updates itself only from the signed feed in that repository: the feed must carry a valid Ed25519
  signature, and a download whose size or SHA-512 differs from the feed is refused (docs/RELEASING.md).
- The optional sonata-align helper (precise word timing) is a separate program, installed only when you ask for it
  (Settings → Precise timing). Its installer checks the size, SHA-256 and signature of what it downloads
  (docs/LEVEL2-ALIGN.md).

## In scope

- The Sonata app: its own windows and pages, what it injects into Apple's web player, its handling of settings,
  caches and the files it writes.
- The updater and its signed feeds (`latest.json`, `latest-dev.json`).
- The sonata-align helper's installer and update feed, and the way the app talks to the helper.

Apple's web player, Widevine, castlabs Electron and the third-party services Sonata can talk to (LRCLIB, Last.fm,
Discord, MusicBrainz, Wikidata, setlist.fm) are out of scope here; please report problems in them to their makers.

## Reporting a vulnerability

Please report it privately through GitHub: **Security → Report a vulnerability** on this repository, not in a public
issue. Include what you found, how to reproduce it, and the version (About shows it). You'll get an answer as soon as
possible; this is a free project, so please allow some days.
