# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What it is

`BtlDeviceManager`: a desktop app that lets the person sitting at a BTL workstation
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

| Question                           | Where to look in bgcm                                  |
| ---------------------------------- | ------------------------------------------------------ |
| Three-process design and why       | `docs/adr/0002-node-server-with-browser-app-window.md` |
| Server hub, state, snapshot replay | `src/server/main.ts`                                   |
| Token auth, path validation        | `src/server/main.ts` (`assertRepo`, the `t` parameter) |
| Typing commands into the pty       | `src/server/terminal.ts`, `App.buildSteps`             |
| Signals, actions, server messages  | `src/web/state.ts`                                     |
| Launcher, detach, app window       | `cli/bgcm.js`                                          |
| Desktop entry with absolute paths  | `scripts/install-desktop.mjs`                          |
| UI rendered without a browser      | `tests/ui.test.tsx`                                    |

Diverge where the job differs, but say why in a comment or an ADR — not
silently.

## Two classes of commands

The most important rule in the app, inherited from bgcm:

- **Direct** (`execFile`, output parsed): reads that can never prompt —
  `avahi-browse`, `lpstat`, `driverless list`, `swaymsg -t get_outputs`,
  `virsh list`. Not `lpinfo`: it needs the `lpadmin` group and answers
  `Forbidden` to a plain user.
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
bgcm: clone, `npm ci`, `npm run build`; the launcher entry the app writes
itself on first start (`scripts/install-desktop.mjs`), unlike bgcm.

Assume CUPS, `avahi-daemon` and `libnss-mdns` are present — the role puts them
there. Do not install packages from the app.

## State of the repository

Done: the skeleton, all four panels from `docs/IDEA.md` (`Printers`,
`Displays`, `Virtual machine`, `Status`) and a live `Performance` panel.
`docs/adr/0001` says where and why it diverges from bgcm.

- `src/printers/` is the `btl-printers` CLI (`cli/btl-printers.js` loads the
  built `dist/printers-cli.js`): `avahi.ts`, `cups.ts` parse command output,
  `model.ts` merges discovered printers with queues, `cli.ts` is the entry.
  The server runs `btl-printers list --json`; it has no CUPS knowledge.
  Queues carry their unfinished jobs (`lpstat -l -o`) and alerts
  (`lpstat -l -p`); `cancel <id> [job]` is typed with `sudo` unless the job
  is the server user's own, because `cancel -a` and other people's jobs are
  `Forbidden` to a plain user. Job files are unreadable and CUPS rewrites
  `printers.conf` only after `DirtyCleanInterval` (30 s), so the server
  rescans every 5 s for 90 s after a typed printer command and while jobs
  wait, instead of trusting the `/etc/cups` watcher alone.
- `src/displays/` is the `btl-displays` CLI: `sway.ts` parses `get_outputs`
  (identifier is `"make model serial"` verbatim, `HEADLESS-*` hidden),
  `geometry.ts` is shared with the canvas (logical size, snapping, overlap),
  `config.ts` renders and validates `outputs.conf`, including one
  `workspace … output …` line per existing workspace. `apply <layout.json>`
  writes the file, runs `sway -C`, `swaymsg reload` and then moves open
  workspaces that still sit elsewhere; the server writes the layout file
  under `~/.cache/btl-device-manager/layouts/` and types the command.
  `move-workspace` is the one display action run directly (no root, one-line
  failure, and it is triggered by a drag).
- `src/vm/` is the `btl-vm` CLI: `virsh.ts` parses `dominfo` (virsh has no
  JSON; `list --all --name` plus one `dominfo` per domain copes with names
  containing spaces), `settings.ts` reads the `set $ws… "…"` workspace names
  from the sway config and renders `config.d/vm.conf`, which holds each
  machine's console workspace as a sway variable `$btl_vm_console_<name>`. Always
  `-c qemu:///system`: without it virsh uses the empty per-user instance.
  `console` subscribes to sway window events, starts `virt-viewer` and moves
  the first window from that pid, so no `app_id` is guessed.
  `console-workspace` is the one direct VM action (a line in the user's own
  sway config).
- `src/status/` is the `btl-status` CLI, read-only: `parse.ts` holds one
  pure parser per source (`systemctl -o json`, `findmnt -J`, `nmcli -t`,
  `ip -j`, sysfs and /proc files, the playbook run log), `summary.ts` renders
  the text the CLI prints and the panel copies, `cli.ts` reads every source
  in parallel and lets each one fail alone. The run log
  (`/var/log/btl/ansible-runs.jsonl`, JSONL, read from the tail) is written
  by btl-infra's `base` role; format in README. `perf.ts` is the pure part
  of `btl-status perf` (two readings of `/proc/stat` and `/proc/[pid]/stat`
  one second apart, hwmon, `powerprofilesctl`); `set-profile` is the one
  direct status action, through power-profiles-daemon, never sysfs + sudo.
  `src/vm/stats.ts` does the same for `virsh domstats` (`btl-vm stats`).
- `src/server/main.ts` is the hub; `cli-source.ts` runs `<cli> list --json`
  for each feature (`CliSource<R>` is generic over the parsed result: lists
  for three panels, one object for status) and holds the watchers
  (`/etc/cups`, `swaymsg -t subscribe`, `virsh event --loop`, `nmcli monitor`).
  `LiveSource` is the other kind of feed: it loops a CLI only while a window
  has sent `watch {topic, on}`, for the Performance panel and the per-vCPU
  load; a sample costs a second, so nothing samples unwatched. `buildSteps`
  validates a printer id or a machine name against the last listing, or a
  layout file against the server's own directory, and returns the line typed
  into the terminal.
  `paths.ts#printersCommand` decides between `btl-printers` (when
  `/usr/local/bin/btl-printers` links to this clone) and the absolute path.
- `src/web/`: `Nav.tsx` lists `PANELS` from `state.ts`; add a panel by adding
  its id there and a component in `main.tsx`. `DisplaysPanel.tsx` keeps an
  editable draft that follows sway until the user edits it.
- Tests use documentation names and addresses (`printer-1234.local`,
  `192.0.2.x`); keep it that way, the repo is public.

Everything in `docs/IDEA.md` is built; new panels follow the same split (CLI
under `src/<feature>/`, a `CliSource` in the server, a component in
`src/web/components/`, an id in `PANELS`).
