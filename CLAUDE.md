# Closet – project notes for Claude

Read this first. It explains what the app is, who it is for, how it is built, and every
decision made so far, so work can continue without the original conversation.

## What this is

A personal **wardrobe / outfit-planning web app**, built by "vibe coding" with a non-developer
(the user). The user photographs their clothes with an iPhone, the app removes the background,
sorts the items into categories and lets them put outfits together on one screen.

- Runs in the browser (Safari on iPhone, added to the Home Screen; also used on a Mac while
  developing). **No installation, no App Store, no Xcode.** (Xcode was rejected: the Mac has
  little free disk space.)
- Planned hosting: **GitHub Pages** (free, static). Nothing is sent to any server; all photos
  and outfits stay on the user's device.
- The user writes to me in **Slovak**. The **app UI is in English** (their explicit request).
  Answer in Slovak, plain language, no jargon; they are not a programmer. Explain what a change
  does for them, and say honestly what was *not* verified (e.g. "tested in a desktop browser,
  not on a real iPhone").

## Tech and rules of the house

- Plain HTML + CSS + JavaScript ES modules. **No framework, no build step, no npm.**
  Keep it that way unless the user agrees; they edit it in VS Code.
- Storage: **IndexedDB** (`db.js`, database `satnik`, version 2, stores `items` and `outfits`),
  plus `localStorage` key `satnik.adjust` for hand adjustments of pieces.
- Background removal: `@imgly/background-removal@1.4.5` loaded from **esm.sh**
  (`image.js`). The model is `'small'` (the first use downloads it, about a minute; later runs
  are fast). Notes: the jsDelivr `+esm` build of this library is broken (lodash import error);
  model names in this version are only `small` / `medium`.
- **Cache busting:** every local import and the `<script>`/`<link>` in `index.html` carry
  `?v=NN`. **Bump NN in all of them whenever files change** (currently 33), e.g.
  `sed -i '' 's/?v=33/?v=34/g' index.html app.js editor.js`. Browsers (Safari especially) cache
  modules and once served a stale `image.js` against a new `app.js`.
- `serve.py` is the local dev server (`python3 serve.py [port]`, serves its own folder, sends
  `Cache-Control: no-store`). Do not use `python3 -m http.server`.
- **IndexedDB upgrades are blocked by other open tabs** of the app. `db.js` exposes `onBlocked`
  and `app.js` shows a visible notice ("another tab is open … your items are safe"). New
  database versions must only *add* stores, never delete data. The user once thought their
  items had vanished because of exactly this; they had not.
- The layout is a phone-width column (max 520px, centred) also on wide screens (user request).
- Never ask the user to clear Safari website data: that deletes their wardrobe.

## Files

| File | Role |
| --- | --- |
| `index.html` | All screens: Outfit, Closet, Saved, Add, plus the touch-up editor, the item sheet, a notice and a toast |
| `style.css` | Look (colour tokens at the top, light and dark mode) |
| `app.js` | Everything about screens and outfits (state, strips, Complete view, saved outfits, closet, add flow) |
| `editor.js` | Touch-up editor (erase / restore brush, zoom and pan, Enhance slider) |
| `image.js` | Photo handling: downscale, background removal, crop, `tightCrop` (+ shoulder/body measurements) |
| `enhance.js` | Cheap photo clean-up without AI (even out light, contrast, saturation) |
| `db.js` | IndexedDB wrapper |
| `serve.py`, `manifest.webmanifest`, `icon.png`, `README.md` | Dev server, Home Screen icon, short Slovak user guide |

## Data model

- **Item** (`items` store): `{ id, cat, blob (PNG, background removed, cropped), created }`.
  `cat` is one of `top, bottom, dress, sweater, jacket, shoes`.
- **Outfit** (`outfits` store): `{ id, created, mode, ids: { category: itemId }, adj: { pieceKey: {dx, dy, scale} } }`.
  `ids` key order is fixed by `slotsFor()` – it is part of how outfits are compared.
- **Mode** is a string: `tb` (top + bottom), `dress`, plus an optional layer prefix/suffix:
  `sweater`, `jacket` (over top + bottom), `dresssweater`, `dressjacket`. `parseMode` /
  `makeMode` convert it. Shoes are a separate on/off flag (`state.shoes`, saved as `ids.shoes`).
- **Piece keys** for hand adjustments: `top|id`, `bottom|id`, `dress|id`, `shoes|id`,
  `sweater|id` / `jacket|id` (only when alone), and `<mainId>|<layerId>` for a layer over a
  top or dress. They are stored in `localStorage` and snapshotted into each saved outfit.

## Screens and behaviour (and why)

**Add** – pick or take a photo → background removed automatically → choose category.
Options: *Cutout / Original* toggle, *Straighten* slider + 90° button, **Enhance** slider
(0–100, off by default, applied on save, not undoable), **Erase leftovers** opens the editor.
The cutout sometimes keeps a hanger or floor; the user wanted a manual fix, not auto-detection.

**Touch-up editor** (`editor.js`, also reachable for saved items) – Erase / Restore / Move tools,
brush size slider, Undo, zoom (pinch, wheel, + / − / Fit) and two-finger pan, Enhance slider.
Strokes are kept as a list (cheap undo). *Restore* only brings back what the cutout had.
A "remove loose bits" button was built and then **removed at the user's request** (did not work well).

**Outfit (strips view)** – rows of horizontally swipeable strips (scroll-snap): top and bottom
separately; a layer (sweater/jacket) sits next to the top or dress as a half-width strip.
Controls: *Top + bottom | Dress*, then *+ Sweater | + Jacket | + Shoes* (sweater and jacket
are mutually exclusive; tapping the active one turns it off). The shuffle button was removed
at the user's request.

**Complete view** (`buildOutfit` / `renderComplete`) – the outfit shown as if worn.
Decisions, in order they were made:
1. A body silhouette/mannequin was tried and **rejected** by the user. Pieces are simply stacked.
2. Items are first **cropped to their real content** (`tightCrop`), never aligned by the photo edge.
3. Top and layer are **aligned by the shoulder line** (first row where the garment reaches 55%
   of its maximum width, so thin straps and hangers are skipped) and the layer is scaled to the
   same **body width** (median width of the lower part), clamped to 0.6x–1.6x.
4. With a layer, the **top shows only its left half and the layer only its right half**
   (explicit request). With a dress the dress stays whole and the layer covers its right half.
   Known side effect: a shorter layer leaves a gap under its hem; fix by hand adjustment.
5. Bottoms sit directly under the upper part (8 units overlap), shoes (optional) at the very bottom.
6. Units: figure 200 wide; fit boxes top 150x190, dress 170x420, bottom 120x300, shoes 110x70.

**Hand adjustment** (`setUpAdjust`) – tap a piece in the picture to select it (hit test uses the
picture's transparency, topmost wins); drag to move, pinch / wheel to resize (about the shoulder
line; shoes and bottoms about their top centre). Nothing is selected at first; **tapping outside
deselects** (user request) and nothing can be moved without a selection. A dashed frame shows the
selection; buttons under the picture (Bottom / Top / Sweater / Jacket / Dress / Shoes) are the
alternative way to select. **Pieces cannot leave the grey outfit card** (`keepInside`).
Adjustments are remembered per item (per pair for layers) and reset with *Reset*.

**Saved** – heart button in Complete view saves the whole outfit (mode, items, adjustments);
the heart is filled while the shown outfit is already saved; tapping it again removes it.
The *Saved* tab shows cards; tap opens the outfit in Complete view as saved; *Edit* deletes.
Deleting an item warns that saved outfits using it are deleted too.

**Closet** – grid with category filters (they wrap onto several lines so none is hidden), a
frozen header (title, Edit, filters stay on top while scrolling). Select items and tap *View
outfit* to jump to Outfit (the mode is chosen automatically). In *Edit* mode, tapping an item opens
a sheet: change category, touch up the photo, delete.

## Decisions to respect

- Category names in English, the most common fashion terms: Tops, Bottoms, Dresses, Sweaters,
  Jackets, Shoes. "Jackets" is separate from "Sweaters" (user chose this over renaming).
- **Skirts are not a separate category** (6 categories is already many). They go into Bottoms,
  which can be moved and resized. If the list grows, prefer a filter/tag inside Bottoms.
- Shoes are optional and hidden unless switched on.
- Enhance must stay light (canvas maths, no AI, little memory). It evens out shadows and colour;
  it does **not** iron out wrinkles.
- Everything must work with a finger on a phone (pointer events, `touch-action: none` where needed).

## How to test

Run `python3 serve.py 8765`, open it in a browser (or the preview pane) at phone size.
Real photos are not available in tests, so make synthetic items (canvases saved with
`db.put`) – remember to delete them afterwards. Pointer events can be dispatched by script with
`pointerId: 1` (other ids make `setPointerCapture` throw). Real iPhone behaviour (camera,
multi-touch, Home Screen install) has **not** been verified by me; say so.

## Ideas not done yet

- **Export / import backup** (single file with all items and outfits). Important before publishing:
  data belongs to the page address, so moving from `localhost` to `github.io` starts empty.
  The address must not change later (renaming the repo or account would lose the data).
- Shoes could follow the bottoms automatically when those are resized.
- Two layers at once (sweater and jacket), which needs a different half-and-half display.
- Skirt filter/tag inside Bottoms.
- Publishing to GitHub Pages (README has the steps in Slovak).
