# Changelog

All notable changes to dsh-picflow are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`install.ps1` — desktop-app installer for Windows.** The desktop build puts no `dsh` on PATH, so `install.sh` cannot run there. This script locates `DSH NEXT.exe`, sets `DSH_HOME`, and drives the plugin operations that ship inside the application (`resources\app\lib\plugin-cli.js`), so it needs nothing beyond PowerShell 5.1. `-Profile`, `-Exe` and `-Remove` are supported; one-liner `iwr …/install.ps1 -useb | iex`.
- **README: desktop (Windows) install section** in both language files, with the manual `--expose-internals` equivalent spelled out.

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
