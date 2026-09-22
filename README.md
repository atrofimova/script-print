# Script Print (Desktop)

A macOS desktop app for queuing up and batch-printing PDF documents.
Confirmed working with The University of Auckland's FollowMe print queues
(color, duplex, and stapling), talking directly to CUPS. Started life as a
Figma Make React prototype with fully simulated printing/file behavior;
all of that has since been replaced with real OS integration.

**Scope: PDF only.** The file dialog is filtered to `*.pdf`, dropped
non-PDF files are rejected with an on-screen message, and the print path
only handles `.pdf`. DOCX/XLSX support was deliberately left out.

**Platform status: macOS/Linux only.** Printing goes through the `lp`
(CUPS) command, which doesn't exist on Windows. `package.json` still has a
`build:win` script and `win` build config left over from an earlier plan,
but printing itself will throw an "isn't wired up yet" error on Windows —
see [Windows support](#windows-support-not-implemented) below.

## Project layout

```
script-print/
├── electron/
│   ├── main.js      # App window, IPC handlers, printing logic
│   ├── preload.js    # Safe bridge exposed to the renderer as window.printPresetAPI
│   ├── pdf.js          # Real PDF page count + color-content detection
│   └── icon.png         # App icon, loaded at runtime for the dock/taskbar
├── frontend/             # The React/Vite UI (from the Figma prototype), rewired
│                          # in App.tsx to call the real Electron APIs
├── build-resources/      # icon.icns / icon.ico / icon.png — used by
│                          # electron-builder when producing installers
└── package.json          # Electron + electron-builder scripts
```

## Printing — how it actually works

Printing goes straight to CUPS via the `lp` command line tool
(`electron/main.js`, `printViaCups`) — the same system every native macOS
app (Preview, Acrobat, etc.) uses under the hood. This was a deliberate
change from an earlier approach that loaded PDFs into a hidden
`BrowserWindow` and used Chromium's built-in print pipeline
(`webContents.print`): that approach turned out to be unreliable for local
PDFs, either producing blank pages or hanging indefinitely depending on
the PDF viewer's render timing. Submitting directly to CUPS is faster and
far more predictable.

Options sent to `lp`, confirmed working against the FollowMe-BW /
FollowMe-Colour queues' actual PPD:

- `-o sides=two-sided-long-edge` / `-o sides=one-sided` — duplex
- `-o print-color-mode=color` / `-o print-color-mode=monochrome` — color mode
- `-o StapleLocation=UpperLeft` — top-left staple, when the toggle is on

The staple option is only applied if `staple` is true, and if CUPS rejects
it (unsupported on some other printer's driver), the job is automatically
resubmitted without it rather than failing outright — see the retry logic
in `printViaCups`. **Note:** exact CUPS option names (especially for
stapling) vary by printer driver/PPD. If you point this at a different
printer and stapling silently does nothing, check what that printer
actually supports with:

```bash
lpoptions -l -d "<printer name>"
```

### Windows support: not implemented

Windows has no CLI equivalent to `lp`. The standard approach for silent
PDF printing on Windows is the `pdf-to-printer` npm package, which bundles
SumatraPDF for that purpose and falls back to `lp`/`lpr` on macOS/Linux —
worth adopting if Windows support becomes necessary, but not currently
wired up (`printViaWindows` in `main.js` just throws an explanatory
error).

## PDF color detection — how it actually works

There's no simple "is this PDF color?" flag in the PDF spec. `electron/pdf.js`
decompresses each page's actual content stream and inspects what's really
drawn, rather than scanning the raw file for color-space *declarations* —
an earlier version did the latter and produced false positives, since PDF
generators (LaTeX, Ghostscript, Word/macOS print-to-PDF, etc.) often embed
unused ICC profiles / output-intent metadata even in genuinely grayscale
documents.

What it actually checks, per page:

1. **Vector/text paint operators**: `rg`/`RG` (RGB) and `k`/`K` (CMYK)
   fill/stroke, and `sc`/`SC`/`scn`/`SCN` (the general "set color"
   operators many real-world PDF producers use instead of the plain
   shorthand) — flagged only when the values aren't gray (unequal RGB
   channels, or nonzero CMY).
2. **Embedded images actually drawn on the page** (referenced via a `Do`
   operator, not just sitting unused in a resource dictionary): checks
   each image's declared `ColorSpace` for DeviceRGB/DeviceCMYK/multi-channel
   ICC/Indexed-with-color-palette.

**Known limitation:** image detection checks the declared color space, not
actual pixel content — an RGB-encoded image containing only gray pixels
(common with some scanners) can still be flagged as color. True
pixel-level detection would need decoding and rendering the image data,
which is a much heavier operation than this heuristic; it favors not
missing real color content over being pixel-perfect on that edge case.

## App icon & name

- `build-resources/icon.icns` / `icon.ico` / `icon.png` are the source
  icon files (a printer glyph on the app's navy header color), used by
  electron-builder when producing installers. These are checked-in, hand-made
  assets — not build output — so they belong in version control.
- `electron/icon.png` is a separate copy of the same icon, used at runtime
  for the dev-mode window/dock icon (`build-resources/` itself isn't
  bundled into the packaged app, only what's listed under `files` in
  `package.json`'s build config).
- The app name ("Script Print") is set in three places that don't
  automatically stay in sync: `package.json`'s `name`/`productName`
  (used by electron-builder for the installer and packaged `.app` bundle
  name), `app.setName()` in `electron/main.js` (used for this app's own
  menu bar labels while running), and the header text in
  `frontend/src/App.tsx`. In dev mode (`npm run dev`), macOS will still
  show "Electron" in the dock tooltip/Cmd+Tab switcher regardless of
  `app.setName()` — that's tied to the actual running binary's bundle name
  (generic `Electron.app` while developing), and only resolves once
  packaged via `npm run build:mac`, which produces a real
  `Script Print.app` bundle.

## Setup

```bash
npm install          # installs Electron + build tooling, then runs postinstall
                      # which installs the frontend's dependencies too
```

Requires **Node 22 LTS** — Electron's postinstall (which downloads the
actual Electron binary) has been unreliable on newer/pre-release Node
versions (e.g. v26) in testing; if `node_modules/electron/path.txt` is
missing after install, that's usually why. Use `nvm install 22 && nvm use 22`
if needed.

If your npm has script-execution allowlisting enabled (shows a
`install-scripts` warning during install), you'll need to approve
Electron's postinstall explicitly or its binary download will be silently
skipped:

```bash
npm install-scripts approve electron
```

## Development

```bash
npm run dev           # runs Vite dev server + Electron together, with hot reload
```

## Building installers

```bash
npm run build:mac     # produces a macOS .dmg + .app in /release
npm run build:win     # NOT currently functional — see Windows support above
```

If `electron-builder`'s DMG packaging step fails with an `hdiutil detach`
error, a stale mounted volume from a previous failed build is usually the
cause:

```bash
hdiutil detach "/Volumes/Script Print 1.0.0-arm64" -force
```

The packaged `.app` in `release/mac-arm64/` is usually already valid even
if the final DMG step fails — check there if you just need the app itself.

## Known follow-ups worth discussing

1. **Windows printing**: not implemented — see above. Would need the
   `pdf-to-printer` package or equivalent.
2. **Code signing**: unsigned builds will trigger Gatekeeper warnings on
   first run. For real distribution, you'll want an Apple Developer ID +
   notarization — not wired up since it needs your actual certificates.
3. **License**: MIT — this was built for the University of
   Auckland printer infrastructure.
