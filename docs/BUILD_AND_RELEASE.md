# Build and release

How to build, test and release Simple Viz. Steps marked **verified** were run on Linux (Fedora 44, x86-64); Windows
and macOS are built and tested by the CI workflow ([.github/workflows/ci.yml](../.github/workflows/ci.yml)) on every
push. On CI a failed end-to-end test is retried twice; one that passes on a retry is reported as flaky.

## Requirements

- **Node 24** and npm. The Electron 45 runtime bundles its own Node.
- `npm ci` runs `postinstall`, which downloads this platform's DuckDB extensions (postgres, sqlite, mysql, httpfs,
  azure) into `resources/duckdb-ext/<os>-<arch>/` and checks each against `scripts/duckdb-extensions.lock.json`.
  They are bundled with the app; nothing is downloaded at run time.
- **For the tests (optional):** podman (PostgreSQL, MariaDB, SQL Server, S3Mock and Azurite containers for the
  database and cloud tests), poppler (`pdftotext`, `pdfinfo`) for the PDF test, xvfb on headless Linux. Tests that
  need a missing tool skip themselves and say so.

## Develop and test (verified on Linux)

```bash
npm ci
npm run dev                # the app with hot reload
npm run typecheck          # strict TypeScript: main/engine and renderer
npm test                   # unit tests
npm run test:integration   # the real engine on real files; databases and cloud storage in podman
npm run e2e:headless       # build, then Playwright drives the app under xvfb (also: axe accessibility audit, light and dark)
npm run bench              # benchmarks at 10k–10M rows (docs/PERFORMANCE_BENCHMARKS.md)
```

Every end-to-end test also fails on a Content-Security-Policy violation or an uncaught error in the window.

Generated and reference data, committed (rerun after changing what they depend on):

```bash
npm run fixtures                                 # test workbooks, CSVs, expected totals (deterministic)
npm run geo                                      # bundled maps from Natural Earth (SHA-256 pinned)
.venv/bin/python scripts/stats-ref.py            # statistics reference values (SciPy, statsmodels)
.venv/bin/python scripts/arrow-fixtures.py       # Arrow/Feather files (pyarrow)
.venv/bin/python scripts/xls-fixtures.py         # .xls workbook and xlrd reference values (xlwt, xlrd, openpyxl)
node scripts/fetch-duckdb-extensions.ts --update-lock   # after a DuckDB upgrade: pin new extension hashes (review the diff)
```

## Build

```bash
npm run dist                       # build, then electron-builder for the current OS (targets in electron-builder.yml)
npx electron-builder --linux dir   # unpacked app only: the quickest for testing
```

Output goes to `release/`.

| OS | Installers |
|---|---|
| Linux x64 | AppImage, deb, rpm |
| Windows x64 | NSIS installer |
| macOS | DMG and ZIP for Apple silicon and Intel |

The macOS Intel build is packaged on Apple silicon: CI unpacks DuckDB's x64 Node binding and the x64 extensions into
place, then runs the smoke test under Rosetta.

**Signing.** Builds are **unsigned** today: Windows SmartScreen and macOS Gatekeeper warn on first launch. macOS
builds are signed ad hoc (`mac.identity: "-"`), because Apple silicon won't run unsigned code; DuckDB extensions are
excluded from signing (they carry DuckDB's own signature, which DuckDB checks when loading them). To sign:

1. Add the certificates as repository secrets: `CSC_LINK` and `CSC_KEY_PASSWORD` (Windows and macOS), and for macOS
   notarization `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`.
2. In `ci.yml`, remove `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` and pass the secrets to the *Installers* step; in
   `electron-builder.yml`, remove `mac.identity: "-"` and enable notarization.

**deb and rpm on a host without fpm's libraries** (Fedora): package the unpacked app in a throwaway container, as for
Simple Cell:

```bash
npx electron-builder --linux dir
podman run --rm --security-opt label=disable -v "$PWD":/src -v "$HOME/.cache/electron-builder":/root/.cache/electron-builder -w /src \
  registry.fedoraproject.org/fedora:44 bash -c \
  "dnf install -y -q nodejs24 libxcrypt-compat rpm-build binutils && node-24 node_modules/.bin/electron-builder --linux deb rpm --prepackaged release/linux-unpacked"
```

## Test the packaged app

```bash
SV_PACKAGED=$PWD/release/linux-unpacked/simple-viz xvfb-run -a npx playwright test   # verified; also runs the updater test
```

CI runs the whole end-to-end suite against the packaged app on all three systems, installs the deb and rpm into
clean Ubuntu 22.04/24.04, Debian 12 and Fedora 44 containers, and checks that every shared library of the app and of
DuckDB's binding resolves.

## Updates

Installed copies check the newest **published** GitHub release of `fleetwoodjohnr/simple-viz` at most once a day
(Settings → About and updates can turn this off), and **ask before installing**. Downloads are checked against the SHA-512 in
the release's `latest*.yml`. macOS opens the release page instead (only Developer ID–signed apps can update
themselves). `tests/e2e/update.spec.ts` checks the prompt, the verified download and the restart prompt against a
local 99.0.0 feed (packaged builds only).

## Release

1. Set the version with `npm version <version> --no-git-tag-version`, turn the top `CHANGELOG.md` section into that
   version, and update the date line in `IMPLEMENTATION_STATUS.md`.
2. Commit, then create and push the tag:
   ```bash
   git tag v<version>
   git push origin HEAD
   git push origin v<version>
   ```
   The tag must match `package.json`; the preflight job rejects mismatches before building.
3. CI builds and tests on all three systems, installs the Linux packages into clean containers, validates every
   installer, blockmap and update manifest (version, size, SHA-512), and uploads them to a **draft** release with the
   newest changelog section as notes.
4. **Nothing is published automatically.** Publishing the draft (on GitHub) is what makes installed copies see the
   update.
