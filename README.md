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

| Button             | What the terminal runs           |
| ------------------ | -------------------------------- |
| **Initialize**     | `sudo btl-printers add <id>`     |
| **Set as default** | `sudo btl-printers default <id>` |
| **Test page**      | `btl-printers test <id>`         |
| **Remove**         | `sudo btl-printers remove <id>`  |

`<id>` is a slug of the printer's mDNS name (`Example_L1234_Series`) and
becomes the queue name. The same CLI works over SSH:

```bash
btl-printers list            # table
btl-printers list --json     # what the app reads
sudo btl-printers add Example_L1234_Series
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
elsewhere shows up without Refresh.

## Status

Read-only. One page with what support asks for first: machine name and
system, hardware (model, BIOS, CPU, memory, graphics, battery), the last
configuration run, failed services, disks, network devices with addresses,
MACs, Wi-Fi link and DNS, and WireGuard tunnels. **Copy summary** puts the
same facts on the clipboard as plain text; `btl-status list` prints that
text in a shell, `--json` is what the server reads. The page follows
`nmcli monitor` and rereads every minute.

The one action is **Show log** on a failed service, typed as

```bash
sudo journalctl -u <unit> -n 50 --no-pager      # journalctl --user … for a user unit
```

because the journal is readable only by root and the `adm` group.

Every source is optional: a missing tool leaves its field empty instead of
failing the page, since a half-broken machine is when the page is needed.
Two things it cannot see without root: the product serial number, and a
WireGuard unit that is set up but has never been started.

_Last playbook run_ is read from `/etc/ansible/facts.d/btl.fact`, a standard
place for local facts that Ansible itself does not write. The playbook has to
record it; a task at the end of the common role does it:

```yaml
- name: Record this run for the Status panel
  ansible.builtin.copy:
    dest: /etc/ansible/facts.d/btl.fact
    content: >-
      {{ {"playbook_run_at": now(utc=true).isoformat(),
          "playbook": ansible_play_name,
          "check_mode": ansible_check_mode} | to_json }}
    mode: '0644'
  when: not ansible_check_mode
```

Until it does, the panel says "no record on this machine".

## Development

```bash
npm run dev          # rebuild on change; run `npm start` in another shell
npm test             # vitest: parsers, merge logic, terminal steps, rendered UI
npm run typecheck
npm run format
```

Architecture notes are in `docs/adr/`; the product reasoning (in Czech) in
`docs/IDEA.md`. Nothing network-specific belongs in this repository.
