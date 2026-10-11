# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What it is

`BtlManager`: a desktop app that lets the person sitting at a BTL workstation
manage **that one machine** — printers first, later displays, the Windows VM
and a read-only status panel. Product spec: `docs/IDEA.md` (Czech; **the UI is
English only**). Read it before writing code; it carries the reasoning, this
file carries the rules.

It exists because not everyone is comfortable in a terminal. Everything it
does is otherwise done with `lpadmin`, `swaymsg` or `virsh`.

**The repository is public.** Nothing secret belongs here — no customer names,
no host names, no addresses, no tokens, not even in examples or test fixtures.
Anything specific to our network lives in `btl-infra`, which is private. The
public repo is also what makes installation work: the `desktop` role clones it
without credentials onto machines that have no key of their own.

**Linux only.** CUPS, sway and libvirt have no Windows equivalent here, so
unlike bgcm this app does not carry cross-platform paths. Do not add them
"just in case".

## It is modeled on bgcm — verify there, do not invent

This project deliberately copies the shape of **bgcm**
(`github.com/dalibaBtl/BtlGitAndClaudeManager`, usually cloned next to this
repo as `../BtlGitAndClaudeManager`). It is not a fork; it is the same
architecture applied to a different job.

When you are unsure how something should look, **read bgcm's source instead of
guessing**:

| Question | Where to look in bgcm |
|---|---|
| Three-process design and why | `docs/adr/0002-node-server-with-browser-app-window.md` |
| Server hub, state, snapshot replay | `src/server/main.ts` |
| Token auth, path validation | `src/server/main.ts` (`assertRepo`, the `t` parameter) |
| Typing commands into the pty | `src/server/terminal.ts`, `App.buildSteps` |
| Signals, actions, server messages | `src/web/state.ts` |
| Launcher, detach, app window | `cli/bgcm.js` |
| Desktop entry with absolute paths | `scripts/install-desktop.mjs` |
| UI rendered without a browser | `tests/ui.test.tsx` |

Diverge where the job differs, but say why in a comment or an ADR — not
silently.

## Two classes of commands

The most important rule in the app, inherited from bgcm:

- **Direct** (`execFile`, output parsed): reads that can never prompt —
  `avahi-browse`, `lpstat`, `lpinfo`, `swaymsg -t get_outputs`, `virsh list`.
- **Typed into the terminal**: anything needing `sudo` or able to fail in an
  interesting way — `lpadmin`, firewall changes, starting a VM.

Never run `sudo` hidden inside the app. The user must see what ran on their
machine and be able to read the error and pass it on. A spinner that fails
silently is the failure mode this app exists to prevent.

## Logic lives in CLIs, not in the app

Each feature ships a small command the app calls:

```
btl-printers list --json      # [{name, ip, model, uri, queue}]
btl-printers add <id>         # creates the queue
```

So it can be tested without a window, run over SSH when the user is elsewhere,
and read in the terminal pane as `sudo btl-printers add 1` rather than a
200-character `lpadmin` line with an encoded URI. New features follow the same
split; resist putting system logic in the server.

## Stack and conventions

Same toolchain as bgcm, for the same reason — it is known and it works:
Node 20 floor, esbuild, Preact + `@preact/signals`, `node-pty`, `ws`, vitest,
prettier, TypeScript with `tsc --noEmit`. Pin versions; no floating ranges.

```bash
npm run build       # esbuild: dist/server.js + dist/web/
npm start           # build must exist; starts server, opens app window
npm test            # vitest
npm run typecheck
npm run format
```

`node_modules/`, `dist/` and `bin/` are off-limits to edits and reads.

## Target machine

Debian 13 (trixie), sway on Wayland, installed and configured by the `desktop`
role in `btl-infra`. That role also installs this app, the same way it installs
bgcm: clone, `npm ci`, `npm run build`, `npm run install-desktop`.

Assume CUPS, `avahi-daemon` and `libnss-mdns` are present — the role puts them
there. Do not install packages from the app.

## State of the repository

Empty apart from `docs/IDEA.md` and this file. The first slice is the skeleton
plus the `Printers` panel; build the skeleton by reading bgcm's, not from
memory of how such an app is usually written.
