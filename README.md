# Šatník

Webová aplikácia na iPhone: odfotíš oblečenie, aplikácia odstráni pozadie a potom swipovaním skladáš outfity.

## Súbory

| Súbor | Čo robí |
| --- | --- |
| `index.html` | Štruktúra obrazoviek (Outfit, Šatník, Pridať) |
| `style.css` | Vzhľad. Farby sú hneď na začiatku súboru |
| `app.js` | Správanie aplikácie: swipovanie, mriežka, pridávanie |
| `image.js` | Odstránenie pozadia, vyrovnanie a orezanie fotky |
| `db.js` | Ukladanie oblečenia v telefóne |
| `manifest.webmanifest`, `icon.png` | Aby sa dala pridať na plochu ako aplikácia |

## Spustenie na Macu

V termináli vo VS Code (menu **Terminal → New Terminal**):

```bash
python3 serve.py
```

Potom otvor v prehliadači `http://localhost:8000`.

## Zverejnenie na GitHub Pages

1. Na github.com si vytvor nový repozitár, napríklad `satnik` (Public).
2. Nahraj doň všetky súbory z tohto priečinka (**Add file → Upload files**).
3. V repozitári choď do **Settings → Pages**, pri **Branch** vyber `main` a `/ (root)` a ulož.
4. O minútu bude aplikácia na adrese `https://TVOJE-MENO.github.io/satnik/`.

## Pridanie na plochu iPhonu

1. Otvor adresu v **Safari**.
2. Ťukni na **Zdieľať** a potom na **Pridať na plochu**.
3. Aplikáciu otváraj vždy z ikony na ploche. Tak Safari tvoje oblečenie nevymaže.

## Dobré vedieť

- Fotky sú uložené iba v telefóne. Na GitHube je len kód.
- Pri prvom odstraňovaní pozadia sa stiahne AI model (desiatky MB). Je lepšie byť na Wi-Fi.

## Poznámky pre ďalšiu prácu

Súbor `CLAUDE.md` obsahuje opis aplikácie, všetky rozhodnutia a požiadavky. Keď otvoríš tento priečinok v Claude Code, prečíta si ho a vie, ako pokračovať.
