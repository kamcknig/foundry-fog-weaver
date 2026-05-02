const MODULE_ID = "fogweaver";

/** Convert a CSS hex color string (e.g. "#1a2b3c") to a [r, g, b] array in 0–1 range. */
export function hexToRgbArray(hex) {
    const n = parseInt(hex.replace("#", ""), 16);
    return [(n >> 16 & 0xff) / 255, (n >> 8 & 0xff) / 255, (n & 0xff) / 255];
}

// Registration pattern avoids a circular ES-module import between layer.mjs and fogweaver.mjs
let _commitShapeFn = null;
let _undoLastShapeFn = null;

// Minimum cursor travel (world px) before a new sample is appended to a freehand stroke.
// Coarser than 1 px / move event to keep the persisted point array compact without
// visibly affecting stroke smoothness at typical zoom levels.
const FREEHAND_SAMPLE_THRESHOLD = 4;

export function registerFogWeaverCallbacks(commitFn, undoFn) {
    _commitShapeFn = commitFn;
    _undoLastShapeFn = undoFn;
}

export class FogWeaverLayer extends foundry.canvas.layers.InteractionLayer {

    static get layerOptions() {
        return foundry.utils.mergeObject(super.layerOptions, {
            name: "fogweaver",
            zIndex: 600
        });
    }

    static prepareSceneControls() {
        if (!game.user.isGM) return null;
        return {
            name: "fogweaver",
            order: 7,
            title: "FOGWEAVER.Controls.Title",
            layer: "fogweaver",
            icon: "fa-solid fa-cloud-fog",
            visible: game.settings.get(MODULE_ID, "enabled"),
            onChange: (_event, active) => {
                if (active) canvas.fogweaver.activate();
            },
            tools: {
                revealCircle:   { name: "revealCircle",   order: 1, title: "FOGWEAVER.Controls.RevealCircle",   icon: "fa-solid fa-circle" },
                revealRect:     { name: "revealRect",     order: 2, title: "FOGWEAVER.Controls.RevealRect",     icon: "fa-solid fa-square" },
                revealLine:     { name: "revealLine",     order: 3, title: "FOGWEAVER.Controls.RevealLine",     icon: "fa-solid fa-minus" },
                revealFreehand: { name: "revealFreehand", order: 4, title: "FOGWEAVER.Controls.RevealFreehand", icon: "fa-solid fa-paintbrush" },
                resetFog:     {
                    name: "resetFog",
                    order: 9,
                    title: "FOGWEAVER.Controls.ResetFog",
                    icon: "fa-solid fa-cloud",
                    button: true,
                    onChange: () => {
                        foundry.applications.api.DialogV2.confirm({
                            window: { title: game.i18n.localize("FOGWEAVER.Controls.ResetFogTitle"), icon: "fa-solid fa-cloud" },
                            content: `<p>${game.i18n.localize("FOGWEAVER.Controls.ResetFogContent")}</p>`,
                            yes: { callback: () => canvas.fog.reset() }
                        });
                    }
                }
            },
            activeTool: "revealCircle"
        };
    }

    /* ---- Helpers ---- */

    /**
     * Resolve the current drag mode from the active tool and live modifier state on `event`.
     * Alt = erase (red preview). Shift = draw from center. Ctrl/Cmd = constrain to circle/square.
     */
    _getDragMode(event) {
        const name = game.activeTool ?? "";
        const isErase    = !!event?.altKey;
        const fromCenter = !!event?.shiftKey;
        const constrain  = !!(event?.ctrlKey || event?.metaKey);
        let shape;
        switch (name) {
            case "revealCircle":   shape = "ellipse"; break;
            case "revealRect":     shape = "rect"; break;
            case "revealLine":     shape = "line"; break;
            case "revealFreehand": shape = "freehand"; break;
            default:               shape = "ellipse";
        }
        return { isErase, shape, fromCenter, constrain };
    }

    /**
     * Resolve the (from, to) the user is dragging into a normalized bounding box (top-left,
     * bottom-right). Encodes Shift (center origin) and Ctrl (constrain to square aspect) so
     * that the rest of the pipeline can treat ellipse/rect uniformly off two corners.
     */
    _normalizeBoundingBox(origin, cursor, fromCenter, constrain) {
        let dx = cursor.x - origin.x;
        let dy = cursor.y - origin.y;
        if (constrain) {
            const side = Math.max(Math.abs(dx), Math.abs(dy));
            dx = (dx < 0 ? -side : side);
            dy = (dy < 0 ? -side : side);
        }
        if (fromCenter) {
            const ax = Math.abs(dx);
            const ay = Math.abs(dy);
            return {
                from: { x: origin.x - ax, y: origin.y - ay },
                to:   { x: origin.x + ax, y: origin.y + ay }
            };
        }
        const ex = origin.x + dx;
        const ey = origin.y + dy;
        return {
            from: { x: Math.min(origin.x, ex), y: Math.min(origin.y, ey) },
            to:   { x: Math.max(origin.x, ex), y: Math.max(origin.y, ey) }
        };
    }

    /* ---- Permissions ---- */

    _canDragLeftStart(user, _event) {
        return user.isGM && game.settings.get(MODULE_ID, "enabled");
    }

    /* ---- PIXI lifecycle ---- */

    async _draw(options) {
        await super._draw(options);
        this._preview = this.addChild(new PIXI.LegacyGraphics());
        // Force the preview to render to an intermediate texture via a filter. For freehand
        // strokes, all geometry is drawn at alpha=1 and the filter applies the preview opacity
        // uniformly, preventing semi-transparent overlapping round joins from compounding.
        this._previewAlphaFilter = new PIXI.Filter(undefined, `
            precision mediump float;
            varying vec2 vTextureCoord;
            uniform sampler2D uSampler;
            uniform float uAlpha;
            void main(void) {
                gl_FragColor = texture2D(uSampler, vTextureCoord) * uAlpha;
            }
        `, { uAlpha: 1.0 });
        this._preview.filters = [this._previewAlphaFilter];
        // Bind once so add/removeEventListener share the same reference.
        this._dragKeyHandler = this._onDragKeyChange.bind(this);

        if (game.user.isGM && game.settings.get(MODULE_ID, "enabled")) {
            this._buildGMOverlay();
        }
    }

    async _tearDown(options) {
        // Don't destroy the texture — it's shared with canvas.fog.sprite (FogManager owns it).
        this._gmOverlay?.destroy({ children: true, texture: false, textureSource: false });
        this._gmOverlay = null;
        this._previewAlphaFilter?.destroy();
        this._previewAlphaFilter = null;
        this._preview?.destroy(true);
        this._preview = null;
        // Reset drag state so an in-progress drag doesn't carry over to the next scene.
        this._dragOrigin = null;
        this._lastDragPos = null;
        this._freehandPoints = null;
        this._freehandLineWidth = null;
        if (this._dragKeyHandler) {
            window.removeEventListener("keydown", this._dragKeyHandler);
            window.removeEventListener("keyup", this._dragKeyHandler);
            this._dragKeyHandler = null;
        }
        // The controls panel lives outside the canvas in document.body — remove it on teardown.
        document.querySelector("#fw-controls-panel")?.remove();
        return super._tearDown(options);
    }

    _activate() {
        if (!game.user.isGM) return;
        if (!game.settings.get(MODULE_ID, "enabled")) return;
        if (this._gmOverlay) this._gmOverlay.visible = true;
        if (canvas.visibility?.filter) {
            canvas.visibility.filter.uniforms.uFogAlpha = game.settings.get(MODULE_ID, "gmFogAlpha");
            canvas.visibility.filter.uniforms.unexploredColor = hexToRgbArray(game.settings.get(MODULE_ID, "gmFogTint"));
        }
        // Force the visibility refresh so our libWrapper override runs immediately, instead of
        // waiting for the next perception event (token move, light change, etc).
        canvas.perception.update({ refreshVision: true });
    }

    _deactivate() {
        if (this._gmOverlay) this._gmOverlay.visible = false;
        if (canvas.visibility?.filter) {
            canvas.visibility.filter.uniforms.uFogAlpha = 1;
            // Restore the scene's unexplored fog color (set by CanvasVisibility during draw).
            canvas.visibility.filter.uniforms.unexploredColor = canvas.colors.fogUnexplored.rgb;
        }
        // Run a refresh so stock logic restores `visible = false` for the GM (no vision sources).
        canvas.perception.update({ refreshVision: true });
    }

    /**
     * Build the GM-only fog preview sprite. The sprite samples the fog exploration
     * RenderTexture (single-channel red); a fragment shader inverts the red channel into
     * alpha so unexplored areas show as the GM's configured fog tint color.
     */
    _buildGMOverlay() {
        if (this._gmOverlay) return;
        const tex = canvas.fog.sprite?.texture;
        // Texture may exist but not yet be bound to a valid base — happens when
        // perception is mid-reinitialization. Skip; caller is expected to retry.
        if (!tex?.valid) return;

        const dims = canvas.dimensions;
        this._gmOverlay = this.addChildAt(new PIXI.Sprite(tex), 0);
        this._gmOverlay.position.set(dims.sceneX, dims.sceneY);
        this._gmOverlay.width = dims.sceneWidth;
        this._gmOverlay.height = dims.sceneHeight;
        this._gmOverlay.visible = this.active;
        // Overlay is purely visual — do not let PIXI hit-test it. If the underlying texture
        // is destroyed (e.g., by canvas.fog.reset()), Sprite.containsPoint crashes on mouse move.
        this._gmOverlay.eventMode = "none";

        // PIXI filters expect premultiplied-alpha output — without the rgb*=alpha step the
        // tint color bleeds through even where alpha is zero, leaving revealed areas tinted.
        const fragSrc = `
            precision mediump float;
            varying vec2 vTextureCoord;
            uniform sampler2D uSampler;
            uniform vec4 fogColor;
            void main(void) {
                float explored = texture2D(uSampler, vTextureCoord).r;
                float a = fogColor.a * (1.0 - explored);
                gl_FragColor = vec4(fogColor.rgb * a, a);
            }
        `;
        const tint = hexToRgbArray(game.settings.get(MODULE_ID, "gmFogTint"));
        const filter = new PIXI.Filter(undefined, fragSrc, {
            fogColor: [...tint, 0.75]
        });
        this._gmOverlay.filters = [filter];
    }

    /* ---- Drag handlers ---- */

    _onDragLeftStart(event) {
        this._dragOrigin = event.interactionData.origin;
        this._lastDragPos = event.interactionData.destination ?? this._dragOrigin;
        this._preview.clear();
        const { shape } = this._getDragMode(event);
        if (shape === "freehand") {
            // Snapshot lineWidth at start so the in-progress preview stays consistent if the
            // setting changes mid-drag (e.g. another GM adjusts the slider). Used at commit
            // time and stored on the shape record for stable replay.
            this._freehandLineWidth = game.settings.get(MODULE_ID, "lineWidth");
            this._freehandPoints = [this._dragOrigin.x, this._dragOrigin.y];
        }
        // Listen for modifier toggles so the preview updates immediately when the user
        // presses/releases Alt/Shift/Ctrl without moving the mouse. Bound once in _draw.
        window.addEventListener("keydown", this._dragKeyHandler);
        window.addEventListener("keyup", this._dragKeyHandler);
    }

    _onDragLeftMove(event) {
        if (!this._dragOrigin) return;
        this._lastDragPos = event.interactionData.destination;
        if (this._freehandPoints) {
            const pts = this._freehandPoints;
            const lx = pts[pts.length - 2];
            const ly = pts[pts.length - 1];
            const cx = this._lastDragPos.x;
            const cy = this._lastDragPos.y;
            if (Math.hypot(cx - lx, cy - ly) >= FREEHAND_SAMPLE_THRESHOLD) {
                pts.push(cx, cy);
            }
        }
        this._refreshPreview(event);
    }

    _onDragLeftDrop(event) {
        if (!this._dragOrigin) return;
        const pos = event.interactionData.destination;
        const { isErase, shape: shapeKind, fromCenter, constrain } = this._getDragMode(event);
        this._preview.clear();

        let record;
        if (shapeKind === "freehand") {
            // Make sure the cursor's final position is captured even if it was below the
            // sample threshold from the previous point.
            const pts = this._freehandPoints ?? [this._dragOrigin.x, this._dragOrigin.y];
            const lx = pts[pts.length - 2];
            const ly = pts[pts.length - 1];
            if (pts.length === 0 || lx !== pos.x || ly !== pos.y) pts.push(pos.x, pos.y);
            record = {
                shape: "freehand",
                points: pts,
                lineWidth: this._freehandLineWidth ?? game.settings.get(MODULE_ID, "lineWidth"),
                isErase
            };
        } else {
            let from = this._dragOrigin;
            let to = pos;
            if (shapeKind !== "line") {
                ({ from, to } = this._normalizeBoundingBox(this._dragOrigin, pos, fromCenter, constrain));
            }
            record = { shape: shapeKind, from, to, isErase };
            if (shapeKind === "line") record.lineWidth = game.settings.get(MODULE_ID, "lineWidth");
        }

        this._endDrag();
        _commitShapeFn?.(record);
    }

    _onDragLeftCancel(_event) {
        this._preview.clear();
        this._endDrag();
    }

    _onDragKeyChange(event) {
        if (!this._dragOrigin || !this._lastDragPos) return;
        if (event.repeat) return;
        const k = event.key;
        if (k !== "Alt" && k !== "Shift" && k !== "Control" && k !== "Meta") return;
        this._refreshPreview(event);
    }

    /**
     * Re-render the preview from `_dragOrigin` to `_lastDragPos`, using the modifier state
     * carried on `modifierSrc` (a pointer or keyboard event). Shared between mouse-move and
     * key-toggle code paths so the live preview stays consistent.
     */
    _refreshPreview(modifierSrc) {
        const { isErase, shape: shapeKind, fromCenter, constrain } = this._getDragMode(modifierSrc);
        const color = isErase ? 0xff4444 : 0x44ff44;

        if (shapeKind === "freehand") {
            // Build a transient record from the sampled points + snapshot width.
            const pts = this._freehandPoints ?? [this._dragOrigin.x, this._dragOrigin.y];
            const lineWidth = this._freehandLineWidth ?? game.settings.get(MODULE_ID, "lineWidth");
            this._drawPreview({ shape: "freehand", points: pts, lineWidth }, color);
            return;
        }

        let from = this._dragOrigin;
        let to = this._lastDragPos;
        if (shapeKind !== "line") {
            ({ from, to } = this._normalizeBoundingBox(this._dragOrigin, this._lastDragPos, fromCenter, constrain));
        }
        const lineWidth = shapeKind === "line" ? game.settings.get(MODULE_ID, "lineWidth") : undefined;
        this._drawPreview({ shape: shapeKind, from, to, lineWidth }, color);
    }

    _endDrag() {
        this._dragOrigin = null;
        this._lastDragPos = null;
        this._freehandPoints = null;
        this._freehandLineWidth = null;
        window.removeEventListener("keydown", this._dragKeyHandler);
        window.removeEventListener("keyup", this._dragKeyHandler);
    }

    _drawPreview(shape, color) {
        const g = this._preview;
        g.clear();

        if (shape.shape === "freehand") {
            // Draw at full internal opacity (alpha=1) and let the filter apply 0.7 uniformly to
            // the composited intermediate texture. If alpha < 1 were used in the lineStyle,
            // overlapping round joins would each be semi-transparent and compound visually.
            this._previewAlphaFilter.uniforms.uAlpha = 0.7;
            drawShapeGeometry(g, shape, color, 1);
            return;
        }

        this._previewAlphaFilter.uniforms.uAlpha = 1;
        // line is a stroke — beginFill/endFill would close the open path, drawing an
        // unwanted straight line back to the start point.
        const isFilled = shape.shape !== "line";
        if (isFilled) g.beginFill(color, 0.25);
        g.lineStyle(2, color, 0.7);
        drawShapeGeometry(g, shape, color, 0.7);
        if (isFilled) g.endFill();
    }

    _onClickLeft(event) {
        const { shape, isErase } = this._getDragMode(event);
        if (shape !== "freehand") return;
        const pos = event.interactionData.origin;
        const lineWidth = game.settings.get(MODULE_ID, "lineWidth");
        _commitShapeFn?.({ shape: "freehand", points: [pos.x, pos.y], lineWidth, isErase });
    }

    _onUndoKey(_event) {
        _undoLastShapeFn?.();
        return true;
    }
}

export function drawShapeGeometry(g, shape, color = 0xFF0000, alpha = 1) {
    const { from, to } = shape;
    const dx = to ? to.x - from.x : 0;
    const dy = to ? to.y - from.y : 0;
    switch (shape.shape) {
        case "ellipse": {
            // Bounding-box ellipse: center is the midpoint of (from, to); half-axes are |dx|/2, |dy|/2.
            const cx = (from.x + to.x) / 2;
            const cy = (from.y + to.y) / 2;
            g.drawEllipse(cx, cy, Math.abs(dx) / 2, Math.abs(dy) / 2);
            break;
        }
        case "circle":
            // Legacy: previously persisted with `from` as center and radius = cursor distance.
            // New draws emit "ellipse" with a square bounding box instead, but old saves still
            // arrive here at replay time.
            g.drawCircle(from.x, from.y, Math.hypot(dx, dy));
            break;
        case "rect": {
            // Normalize so the origin is the top-left corner regardless of drag direction —
            // PIXI's drawRect doesn't accept negative width/height.
            const x = Math.min(from.x, to.x);
            const y = Math.min(from.y, to.y);
            g.drawRect(x, y, Math.abs(dx), Math.abs(dy));
            break;
        }
        case "square": {
            // Legacy: square centered on `from`, half-side = larger axis. New draws emit "rect"
            // with a square bounding box; this case stays so old saves still replay correctly.
            const half = Math.max(Math.abs(dx), Math.abs(dy));
            g.drawRect(from.x - half, from.y - half, half * 2, half * 2);
            break;
        }
        case "line": {
            // Prefer the per-shape snapshot; fall back to the live setting for shapes saved
            // before Phase 1.5 that don't carry their own lineWidth.
            const width = shape.lineWidth ?? game.settings.get(MODULE_ID, "lineWidth");
            g.lineStyle(width, color, alpha);
            g.moveTo(from.x, from.y);
            g.lineTo(to.x, to.y);
            break;
        }
        case "freehand": {
            const width = shape.lineWidth ?? game.settings.get(MODULE_ID, "lineWidth");
            const pts = shape.points ?? [];
            if (pts.length === 0) break;
            if (pts.length < 4) {
                // Single sampled point (click without drag) — render a filled dot so the
                // action leaves a visible mark.
                g.lineStyle(0);
                g.beginFill(color, alpha);
                g.drawCircle(pts[0], pts[1], width / 2);
                g.endFill();
                break;
            }
            g.lineStyle({ width, color, alpha, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
            g.moveTo(pts[0], pts[1]);
            for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
            break;
        }
    }
}
