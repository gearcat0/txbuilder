# Releasing

Pushing a `v*` tag runs `.github/workflows/release.yml`. It builds macOS (signed and
notarized), Linux and an unsigned Windows check on GitHub's runners, and drafts a
GitHub Release with the macOS and Linux installers attached. The signed Windows
installer is built on the maintainer's own Windows machine and uploaded to the same
draft. Nothing is public until you publish the draft.

`appId` (`com.txbuilder.app`) is the app's signing and update identity. Do not change
it.

Each build also writes `latest*.yml` and `.blockmap` files (from `build.publish` in
`package.json`). The app has no auto-updater yet; they are attached anyway so one can
be added later and see every release already out.

## One-time setup

### GitHub `release` environment

Create an environment named `release` in the repo settings (Settings → Environments),
add yourself as a **required reviewer**, and add these environment secrets:

| Secret | What |
|---|---|
| `MAC_CSC_LINK` | Developer ID Application certificate, `.p12`, base64 |
| `MAC_CSC_KEY_PASSWORD` | its password |
| `APPLE_API_KEY_P8` | App Store Connect API key, the `.p8` file's contents |
| `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | that key's ID and issuer ID |

From the command line:

```sh
base64 -i DeveloperID.p12 | gh secret set MAC_CSC_LINK --env release
gh secret set MAC_CSC_KEY_PASSWORD --env release
gh secret set APPLE_API_KEY_P8 --env release < AuthKey_XXXXXXXXXX.p8
gh secret set APPLE_API_KEY_ID --env release
gh secret set APPLE_API_ISSUER --env release
```

Notarization uses electron-builder's built-in notarytool support, which switches on
when `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` are set.

### Windows signing machine

Windows is signed with a Certum certificate. The key lives in SimplySign's cloud HSM
behind the one-time code from the SimplySign phone app, so it cannot sit in CI.
Signing must happen inside electron-builder: `latest.yml` holds the installer's
sha512, and signing it afterwards would change that hash.

On the signing machine (a Windows VM is fine; use it for nothing else), install:

- Git, Node 22, pnpm 11 (`npm install -g pnpm`), and npm 11.18 or newer
  (`npm install -g npm@11`), which evm-ui requires
- the GitHub CLI (`gh auth login`)
- SimplySign Desktop

No C++ toolchain is needed: the only native modules (usb, keccak) ship prebuilt
binaries.

`build.win.signtoolOptions.publisherName` in `package.json` must be the certificate's
subject CN. It is the name Windows shows as the publisher, and a future updater will
only accept updates signed by it.

## Cutting a release

1. Bump `version` in `package.json` (plain `x.y.z`; a prerelease suffix like
   `-beta.1` would put a future updater's users on prereleases), merge, then:
   ```sh
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
2. Approve the `release` environment on the workflow run. CI signs and notarizes
   macOS (arm64 and x64; notarization can take a long time), builds Linux, and drafts
   a Release with the installers. Its Windows build is an unsigned check and is not
   attached.
3. On the Windows signing machine, in fresh clones at the tag:
   ```powershell
   git clone --branch vX.Y.Z https://github.com/gearcat0/txbuilder.git
   git clone https://github.com/gearcat0/evm-ui.git
   cd evm-ui; npm ci; npm run build; cd ..\txbuilder
   pnpm install --frozen-lockfile
   ```
   Log in to SimplySign Desktop, then:
   ```powershell
   # Find the thumbprint: Get-ChildItem Cert:\CurrentUser\My | Format-List Subject, Thumbprint
   $env:TXBUILDER_WIN_CERT_SHA1 = '<thumbprint>'
   pnpm dist:win:signed
   ```
   It refuses to build without a publisher name and thumbprint, verifies the
   signature, signer and timestamp, and prints the `gh release upload` command for
   the installer, its blockmap and `latest.yml`. Run that command.
4. Download the draft's installers and smoke-test them on each OS, including a
   hardware-wallet signature.
5. Publish the draft.

To pull a bad release, unpublish it and ship a higher version.

## Checking a build without releasing

Run the workflow by hand (Actions → release → Run workflow). It builds and signs
everything and uploads the installers as workflow artifacts, but does not create a
Release.

On a Mac, a downloaded build can be checked with:

```sh
spctl -a -vv "/Applications/TX Builder.app"   # accepted, source=Notarized Developer ID
xcrun stapler validate "/Applications/TX Builder.app"   # The staple ticket is valid
```

The notarization ticket is stapled to the app inside the DMG, not to the DMG
itself, so run `stapler validate` against the `.app`; on the `.dmg` it reports
a failure even for a good build.

## Certificate calendar

- **Certum** (Windows): one year. Renew about a month early and keep the same subject
  CN. If the CN has to change, update `publisherName` in the same release.
  Signatures are timestamped, so installers already out keep verifying after the
  certificate expires.
- **Apple Developer Program**: yearly membership. If it lapses, builds already
  notarized keep working, but new ones cannot be notarized.
