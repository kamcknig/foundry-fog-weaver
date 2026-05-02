# Fog Weaver

A Foundry VTT v13+ module that gives the GM full manual control over fog of war. When enabled, token movement no longer reveals fog — the GM paints revealed and hidden areas directly using a set of drawing tools.

## Requirements

- Foundry VTT v13+
- [libWrapper](https://foundryvtt.com/packages/lib-wrapper) v1.12+

## Features

- Four drawing tools: **Circle/Ellipse**, **Rectangle**, **Line**, and **Freehand**
- **Alt + drag** on any tool switches to erase mode (re-fogs the painted area)
- **Shift + drag** draws from center (circle and rectangle tools)
- **Ctrl + drag** constrains to a perfect circle or square (circle and rectangle tools)
- **Single click** with the Freehand tool deposits a dot at the click point
- In-HUD panel with live sliders for fog opacity, fog tint color, and line/stroke width
- **Undo** (Ctrl+Z or the Foundry undo keybind) removes the most recently drawn shape and rebuilds the fog texture
- **Reset Fog** button clears all revealed/hidden areas and the drawing history

## Installation

Install using the manifest URL directly.

For local development, symlink the repo into your Foundry data folder:

```
ln -s /path/to/fog-weaver /path/to/foundry/Data/modules/fogweaver
```

## Usage

### Activating the module

Enable the module in **Module Management**. The module adds an **Enable Manual Fog Control** world setting (on by default). When enabled, the Fog Weaver scene control (cloud-fog icon) appears in the left toolbar, visible only to GMs.

Click the **Fog Weaver** toolbar button to activate the layer. A HUD panel appears to the right of the toolbar with live controls.

### Drawing tools

| Tool | Icon | Behavior |
|---|---|---|
| Circle / Ellipse | `fa-circle` | Drag to draw an ellipse from corner to corner |
| Rectangle | `fa-square` | Drag to draw a rectangle from corner to corner |
| Line | `fa-minus` | Drag to draw a stroked line |
| Freehand | `fa-paintbrush` | Drag to paint a freehand stroke; click for a dot |

### Modifier keys

| Key | Effect |
|---|---|
| **Alt** | Erase mode — preview turns red; release to hide fog along the shape |
| **Shift** | Draw from center (circle and rectangle tools only) |
| **Ctrl / Cmd** | Constrain to circle or square aspect ratio (circle and rectangle tools only) |

Modifier keys can be pressed and released while dragging; the preview updates in real time.

### HUD panel

The panel appears automatically when the Fog Weaver layer is active:

| Control | Description |
|---|---|
| **Fog Opacity** slider | How opaque unexplored fog appears to the GM while the tool is active (does not affect players) |
| **Fog Tint** color picker | Color of unexplored fog areas shown to the GM |
| **Line Width** slider | Stroke width used by the Line and Freehand tools (world units) |

These controls are per-client. Changes are saved to the module settings immediately on release.

### Undo

Press **Ctrl+Z** (or the Foundry undo keybind) to remove the most recently drawn shape. The fog texture is rebuilt from the remaining shape history. Each undo step is a single shape record; multiple undos pop the stack one at a time.

### Reset Fog

Click the **Reset Fog** button (cloud icon, bottom of the tool list) to erase all revealed and hidden areas and clear the entire drawing history. This operation cannot be undone.

## Settings

| Setting | Scope | Default | Description |
|---|---|---|---|
| Enable Manual Fog Control | World | `true` | Master switch. When off, token movement resumes revealing fog normally. |
| Line Tool Width | World | `100` | Stroke width (world px) for the Line and Freehand tools. Range: 20–500. |
| GM Fog Preview Opacity | Client | `0.7` | Fog opacity shown to the GM while the Fog Weaver layer is active. Range: 0.2–1.0. |
| GM Fog Tint Color | Client | `#000000` | Color of unexplored fog shown to the GM. |

## How it works

When enabled, Fog Weaver:

1. **Intercepts `FogManager.commit()`** via libWrapper so token movement no longer writes to the fog texture.
2. **Patches the `VisibilityFilter` shader** so fog is driven purely by the GM-drawn texture rather than token line-of-sight. Revealed areas (`r = 1` in the fog texture) are always visible regardless of token position.
3. **Persists shape records** (`scene.flags.fogweaver.shapes`) so the fog can be exactly rebuilt on world reload or after an undo. Each record carries the shape kind, geometry, whether it is an erase, and a snapshot of the stroke width.
4. **Syncs the fog texture** to all connected players after each draw operation via `canvas.fog.sync()`.
5. **Shows the GM a tinted overlay** (a PIXI sprite sampling the fog RenderTexture through a custom fragment shader) so the GM can see unexplored areas while painting.

### Shape persistence format

Shapes are stored in `scene.flags.fogweaver.shapes` as an array of records:

```jsonc
[
  // Ellipse / rectangle — defined by bounding box corners
  { "id": "…", "shape": "ellipse", "from": {"x": 100, "y": 200}, "to": {"x": 300, "y": 400}, "isErase": false },
  { "id": "…", "shape": "rect",    "from": {"x": 100, "y": 200}, "to": {"x": 300, "y": 400}, "isErase": false },
  // Line — from/to with a snapshotted stroke width
  { "id": "…", "shape": "line", "from": {"x": 100, "y": 200}, "to": {"x": 300, "y": 400}, "lineWidth": 100, "isErase": false },
  // Freehand — flat [x1, y1, x2, y2, …] point array with snapshotted stroke width
  { "id": "…", "shape": "freehand", "points": [100, 200, 110, 205, …], "lineWidth": 100, "isErase": false }
]
```
