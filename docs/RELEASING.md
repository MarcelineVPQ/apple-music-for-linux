# Releasing Sonata

Sonata updates itself from a **signed feed**, the same design as the DS5 app:

| File (on `main` of [MarcelineVPQ/sonata-releases](https://github.com/MarcelineVPQ/sonata-releases)) | Channel | Lists |
|---|---|---|
| `latest.json` + `latest.json.sig` | Stable (default) | the newest published `vX.Y.Z` release |
| `latest-dev.json` + `latest-dev.json.sig` | Development | the newest of the `vX.Y.Z-dev.N` prereleases and the stable releases |

The app reads them from `https://raw.githubusercontent.com/MarcelineVPQ/sonata-releases/main/latest(-dev).json`
plus `.sig` (builds up to 0.15.18 / 0.15.44-dev.1: this repository's `master`, see [Releases repository](#releases-repository)), every 2 hours, at start (after 20 s), on *Check for Updates…* and on a channel switch.
A check the user asks for (Check for updates) reads the same two files through GitHub's contents API
(`api.github.com/repos/MarcelineVPQ/sonata-releases/contents/latest(-dev).json?ref=main`, raw bytes, `Cache-Control: no-cache`),
because raw.githubusercontent.com's CDN keeps them up to 5 minutes and ignores query strings; if the API refuses
(60 unauthenticated requests an hour) it falls back to the CDN. The signature check is the same (`update-feed.js` `freshUrl`).

Feed format (`tools/feed-lib.js`):

```json
{
  "channel": "stable",
  "version": "0.15.13",
  "file": "sonata-0.15.13-x86_64.AppImage",
  "url": "https://github.com/MarcelineVPQ/sonata-releases/releases/download/v0.15.13/sonata-0.15.13-x86_64.AppImage",
  "sha512": "<128 hex>",
  "size": 125815305,
  "date": "<release published_at>",
  "notes_url": "<release page>",
  "notes": "<release notes, Markdown>"
}
```

What the app checks (`update-feed.js`): the `.sig` is an Ed25519 signature over the feed's exact bytes
by a key in `TRUSTED_KEYS`; the feed's `channel` is the one asked for; Stable never takes a `-dev` version;
`file` and `url` are the releases repository's release file for that version; then the download's size and SHA-512 must
match. Anything else is refused: the log says `update check failed: update refused: …`, and an interactive
check shows the same message. Only strictly newer versions are installed (`0.15.13-dev.2 < 0.15.13 < 0.15.14-dev.1`).
Switching from Development back to Stable installs nothing until Stable passes the dev build you have.

What the user sees (0.15.32, `updater.js`): "Sonata X is available" with *Update* and *Details* (the feed's
`notes`), download progress, "Sonata X is installed" with *Restart now* (only while nothing plays), and
"Updated to X · See what's new" after the restart. *Install updates automatically* (asked once) installs an
offered newer version by itself; *Check for updates automatically* off means no timer and nothing online
until *Check for updates*. **Back to stable** (Settings → Updates, from Development, confirmed) is the one path that
installs an older version: the newest stable release. A plain switch from Development to Stable installs
nothing until Stable passes the build you have.

### A local signed test feed

To exercise a whole update before anything is published (as in the DS5 app):

```bash
# a throwaway key pair; the public key only ever goes to the test app's environment
node -e "const c=require('crypto');const k=c.generateKeyPairSync('ed25519');require('fs').writeFileSync('test-key.pem',k.privateKey.export({format:'pem',type:'pkcs8'}));console.log(k.publicKey.export({format:'der',type:'spki'}).toString('base64'))" > test-key.pub
# feed: latest.json (+ latest-dev.json) with url http://127.0.0.1:8765/vX.Y.Z/sonata-X.Y.Z-x86_64.AppImage,
# its sha512 and size, signed like CI does:
SONATA_FEED_KEY="$(cat test-key.pem)" node tools/sign-feed.js latest.json
python3 -m http.server 8765        # serving latest.json(.sig) and vX.Y.Z/<file>
SONATA_UPDATE_FEED=http://127.0.0.1:8765/ SONATA_UPDATE_PUBKEY="$(cat test-key.pub)" ./sonata-*.AppImage
```

`SONATA_UPDATE_FEED` is honoured only for loopback `http://` (127.0.0.1 / localhost), downloads must then
come from the same server, and the test key is trusted only together with it. `test/updater.test.js` runs
the same flow automatically: bad signature, bad hash, an older version on Stable, Development → Stable, and
Back to stable. Run a test AppImage only from a scratch folder, never from ~/Downloads: it repoints the
`Sonata.AppImage` link beside itself and prunes older AppImages there.

**Never edit the feeds by hand.** CI writes and signs them (the releases repository's `feed.yml`; the
legacy feeds here: `.github/workflows/feed.yml`); to regenerate, run that workflow (Actions → Update feed →
Run workflow).

## Stable release

1. Set the version in one step, never by hand:
   `node tools/set-version.js X.Y.Z --summary "One sentence for software centres"` writes `package.json`,
   `package-lock.json` and the `<release>` in `io.github.MarcelineVPQ.Sonata.metainfo.xml` (today's date;
   `--date YYYY-MM-DD` to choose). Rename `## [Unreleased]` in `CHANGELOG.md` to `## [X.Y.Z] — Short title`,
   check with `node tools/set-version.js --verify vX.Y.Z`, and commit on `master`.
2. `git tag vX.Y.Z && git push origin master vX.Y.Z`.
3. `release.yml` runs the tests and the verdict gate, checks the tag against the version
   (`tools/set-version.js --verify "$GITHUB_REF_NAME"`: a mismatch fails the release), makes the GPL source
   archive (`git archive` of the tag → `sonata-X.Y.Z-source.tar.gz`) and the notes (the CHANGELOG section), and
   hands them to the releases repository (see [Releases repository](#releases-repository)).
4. There, `publish.yml` unpacks the archive, runs `npm ci`, `npm test` and the gates **from the archive**, builds
   the AppImage from it, attests every file (see [Build attestations](#build-attestations)), and publishes the
   release: `sonata-X.Y.Z-x86_64.AppImage`, `sonata-X.Y.Z-source.tar.gz`, **`latest-linux.yml`** and `SHA256SUMS`,
   as *Latest*. Its `feed.yml` then downloads and hashes the AppImage, writes `latest.json` and `latest-dev.json`,
   signs them, commits them to `main` and attests them.
5. No bridge for Stable: a Stable release is published only in the releases repository (see
   [Releases repository](#releases-repository)).

## Checks before tagging

Not in CI: these need a display (Xvfb) and minutes of wall time. Each runs its own isolated copy
(`tools/isolated.sh`: throwaway HOME, its own Xvfb display, private D-Bus; never Marcy's copy or screen).

| Release | Checks |
|---|---|
| Every change | `npm test` and `npm run gates` (CI runs both) |
| Development (`X.Y.Z-dev.N`) | the UI checker phases (`tools/ui-check.js`, including `every`), **`tools/check_budgets.sh`** (quick, ~10 min: every budget in `tools/budgets.json` once; it exits 1 on a FAIL) and a packaged AppImage smoke start |
| Stable (`X.Y.Z`) | all of the above, **`tools/check_budgets.sh --soak`** (~35 min: memory and listener growth over 30 minutes of playback) and Marcy's own QC |

A FAIL blocks the tag until it is fixed, or until Marcy agrees to a new limit (changed in `tools/budgets.json`
with the reason in `docs/BUDGETS.md`, in the same commit). Record the numbers in `docs/BUDGETS.md` ("Last
measurement") when they move.

## Development release

Same steps on the `dev` branch (work lands there; commit and push `dev`, not `master`) with version
`X.Y.Z-dev.N` (the `X.Y.Z` it leads up to; N from 1) and tag `vX.Y.Z-dev.N`;
the CHANGELOG section is `## [X.Y.Z-dev.N]` (falls back to `[Unreleased]`). The release is published as a
**prerelease** (never *Latest*, so `releases/latest` and old installs never see it), without
`latest-linux.yml`, and only `latest-dev.json` changes (in both repositories while the bridge runs: release.yml then
waits for the release there, downloads its files, checks them against `SHA256SUMS` and publishes the same files as
the same prerelease here; this repository's `feed.yml` refreshes the legacy feeds on `master`).

## Build attestations

Releases carry GitHub [artifact attestations](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds):
a statement, signed through Sigstore with a short-lived certificate that GitHub issues to the workflow run,
that this repository's workflow built the file, from which tag and commit. It's a second, independent check
beside the feed signature: the `.sig` says the feed comes from the holder of Sonata's key; an attestation
says which workflow run made the file. Only releases tagged after these steps were added have them
(v0.15.38-dev.1 and earlier don't).

| File | Attested by | When |
|---|---|---|
| `sonata-X.Y.Z(-dev.N)-x86_64.AppImage`, `sonata-X.Y.Z(-dev.N)-source.tar.gz`, `SHA256SUMS` | the releases repository's `publish.yml` | every release, before the release is published |
| `latest-linux.yml` | the releases repository's `publish.yml` | Stable releases only (development releases don't upload it) |
| `latest.json`, `latest-dev.json` and their `.sig` | `feed.yml` (each repository for its own feeds) | whenever the feed run commits a change (a release, or a run that finds one); an unchanged daily run attests nothing |

Since the move to the releases repository (v0.15.45-dev.1), the files are attested there:
use `-R MarcelineVPQ/sonata-releases` below. The bridge copies here carry the same bytes, so the same command
verifies them. Earlier releases: `-R MarcelineVPQ/apple-music-for-linux`. The releases repository is public, so
its attestations keep working when the source repository is private.

Permissions: the jobs that attest have `id-token: write` (the OIDC token for the signing certificate) and
`attestations: write` (to store it); `release.yml`'s `feed` job grants them to `feed.yml`, since a called
workflow gets only what its caller job grants.

To check a file (GitHub CLI 2.49 or newer; it fetches the attestation from GitHub by the file's SHA-256):

```bash
gh attestation verify sonata-X.Y.Z-x86_64.AppImage -R MarcelineVPQ/apple-music-for-linux
# stricter: also require the release workflow as the signer
gh attestation verify sonata-X.Y.Z-x86_64.AppImage -R MarcelineVPQ/apple-music-for-linux \
  --signer-workflow MarcelineVPQ/apple-music-for-linux/.github/workflows/release.yml
# a feed, as the app downloads it
curl -sLO https://raw.githubusercontent.com/MarcelineVPQ/apple-music-for-linux/master/latest.json
gh attestation verify latest.json -R MarcelineVPQ/apple-music-for-linux
```

It passes with "Verification succeeded!" and names the workflow and commit; a file that was changed
after the build, or never built here, fails (and so does a release from before attestations). The app itself doesn't check
attestations: it checks the Ed25519 signature, the size and the SHA-512 (above).

**Proven on real releases:** v0.15.39-dev.1 was the first tag to run these steps. On 2026-10-17,
`gh attestation verify` passed for the v0.15.41-dev.1 AppImage and for `latest-dev.json` on `master`.
Not yet seen in a real run: a Stable release (its `latest-linux.yml` and `latest.json` attestations); check
those with the lines above after the first stable tag.

## Releases repository

Releases, the signed feeds and each release's GPL source archive live in the public, release-only
repository [MarcelineVPQ/sonata-releases](https://github.com/MarcelineVPQ/sonata-releases) (`update-feed.js`
`REPO`; feeds on its `main`). It holds no source tree, only its README, its two workflows and what they publish.

**Hand-over, no token.** This repository's `release.yml` pushes one commit to a branch `incoming/<tag>` there,
over SSH with a deploy key (write access to `sonata-releases` only, nothing else): `release.json` (tag, version,
title, source commit, the archive's SHA-256), notes.md and `sonata-X.Y.Z-source.tar.gz`. That push starts
`publish.yml` there, which builds from the archive with its own `GITHUB_TOKEN`, calls its `feed.yml`, and
deletes the branch. Secrets: here `RELEASES_DEPLOY_KEY` (the deploy key's private half), there
`SONATA_FEED_KEY` (the same feed key as here). A `release.json` with `"dry_run": true` (any `incoming/…`
branch) runs the whole build and the checks there and publishes nothing.

Replacing the deploy key (e.g. for a new source repository), once:

```bash
ssh-keygen -q -t ed25519 -N '' -C 'sonata release workflow -> sonata-releases' -f k
gh repo deploy-key add k.pub -R MarcelineVPQ/sonata-releases --allow-write --title "Sonata release workflow (push incoming/*)"
gh secret set RELEASES_DEPLOY_KEY -R <source repository> < k && shred -u k && rm k.pub
```

(delete the old key under sonata-releases → Settings → Deploy keys).

**The bridge (Development only).** Installed builds up to 0.15.18 (Stable) and 0.15.44-dev.1 (Development) read
only this repository's feeds on `master` and accept only downloads from this repository's releases
(`parseSignedFeed` compares the `url` with the prefix compiled into them). So the first Development builds
that read the releases repository, from **0.15.45-dev.1** on, are published to both repositories with the same
bytes, and this repository's `feed.yml` keeps signing its feeds (`--repo MarcelineVPQ/apple-music-for-linux`;
`master`'s `tools/build-feed.js` already lists this repository by default). An installed Development build takes
the bridge build from its old feed, verifies it with the same key, and from then on reads the releases repository.
`test/release-bridge.test.js` checks this against the installed builds' own `update-feed.js`
(`test/fixtures/installed-update-feed/`, frozen copies).

**There is no Stable bridge** (Marcy, 2026-10-18): Stable installs up to 0.15.18 are cut off by design. release.yml
copies only `-dev.` tags here, so this repository's Stable feed stays on 0.15.18 for good.

**Ending the bridge**, once Marcy's copies run a bridge build: set `BRIDGE: 'false'` in
release.yml and drop its `feed` job and the bridge steps. No release is added here any more, so the legacy
feeds stay on the bridge builds for good and a late updater still lands on a build that reads the releases
repository. Keep this repository's releases and feeds online for those installs.

## Signing key

The private key exists in these places only: the `SONATA_FEED_KEY` Actions secret (here and in the releases
repository) and the developer's PC at
`~/.config/sonata-release/feed-signing-key.pem` (folder 700, file 600, outside the repo; the DS5 key lives
next to it in `~/.config/ds5-release`). The public key is embedded in `update-feed.js` (`TRUSTED_KEYS`).

**Until the first key is set up, `TRUSTED_KEYS` holds a PLACEHOLDER.** With it, the app ignores the
signed feeds and keeps using the old unsigned `latest-linux.yml` path (Stable only, even on Development),
and `feed.yml` skips publishing (a notice, no failure). To set it up, once:

1. `node tools/feed-keygen.js` — creates the key pair, refuses to overwrite an existing key, and prints
   the two lines below. Back the `.pem` up offline: without it no further updates can reach installed apps.
2. `gh secret set SONATA_FEED_KEY -R MarcelineVPQ/apple-music-for-linux < ~/.config/sonata-release/feed-signing-key.pem`
3. In `update-feed.js`, replace `PLACEHOLDER_KEY` in `TRUSTED_KEYS` with the printed public key
   (base64 SPKI DER), commit, run *Update feed* once (so `latest.json` exists before any app reads it),
   then release. From that release on, installs read only the signed feed.

Once the key is in `update-feed.js`, `feed.yml` fails if the secret is missing, so an unsigned feed is never
published. **Rotation:** add the new public key to `TRUSTED_KEYS` and release; once that release is out,
switch the secret (`gh secret set` again) and later drop the old key.

## Transition from latest-linux.yml

Installs up to 0.15.12 only read `releases/latest/download/latest-linux.yml` (electron-builder's,
unsigned). So:

- **Every Stable release keeps uploading `latest-linux.yml`** (release.yml fails a stable release without
  it). Old installs update through it to the first release with the new updater, and from there on to
  the signed feed once the real key ships. It costs nothing.
- The first release with this updater still carries the placeholder key, so its installs also use
  `latest-linux.yml` until the release that adds the real key reaches them through it.
- **When it could be dropped:** once no install older than the first release *with the real key* is
  expected to remain (in practice: several stable releases and a few months after the key release).
  Dropping it strands any install that never ran since; keeping it is harmless, so there is no hurry.
  To drop it: remove the `latest-linux.yml` lines from release.yml and `parseLegacyFeed` / the placeholder
  fallback from `update-feed.js`.
