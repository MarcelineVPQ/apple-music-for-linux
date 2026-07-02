# AUR package: `sonata-apple-music-bin`

A binary AUR package that installs the released AppImage (extracted, so no FUSE
is needed at runtime), plus a desktop entry and icon.

The `sonata` name is already taken on the AUR by an unrelated MPD client, hence
the `-bin` binary-package name.

## Publishing / updating (requires your own AUR account)

I can't push to the AUR for you — it needs your account and SSH key. Once set up
([wiki.archlinux.org/title/AUR_submission_guidelines](https://wiki.archlinux.org/title/AUR_submission_guidelines)):

```bash
# first time: clone the (empty) AUR repo
git clone ssh://aur@aur.archlinux.org/sonata-apple-music-bin.git
cd sonata-apple-music-bin

# copy in PKGBUILD (and regenerate .SRCINFO on an Arch box to be safe)
cp /path/to/repo/packaging/aur/PKGBUILD .
makepkg --printsrcinfo > .SRCINFO   # or copy the checked-in .SRCINFO

git add PKGBUILD .SRCINFO
git commit -m "sonata-apple-music-bin 0.10.0-1"
git push
```

## Updating for a new release

1. Bump `pkgver` in `PKGBUILD`.
2. Update both `sha256sums` — download the new AppImage and `sonata.png` and run
   `sha256sum` (or `updpkgsums` on Arch).
3. Regenerate `.SRCINFO`, commit, push.

## Test locally before pushing

```bash
makepkg -si   # builds and installs
```
