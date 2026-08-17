# PiP Toolkit — a Premiere Pro panel for zooms, highlights & talking-head overlays

A personal-use Adobe Premiere Pro extension inspired by the kind of "click a
few times instead of hand-keyframing" panel editors build for themselves.
It adds a dockable panel with three tools:

- **Zoom** — click a point in the frame, pick a scale, hit **Animate Zoom**.
  Keyframes a smooth push-in on the selected/parked clip's Motion effect,
  with an optional hold + zoom back out.
- **Highlight** — drag a box over the thing you want to call out, pick a
  style (**Draw**, **Pop**, **Fade**), hit **Animate Highlight**. Dims the
  rest of the frame, reveals the boxed region at full brightness, and
  optionally magnifies it, with a border and colored glow.
- **Overlay** — position/size a talking-head or PiP clip with a 9-position
  preset grid (or a free-drag point), pick a shape, add a border/glow/drop
  shadow, and animate it into place (slide from the edge, pop, or fade).

Built as an Adobe CEP (Common Extensibility Platform) panel: an HTML/JS UI
that drives Premiere through an ExtendScript host file. That's the
extensibility layer that has reliably supported custom Premiere Pro panels
for years (Premiere's newer UXP support doesn't yet cover this kind of
panel), and it's what most third-party Premiere panel plugins on the market
are built with.

## Install

You need Adobe Premiere Pro (2021 / v15 or newer) installed. This extension
is unsigned (a personal certificate would need to be generated and Premiere
told to trust it), so Premiere needs to be put into debug mode to load it —
completely normal for personal/dev panels, same as any custom panel that
isn't distributed through Adobe Exchange.

**macOS**
```
cd premiere-pip-toolkit
./install.sh
```

**Windows** (PowerShell)
```
cd premiere-pip-toolkit
./install.ps1
```

Both scripts copy/symlink this folder into Premiere's CEP extensions
directory and flip the `PlayerDebugMode` flag for CSXS versions 9–12 (the
range current Premiere releases use). Restart Premiere, then open the panel
from **Window > Extensions > PiP Toolkit**.

If you'd rather do it by hand: copy this whole folder into
`~/Library/Application Support/Adobe/CEP/extensions/` (macOS) or
`%APPDATA%\Adobe\CEP\extensions\` (Windows), and set the registry value /
`defaults write com.adobe.CSXS.11 PlayerDebugMode 1` (repeat for the CSXS
version your Premiere build uses if 11 doesn't do it).

If the extension folder ends up with a macOS "quarantine" flag (this
happens when you get the files by downloading a ZIP through a browser, and
makes Premiere silently skip the extension with no error anywhere), clear
it with:
```
xattr -dr com.apple.quarantine ~/"Library/Application Support/Adobe/CEP/extensions/pip-toolkit"
```

## Updating

If you got this folder via `git clone` (recommended over downloading a
ZIP — see below), pulling new versions is one command:
```
./update.sh
```
This pulls the latest changes, makes sure Premiere's extensions folder is
symlinked straight to this checkout (so there's no separate copying step,
ever), clears any quarantine flag, and quits Premiere for you (reopen it
manually afterwards).

If you originally installed via ZIP download rather than `git clone`, switch
to a proper clone once so `update.sh` has something to pull:
```
cd ~/Documents   # or wherever you want to keep it
git clone -b claude/premiere-editing-plugin-i43hpm https://github.com/Leeevans117/Claude-code.git pip-toolkit-src
cd pip-toolkit-src/premiere-pip-toolkit
./install.sh
```
From then on, `./update.sh` from inside that folder is the only command
you need after any update.

## Using it

1. Select a clip in the timeline (or just park the playhead over it — the
   panel falls back to whatever's on the topmost video track under the
   playhead if nothing is explicitly selected).
2. Pick a tool tab.
3. Click/drag in the frame preview at the top of the panel to set the point
   or box.
4. Adjust the sliders.
5. Hit the **Animate** button. Keyframes land on the clip relative to the
   current playhead position — put the playhead where you want the effect
   to peak before clicking Animate.

Hit the refresh icon (↻) top-right any time you change your selection — the
panel also auto-refreshes every few seconds.

## How the automation actually works

**Zoom** keyframes the clip's built-in Motion effect (`Position` +
`Scale`), computed so the point you clicked lands dead-center at your
target scale, with the frame's original 100%/centered framing as the start
keyframe. That's ordinary Position/Scale math, documented and reliable
across Premiere versions.

**Highlight** ("spotlight" technique) — Premiere has no native shape/vector
generator the way After Effects does, so this is built entirely from stock
effects: the highlighted region is a duplicate of the same source clip on
an empty track above the original, cropped down to just your box (the crop
edges are what get keyframed for the Draw/Pop reveal styles), while the
original clip underneath gets a Brightness & Contrast dip so everything
*outside* the box dims. That's why it needs a free video track above your
clip to work — the panel will tell you if there isn't one.

**Overlay** repositions/scales the existing PiP clip directly via
Position/Scale (no duplication needed) and layers on Drop Shadow / Alpha
Glow / Bevel Edges for the frame treatment.

## Known limitations (read before you rely on this)

Being upfront about where this sits outside Premiere's officially
documented scripting surface, since a couple of these functions matter for
whether a feature works on your specific Premiere version:

- **Adding new filter effects** (Crop, Drop Shadow, Alpha Glow, Bevel
  Edges, Brightness & Contrast) uses Premiere's "QE" automation DOM. It's
  not in Adobe's public scripting guide, but it's the long-standing,
  widely-used way Premiere scripts add effects, because the documented
  `TrackItem`/`Component` API has no supported "add an effect" call. If it
  fails on your Premiere version, the panel skips that one cosmetic step
  (border/glow/dim/crop) and tells you what it couldn't add, rather than
  aborting — position/scale/opacity keyframing (the main value) always goes
  through the documented API and isn't affected.
- **Setting effect colors** (glow color) similarly uses a best-effort
  numeric format for Premiere's color parameters; if your version rejects
  it, the effect still gets added, just without the custom color.
- **Rounded/circle overlay shapes** would need a mask on the Opacity
  effect, which isn't reliably scriptable across Premiere versions. The
  panel attempts it and reports if it fell back to a plain rectangle — Drop
  Shadow, Alpha Glow, and border still apply either way.
- **Border** is approximated with Premiere's built-in Bevel Edges effect
  (a lit 3D bevel along the alpha edge) since Premiere has no native flat
  colored-stroke effect — it reads as a border but isn't a flat color; the
  border-color picker is UI-only until a stroke effect is added.
- Every host-script function returns a structured `OK` / `OK|warn:...` /
  `ERR|...` string that the panel surfaces in the status bar, so failures
  are visible rather than silent.

## Project layout

```
premiere-pip-toolkit/
├── CSXS/manifest.xml     extension manifest (host app/version, panel size)
├── .debug                enables CEF remote debugging on port 8088
├── client/               panel UI (HTML/CSS/JS, runs in Premiere's CEF)
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── stage.js      draggable point/rect frame picker
│       └── main.js       panel logic, talks to the host script
├── host/hostscript.jsx   ExtendScript automation (the actual Premiere control)
├── install.sh / install.ps1
└── README.md
```

## Debugging

With `.debug` in place, open `http://localhost:8088` in Chrome while
Premiere is running with the panel open — that gives you devtools on the
panel's HTML/JS side. For the ExtendScript side, `$.writeln()` calls in
`hostscript.jsx` show up in the ExtendScript Toolkit / Visual Studio Code
ExtendScript debugger console.

## Extending it

`host/hostscript.jsx` is organized as: shared utilities → `getContext()` →
one section per tool. Each tool function is self-contained and returns a
plain string, so adding a fourth tool means adding one function there and
one panel section + button handler in `client/`.
