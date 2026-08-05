# Release verification runbook — live auto-update round trip

Roadmap item M1.2. This runbook is the exact procedure for the repo owner (only the owner
has push/release credentials).

**Status: PASSED live twice on 2026-08-05** — `0.7.0 → 1.0.2` against the `v1.0.2`
release, then `1.0.2 → 1.0.3` against the `v1.0.3` release. See the two "Live result"
sections at the end for evidence and the parts that remain unproven. The pre-flight
checklist and procedure below are written against the earlier `0.6.x → 0.7.0` hop and
are kept as the reusable template — substitute the current version numbers when running
it again.

## Pre-flight checklist (verified facts)

| # | Fact | Evidence |
|---|------|----------|
| 1 | Publish target is `github` / `bosscube1` / `OPENCCODE`; no `channel` or `releaseType` override, so electron-builder defaults apply: channel `latest` → `latest.yml`, releaseType `release` | `electron-builder.yml:55-58` |
| 2 | Git remote matches the publish target | `git remote -v` → `https://github.com/bosscube1/OPENCCODE.git` |
| 3 | NSIS artifact name is `OpenCode-Desktop-${version}-setup.${ext}`; `dist/` contains `OpenCode-Desktop-0.7.0-setup.exe` and `OpenCode-Desktop-0.7.0-setup.exe.blockmap` — names match what electron-updater resolves from `latest.yml` | `electron-builder.yml:50`, `dist/` listing |
| 4 | `dist/latest.yml` is internally consistent: `version: 0.7.0`, `path`/`files[0].url` = `OpenCode-Desktop-0.7.0-setup.exe`, `size: 130736084` matches the actual file size, and the `sha512` was re-computed from the exe and is identical (`jT3EcSGWHL2XPi4JUBH1ZlIrIkcy2NzIJLT2UJCz3bPtSp6fe6CynAha3+nPJU/4y1XY+h8DYBQB6KrvypJPDw==`) | `dist/latest.yml:1-8` |
| 5 | `package.json` version is `0.7.0` | `package.json` |
| 6 | Updater never overrides `autoUpdater.channel` → resolves `latest.yml` on the default `latest` channel; matches checklist item 1 | `src/main/updater.ts` (no channel assignment anywhere) |
| 7 | Guards are correct: dev builds (`!app.isPackaged`) and portable builds (`PORTABLE_EXECUTABLE_FILE`/`PORTABLE_EXECUTABLE_DIR` env) refuse to check; packaged builds auto-check once at startup and via the app menu | `src/main/updater.ts:119-128`, `src/main/index.ts:335`, `src/main/menu.ts:116-117` |
| 8 | Install is never silent/automatic: `autoDownload = true`, `autoInstallOnAppQuit = false`, and `quitAndInstall` runs only after the user clicks "Install and Restart" in a dialog | `src/main/updater.ts:97-98`, `src/main/updater.ts:54-83` |
| 9 | Close-to-tray cannot veto the update restart: `beforeInstall` sets `quitRequested = true`, and `window-all-closed` honors it | `src/main/index.ts:318`, `src/main/index.ts:345-349` |
| 10 | Update status reaches the renderer on the `update:status` channel | `src/main/index.ts:93-99` |
| 11 | Differential updates are possible: both the existing v0.6.0 release and the new 0.7.0 artifacts carry a `.blockmap` next to the setup exe | GitHub API asset list, `dist/` listing |
| 12 | Existing releases on GitHub: `v0.6.0` and `v0.2.0`, both published (not draft), each with `latest.yml` + setup exe + blockmap + portable exe. **No v0.7.0 release exists yet.** | GitHub API `/repos/bosscube1/OPENCCODE/releases` |
| 13 | electron-updater 6.8.9 / electron-builder 26.15.3 | `package.json` devDependencies |

## Defect found (fix BEFORE creating the release)

**D1 — The pushed `v0.7.0` tag points at the wrong commit.** The annotated tag
`v0.7.0` (tag object `11bf087`) resolves to commit `933329c` ("perf: make the router
latency-aware… (0.7.0)") on `feat/p3-code-surface`, which is **not an ancestor of
`main` HEAD** (`c98365c`, "chore: release 0.7.0"). The trees differ in 5 renderer
files (`routing.ts`, `ModelPicker.tsx`, `MessageView.tsx`, tests). `package.json`
says `0.7.0` on both, so the updater itself doesn't care — but a GitHub Release
created from this tag would attach 0.7.0 binaries to a source snapshot that isn't
what shipped, and the tag would forever point off-main.

Fix (owner, one time):

```bash
git fetch origin
git push --delete origin v0.7.0        # delete the misplaced remote tag
git tag -d v0.7.0
git tag -a v0.7.0 c98365c -m "Release 0.7.0"
git push origin v0.7.0
```

## Known limitations (not blockers)

- **L1 — Assisted installer on update.** `nsis.oneClick: false` (`electron-builder.yml:43`)
  plus `quitAndInstall(false, true)` (`src/main/updater.ts:76`) means the update install
  shows the full NSIS assisted-installer UI; the user clicks through it. This is expected,
  not a failure. The app relaunches automatically afterwards.
- **L2 — Unsigned binaries.** SmartScreen may warn on both the 0.6.0 install and the
  0.7.0 update install. Expected for an unsigned app; click through.
- **L3 — What the unit tests cannot prove.** `src/main/__tests__/updater.test.ts` mocks
  `electron-updater` and `electron` entirely. It proves the guard logic, event→status
  mapping, sanitized errors, confirm-before-install flow, and listener cleanup. It says
  nothing about real `latest.yml` parsing, sha512 verification, blockmap differential
  download, or the NSIS hand-off — that is exactly what this runbook round-trips.

## Round-trip procedure

### Step 1 — Fix the tag (see D1 above)

### Step 2 — Rebuild artifacts from the tagged commit

Do this even though `dist/` already contains 0.7.0 artifacts: it makes the binaries
provably match the tag.

```powershell
git checkout v0.7.0        # or stay on main at c98365c after re-tagging
npm ci
npm run dist:win
```

Sanity-check the output before uploading:

```powershell
Get-Item dist\OpenCode-Desktop-0.7.0-setup.exe | Select-Object Length   # must equal "size" in dist\latest.yml
```

(`dist/latest.yml` and `dist/OpenCode-Desktop-0.7.0-setup.exe.blockmap` are regenerated
by the build; the sha512 consistency was verified once already, checklist item 4.)

### Step 3 — Create the GitHub Release and upload the three artifacts

`gh` is **not installed** on the development machine (`gh: command not found`), so either
install/authenticate it or use the web UI.

With `gh`:

```bash
gh release create v0.7.0 \
  dist/latest.yml \
  dist/OpenCode-Desktop-0.7.0-setup.exe \
  dist/OpenCode-Desktop-0.7.0-setup.exe.blockmap \
  dist/OpenCode-Desktop-0.7.0-portable.exe \
  --repo bosscube1/OPENCCODE --title "v0.7.0" --notes "OpenCode Desktop 0.7.0"
```

Web UI equivalent: Releases → Draft a new release → choose tag `v0.7.0` → attach the same
four files → Publish release (not draft, not prerelease).

Rules that matter:

- `latest.yml` **must** be uploaded as a release asset with exactly that name.
- The setup exe and its `.blockmap` must keep the exact names from `dist/` — GitHub does
  not rewrite hyphenated names (that is why `electron-builder.yml:38-40` bans spaces).
- Upload the blockmap even though only the exe is listed in `latest.yml`; electron-updater
  fetches `<exe-name>.blockmap` from the same release for differential download.
- The portable exe is optional for the updater (portable builds refuse updates by design,
  checklist item 7) but prior releases shipped it, so keep parity.

### Step 4 — Install the OLD version

1. Download `OpenCode-Desktop-0.6.0-setup.exe` from the existing `v0.6.0` release:
   https://github.com/bosscube1/OPENCCODE/releases/tag/v0.6.0
2. Install it (click through SmartScreen, L2).
3. If 0.7.0 was previously installed on the test machine, uninstall it first (the
   assisted installer would otherwise refuse/downgrade-prompt).

### Step 5 — Trigger and observe the update

1. Launch the installed 0.6.0. It auto-checks once at startup (`src/main/index.ts:335`);
   or use the app menu's update item (`src/main/menu.ts:116-117`).
2. Expected status sequence in the UI: checking → available (0.7.0) → download progress
   → downloaded → dialog "OpenCode Desktop 0.7.0 is ready to install."
3. Click **Install and Restart**. Expected: app quits (close-to-tray must NOT intercept
   this — item 9), the NSIS assisted installer appears (L1), completes, and the app
   relaunches.
4. Verify the relaunched app reports version 0.7.0 (app About/version surface, or
   `%LOCALAPPDATA%\Programs\opencode-desktop\` contents replaced).
5. Re-open the update check: it should now report up-to-date / not-available.

### Abort / triage


- Status shows "Unable to check for updates…" → the message is deliberately sanitized
  (`src/main/updater.ts:25`); check network, that the release is published (not draft),
  and that `latest.yml` is attached with its exact name.
- Update downloads but install fails → grab the real error from the updater cache under
  `%LOCALAPPDATA%` before retrying; a sha512 mismatch means the uploaded exe differs from
  the one `latest.yml` was generated with (re-upload both from the same `dist/` build).
- If the dialog never appears after "downloaded", the install prompt is single-flight
  (`installPromptOpen`, `src/main/updater.ts:33`) — restart the app; the downloaded
  update is re-offered.

## Live result #1 — 2026-08-05, 0.7.0 → 1.0.2 (PASSED)

Run on the owner's Windows 11 machine against the published `v1.0.2` release.

| Step | Result |
|------|--------|
| Unit tests | `src/main/__tests__/updater.test.ts` — 5 passed |
| Release reachable | `v1.0.2` published (not draft), assets `latest.yml` + setup exe + blockmap |
| `latest.yml` fidelity | Release asset byte-identical to `dist/latest.yml`: `version: 1.0.2`, `size: 130868428`, `sha512 QuLmc82k…5StIcw==` |
| Asset fidelity | Locally built exe re-hashed to the same sha512; `HEAD` on the release asset returned `200` / `Content-Length: 130868428` |
| Check + download | Installed 0.7.0 auto-checked at startup, resolved `latest.yml` on the default `latest` channel, downloaded to `%LOCALAPPDATA%\opencode-desktop-updater\pending\` |
| sha512 verification | Downloaded file re-hashed independently — matched `latest.yml` exactly. `update-info.json` written with `isAdminRightsRequired: false` |
| NSIS hand-off | "Install and Restart" → install directory rewritten, updater cache emptied |
| Relaunch | App relaunched itself; running process and installed exe both report `1.0.2.0` |
| Re-check | Settings → UPDATES reads "OpenCode Desktop is up to date." |

Close-to-tray did not veto the restart: the tray setting was enabled and the app still
quit and installed (checklist item 9 holds in practice).

Still unproven after this run:

- **Differential download.** The full 130 MB was fetched; the blockmap delta path did not
  engage on a 0.7.0 → 1.0.2 hop. A narrower hop is needed to exercise it.
- **Signature verification.** Skipped, not passed — the builds are unsigned and
  `publisherName` is unset (L2, M1.1). Integrity rested entirely on the sha512, which did
  verify.
- **The dialog itself.** The install was confirmed by its effect (install directory
  replaced, `autoInstallOnAppQuit` is `false` so nothing else could trigger it), not by an
  observed screenshot of the prompt.

## Live result #2 — 2026-08-05, 1.0.2 → 1.0.3 (PASSED)

Second round trip on the same machine, this time a single-patch hop, run specifically to
try to exercise the differential-download path.

| Step | Result |
|------|--------|
| `latest.yml` fidelity | Release asset byte-identical to `dist/latest.yml`: `version: 1.0.3`, `size: 130870003`, `sha512 tnAM9s1z…nfrSQ==` |
| Asset fidelity | Three-way sha512 match: locally built exe = published asset = downloaded file |
| Check + download | Installed 1.0.2 auto-checked at startup and staged the update, complete ~34 s after launch (vs ~56 s on the 0.7.0 hop) |
| sha512 verification | Downloaded file re-hashed independently — matched. `update-info.json`: `{"fileName":"OpenCode-Desktop-1.0.3-setup.exe","sha512":"tnAM9s1z…","isAdminRightsRequired":false}` |
| NSIS hand-off | Install directory rewritten at 19:28:02 |
| Relaunch | Installed exe and running process both report `1.0.3.0` |
| Re-check | Settings → UPDATES reads "OpenCode Desktop is up to date." |

Still unproven after this run:

- **Differential download — still not proven, and not provable as the code stands.**
  The staged file is full-size either way (a delta reconstructs the whole artifact), so
  size proves nothing, and the faster wall-clock is circumstantial. The only decisive
  evidence is electron-updater's own log line, and `src/main/updater.ts:99` sets
  `autoUpdater.logger = null`, so nothing is written. **To settle it:** temporarily
  assign a logger (e.g. `electron-log`) at that line, re-run a patch hop, and read the
  differential-download decision out of the log. This is the last unexercised path in
  the updater.
- **Signature verification.** Skipped again, not passed — still unsigned (L2, M1.1).

### Incident — tag/release drift on the 1.0.3 publish

The 1.0.3 artifacts were first published under a release named **`v1.0.4`**, while the
`v1.0.4` tag pointed at the same commit as `v1.0.3` (`1a9dd56`, "chore: release v1.0.3").
`latest.yml` inside it read `version: 1.0.3`. The updater worked — it trusts `latest.yml`,
not the tag — but this is the same defect class as the `V1.0.1` incident that
`scripts/release.mjs` exists to prevent: binaries attached to a tag that does not name
them.

Resolved on 2026-08-05: the four assets were attached to the `v1.0.3` release, the
`v1.0.4` tag was deleted locally and on the remote, and the `v1.0.4` release was removed.
Verified afterwards — `GET /repos/bosscube1/OPENCCODE/releases/latest` resolves `v1.0.3`
with 4 assets, and `releases/download/v1.0.3/latest.yml` returns `200` and is
byte-identical to the local build. Commit `1a9dd56` remained reachable throughout via the
`v1.0.3` tag and `main`.

**Rule for next time:** the release name, the tag, and `version:` inside `latest.yml`
must all agree before the release is published. Deleting a published release's tag does
not delete the release — GitHub converts it to a draft that still holds its assets, so
the release itself has to be deleted separately in the web UI.

Note the GitHub API caches `/releases/latest`; immediately after the fix it still returned
the stale `v1.0.4`. Re-probe with a cache-busting query before concluding the fix failed.
