# Laser control

Browser control panel for the **Ender 3 S1 + Creality 5 W laser** conversion. It talks
to the stock Marlin firmware over **Web Serial**, previews Lasertools `.ngc` files on a
220 × 220 mm bed, and can home, jog, focus, mark alignment corners, and stream a job
(dry or live).

Built with **Vue 3 + Vite + Tailwind v4** and styled exclusively with the sibling
**Reclaim UI** `base` theme. The Python tools in `/home/antero/Projects/laser cutter`
remain the reference implementation and are not modified.

## Requirements

- Node 20+ for the dev server and build.
- **Chromium** or **Firefox 151+** on desktop, over `localhost` or `https` (Web Serial
  needs a secure context; a plain-HTTP LAN address will not work).
- The printer connected **directly** over USB — a hub caused enumeration failures on
  this machine.
- Laser safety glasses (450 nm rated) whenever the machine can fire.

## Develop

```sh
cd /home/antero/Projects/reclaim/laser
npm install
npm run dev
```

Open the printed `localhost` URL. The app consumes Reclaim UI **from source** through
Vite aliases to `../../reclaim-ui` (the Reclaim checkout beside `Projects/reclaim`),
so a component change in that checkout is picked up
immediately. Bare dependencies (`vue`, `reka-ui`, `clsx`, `tailwind-merge`) come from
this app's `node_modules`.

```sh
npm test           # pure G-code parser tests (no browser, no hardware)
npm run test:shots # preview screenshots via cached Playwright Chromium (no hardware)
npm run build      # production build into dist/
npm run preview
```

`test:shots` starts its own Vite server, loads the sample grids through the file
input, and writes light/dark × relative/absolute preview captures to
`tests/screenshots/`. It uses `playwright-core` with the Chromium already cached
in `~/.cache/ms-playwright` (no browser download).

## Deploy

`npm run build` produces a self-contained static `dist/` — Reclaim source is bundled.
`vite.config.js` sets `base: "./"`, so the output also works under a GitHub Pages
subpath (for example `https://user.github.io/repo/laser/`). Upload the contents of
`dist/` as-is.

## Using the panel

1. **Connect** opens the browser's serial-port picker (the CH340 device). Opening the
   port resets the board, so the app waits for the banner, drains it, and treats the
   position as **not homed**.
2. **Home** runs `G28` (CRTouch gives `Z0 = bed`).
3. **Load** a Lasertools `.ngc` with **Open G-code**. The preview shows burn paths,
   optional travel moves, the firing bounding box, corner markers, and the live head
   position. Burn opacity tracks each segment's S power: the **Power scale** select
   (right panel) switches between *Relative* (normalized to the job's max S, the
   default) and *Absolute* (against S1000). Y is flipped so the canvas matches the
   front-left machine origin.
4. **Jog** X/Y with the arrow pad. Step is 0.1 / 1 / 10 mm; manual moves are clamped to
   X/Y 0–220 mm and Z 0–250 mm.
5. **Z**: enter a Z target and use the vertical nudge buttons. The `0` button moves to
   the entered value; `±1`, `±10` and `±100` move relative to the current Z. Two `+10`
   clicks raise the head 20 mm for loading.
6. **Corner dots** visits the four bounding-box corners. `S0` is a dry visit; a higher
   power fires a short pulse of the set time per corner behind a confirmation dialog.
7. **Run** streams with ok-wait flow control. **Override S** rewrites every nonzero `S`
   in the stream at send time; an existing `S0` stays `S0`. **Dry run (S0)** is a
   shortcut that forces the effective power to `S0` without changing the override
   value, so you can dry-run and then return to the same power. A fresh browser starts
   with dry run on. **Stop** breaks after the in-flight line and sends `M5`. `M5` is
   attempted on every exit path (stop, error, disconnect, tab close).

Settings (`focus_z` as the Z target, dot power/time, jog step, dry run, override
S/enabled, dark mode, preview power scale) live in this browser's `localStorage`
under `laser.*` keys. They
are intentionally **not** synced with the Python tools' `~/.config/laser-cutter/config.json`;
enter the Z target once in the GUI.

## Safety

- Wear 450 nm-rated glasses. Never leave a firing job unattended.
- A software **Stop** is not an emergency stop: a long buffered move finishes before
  the stream breaks. The printer's physical switch is the real E-stop.
- Stop the job before closing the tab. The `pagehide` handler makes a best-effort `M5`,
  but an unload cannot be awaited.
- Use a sacrificial, non-reflective plate under the work (matte ceramic, anodized
  aluminium, slate). Do not fire directly on the PEI sheet.
- Keep a spray bottle or CO₂ extinguisher within reach and ventilate paint/fume work.

## Layout

```
laser/
├── index.html
├── package.json
├── vite.config.js          # Vue + Tailwind; @reclaim/ui & @reclaim/themes aliases
├── public/favicon.svg
├── src/
│   ├── main.js             # theme/fonts, dark mode bootstrap, mount
│   ├── app.css             # Reclaim Tailwind bridge + component source scan
│   ├── App.vue             # shell, sidebar sections, dialogs, file input
│   ├── components/
│   │   ├── BedPreview.vue  # canvas: bed, toolpath, bbox, corners, head
│   │   └── LogPane.vue     # mono serial console (last 2000 lines)
│   └── lib/
│       ├── gcode.js        # pure parser (Node-tested)
│       ├── marlin.js       # Web Serial link, serialized ok-wait queue
│       ├── store.js        # reactive state + connect/home/jog/dots/run actions
│       └── theme.js        # token → rgba() resolver for canvas
└── tests/
    ├── gcode.test.mjs      # parser unit tests (plain Node)
    └── preview.screenshot.mjs  # Playwright preview captures → tests/screenshots/
```

The design system gained two components for this app — **`Dialog`** and **`Progress`** —
in `reclaim-ui/packages/ui/src/components` (plus their `.rc-*` classes and registry
entries). Everything else is reused from Reclaim UI.

## Sample G-code

The reference project ships test files at:

```
/home/antero/Projects/laser cutter/gcode/output.ngc
/home/antero/Projects/laser cutter/gcode/test_grid.ngc
/home/antero/Projects/laser cutter/gcode/test_paths.ngc
```

`test_grid.ngc` is a good first preview and dry run: power increases left → right and
speed increases bottom → top. The parser tests read those files directly.