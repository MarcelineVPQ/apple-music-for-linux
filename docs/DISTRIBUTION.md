# Distributing Sonata through KDE Discover

Research of 2026-10-15, against Sonata 0.15.16 (`main.js`, `package.json`, the workflows, the metainfo).
Goal: Sonata installs and updates from KDE Discover with as few hoops as possible. Sources are at
the end; **(?)** marks a claim no source confirmed, which needs a test.

## Recommendation

**Publish Sonata's own Flatpak repository on GitHub Pages, signed by CI, and give users one
`sonata.flatpakref` link.** Clicking it opens Discover (`org.kde.discover.desktop` handles
`application/vnd.flatpak.ref`; checked on Plasma 6.6.6). Discover adds the `sonata` remote and Flathub
for the runtime, then installs Sonata. After that, Discover lists Sonata like any other app and shows
its updates in the normal update notification.

Why this route:

- **No gatekeeper.** No review, no account, no policy that can block a release. Releases go out from
  the existing `release.yml` the same way the AppImage and the signed feed do.
- **Flathub's 2026 AI policy is the biggest problem.** Flathub requires you to disclose AI-generated
  code (77 of Sonata's 121 commits carry `Co-Authored-By: Claude`), and reviewers may reject a
  submission over it without further review. The Flathub manifest must contain no AI-generated or
  AI-assisted content, even if disclosed. An AI agent may not open the PR or write its replies. That
  means Marcy hand-writes the manifest and handles the whole review herself, and it can still fail.
  This was most likely the "million hoops".
- **Smaller updates than the AppImage.** OSTree downloads only the files that changed. A Sonata
  release that touches only `app.asar` costs a few MB, not the 126 MB AppImage. Static deltas make
  it smaller still.
- **The Flathub door stays open.** The same manifest (rewritten by hand) can go to Flathub later.
  Flathub only rejects *third-party* submissions when upstream ships its own Flatpak. Upstream may
  still submit.

**Effort:** about 2–3 focused days: code changes ½–1 day, manifest and local build ½ day, CI, Pages
and signing ½–1 day, Discover install/update test ½ day. Marcy does three one-time things: set
Pages Source to *GitHub Actions*, create the GPG key with the commands below, and set one secret.

## Comparison

| Route | Effort | Hoops | Reach in Discover | Updates | Risks |
|---|---|---|---|---|---|
| **Own Flatpak repo (GitHub Pages)** | 2–3 days, then automatic | Enable Pages, one GPG key + secret | Every distro with the Flatpak backend (Kubuntu, Fedora KDE, openSUSE, Arch, neon, SteamOS). The user clicks the `.flatpakref` link once; Sonata is not in search until then | Discover update notifications; Discover's automatic updates if enabled; file-level, small | Pages limits (1 GB site, 100 GB/month soft); GPG key loss means users must re-add the remote; Widevine in the sandbox needs a test |
| Flathub | Same packaging work + hand-written manifest + review (volunteers, weeks) | GenAI disclosure + human-only manifest/PR; "not a simple web wrapper" proof; trademark check; GitHub 2FA; each update is a PR to `flathub/io.github.MarcelineVPQ.Sonata` (the checker bot can open it) | Best: searchable by name in Discover, GNOME Software, Bazaar; "verified" badge via GitHub login (`io.github.` ID) | Same as above | Rejection over AI content (policy tightened 2026-09-04); removal later "if found to violate any policy"; Development builds only via flathub-beta |
| Snap Store | 1 day (`electron-builder --linux snap` exists in `package.json`) | Snapcraft account, name registration, manual review for the `mpris` slot named `chromium` | Only where snapd + Discover's snap backend exist (Kubuntu/Ubuntu); not Fedora/Arch/openSUSE by default | Automatic (snapd) | Trademark dispute over Apple naming (the old upstream snap is called "Apple Music"); low reach among KDE users |
| OBS (openSUSE Build Service) | 3–5 days (spec + debian packaging, castlabs binary as an uploaded source) | OBS account; per-distro build targets | After a terminal repo-add per distro, PackageKit shows updates in Discover | Distro package updates | Highest upkeep; users must add a repo and key by hand, not one-click |
| KDE Store (store.kde.org) | ½ day (upload the AppImage) | Account | **None.** Plasma 6.6.6 ships no apps `.knsrc` (only Plasma add-on categories); Discover shows no AppImages | None (the AppImage self-updates as today) | Just a web listing |
| AUR (`packaging/aur`) | Already written; PKGBUILD is stale (0.10.1) and **not published** (AUR RPC: 0 results) | AUR account + SSH key | Arch only; Discover doesn't show AUR | Via AUR helpers | Manual bump per release unless CI pushes |
| Status quo (AppImage) | 0 | None | None | In-app signed feed | Not in Discover |

## Flathub, in detail (for the record)

- **Allowed in principle.** Two close precedents are on Flathub:
  - `com.mastermindzh.tidal-hifi`: a FLOSS, third-party castlabs-Electron wrapper of `listen.tidal.com`. Its manifest repackages its own AppImage release on `Electron2.BaseApp`.
  - `sh.cider.Cider`: a proprietary Apple Music client, repackaged from its `.deb`.

  Neither manifest does anything special for Widevine. castlabs' Component Updater downloads the
  CDM at runtime into the app's data, so it is never redistributed.
- **castlabs terms:** the ECS builds are VMP-signed for development. Production VMP signing (EVS) is
  for Windows/macOS only, because "the Linux Widevine CDM does not support VMP". Nothing extra is
  needed on Linux, and no castlabs clause blocks redistributing the Electron binary. Sonata ships
  the same binary as an AppImage today.
- **Hoops:**
  1. *Generative AI policy*: disclosure, a human-only manifest, and no AI-run PR or replies. This is the
     likely blocker.
  2. *"Simple web wrapper applications … without significant polish … will not be accepted"*. Sonata's
     tray, mini player, lyrics, visualizer, Last.fm and Discord should clear this, but it is up to
     the reviewer.
  3. *Trademarks*: the name "Sonata" is free on Flathub and Snap. Never use Apple's logo. "Apple Music"
     appears only descriptively, as in the current summary.
  4. *Build offline from listed sources*: the TIDAL/Cider pattern of downloading the release
     AppImage with a checksum.
  5. *No self-updater*, *minimal static permissions*, *metainfo quality* (screenshots, releases, OARS).
  6. *Review*: open a PR against `flathub/flathub` branch `new-pr`, answer the volunteers, `bot, build`,
     merge in batches. Then 2FA, and accept the repo invite within a week.
- **Verdict:** possible, but slow and uncertain, and it needs Marcy's own hands at every step.
  Revisit it once the own repo has run for a while. The manifest will already be proven, but it
  must be rewritten by hand for Flathub.

## Step-by-step plan: own Flatpak repo

### 1. Repo layout (all in this repo)

```
packaging/flatpak/
  io.github.MarcelineVPQ.Sonata.yml      # manifest (template: version + sha512 filled in by CI)
  sonata.sh                              # launcher -> zypak-wrapper
  sonata.flatpakref                      # one-click install (committed, holds the public key)
  sonata.flatpakrepo                     # "add the remote" file (same key)
  sonata-flatpak.gpg                     # public key, armored, for manual checks
  index.html                             # tiny landing page on Pages: Install button + manual command
.github/workflows/flatpak.yml            # build, sign, publish to Pages (called by release.yml)
```

Published site (`https://marcelinevpq.github.io/apple-music-for-linux/`):

```
repo/                    OSTree repo (archive-z2): refs app/io.github.MarcelineVPQ.Sonata/x86_64/{stable,dev}, appstream, summary
sonata.flatpakref        stable
sonata-dev.flatpakref    Development channel (optional, see open questions)
sonata.flatpakrepo
sonata-flatpak.gpg
index.html
```

### 2. Manifest sketch

This repackages the exact release AppImage (the same bits as the AppImage users, checked with the
feed's SHA-512), the TIDAL Hi-Fi/Vesktop pattern:

```yaml
id: io.github.MarcelineVPQ.Sonata
runtime: org.freedesktop.Platform
runtime-version: '26.08'
sdk: org.freedesktop.Sdk
base: org.electronjs.Electron2.BaseApp      # zypak, libappindicator, libnotify, patch-electron-desktop-filename
base-version: '26.08'
command: sonata
separate-locales: false
finish-args:
  - --share=ipc
  - --share=network
  - --socket=wayland
  - --socket=fallback-x11
  - --socket=pulseaudio                      # PipeWire via pipewire-pulse
  - --device=dri
  - --own-name=org.mpris.MediaPlayer2.chromium.*   # Chromium's built-in MPRIS (live name: chromium.instanceN)
  - --talk-name=org.kde.StatusNotifierWatcher      # tray
  - --talk-name=org.kde.KWin                       # keep-above on KDE Wayland (only if item 6 below is fixed)
  - --filesystem=xdg-run/discord-ipc-0             # Discord RPC, native Discord
  - --filesystem=xdg-run/app/com.discordapp.Discord:ro   # Discord RPC, Flatpak Discord (discord.js already looks here)
  - --env=XCURSOR_PATH=/run/host/user-share/icons:/run/host/share/icons
  # Notifications: Electron's libnotify uses the portal; no talk-name needed (Flatpak Electron docs).
  # Autostart: Background portal, no permission needed.
modules:
  - name: sonata
    buildsystem: simple
    build-commands:
      - chmod +x sonata.AppImage && ./sonata.AppImage --appimage-extract >/dev/null
      - mkdir -p ${FLATPAK_DEST}/sonata && cp -a squashfs-root/. ${FLATPAK_DEST}/sonata/
      - install -Dm755 stub-sandbox ${FLATPAK_DEST}/sonata/chrome-sandbox   # zypak sandboxes instead
      - patch-electron-desktop-filename ${FLATPAK_DEST}/sonata/resources/app.asar   # Wayland app_id = our ID
      - install -Dm755 sonata.sh ${FLATPAK_DEST}/bin/sonata
      - install -Dm644 sonata.png ${FLATPAK_DEST}/share/icons/hicolor/512x512/apps/${FLATPAK_ID}.png
      - install -Dm644 ${FLATPAK_ID}.metainfo.xml -t ${FLATPAK_DEST}/share/metainfo
      - install -Dm644 LICENSE ${FLATPAK_DEST}/share/licenses/${FLATPAK_ID}/LICENSE
      - |
        install -Dm644 /dev/stdin ${FLATPAK_DEST}/share/applications/${FLATPAK_ID}.desktop <<EOF
        [Desktop Entry]
        Type=Application
        Name=Sonata
        Comment=Unofficial Apple Music desktop player
        Exec=sonata %U
        Icon=${FLATPAK_ID}
        Terminal=false
        Categories=AudioVideo;Audio;Player;
        StartupWMClass=apple-music-for-linux
        EOF
    sources:
      - type: file
        dest-filename: sonata.AppImage
        url: https://github.com/MarcelineVPQ/apple-music-for-linux/releases/download/v@VERSION@/sonata-@VERSION@-x86_64.AppImage
        sha512: '@SHA512@'
      - { type: file, path: ../../sonata.png }
      - { type: file, path: ../../io.github.MarcelineVPQ.Sonata.metainfo.xml }
      - { type: file, path: ../../LICENSE }
      - { type: file, path: sonata.sh }
      - type: script
        dest-filename: stub-sandbox
        commands: ['echo "Stub sandbox ignoring: $@"; exit 1']
```

`sonata.sh`:

```sh
#!/bin/sh
# Chromium singleton/socket dir shared across instances
export TMPDIR="$XDG_RUNTIME_DIR/app/$FLATPAK_ID"
exec zypak-wrapper /app/sonata/apple-music-for-linux "$@"
```

The binary name inside the AppImage is an assumption; check `squashfs-root/`. On NVIDIA plus
Wayland, TIDAL's `run.sh` adds `--disable-gpu-sandbox` (see the memory note on the RTX 5080 crash
loop). Pass only the flags the AppImage already needs today, and add that one only if the test
needs it.

### 3. CI workflow sketch (`.github/workflows/flatpak.yml`)

Called from `release.yml` after `build` (next to `feed`), plus `workflow_dispatch` for re-runs.
Stable tags go to branch `stable`; `-dev.N` tags go to `dev`. The live repo is **mirrored from
Pages first**, so every run adds to the published history instead of replacing it. This is
`supercell-wx`'s approach (`tools/ci/publish-flatpak-repo.sh`): GitHub Pages keeps no state between
deploys.

```yaml
name: Flatpak repo
on:
  workflow_call:
    inputs: { tag: { type: string, required: true } }
    secrets: { SONATA_FLATPAK_GPG_KEY: { required: false } }
  workflow_dispatch:
    inputs: { tag: { type: string, required: true } }
concurrency: { group: flatpak-repo, cancel-in-progress: false }   # stable + dev never race
permissions: { contents: read }
env:
  SITE: https://marcelinevpq.github.io/apple-music-for-linux
jobs:
  build:
    runs-on: ubuntu-latest
    container: { image: 'ghcr.io/flathub-infra/flatpak-github-actions:freedesktop-26.08', options: --privileged }
    steps:
      - uses: actions/checkout@v5
      - name: Signing key present?          # same gate as feed.yml: never publish unsigned
        id: key
        env: { K: '${{ secrets.SONATA_FLATPAK_GPG_KEY }}' }
        run: |
          if [ -z "$K" ]; then echo "::notice::SONATA_FLATPAK_GPG_KEY not set; not publishing"; exit 0; fi
          export GNUPGHOME=$(mktemp -d); echo "GNUPGHOME=$GNUPGHOME" >> $GITHUB_ENV
          printf '%s' "$K" | gpg --batch --import
          echo "fpr=$(gpg --with-colons --list-secret-keys | awk -F: '/^fpr/{print $10; exit}')" >> $GITHUB_OUTPUT
      - name: Fill version + sha512 from the release
        if: steps.key.outputs.fpr
        env: { GH_TOKEN: '${{ github.token }}', TAG: '${{ inputs.tag }}' }
        run: |
          v="${TAG#v}"; gh release download "$TAG" -p "sonata-$v-x86_64.AppImage" -D /tmp/rel
          sha=$(sha512sum /tmp/rel/*.AppImage | cut -d' ' -f1)
          sed -i "s/@VERSION@/$v/g; s/@SHA512@/$sha/" packaging/flatpak/io.github.MarcelineVPQ.Sonata.yml
          case "$v" in *-dev.*) echo BRANCH=dev ;; *) echo BRANCH=stable ;; esac >> $GITHUB_ENV
      - name: Mirror the published repo (first run: start empty)
        if: steps.key.outputs.fpr
        run: |
          ostree init --repo=repo --mode=archive-z2
          if curl -sfI "$SITE/repo/config" >/dev/null; then
            ostree remote add --repo=repo --gpg-import=packaging/flatpak/sonata-flatpak.gpg live "$SITE/repo/"
            ostree pull --repo=repo --mirror live && ostree remote delete --repo=repo live
          fi
      - name: Build + commit into the repo
        if: steps.key.outputs.fpr
        run: |
          flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
          flatpak-builder --user --install-deps-from=flathub --force-clean --disable-rofiles-fuse \
            --default-branch="$BRANCH" --repo=repo --gpg-sign=${{ steps.key.outputs.fpr }} \
            build packaging/flatpak/io.github.MarcelineVPQ.Sonata.yml
          flatpak build-update-repo --title=Sonata --generate-static-deltas --prune --prune-depth=2 \
            --gpg-sign=${{ steps.key.outputs.fpr }} repo
      - name: Assemble site
        if: steps.key.outputs.fpr
        run: |
          mkdir site && mv repo site/ && cp packaging/flatpak/{sonata.flatpakref,sonata.flatpakrepo,sonata-flatpak.gpg,index.html} site/
          du -sh site   # 1 GB Pages limit; fail loudly if near
      - if: steps.key.outputs.fpr
        uses: actions/upload-pages-artifact@v4
        with: { path: site }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    permissions: { pages: write, id-token: write }
    environment: { name: github-pages }
    steps:
      - uses: actions/deploy-pages@v4
```

(The deploy job must also be skipped when no key is set, for example through a job output. The
exact `upload-pages-artifact`/`deploy-pages` major versions need checking when writing it.) Add a
`flatpak-builder --run … appstreamcli validate` (or `flatpak run --command=flatpak-builder-lint
org.flatpak.Builder manifest …`) step so a broken metainfo, which would hide Sonata in Discover,
fails the run.

`sonata.flatpakref`:

```ini
[Flatpak Ref]
Title=Sonata
Name=io.github.MarcelineVPQ.Sonata
Branch=stable
Url=https://marcelinevpq.github.io/apple-music-for-linux/repo/
SuggestRemoteName=sonata
Homepage=https://github.com/MarcelineVPQ/apple-music-for-linux
Icon=https://raw.githubusercontent.com/MarcelineVPQ/apple-music-for-linux/master/sonata.png
RuntimeRepo=https://dl.flathub.org/repo/flathub.flatpakrepo
IsRuntime=false
GPGKey=<base64 of the public key, one line>
```

`sonata.flatpakrepo` has the same `Title`, `Url`, `Homepage`, `Icon` and `GPGKey`, plus
`DefaultBranch=stable` and `Comment=Unofficial Apple Music desktop player`.

Command-line equivalent for the README:
`flatpak install --user https://marcelinevpq.github.io/apple-music-for-linux/sonata.flatpakref`.

### 4. Signing key (mirrors the feed key)

Flatpak/OSTree verify **OpenPGP** signatures, so the Ed25519 feed key (a raw PEM read by Node)
cannot sign the repo. A second key gets the same treatment: it lives in two places only, the
developer's PC and one Actions secret.

```sh
# once, on Marcy's PC (folder 700, files 600, outside the repo)
export GNUPGHOME=~/.config/sonata-release/flatpak-gnupg
mkdir -p -m 700 "$GNUPGHOME"
gpg --batch --passphrase '' --quick-gen-key 'Sonata Flatpak repository' ed25519 sign never
FPR=$(gpg --with-colons --list-secret-keys | awk -F: '/^fpr/{print $10; exit}')
gpg --armor --export-secret-keys "$FPR" > ~/.config/sonata-release/flatpak-signing-key.asc
chmod 600 ~/.config/sonata-release/flatpak-signing-key.asc
gh secret set SONATA_FLATPAK_GPG_KEY -R MarcelineVPQ/apple-music-for-linux < ~/.config/sonata-release/flatpak-signing-key.asc
gpg --armor --export "$FPR" > packaging/flatpak/sonata-flatpak.gpg     # public, committed
gpg --export "$FPR" | base64 -w0                                       # -> GPGKey= in .flatpakref/.flatpakrepo
```

- No email in the user ID: the key is public, so Marcy's address stays out of it. No passphrase,
  like the feed PEM, so CI signs non-interactively. Protection is the 600 file plus the secret.
- **Back it up offline.** Flatpak has no automatic key rotation. Every install pins the key from the
  `.flatpakref`. Losing it means every user must remove and re-add the remote. Rotating it means
  `flatpak remote-modify --gpg-import` on every machine.
- Document it in `docs/RELEASING.md` next to the feed key.

### 5. One-time GitHub setup (Marcy)

Settings → Pages → Source = **GitHub Actions**. Keep the `github-pages` environment restricted to
`master` and tags `v*`.

### 6. Discover behaviour to expect

- Opening the `.flatpakref` in Discover shows Sonata's page (name, summary, screenshots, releases
  come from the metainfo through the repo's `appstream` branch, which `flatpak-builder`/
  `build-update-repo` generate) → **Install**. Discover adds the `sonata` remote and, if missing,
  Flathub from `RuntimeRepo` for `org.freedesktop.Platform//26.08` (first install of the runtime:
  a few hundred MB, shared with other apps).
- After that, Sonata appears under Installed, and its updates appear in Discover's Updates page and
  in the Plasma update notifier (or are applied automatically if the user enabled that). A running
  Sonata keeps the old version until restarted.
- Sonata does not show up in Discover **search** before the remote is added. That is the price of
  not being on Flathub.

### 7. Size and bandwidth

- The AppImage is 125.8 MB (squashfs). A commit in an archive-z2 repo is about the same order
  (per-file zlib) **(?)**. With two branches, `--prune-depth=2` and static deltas, the site should
  stay around **0.4–0.7 GB**, under the 1 GB limit. The `du` step watches it.
- 100 GB/month soft limit ≈ 700+ fresh installs a month. Updates are small: OSTree fetches only
  changed files, and an Electron bump changes most of them. Current traffic is far below this
  (v0.15.15 AppImage: 1 download). If it ever grows, the same `site/` can be rsynced to the Hetzner
  VPS behind Caddy (20 TB traffic) with no client change other than `Url` (or put a custom domain
  on Pages now so the URL never has to change).

## Code changes Sonata needs

Detect with `const isFlatpak = !!process.env.FLATPAK_ID` (or `fs.existsSync('/.flatpak-info')`).

1. **Updater off.** `startUpdateChecks`/`checkForUpdates` already return when `APPIMAGE` is unset,
   which is true in Flatpak. The **controls** still need hiding, because no control may do nothing.
   Hide the tray item *Check for Updates…* and the Settings *Update channel* row. Replace them with
   one line: "Updates come through Discover (Flatpak)". `settings.html` already switches the
   description on `s.appImage`; add `s.flatpak`. Optional later: the Flatpak portal's
   `CreateUpdateMonitor` → `UpdateAvailable` signal for a "Restart to update" tray item.
2. **Autostart through the Background portal.** `applyAutostart` writes
   `$XDG_CONFIG_HOME/autostart/…desktop`. In Flatpak that path is `~/.var/app/<id>/config/autostart`,
   which the session never reads, so the setting would silently do nothing. Instead call
   `org.freedesktop.portal.Background.RequestBackground("", {reason, autostart: <b>, commandline:
   ['sonata'] or ['sonata','--hidden'], handle_token})`. The portal writes the host autostart entry
   (`flatpak run …`) and removes it with `autostart: false`. Use `gdbus call` if the runtime
   ships `gdbus` **(?)**, or a small D-Bus client (`dbus-next`). Read the `Response` signal so the
   toggle shows the real result (`autostart` true/false). The user may be asked to allow it.
3. **AppImage integration stays off.** `integrateAppImage`, `pruneOldAppImages` and
   `restartIntoUpdate` key off `APPIMAGE`, so nothing changes. The Flatpak exports its own
   `.desktop` and icon.
4. **App ID and Wayland.** `patch-electron-desktop-filename` in the manifest sets the Wayland app_id
   to `io.github.MarcelineVPQ.Sonata`, so the taskbar icon matches. No code change, and the AppImage
   is untouched.
5. **Paths.** `app.getPath('userData')` becomes
   `~/.var/app/io.github.MarcelineVPQ.Sonata/config/apple-music-for-linux/`. castlabs' Component
   Updater downloads the Widevine CDM under userData there. No code change, but **test playback
   first**: a Vivaldi Flatpak once failed to `dlopen` a CDM from its `~/.var/app` config. TIDAL
   Hi-Fi on Flathub plays fine, so castlabs ECS is expected to work. Nothing carries over from an
   AppImage install (Apple login, Last.fm, Discord, settings). See the open questions.
6. **KWin keep-above (mini player / lyrics "always on top" on KDE Wayland).** `applyKeepAbove` shells
   out to `qdbus`, which is not in the runtime, and loads a script from `os.tmpdir()`, which is
   private to the sandbox so KWin can't read it. In Flatpak this breaks. Fix: write the script under
   `$XDG_RUNTIME_DIR/app/$FLATPAK_ID/` (host-visible at the same path) and call KWin over D-Bus
   (`gdbus` or the D-Bus client from item 2) with `--talk-name=org.kde.KWin`. Until then, hide the
   setting in Flatpak on KDE Wayland.
7. **Leftover KWin cleanup.** `cleanupWindowPositionMemory` reads a redirected `kwinrulesrc` in
   Flatpak, so it is a no-op there. That is fine, because a fresh Flatpak never wrote those rules.
8. **Desktop entry clash.** The AppImage writes `~/.local/share/applications/io.github.MarcelineVPQ.Sonata.desktop`.
   That is the **same desktop ID** the Flatpak exports, and `~/.local/share` comes first in
   `XDG_DATA_DIRS`. On a machine with both, the menu would launch the AppImage. Either the
   AppImage removes its entry when `flatpak info io.github.MarcelineVPQ.Sonata` succeeds, or the
   README's switch instructions say to delete the AppImage and that file.
9. **Discord RPC, links, notifications, single instance.** `discord.js` already searches
   `$XDG_RUNTIME_DIR/app/com.discordapp.Discord`, and the finish-args cover native Discord.
   `shell.openExternal` goes through the OpenURI portal. Notifications go through the portal. The
   single-instance lock works inside one sandbox. No change.
10. **About / logs:** show "Flatpak" as the packaging next to the version, so bug reports say which
    build they come from.

## Open questions

1. **Development channel in Flatpak?** Publish a `dev` branch plus `sonata-dev.flatpakref`, or ship
   Stable only through Flatpak and keep Development on the AppImage. Recommendation: Stable only at
   first. Both branches add repo size and a second listing in Discover.
2. **Migrating from the AppImage:** fresh start (re-login) vs a one-time import. An import needs
   `--filesystem=xdg-config/apple-music-for-linux:ro`, a permanent read grant for a one-off copy.
   Recommendation: fresh start, with a README note.
3. **Where to test the Flatpak?** Installing it touches a system: a user-scope remote, the runtime
   and the app. Options: Marcy's OK for a `--user` install on her desktop (removable), or a Linux
   VM. First check Widevine playback, tray, MPRIS, the Discover install and update flow, and
   autostart.
4. **Custom domain now** (for example under 42pixelstudios.com) so the repo URL never changes if it
   moves off Pages? The `Url` is pinned in every user's remote config.
5. **Flathub later?** Only if Marcy wants to hand-write the manifest and run the review herself
   under the AI policy. If accepted, users of the own repo would see Sonata from two sources in
   Discover, and the own repo would then publish an end-of-life notice.
6. **aarch64:** castlabs publishes arm64 Linux builds; the AppImage is x86_64 only today. Skip for now.

## Sources

- Flathub requirements (web wrappers, Generative AI policy, extra-data, permissions, stable releases):
  https://docs.flathub.org/docs/for-app-authors/requirements ; source:
  https://github.com/flathub-infra/documentation/blob/main/docs/02-for-app-authors/02-requirements.md
  (commit "Restore explicit LLM ban for manifests", 2026-09-04)
- Flathub submission process: https://docs.flathub.org/docs/for-app-authors/submission
- Flathub verification (`io.github.` via GitHub login): https://docs.flathub.org/docs/for-app-authors/verification
- TIDAL Hi-Fi on Flathub (castlabs-Electron web wrapper, AppImage repack):
  https://github.com/flathub/com.mastermindzh.tidal-hifi
- Cider on Flathub (`.deb` repack, Electron2.BaseApp 26.08): https://github.com/flathub/sh.cider.Cider
- Flathub search API (Apple Music / Tidal / Spotify clients, "Sonata" name free): https://flathub.org/api/v2/search
- castlabs Electron for Content Security: https://github.com/castlabs/electron-releases ;
  EVS / VMP (Linux has no VMP): https://github.com/castlabs/electron-releases/wiki/EVS
- Flatpak, Electron guide (BaseApp, zypak, desktop filename, notifications portal, XCURSOR_PATH):
  https://docs.flatpak.org/en/latest/electron.html
- Flatpak, hosting a repository (.flatpakrepo/.flatpakref keys, GPG, static deltas):
  https://docs.flatpak.org/en/latest/hosting-a-repository.html
- Background portal (RequestBackground, autostart, commandline):
  https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Background.html
- flatpak-github-actions and CI images: https://github.com/flatpak/flatpak-github-actions ,
  https://github.com/flathub-infra/actions-images
- Flatter (GitHub Pages Flatpak repo action): https://github.com/andyholmes/flatter
- Real GitHub Pages Flatpak repo with a mirror-then-append CI: Supercell Wx,
  https://supercell-wx.readthedocs.io/en/latest/development/flatpak-repo-hosting.html ,
  https://github.com/dpaulat/supercell-wx/blob/develop/.github/workflows/publish-flatpak-repo.yml
- GitHub Pages limits: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- Vivaldi Flatpak CDM load failure: https://discourse.flathub.org/t/drm-codec-library-issues-when-building-custom-flatpak-vivaldi-browser/1435
- Electron MPRIS name hard-coded to chromium (Snap review): https://forum.snapcraft.io/t/electron-apps-and-mpris-slot/21408
- KDE Discover backends (no AppImage backend; KNS = add-ons): https://invent.kde.org/plasma/discover/-/tree/master/libdiscover/backends ;
  local check on Plasma 6.6.6: no apps `.knsrc` in `/usr/share/knsrcfiles`, Discover registered for
  `application/vnd.flatpak.ref`/`.repo`
- Snap Store search (upstream "Apple Music" snap by Marcus Tomlinson, Sidra): https://api.snapcraft.io/v2/snaps/find
- AUR RPC (no `sonata-apple-music-bin`): https://aur.archlinux.org/rpc/v5/info?arg[]=sonata-apple-music-bin
