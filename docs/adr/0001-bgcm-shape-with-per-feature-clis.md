# ADR 0001: bgcm's shape, Linux only, with the logic in per-feature CLIs

- **Status:** Proposed
- **Date:** 2026-10-11

## Context

BTL Manager lets a workstation user do what the `desktop` role in btl-infra
cannot decide for them: which printer to set up, how monitors are arranged,
when to start the VM. The audience is not a developer, and the operations
need `sudo` or can fail in ways the user must be able to report.

bgcm's [ADR 0002](https://github.com/dalibaBtl/BtlGitAndClaudeManager/blob/main/docs/adr/0002-node-server-with-browser-app-window.md)
settled a shape for a small local desktop tool: a Node server on loopback
with a per-launch token, a Preact page in a Chromium app window, a shell in a
pty per window, and two classes of commands (direct reads via `execFile`;
anything that may prompt is typed into the terminal). It is in daily use and
the users already know the window.

Two things differ here. The target is one known platform (Debian 13, sway,
CUPS, libvirt), and the system logic is useful on its own: a printer queue is
as often fixed over SSH as from a GUI.

## Decision

1. **Same three processes, same toolchain, same token and terminal model as
   bgcm.** Not a fork; the skeleton is copied and trimmed. Deviations are
   stated in comments at the place they occur.
2. **Linux only.** No Windows or macOS branches (bgcm's `ShellKind`, launcher
   candidates, config-dir variants are dropped rather than kept dormant).
3. **Each feature is a CLI; the app calls it.** `btl-printers list --json` is
   what the server runs to get its state, and `sudo btl-printers add <id>` is
   what the terminal shows. The server never contains CUPS, sway or libvirt
   knowledge beyond the CLI's JSON shape. Later panels follow the same split
   (`btl-displays`, `btl-vm`, …).
4. **Privileged commands are typed, never hidden.** The server validates the
   target against its own last listing (the `assertRepo` equivalent), builds
   one short line and types it. `lpinfo` turned out to need the `lpadmin`
   group, so the direct reads are `avahi-browse`, `lpstat` and `driverless
list`; everything through `lpadmin` goes via `sudo` in the terminal.
5. **The CLI reaches `sudo` through `/usr/local/bin`.** `sudo` ignores the
   user's PATH, so the `desktop` role links
   `/usr/local/bin/btl-printers → <clone>/cli/btl-printers.js`. The app types
   the short name when that link points at its own clone and the absolute
   script path otherwise, so an unprovisioned checkout still works.
6. **Printers are identified by a slug of their mDNS name**, which is also
   the queue name. A numeric index would shift as printers wake and sleep
   between `list` and `add`.

## Consequences

- One extra Node process per refresh (the CLI), about a second of mDNS
  browsing each minute. Acceptable for a desktop app; cheaper than keeping a
  second implementation in the server.
- The CLI must stay usable by a human: readable table output, exit codes,
  errors that say what to do (`wake it up and retry`). It is also the test
  surface: parsers and merge logic are unit-tested, the CLI is run against
  the machine.
- Installing the symlink is the role's job; the app and `install-desktop`
  only detect and explain its absence.
- The repository is public, so test fixtures use documentation names and
  addresses; nothing from the real network appears in code.
