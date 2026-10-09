# Changelog

All notable changes to dsh-picflow are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] — 2026-10-10

### Notes

- Version-only release: the code is identical to 0.2.0, so the feature set documented under 0.2.0 (usage ledger, four-state classification, time buckets, trash-backed cleanup wizard, pinning, `install.ps1`) is what this version ships.
- First formally tagged and published release of `dsh-picflow` (`v0.3.0`). The compatibility table had been missing its 0.2.0 / 0.3.0 rows; they are added with this release.

## [0.2.0] — 2026-10-09

### Added

- **`install.ps1` — desktop-app installer for Windows.** The desktop build puts no `dsh` on PATH, so `install.sh` cannot run there. This script locates `DSH NEXT.exe`, sets `DSH_HOME`, and drives the plugin operations that ship inside the application (`resources\app\lib\plugin-cli.js`), so it needs nothing beyond PowerShell 5.1. `-Profile`, `-Exe` and `-Remove` are supported; one-liner `iwr …/install.ps1 -useb | iex`.
- **README: desktop (Windows) install section** in both language files, with the manual `--expose-internals` equivalent spelled out.
- **Usage ledger** (`ledger.js`, host route `POST /ledger`). Every insert, attach, auto-insert and `@` pick records the image's sha with a use count, last-used time and the sessions it appeared in, under `<DSH_HOME>/dsh-picflow/usage.json`. Reporting is fire-and-forget: a failed report never blocks an insert.
- **Four-state classification.** Each row is now `hot` (used within 7 days, pinned, or pasted in the current session), `warm` (used within 30 days), `cold` (never referenced after the age cutoff, or last used more than 30 days ago) or `fresh` (recent, not yet referenced), plus orthogonal `noise` (< 20 KB) and `big` (> 500 KB) tags. Reason strings are shown verbatim in the cleanup wizard.
- **Time buckets replace the per-day chip row.** The filter bar is now five rolling buckets — `全部 · 近3天 · 近7天 · 近30天 · 更早` — with a second row of state chips (`用过 · 没用过 · 已置顶 · 大文件 · 小噪音 · 可清理`) carrying live counts; exact-day chips moved behind a `按日期` toggle.
- **Honest header numbers.** The panel header reports real disk occupancy, the cleanable amount (count + bytes) and the last-used time, aggregated over the whole library instead of the visible window.
- **Cleanup wizard backed by a trash folder** (`cleanup.js`, routes `GET /cleanup`, `GET|POST /trash`). Candidates are images older than the cutoff (default 14 days) that were never referenced, are not pinned and do not belong to the current session; they come pre-selected, move to `<DSH_HOME>/trash/dsh-picflow/<source>/<sha2>/<sha>` with a manifest, keep workspace thumbnail copies cleaned, and are restorable for 7 days (`op: restore`), after which `op: purge` deletes them for good.
- **Pinning.** `POST /pin` toggles a per-image pin stored in `<DSH_HOME>/dsh-picflow/pins.json`; a pinned image never enters cleanup candidates, and the cell shows a `顶` badge with an immediate `置顶 / 取消置顶` flip.

### Changed

- `GET /images` accepts `bucket` and `state`, decorates every row with its state, reasons, pin flag and use stats, and returns a `stats` aggregate so the panel needs one request per refresh.
- `GET /stats` and `GET /cleanup` answer `405` to non-GET methods, matching the method-check convention of the other routes.
- Trash entry ids carry a sequence suffix, so two images moved in the same minute with the same sha prefix stay individually restorable.

### Notes

- Nothing is deleted by default: the official attachment library is only touched by an explicit move into the plugin's own trash folder, and anything referenced by a session never qualifies.
- Tests: `tests/chip.mjs` (96 checks), `tests/host.mjs` (24), `tests/ledger-cleanup.mjs` (19), `tests/routes.mjs` (6 live HTTP route checks).

## [0.1.0] — 2026-10-05

First release. Measured against harness `0.2.0-rc.2` (desktop build).

### Added

- **Paste-time admission.** A 350 ms sweep of the composer's live draft attachments POSTs each pasted image to the plugin's own host route, which calls the official `attachments.saveImage` — the same normalization, the same sha256 and therefore the same library entry the image will have if it is later sent.
- **Stable numbering.** `图片N` is assigned across the whole library sorted by file mtime ascending, so existing numbers never shift as new images arrive.
- **Composer-dock panel.** The `N 张图` pill expands into `引用素材`: newest-first thumbnail cells with the image's number, time and size, and the actions `插到光标处` (insert a native reference chip at the caret), `挂上` (re-attach the stored image to the current message) and `路径` (copy the markdown reference). Clicking a thumbnail opens a full-screen overlay closed by click or `Esc`.
- **Search, day filters and sorting.** `图片12` / `10-04` / `昨天` / `png` / sha prefix / `128kb`, per-day chips, `最新 / 最早 / 最大`, and paging 120 rows at a time.
- **`@图片` input source.** A `图片` group in the `@` menu that inserts the same numbered reference chip as the panel button.
- **Auto-insert switch** (default on, remembered in `localStorage` under `dsh-picflow.autoInsert`): with it on, the reference lands at the caret right after admission and the panel stays closed; with it off, pasting only stores the image. When the composer is busy or the caret is unavailable, the plugin opens the panel with the reason instead of failing silently.
- **Four host routes** — `/version` (cheap library fingerprint), `/admit`, `/images` (list, search, paging, on-demand materialization) and `/raw` — all behind the host trust fence, with `trustedHosts` configuration for LAN or domain access.
- **Workspace materialization.** `<workspace>/.dsh/pics/pic-<MMDD-HHMM>-<sha8>.<ext>` copies so that `dsh-resource://file/absolute/...` references resolve for the model, written on demand and skipped when an identical copy is already present.

### Notes

- Formats: PNG, JPEG, WebP, GIF (BMP is refused by the official store). 20 MB per image, 24 MB request body cap.
- Known trade-off: an image enters the library at paste time, so an image that is pasted and never sent is still stored.
- No npm dependencies, no build step; the host half registers routes and therefore needs one restart after install.
