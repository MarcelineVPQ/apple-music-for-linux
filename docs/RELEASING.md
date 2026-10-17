# Releasing Sonata

Sonata updates itself from a **signed feed**, the same design as the DS5 app:

| File (on `master`) | Channel | Lists |
|---|---|---|
| `latest.json` + `latest.json.sig` | Stable (default) | the newest published `vX.Y.Z` release |
| `latest-dev.json` + `latest-dev.json.sig` | Development | the newest of the `vX.Y.Z-dev.N` prereleases and the stable releases |

The app reads them from `https://raw.githubusercontent.com/MarcelineVPQ/apple-music-for-linux/master/latest(-dev).json`
plus `.sig`, every 2 hours, at start (after 20 s), on *Check for Updates…* and on a channel switch.

Feed format (`tools/feed-lib.js`):

```json
{
  "channel": "stable",
  "version": "0.15.13",
  "file": "sonata-0.15.13-x86_64.AppImage",
  "url": "https://github.com/MarcelineVPQ/apple-music-for-linux/releases/download/v0.15.13/sonata-0.15.13-x86_64.AppImage",
  "sha512": "<128 hex>",
  "size": 125815305,
  "date": "<release published_at>",
  "notes_url": "<release page>",
  "notes": "<release notes, Markdown>"
}
```

What the app checks (`update-feed.js`): the `.sig` is an Ed25519 signature over the feed's exact bytes
by a key in `TRUSTED_KEYS`; the feed's `channel` is the one asked for; Stable never takes a `-dev` version;
`file` and `url` are this repo's release file for that version; then the download's size and SHA-512 must
match. Anything else is refused: the log says `update check failed: update refused: …`, and an interactive
check shows the same message. Only strictly newer versions are installed (`0.15.13-dev.2 < 0.15.13 < 0.15.14-dev.1`).
Switching from Development back to Stable installs nothing until Stable passes the dev build you have.

What the user sees (0.15.32, `updater.js`): "Sonata X is available" with *Update* and *Details* (the feed's
`notes`), download progress, "Sonata X is installed" with *Restart now* (only while nothing plays), and
"Updated to X · See what's new" after the restart. *Install updates automatically* (asked once) installs an
offered newer version by itself; *Check for updates automatically* off means no timer and nothing online
until *Check now*. **Back to stable** (Settings → Updates, from Development, confirmed) is the one path that
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

**Never edit the feeds by hand.** CI writes and signs them (`.github/workflows/feed.yml`); to regenerate,
run that workflow (Actions → Update feed → Run workflow).

## Stable release

1. Set the version in one step, never by hand:
   `node tools/set-version.js X.Y.Z --summary "One sentence for software centres"` writes `package.json`,
   `package-lock.json` and the `<release>` in `io.github.MarcelineVPQ.Sonata.metainfo.xml` (today's date;
   `--date YYYY-MM-DD` to choose). Rename `## [Unreleased]` in `CHANGELOG.md` to `## [X.Y.Z] — Short title`,
   check with `node tools/set-version.js --verify vX.Y.Z`, and commit on `master`.
2. `git tag vX.Y.Z && git push origin master vX.Y.Z`.
3. `release.yml` runs the tests and the verdict gate, checks the tag against the version
   (`tools/set-version.js --verify "$GITHUB_REF_NAME"`: a mismatch fails the release), builds the AppImage, creates a
   draft release with the CHANGELOG section as notes, uploads `sonata-X.Y.Z-x86_64.AppImage` **and
   `latest-linux.yml`**, then publishes it as *Latest*.
4. `feed.yml` (called by the release) downloads and hashes the AppImage, writes `latest.json` and
   `latest-dev.json`, signs them and commits them to `master`.

## Development release

Same steps with version `X.Y.Z-dev.N` (the `X.Y.Z` it leads up to; N from 1) and tag `vX.Y.Z-dev.N`;
the CHANGELOG section is `## [X.Y.Z-dev.N]` (falls back to `[Unreleased]`). The release is published as a
**prerelease** (never *Latest*, so `releases/latest` and old installs never see it), without
`latest-linux.yml`, and only `latest-dev.json` changes.

## Signing key

The private key exists in two places only: the `SONATA_FEED_KEY` Actions secret and the developer's PC at
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
