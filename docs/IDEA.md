# BTL Device Manager

Desktopová aplikace pro správu vlastní pracovní stanice. **UI je anglicky.**

Vzniká proto, že ne každý je kamarád s terminálem. Všechno, co se na stanici
dnes dělá přes `lpadmin`, `swaymsg` nebo `virsh`, je pro běžného uživatele
nedosažitelné — a správce k němu nebude jezdit kvůli druhému monitoru.

**Veřejný repozitář**, stejně jako bgcm. Nic tajného tu není — jsou to
helpery nad systémovými příkazy. Praktický důvod je instalace: role `desktop`
v `btl-infra` klonuje bez přihlášení, takže na stanici, která nemá a nemá mít
klíč k našim repozitářům, to prostě projde. Z toho plyne jediné pravidlo:
**žádná jména zákazníků, adresy, hostitelé ani tokeny v kódu ani v ukázkách.**
Co je specifické pro naši síť, patří do `btl-infra`.

Proč tedy samostatný repozitář a ne panel v bgcm: jiné publikum a jiný rozsah.
bgcm je nástroj vývojáře nad gitem a relacemi Clauda. Tohle je samoobsluha
uživatele nad jeho vlastním strojem. Sloučit by znamenalo ukazovat každému
polovinu aplikace, která pro něj nedává smysl.

Spravuje **jen ten stroj, na kterém běží**. Není to konzole pro flotilu; stav
flotily a její konfigurace patří do `btl-infra` a Ansiblu. Hranice je ostrá:
co má být na všech strojích stejné, dělá Ansible. Co si uživatel nastavuje
sám a podle situace, dělá tahle aplikace.

## Tvar

Stejný jako bgcm, včetně rozvržení: strom vlevo, obsah uprostřed, **vestavěný
terminál dole**. Důvod není úspora práce, ale ADR 0002 bgcm — tři procesy
(Node server, stránka v okně prohlížeče, pty na klienta) se osvědčily a
uživatel už to okno zná.

Kostra se okopíruje z bgcm: launcher s tokenem, WebSocket se snapshotem,
Preact se signály, esbuild. Není to fork, jen stejný tvar.

## Dvě třídy příkazů

Převzato z bgcm a je to nejdůležitější pravidlo celé aplikace:

- **Přímo** (`execFile`, výstup se rozebere): čtení, které se nikdy na nic
  nezeptá — `avahi-browse`, `lpstat`, `swaymsg -t get_outputs`, `virsh list`.
- **Vypsáno do terminálu**: cokoli, co chce heslo nebo může selhat zajímavě —
  všechno přes `sudo`, tedy `lpadmin`, změny firewallu, start virtuálky.

Uživatel tak vidí, co se na jeho stroji doopravdy spustilo, a když to selže,
má chybu před sebou a může ji poslat dál. Skrytý `sudo` v aplikaci je proti
tomuhle záměru.

## Příkazy jako samostatné CLI

Logika nebydlí v aplikaci, ale v malých příkazech, které aplikace volá:

```
btl-printers list --json      # [{name, ip, model, uri, queue}]
btl-printers add <id>         # založí frontu
```

Tři důvody. Jde to **otestovat bez okna**. Jde to pustit **přes SSH**, když
uživatel sedí jinde a něco nefunguje. A v terminálu je pak vidět `sudo
btl-printers add 1`, ne dvousetznakový `lpadmin` se zakódovaným URI, ze
kterého nikdo nic nevyčte.

CLI se instaluje s aplikací a role `desktop` v `btl-infra` ho roznese na
stanice stejně, jako dnes roznáší bgcm.

## v1 — čtyři panely

Kostra je dražší než kterýkoli z panelů, takže se nevyplatí vydávat ji
s jediným tlačítkem. Ven jde `Printers`, `Displays`, `Virtual machine`
a `Status`.

### Printers

- seznam nalezených tiskáren: **name, IP, model**, a u každé jestli už frontu má
- tlačítko **Initialize** u tiskárny bez fronty
- tlačítko **Set as default**
- tlačítko **Test page**

Hledání jde přes DNS-SD (`avahi-browse`), přidání přes generátor
`driverless` z `cups-filters`.

**Past, kvůli které to celé vzniká:** `lpadmin -m everywhere` na Debianu 13
frontu založí, ale bez PPD. Tisk pak projde jako „hotový" a z tiskárny leze
zdrojový kód PDF jako text. Správně je:

```
lpinfo -m | grep '^driverless:'                  # URI ovladače
/usr/lib/cups/driver/driverless --std-ipp-uris   # adresa tiskárny
lpadmin -p <name> -E -v '<ipp://...>' -m '<driverless:...>'
```

Prázdný seznam neznamená chybu — tiskárny usínají a mizí z mDNS. UI to má
říct, ne mlčet.

### Displays

Plátno s obdélníky k přetahování, pod ním seznam výstupů s rozlišením,
měřítkem, otočením a vypínačem. Čte `swaymsg -t get_outputs`, zapisuje
`~/.config/sway/config.d/outputs.conf` a volá `swaymsg reload`.

Řeší to, že sway každý nově objevený výstup řadí doprava, takže se poloha
dnes píše ručně.

Co `get_outputs` opravdu vrací (ověřeno na stanici, ne z dokumentace):

```
name          eDP-1                       konektor; MĚNÍ SE podle portu
make/model/   Samsung Display Corp. /     sway identifier je "make model serial"
serial        ATNA40KW01-0 / Unknown      pozor: mezera na konci, i "Unknown"
rect          {x, y, width, height}       LOGICKÉ pixely, už po scale i transform
current_mode  {width, height, refresh}    refresh je v mHz: 60000 = 60 Hz
scale         1.0
transform     normal | 90 | 180 | 270 | flipped-*
active        false u odpojeného          pak je rect nulový a current_mode prázdný
```

Na co to při psaní narazí:

- **Identifikovat podle `make model serial`, ne podle `name`.** Konektor se
  mění podle toho, do kterého portu se kabel strčí; identifikátor ne. Musí
  se citovat a porovnávat přesně — bývá v něm „Unknown" i mezera na konci.
- **Plátno pracuje s logickými rozměry**, tedy `rect`. U vypnutého výstupu
  `rect` není, takže se musí dopočítat z vybraného režimu a měřítka; otočení
  o 90 a 270 prohazuje šířku s výškou.
- **Souřadnice jsou celá čísla** a výstupy se nemají překrývat ani mezi sebou
  nechávat mezery. Sway obojí dovolí, ale myš se pak přes díru chová divně.
  Přichytávání k hranám sousedů to řeší elegantněji než kontrola po zápisu.
- **Hotplug za běhu**: `swaymsg -t subscribe '["output"]'` je proud událostí
  (typ ověřen), který se napojí na stejný WebSocket jako zbytek stavu.
  Překreslit, ne nutit uživatele mačkat „načíst znovu".
- **Zápis nesmí být slepý.** Soubor dnes píše člověk ručně; než ho aplikace
  přepíše, má jeho obsah ukázat a nechat potvrdit.

### Virtual machine

Seznam virtuálek (`virsh list --all`), start, vypnutí a otevření konzole.

Konzoli otevírá **`virt-viewer`**, ne `virt-manager`. Důvod je okenní:
`virt-manager` je správcovský nástroj a konzoli otevírá jako další okno téhož
programu, takže by se s ní na plochu virtuálek stěhoval i on. `virt-viewer`
je samostatné okno s vlastním `app_id`. Instaluje ho role `desktop`
v `btl-infra`.

**Okno nemá zůstat tam, kde stojí Manager, ale cílová plocha není daná.**
`5: vm` je na to v sway configu připravená, závazná ale být nemá: virtuálek
může přibýt a každou si uživatel může chtít dát jinam. Plochu si
uživatel vybere v panelu (nabídka = `set $ws… "…"` ze sway configu plus živé
plochy) a volba se uloží jako sway proměnná do `config.d/vm.conf`. Přesun
nedělá pravidlo `assign` (potřebovalo by `app_id`, které se dá jen hádat),
ale `btl-vm console`: přihlásí se na okenní události sway, spustí
`virt-viewer` a první okno s PID potomka přesune a plochu zaměří. „Přepni
plochu a pak spusť" by byl závod s tím, kdy se okno objeví; reakce na vznik
okna není.

### Status

Ke čtení, ne k zásahům: kdy naposledy běžel playbook, co hlásí
`systemctl --failed`, kolik zbývá místa, jestli jede síť a VPN.

## Co to není

Není to správa flotily, není to náhrada Ansiblu a nenastavuje nic, co má být
na strojích jednotné. Nemá vlastní konfigurační soubor se stavem stroje —
stav je v systému a aplikace ho jen ukazuje a mění systémovými příkazy.
