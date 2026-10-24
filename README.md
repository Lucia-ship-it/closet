# Closet

Webová aplikácia na iPhone: odfotíš oblečenie, aplikácia odstráni pozadie, zaradí ho do kategórie a potom swipovaním skladáš outfity. Hotové outfity si môžeš uložiť.

**Adresa aplikácie:** https://lucia-ship-it.github.io/closet/

## Čo aplikácia vie

- **Add:** fotka kúsku, automatické odstránenie pozadia, úprava (guma, vyrovnanie, Enhance) a výber kategórie (Top, Bottom, Dress, Sweater, Jacket, Shoes).
- **Outfit:** swipovanie kúskov, voliteľne sveter alebo bunda cez top či šaty a topánky. Tlačidlo **Complete** ukáže outfit poskladaný dokopy, kde sa dá každý kúsok posúvať a meniť mu veľkosť. Srdiečkom sa outfit uloží.
- **Saved:** uložené outfity.
- **Closet:** všetky kúsky, filtre podľa kategórie, zmena kategórie, úprava fotky a mazanie.

## Súbory

| Súbor | Čo robí |
| --- | --- |
| `index.html` | Štruktúra obrazoviek |
| `style.css` | Vzhľad. Farby sú hneď na začiatku súboru |
| `app.js` | Správanie aplikácie: swipovanie, skladanie outfitu, uložené outfity, Closet, pridávanie, kontrola aktualizácií |
| `editor.js` | Úprava fotky: guma, vrátenie, zoom, Enhance |
| `image.js` | Odstránenie pozadia, vyrovnanie a orezanie fotky |
| `enhance.js` | Jednoduché vylepšenie fotky (svetlo, kontrast, farby) |
| `db.js` | Ukladanie kúskov a outfitov v telefóne |
| `serve.py` | Malý server na vyskúšanie aplikácie na Macu |
| `manifest.webmanifest`, `icon.png` | Aby sa dala pridať na plochu ako aplikácia |
| `LICENSE` | Licencia (všetky práva vyhradené) |
| `CLAUDE.md` | Opis aplikácie, rozhodnutia a požiadavky pre ďalšiu prácu |

## Spustenie na Macu

V termináli vo VS Code (menu **Terminal → New Terminal**):

```bash
python3 serve.py
```

Potom otvor v prehliadači `http://localhost:8000`.

## Ako sa zmena dostane do telefónu

1. Zmeny sa uložia (commit) a pošlú na GitHub vo VS Code cez **Source Control → Sync Changes**.
2. GitHub Pages ich po minúte-dvoch zverejní.
3. Aplikácia na ploche si novú verziu zistí sama pri spustení (alebo ukáže hore lištu **Update**). Ručne sa dá skontrolovať dole na obrazovke **Add** tlačidlom **Check for updates**.

## Pridanie na plochu iPhonu

1. Otvor adresu v **Safari**.
2. Ťukni na **Zdieľať** a potom na **Pridať na plochu**.
3. Aplikáciu otváraj vždy z ikony na ploche.

## Dobré vedieť

- Kúsky a outfity sú uložené **iba v tomto zariadení**. Na GitHube je len kód. Ikonu z plochy ani dáta stránok v Safari **nemaž**, prišla by si o šatník. Záloha zatiaľ nie je.
- Dáta patria k hlavnej časti adresy (`lucia-ship-it.github.io`). Premenovanie repozitára ich zachová, ale stará adresa prestane fungovať a ikonu na ploche treba pridať znova. Zmena účtu alebo vlastná doména by šatník vyprázdnila.
- Pri prvom odstraňovaní pozadia sa stiahne AI model (desiatky MB). Je lepšie byť na Wi-Fi.
- Odstraňovanie pozadia používa knižnicu od IMG.LY (licencia AGPL-3.0).
