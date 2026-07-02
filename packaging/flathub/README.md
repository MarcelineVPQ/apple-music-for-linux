# Flathub submission

`io.github.MarcelineVPQ.Sonata.yml` builds Sonata from the pinned castlabs
Electron binary plus the app source in this repo. The app has **no runtime npm
dependencies**, so no offline node-sources step is needed. Widevine is fetched
at runtime (network permission), not bundled.

Verified locally with `flatpak-builder` (runtime 24.08, Electron2.BaseApp): it
builds, passes `appstreamcli compose`, exports the desktop file / icon /
metainfo under the app id, and launches through zypak.

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

1. Fork [github.com/flathub/flathub](https://github.com/flathub/flathub), branch off `master`.
2. Add `io.github.MarcelineVPQ.Sonata.yml` (copy this manifest). Pin the `git`
   source to a **tag and its commit sha** for reproducibility, e.g.:
   ```yaml
   - type: git
     url: https://github.com/MarcelineVPQ/apple-music-for-linux.git
     tag: v0.10.0
     commit: <full-sha-of-that-tag>
   ```
   The tag must include `packaging/flathub/` (launcher + desktop) and the
   `*.metainfo.xml`. Bump both fields on every release.
3. Open a PR. A reviewer (and the build bot) will check it.

## Things reviewers will raise (be ready)

- **Trademark** — "Apple Music" as a wrapper. The neutral name (Sonata), original
  icon, and the disclaimer in the metainfo are there to address this, but expect
  questions.
- **DRM** — Widevine is proprietary; confirm it is downloaded at runtime, never
  redistributed. Note that castlabs Electron is a prebuilt binary (declared as a
  source with a checksum).
- **Real screenshots** — the metainfo currently points at the icon as a
  placeholder; add actual app screenshots hosted in the repo before submitting.
