# Flathub submission

`io.github.MarcelineVPQ.Sonata.yml` builds Sonata from the pinned castlabs
Electron binary plus the app source in this repo. The app has **no runtime npm
dependencies**, so no offline node-sources step is needed. Widevine is fetched
at runtime (network permission), not bundled.

The `git` source is pinned to a release tag + commit sha (bump both per
release). Verified locally with `flatpak-builder` (runtime 24.08,
Electron2.BaseApp): it builds, passes `appstreamcli compose`, exports the
desktop file / icon / metainfo under the app id, and launches through zypak.

## Prerequisite: the app-id namespace repo

Flathub's linter requires an `io.github.<user>.<name>` app id to resolve to a
real repo at `github.com/<user>/<name>`. The code lives in
`apple-music-for-linux` (and repo names can't be app ids — hyphens aren't
allowed), so create a companion repo **`github.com/MarcelineVPQ/sonata`** (a
short README linking here is enough). Without it, lint fails with
`appid-url-not-reachable`.

## Build and test locally

```bash
flatpak install flathub org.flatpak.Builder
flatpak run org.flatpak.Builder --user --force-clean --install \
  builddir packaging/flathub/io.github.MarcelineVPQ.Sonata.yml
flatpak run io.github.MarcelineVPQ.Sonata
```

Lint before submitting (Flathub runs these):

```bash
flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest packaging/flathub/io.github.MarcelineVPQ.Sonata.yml
flatpak run --command=flatpak-builder-lint org.flatpak.Builder repo repo
```

## Submitting to Flathub

1. Create `github.com/MarcelineVPQ/sonata` (see prerequisite above).
2. Fork [github.com/flathub/flathub](https://github.com/flathub/flathub) and
   create a branch named exactly `io.github.MarcelineVPQ.Sonata`.
3. Copy this `io.github.MarcelineVPQ.Sonata.yml` into the fork root, commit, push.
4. Open a PR against `flathub/flathub` `master`. The build bot lints and builds it;
   a reviewer follows up.

## Things reviewers will raise (be ready)

- **Trademark** — "Apple Music" as a wrapper. The neutral name (Sonata), original
  icon, and the disclaimer in the metainfo are there to address this, but expect
  questions.
- **DRM** — Widevine is proprietary; confirm it is downloaded at runtime, never
  redistributed. Note that castlabs Electron is a prebuilt binary (declared as a
  source with a checksum).
- **Real screenshots** — the metainfo references a real screenshot at
  `screenshots/lyrics-mini-player.png`; add more before submitting if you like.
