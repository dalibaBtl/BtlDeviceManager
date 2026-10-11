# BTL Manager

Desktop app for the person sitting at a BTL workstation (Debian 13, sway) to
manage **that one machine** without a terminal: printers first; displays, the
Windows VM and a status panel follow.

```text
┌────────────┬──────────────────────────────────────────────┐
│ Printers   │ Printer      Model     Address   Status      │
│ (Displays) │ …            …         …         [Initialize]│
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
git clone https://github.com/dalibaBtl/BtlManager.git && cd BtlManager
npm ci
npm run build
sudo ln -sf "$PWD/cli/btl-printers.js" /usr/local/bin/btl-printers
```

The app registers itself with the app launcher (Mod+D, rofi, …) on its first
start by writing `~/.local/share/applications/btl-manager.desktop` with
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
node cli/btl-manager.js --no-open  # server only; prints the URL
node cli/btl-manager.js --foreground
```

The server listens on `127.0.0.1` with a per-launch token, logs to
`~/.cache/btl-manager/server.log` and exits ten seconds after the last window
closes. The app window is started with `--class=btl-manager`; under Wayland
match the window title `BTL Manager` in sway rules.

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

## Development

```bash
npm run dev          # rebuild on change; run `npm start` in another shell
npm test             # vitest: parsers, merge logic, terminal steps, rendered UI
npm run typecheck
npm run format
```

Architecture notes are in `docs/adr/`; the product reasoning (in Czech) in
`docs/IDEA.md`. Nothing network-specific belongs in this repository.
