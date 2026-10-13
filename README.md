# BTL Device Manager

Desktop app for the person sitting at a BTL workstation (Debian 13, sway) to
manage **that one machine** without a terminal: printers and displays today;
the Windows VM and a status panel follow.

```text
┌────────────┬──────────────────────────────────────────────┐
│ Printers   │ Printer      Model     Address   Status      │
│ Displays   │ …            …         …         [Initialize]│
│ (VM)       ├──────────────────────────────────────────────┤
│ (Status)   │ Terminal                                     │
└────────────┴──────────────────────────────────────────────┘
```

It exists because not everyone is comfortable with `lpadmin`, `swaymsg` or
`virsh`. It is modelled on [bgcm](https://github.com/dalibaBtl/BtlGitAndClaudeManager)
(same three processes, same toolchain) and shares its one hard rule: anything
that needs `sudo` or can fail in an interesting way is **typed into the
embedded terminal**, never run hidden by the app. You see the command, the
password prompt and the error. Licensed under [MIT](LICENSE).

**Linux only.** CUPS, sway and libvirt have no Windows equivalent here.

## Requirements

- Debian 13 or similar with Node.js 20+, `cups`, `cups-filters`,
  `avahi-daemon`, `avahi-utils` and `libnss-mdns` (the `desktop` role in
  btl-infra installs all of these)
- A Chromium-family browser for the app window; otherwise the UI opens in
  the default browser as a tab
- `sudo` rights for the user who sets up printers

## Install

```bash
git clone https://github.com/dalibaBtl/BtlDeviceManager.git && cd BtlDeviceManager
npm ci
npm run build
sudo ln -sf "$PWD/cli/btl-printers.js" /usr/local/bin/btl-printers
```

The app registers itself with the app launcher (Mod+D, rofi, …) on its first
start by writing `~/.local/share/applications/btl-device-manager.desktop` with
absolute paths; `npm run install-desktop` does the same explicitly and
`npm run install-desktop -- --remove` takes it out again.

The `ln -sf` line puts the printers CLI where `sudo` can find it (`sudo` resets
`PATH` to `secure_path`). Without it everything still works; the terminal
just shows the full script path instead of `btl-printers`. The `desktop`
role does all four steps on managed workstations.

## Run

From the launcher, or:

```bash
npm start                          # server in the background, app window opens
node cli/btl-device-manager.js --no-open  # server only; prints the URL
node cli/btl-device-manager.js --foreground
```

The server listens on `127.0.0.1` with a per-launch token, logs to
`~/.cache/btl-device-manager/server.log` and exits ten seconds after the last window
closes. The app window is started with `--class=btl-device-manager`; under Wayland
match the window title `BTL Device Manager` in sway rules.

## Printers

The panel lists printers announced over mDNS (`avahi-browse _ipp._tcp`)
together with the queues CUPS already has (`lpstat`), merged by host. An
empty list is not an error: printers go to sleep and drop off mDNS after a
while; wake one up and press **Refresh**. Queues whose printer is asleep stay
listed as _Not seen on network_ and remain usable.

Unfinished jobs (`lpstat -l -o`) are listed under their printer with who sent
them, the size and the time, and the status chip says _Printing_, _2 jobs
waiting_ or the printer's own alert in plain words (_Out of paper_, _Paper
jam_, _Cover open_, from `lpstat -l -p`'s `Alerts:` line).

The list follows the terminal without a Refresh click: for 90 s after a
printer command was typed, and for as long as a queue has jobs, the app
rescans every 5 s instead of every minute. Polling is the only option:
CUPS's job files are not readable by a plain user, and `printers.conf` is
rewritten only after its `DirtyCleanInterval` (30 s), so the `/etc/cups`
watcher fires half a minute after `lpadmin` and never for a job.

| Button             | What the terminal runs           |
| ------------------ | -------------------------------- |
| **Initialize**     | `sudo btl-printers add <id>`     |
| **Set as default** | `sudo btl-printers default <id>` |
| **Test page**      | `btl-printers test <id>`         |
| **Cancel** (a job) | `btl-printers cancel <id> <job>` |
| **Cancel all**     | `sudo btl-printers cancel <id>`  |
| **Remove**         | `sudo btl-printers remove <id>`  |

Cancelling your own job needs no password; another account's job, and
`cancel -a` (purging the queue), are refused by CUPS with _Forbidden_ for a
plain user, so those lines carry `sudo`.

`<id>` is a slug of the printer's mDNS name (`Example_L1234_Series`) and
becomes the queue name. The same CLI works over SSH:

```bash
btl-printers list            # table
btl-printers list --json     # what the app reads
sudo btl-printers add Example_L1234_Series
btl-printers cancel Example_L1234_Series 12   # one job
sudo btl-printers cancel Example_L1234_Series # every job on the queue
```

### Why not `lpadmin -m everywhere`

On Debian 13 (CUPS 2.5) `lpadmin -m everywhere` creates the queue **without a
PPD**. Jobs then "complete" while the printer prints the PDF source as text.
`btl-printers add` asks `/usr/lib/cups/driver/driverless list` for the
printer's `driverless:ipp://…` model and runs

```bash
lpadmin -p <id> -E -v 'ipp://<host>:631/ipp/print' -m 'driverless:ipp://<host>:631/ipp/print'
```

which makes cups-filters generate a real PPD from the printer's IPP
attributes. The CLI prints that line before running it. A queue created the
wrong way can be removed from the panel and initialized again.

## Displays

The panel draws the enabled displays as rectangles you drag into place; edges
snap together so the mouse crosses between monitors without a gap. Below it,
each display has its mode, scale (1, 1.25, 1.5, 2), rotation and an Enabled
switch. **Apply…** shows the current `~/.config/sway/config.d/outputs.conf`
next to the file that would replace it; after confirming, the terminal runs

```bash
btl-displays apply ~/.cache/btl-device-manager/layouts/layout-<timestamp>.json
```

which writes the file, validates the whole sway config (`sway -C`) and runs
`swaymsg reload`. Nothing here needs `sudo`. The file is rewritten entirely;
hand-written comments in it do not survive, which is why the dialog shows it
first.

Each rectangle also shows the workspaces currently on that display. Drag a
workspace label onto another display to move it there right away
(`btl-displays move-workspace`, no reload). **Apply…** additionally writes a
`workspace "<name>" output "<identifier>"` line for every existing workspace,
so after a monitor is unplugged and plugged back in the workspaces return to
it instead of piling up on the laptop panel.

Displays are matched by sway's `"make model serial"` identifier, not by
connector name, so the arrangement holds when a cable moves to another port.
Hotplug events (`swaymsg -t subscribe`) redraw the panel on their own; the
headless output used for streaming is hidden because the role manages it.

```bash
btl-displays list [--json]
btl-displays preview layout.json     # the outputs.conf a layout would produce
btl-displays config                  # the current outputs.conf
btl-displays move-workspace "3: ai" "<make model serial>"
```

## Virtual machine

Lists the libvirt domains on the system connection (`qemu:///system`) with
their state, CPUs and memory. **Start** (which goes straight on to the
console), **Shut down** (ACPI; the guest decides) and **Force off…** (pull the
plug, after confirming) are typed into the terminal as `btl-vm start <name>`
and so on. Nothing needs `sudo` for a
member of the `libvirt` group. The commands are still typed
rather than run hidden, because a guest that will not start says why on
stderr and that text is what you pass on when asking for help.

**Console** opens `virt-viewer` (the role installs it; `virt-manager` would
drag its own window along). _Console on_ in each row picks the workspace that
machine's console window is moved to. The choices are sway variables in
`~/.config/sway/config.d/vm.conf`, one per machine:

```
set $btl_vm_console_win11 "5: vm"
```

The list offers the workspaces named by `set $ws… "…"` in `~/.config/sway/config`
plus the ones open right now. `btl-vm console` subscribes to sway's window
events before starting the viewer and moves the first window that process
creates, then focuses the workspace; no `app_id` has to be known or guessed.
A viewer started by hand is not moved.

```bash
btl-vm list [--json]
btl-vm start|shutdown|poweroff|console <name>
btl-vm console-workspace win11 "5: vm"     # or --none
```

The panel follows `virsh event --all --loop`, so a guest started or stopped
elsewhere shows up without Refresh. While it is open, a running guest shows
its load live: one bar per vCPU and the host memory it occupies, from two
`virsh domstats` readings a second apart (`btl-vm stats`). Two flat bars
next to two full ones is a guest that will not use all its vCPUs, which on
Windows means a socket count above what the edition allows.

## Status

Read-only. One page with what support asks for first: machine name and
system, hardware (model, BIOS, CPU, memory, graphics, battery), the last
configuration run, failed services, disks, network devices with addresses,
MACs, Wi-Fi link and DNS, and WireGuard tunnels. **Copy summary** puts the
same facts on the clipboard as plain text; `btl-status list` prints that
text in a shell, `--json` is what the server reads. The page follows
`nmcli monitor` and rereads every minute.

Two actions are typed into the terminal. **Show log** on a failed service
runs

```bash
sudo journalctl -u <unit> -n 50 --no-pager      # journalctl --user … for a user unit
```

because the journal is readable only by root and the `adm` group.
**Change password…** next to the account name runs plain `passwd` and moves
the focus to the terminal, with a note on what it will ask. There is no form
on purpose: a form would have to send the password through the app, while
`passwd` takes it straight from the keyboard with echo off and prints the
reason when it rejects one. The same password serves login and `sudo`.

Every source is optional: a missing tool leaves its field empty instead of
failing the page, since a half-broken machine is when the page is needed.
Two things it cannot see without root: the product serial number, and a
WireGuard unit that is set up but has never been started.

_Last playbook run_ comes from `/var/log/btl/ansible-runs.jsonl`, which the
`base` role in btl-infra appends to on every run: one JSON object per line,

```json
{ "at": "2026-10-11T21:01:27Z", "playbook": "Base", "user": "jan", "from": "192.0.2.5" }
```

`at` is UTC with the zone written out; a timestamp without a zone is still
taken as UTC, never as local time. `from` is empty for a run started on the
machine itself. The panel shows the latest run and a short history; it
answers "when did a playbook last touch this machine", not what changed,
since the task runs before the play's final statistics exist. Without the
file the panel says "no record on this machine".

## Performance

Live while the panel is open, like a task manager: CPU over all cores and
per core, clock per core against the hardware range, load, memory,
temperature (the CPU sensor when the kernel exposes one, else the ACPI zone,
with the sensor named), the five busiest processes, and the power profile.
Each sample is one `btl-status perf` run, a one-second window on the
kernel's counters, so the numbers are what is happening now and not averages
since boot. The server samples only while a window watches.

The power profile select goes through `power-profiles-daemon`
(`btl-status set-profile <name>`): polkit lets the user at the keyboard
switch without root and the daemon remembers the choice. _In effect_ shows
what the profile actually set: the ACPI platform profile (firmware power and
thermal limits, fan curve), the energy-performance preference the CPU's own
frequency control follows, and the cpufreq governor, which on `amd-pstate`
and `intel_pstate` stays `powersave` and lets EPP decide. Without the daemon
the panel says so; the `desktop` role installs it.

```bash
btl-status perf              # the same sample in a shell
btl-status set-profile performance
```

## Updating

The version line at the bottom of the navigation compares this clone with
`origin/main` once an hour (`git fetch` on the public repository, no
credentials) and turns into **Update available (n)** when the repository is
ahead; hovering lists the commits. **Update** types

```bash
btl-device-manager update        # git pull --ff-only && npm ci && npm run build
btl-device-manager update --check [--json]   # only report; what the app runs
```

into the terminal, so every step and every error is in view. Nothing needs
root: the clone belongs to the user who runs the app. When the new bundle is
on disk the line changes to **New build ready · Restart**; Restart replaces
the server process in place (same port, same token, so the window simply
reconnects) and the terminal gets a fresh shell. The server never restarts on
its own.

A clone with modified tracked files or a branch that does not track `origin`
is shown as _local changes_ / _not tracking origin_ and is never updated
automatically; that is a development checkout, and `git` in it is yours.

## Development

```bash
npm run dev          # rebuild on change; run `npm start` in another shell
npm test             # vitest: parsers, merge logic, terminal steps, rendered UI
npm run typecheck
npm run format
```

Architecture notes are in `docs/adr/`; the product reasoning (in Czech) in
`docs/IDEA.md`. Nothing network-specific belongs in this repository.
