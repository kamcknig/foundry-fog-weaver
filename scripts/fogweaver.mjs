import { FogWeaverLayer, drawShapeGeometry, registerFogWeaverCallbacks, hexToRgbArray } from "./layer.mjs";

const MODULE_ID = "fog-weaver";

/**
 * Sentinel level key used on v13, which has no concept of levels.
 * Every read/write routes through this single key so v13 scenes
 * are handled identically to a single-level v14 scene.
 */
const LEGACY_LEVEL_KEY = "_default";

/**
 * Resolve the current level id, or the v13 sentinel.
 * v14: canvas.scene._view is the active level id (string).
 * v13: no levels concept — every read/write routes through "_default".
 *
 * @returns {string} The current level id, or "_default" on v13.
 */
function _getLevelKey() {
    return canvas.scene?._view ?? LEGACY_LEVEL_KEY;
}

/**
 * Read the shapes array for the current level from the scene flags.
 * Returns an empty array when the scene has no shapes flag yet, when
 * the flag is in the legacy single-array shape (pre-migration), or
 * when this level has never been painted on.
 *
 * @returns {object[]} The shapes for the current level.
 */
function _getShapesForCurrentLevel() {
    const all = canvas.scene.getFlag(MODULE_ID, "shapes");
    if (!all) return [];
    if (Array.isArray(all)) return all; // legacy / pre-migration scenes
    return all[_getLevelKey()] ?? [];
}

/**
 * Write the shapes array for the current level via setFlag. Always
 * writes the keyed object format — never the legacy array format.
 *
 * @param {object[]} shapes - The shapes array to store for this level.
 * @returns {Promise<void>}
 */
async function _setShapesForCurrentLevel(shapes) {
    const all = canvas.scene.getFlag(MODULE_ID, "shapes");
    const map = (!all || Array.isArray(all)) ? {} : { ...all };
    map[_getLevelKey()] = shapes;
    await canvas.scene.setFlag(MODULE_ID, "shapes", map);
}

/**
 * Read the weaverFog base64 string for the current level from the
 * scene flags. Returns null when absent or when the flag is in the
 * legacy single-string shape (pre-migration).
 *
 * @returns {string|null} The weaverFog base64 string, or null if absent.
 */
function _getWeaverFogForCurrentLevel() {
    const all = canvas.scene.getFlag(MODULE_ID, "weaverFog");
    if (!all) return null;
    if (typeof all === "string") return all; // legacy / pre-migration
    return all[_getLevelKey()] ?? null;
}

/**
 * Write the weaverFog base64 string for the current level via setFlag.
 * Always writes the keyed object format — never the legacy string format.
 * Pass null to clear just this level's slot.
 *
 * @param {string|null} value - The base64 weaverFog string, or null to clear.
 * @returns {Promise<void>}
 */
async function _setWeaverFogForCurrentLevel(value) {
    const all = canvas.scene.getFlag(MODULE_ID, "weaverFog");
    const map = (!all || typeof all === "string") ? {} : { ...all };
    if (value === null) delete map[_getLevelKey()];
    else map[_getLevelKey()] = value;
    await canvas.scene.setFlag(MODULE_ID, "weaverFog", map);
}

Hooks.once("init", () => {
    game.settings.register(MODULE_ID, "enabled", {
        name: "FOGWEAVER.Settings.Enabled.Name",
        hint: "FOGWEAVER.Settings.Enabled.Hint",
        scope: "world",
        config: true,
        type: Boolean,
        default: true,
        requiresReload: false,
        onChange: _onEnabledChange
    });

    game.settings.register(MODULE_ID, "lineWidth", {
        name: "FOGWEAVER.Settings.LineWidth.Name",
        hint: "FOGWEAVER.Settings.LineWidth.Hint",
        scope: "world",
        config: true,
        type: Number,
        range: { min: 20, max: 500, step: 10 },
        default: 100,
        onChange: value => {
            // Keep inline slider in sync when setting changes externally (e.g. settings menu).
            const slider = document.querySelector("#fw-line-width-slider");
            if (!slider) return;
            slider.value = value;
            const label = document.querySelector("#fw-line-width-value");
            if (label) label.textContent = `${value}px`;
        }
    });

    game.settings.register(MODULE_ID, "gmFogAlpha", {
        name: "FOGWEAVER.Settings.GmFogAlpha.Name",
        hint: "FOGWEAVER.Settings.GmFogAlpha.Hint",
        scope: "client",
        config: true,
        type: Number,
        range: { min: 0.2, max: 1, step: 0.05 },
        default: 0.7,
        onChange: value => {
            if (!canvas.visibility?.filter) return;
            if (ui.controls?.control?.name !== "fogweaver") return;
            canvas.visibility.filter.uniforms.uFogAlpha = value;
            // Keep inline slider in sync when setting changes externally (e.g. settings menu).
            const slider = document.querySelector("#fw-opacity-slider");
            if (slider) slider.value = value;
        }
    });

    game.settings.register(MODULE_ID, "gmFogTint", {
        name: "FOGWEAVER.Settings.GmFogTint.Name",
        hint: "FOGWEAVER.Settings.GmFogTint.Hint",
        scope: "client",
        config: true,
        type: String,
        default: "#000000",
        onChange: value => {
            if (!canvas.visibility?.filter) return;
            if (ui.controls?.control?.name !== "fogweaver") return;
            const rgb = hexToRgbArray(value);
            canvas.visibility.filter.uniforms.unexploredColor = rgb;
            // Keep GM overlay color in sync.
            const overlay = canvas.fogweaver?._gmOverlay;
            if (overlay?.filters?.[0]) {
                const fc = overlay.filters[0].uniforms.fogColor;
                overlay.filters[0].uniforms.fogColor = [rgb[0], rgb[1], rgb[2], fc?.[3] ?? 0.75];
            }
            // Keep inline color picker in sync when setting changes externally.
            const picker = document.querySelector("#fw-tint-picker");
            if (picker) picker.value = value;
        }
    });

    game.settings.register(MODULE_ID, "isolateStates", {
        name: "FOGWEAVER.Settings.IsolateStates.Name",
        hint: "FOGWEAVER.Settings.IsolateStates.Hint",
        scope: "world",
        config: true,
        type: Boolean,
        default: true
    });

    game.settings.register(MODULE_ID, "snapshotSizeWarning", {
        name: "FOGWEAVER.Settings.SnapshotSizeWarning.Name",
        hint: "FOGWEAVER.Settings.SnapshotSizeWarning.Hint",
        scope: "world",
        config: true,
        type: Number,
        range: { min: 100, max: 2000, step: 100 },
        default: 500
    });

    // Ensure the VisibilityFilter has the uFogAlpha uniform at its default before any filter
    // instance is created. The fragment shader patch (in _wrapFogCommit) declares the uniform;
    // setting the default here prevents WebGL from silently treating it as 0 on first draw.
    CONFIG.Canvas.visibilityFilter.defaultUniforms.uFogAlpha = 1.0;

    CONFIG.Canvas.layers.fogweaver = {
        layerClass: FogWeaverLayer,
        group: "interface"
    };

    _wrapFogCommit();

    registerFogWeaverCallbacks(commitShape, _undoLastShape);
});

// After any vision refresh, reconcile the GM overlay with the current fog texture.
// Foundry can swap the fog texture out from under us (e.g., on canvas.fog.reset(), scene
// reload, or FogManager.load() finishing a saved-image load); when that happens, our
// overlay sprite still points at the destroyed texture and PIXI crashes during hit-test.
Hooks.on("sightRefresh", () => {
    if (!game.user.isGM) return;
    const layer = canvas.fogweaver;
    if (!layer || !game.settings.get(MODULE_ID, "enabled")) return;

    const liveTex = canvas.fog.sprite?.texture;
    const overlayTex = layer._gmOverlay?.texture;
    if (overlayTex && overlayTex !== liveTex) {
        // Overlay's texture has been replaced (or destroyed) — drop the stale sprite
        // so it can be rebuilt cleanly with the new texture.
        layer._gmOverlay.destroy({ children: true, texture: false, textureSource: false });
        layer._gmOverlay = null;
    }
    if (!layer._gmOverlay && liveTex?.valid) {
        layer._buildGMOverlay();
    }
});

// One-time migration: convert legacy single-bucket fog scene flags to the per-level keyed
// layout introduced in v14. Runs on the GM only, once per world (at game-ready time), so
// all scenes are migrated up-front before any per-level writes can inadvertently discard
// legacy data. Uses a progress-bar notification for worlds with many scenes.
// Gate flag: `scene.flags.fogweaver.levelsMigratedToV14` per scene.
Hooks.once("ready", async () => {
    if (!game.user.isGM) return;
    if (game.release.generation < 14) return;

    const toMigrate = game.scenes.filter(s =>
        !s.getFlag(MODULE_ID, "levelsMigratedToV14") &&
        (Array.isArray(s.getFlag(MODULE_ID, "shapes")) || typeof s.getFlag(MODULE_ID, "weaverFog") === "string")
    );

    if (!toMigrate.length) return;

    const progress = ui.notifications.info(
        `Fog Weaver: Migrating fog data for ${toMigrate.length} scene(s)...`,
        { progress: true, console: false }
    );

    for (let i = 0; i < toMigrate.length; i++) {
        const scene = toMigrate[i];
        progress.update({ pct: i / toMigrate.length, message: `Fog Weaver: Migrating "${scene.name}" (${i + 1}/${toMigrate.length})` });

        const legacyShapes = scene.getFlag(MODULE_ID, "shapes");
        const legacyWeaverFog = scene.getFlag(MODULE_ID, "weaverFog");
        const targetKey = scene.levels?.contents?.[0]?.id ?? scene.initialLevel?.id ?? LEGACY_LEVEL_KEY;
        const update = { flags: { [MODULE_ID]: { levelsMigratedToV14: true } } };
        if (Array.isArray(legacyShapes)) update.flags[MODULE_ID].shapes = { [targetKey]: legacyShapes };
        if (typeof legacyWeaverFog === "string") update.flags[MODULE_ID].weaverFog = { [targetKey]: legacyWeaverFog };
        await scene.update(update);
        console.log(`${MODULE_ID} | migrated scene "${scene.name}" to per-level fog layout (key: ${targetKey})`);
    }

    progress.update({ pct: 1.0, message: `Fog Weaver: Migrated ${toMigrate.length} scene(s)` });
});

// Inject the opacity slider + tint picker as a fixed-position panel anchored to the right
// of the tools section. Fixed positioning escapes #scene-controls' overflow:hidden and the
// narrow (~72px) column-1 width, giving us a full-width panel to work with.
Hooks.on("renderSceneControls", (_app, html) => {
    // Always remove any stale panel first so it doesn't linger after control change.
    document.querySelector("#fw-controls-panel")?.remove();

    if (!game.user.isGM) return;
    if (!game.settings.get(MODULE_ID, "enabled")) return;
    if (ui.controls?.control?.name !== "fogweaver") return;

    const alpha     = game.settings.get(MODULE_ID, "gmFogAlpha");
    const tint      = game.settings.get(MODULE_ID, "gmFogTint");
    const lineWidth = game.settings.get(MODULE_ID, "lineWidth");

    const panel = document.createElement("div");
    panel.id = "fw-controls-panel";
    panel.innerHTML = `
        <label class="fw-label">${game.i18n.localize("FOGWEAVER.Controls.Opacity")}</label>
        <div class="fw-row">
            <input id="fw-opacity-slider" type="range" min="0.2" max="1" step="0.05" value="${alpha}">
            <span id="fw-opacity-value">${Math.round(alpha * 100)}%</span>
        </div>
        <label class="fw-label">${game.i18n.localize("FOGWEAVER.Controls.FogTint")}</label>
        <div class="fw-row">
            <input id="fw-tint-picker" type="color" value="${tint}">
        </div>
        <label class="fw-label">${game.i18n.localize("FOGWEAVER.Controls.LineThickness")}</label>
        <div class="fw-row">
            <input id="fw-line-width-slider" type="range" min="20" max="500" step="10" value="${lineWidth}">
            <span id="fw-line-width-value">${lineWidth}px</span>
        </div>
        <hr class="fw-sep">
        <label class="fw-label">${game.i18n.localize("FOGWEAVER.Controls.HintsTitle")}</label>
        <ul class="fw-hints">
            <li>${game.i18n.localize("FOGWEAVER.Controls.HintDrag")}</li>
            <li>${game.i18n.localize("FOGWEAVER.Controls.HintAlt")}</li>
            <li>${game.i18n.localize("FOGWEAVER.Controls.HintShift")}</li>
            <li>${game.i18n.localize("FOGWEAVER.Controls.HintCtrl")}</li>
        </ul>
    `;

    // Position the panel to the right of the tools section.
    // We inject into body as position:fixed so parent overflow:hidden can't clip us.
    // getBoundingClientRect() returns viewport coordinates including CSS transforms, so no
    // additional scale factor needed.
    document.body.appendChild(panel);
    const toolsSection = html.querySelector("#scene-controls-tools");
    if (toolsSection) {
        const rect = toolsSection.getBoundingClientRect();
        panel.style.left = `${rect.right + 8}px`;
        panel.style.top  = `${rect.top}px`;
    }

    // Live-update filter uniform while dragging; save to setting on release.
    const slider = panel.querySelector("#fw-opacity-slider");
    const valueLabel = panel.querySelector("#fw-opacity-value");
    slider.addEventListener("input", () => {
        const v = parseFloat(slider.value);
        valueLabel.textContent = `${Math.round(v * 100)}%`;
        if (canvas.visibility?.filter && ui.controls?.control?.name === "fogweaver") {
            canvas.visibility.filter.uniforms.uFogAlpha = v;
        }
    });
    slider.addEventListener("change", () => {
        game.settings.set(MODULE_ID, "gmFogAlpha", parseFloat(slider.value));
    });

    // Live-update tint; save on change.
    const picker = panel.querySelector("#fw-tint-picker");
    picker.addEventListener("input", () => {
        if (canvas.visibility?.filter && ui.controls?.control?.name === "fogweaver") {
            canvas.visibility.filter.uniforms.unexploredColor = hexToRgbArray(picker.value);
        }
    });
    picker.addEventListener("change", () => {
        game.settings.set(MODULE_ID, "gmFogTint", picker.value);
    });

    // Display update is instant; the setting is read at commit time so no live canvas update needed.
    const lineSlider = panel.querySelector("#fw-line-width-slider");
    const lineLabel  = panel.querySelector("#fw-line-width-value");
    lineSlider.addEventListener("input", () => {
        lineLabel.textContent = `${lineSlider.value}px`;
    });
    lineSlider.addEventListener("change", () => {
        game.settings.set(MODULE_ID, "lineWidth", parseInt(lineSlider.value, 10));
    });
});

// Convert the gmFogTint text input in the settings form to a proper color picker.
Hooks.on("renderSettingsConfig", (_app, html) => {
    const input = html.querySelector(`input[name="${MODULE_ID}.gmFogTint"]`);
    if (!input) return;
    input.type = "color";
    input.style.width = "48px";
    input.style.height = "28px";
    input.style.padding = "0";
    input.style.cursor = "pointer";
});

/**
 * Re-render the scene controls to reflect the current enabled state.
 * `reset: true` triggers #prepareControls() in both v13 and v14, which re-evaluates
 * each layer's `visible` flag and removes controls whose layer returns visible=false.
 */
function _refreshControlsUI() {
    ui.controls.render({ reset: true });
}

async function _onEnabledChange(enabled) {
    // If the fogweaver control is active and we're disabling, switch back to tokens
    // so the now-removed control set doesn't leave the UI stuck on a missing control.
    if (!enabled && ui.controls.control?.name === "fogweaver") {
        ui.controls.activate({ control: "tokens" });
    }
    // Reset fog uniforms when disabling so the canvas doesn't stay dimmed or tinted.
    // canvas.visibility.draw() below will reissue a refresh, but uniforms must be restored
    // before that happens so the GM isn't left with a dimmed canvas.
    if (!enabled && canvas.visibility?.filter) {
        canvas.visibility.filter.uniforms.uFogAlpha = 1;
        canvas.visibility.filter.uniforms.unexploredColor = canvas.colors.fogUnexplored.rgb;
    }
    // The controls panel lives in document.body; remove it explicitly since _refreshControlsUI()
    // below won't fire renderSceneControls for the disabled fogweaver control.
    document.querySelector("#fw-controls-panel")?.remove();
    _refreshControlsUI();

    // Tear down the GM overlay from the OLD visibility group / fog state before we redraw.
    // After visibility.draw() the fog sprite/texture may be swapped; the sightRefresh hook
    // will rebuild the overlay (when enabled) once the new texture is in place.
    if (canvas.fogweaver?._gmOverlay) {
        canvas.fogweaver._gmOverlay.destroy({ children: true, texture: false, textureSource: false });
        canvas.fogweaver._gmOverlay = null;
    }

    // FogManager.commit() only schedules a save after FogManager.COMMIT_THRESHOLD (70)
    // commits — small amounts of token-vision exploration accumulate in memory but
    // aren't persisted to the FogExploration doc. visibility.draw() below tears down the
    // in-memory texture and reloads from the saved doc, so we must flush first or we
    // lose the unsaved fog data.
    if (canvas.fog._updated) await canvas.fog.save();

    // Swap the per-mode fog state. On enable, this snapshots the current (normal) state
    // into the user's FogExploration flag and loads the FW state from the scene flag;
    // on disable, the GM saves the current (FW) state to the scene flag and each user
    // restores their own per-user normal snapshot. The visibility redraw below then
    // reloads `canvas.fog` from the freshly-updated FogExploration.explored.
    await _swapFogState(enabled);

    // The visibility filter shader is compiled once at canvas.visibility._draw(). Toggling
    // the module changes what our libWrapper returns from VisibilityFilter.fragmentShader,
    // but the existing filter instance already has the OLD compiled program. Redraw just
    // the visibility group (lighter than canvas.draw()) so the new filter picks up the
    // patched (or unpatched) shader. visibility._draw also re-runs canvas.fog.initialize()
    // so perception state stays consistent.
    await canvas.visibility.draw();

    // canvas.visibility._tearDown() called canvas.effects.visionSources.clear(), so the
    // sources collection is empty after the redraw. canvas.perception.initialize()'s
    // initializeVision flag only iterates EXISTING sources — it doesn't repopulate the
    // collection. We have to re-add token vision sources ourselves; otherwise tokens render
    // as explored-but-not-visible (no LOS) until the next thing that re-adds a source
    // (movement, vision config change, etc.).
    for (const token of canvas.tokens.placeables) {
        if (!token.isPreview) token.initializeSources();
    }

    // Now that vision sources are repopulated, schedule a perception refresh so the new
    // visibility filter gets up-to-date inputs.
    canvas.perception.initialize();

    // On enable, the GM is reasserting authority. Push the GM's fog state to every other
    // user, overwriting any local exploration they accumulated while the module was off.
    // This guarantees all players see exactly what the GM has revealed via shapes; any
    // token-vision exploration the players did locally is wiped.
    if (enabled && game.user.isGM) {
        try {
            await canvas.fog.sync(game.user);
        } catch (err) {
            console.warn(`${MODULE_ID} | fog sync skipped:`, err.message);
        }
    }

    // sightRefresh normally rebuilds the GM overlay after the redraw, but it only fires when
    // vision sources update. Build now as a fallback so the overlay is correct immediately
    // after toggle even on scenes without active token vision.
    if (enabled && game.user.isGM) canvas.fogweaver?._buildGMOverlay();
}

function _wrapFogCommit() {
    // When fog is reset (via Foundry's lighting-layer button or any socket caller), also clear
    // the module's stored shape history so undo doesn't replay shapes drawn before the reset.
    libWrapper.register(
        MODULE_ID,
        "foundry.canvas.perception.FogManager.prototype._handleReset",
        async function (wrapped, ...args) {
            if (game.user.isGM && game.settings.get(MODULE_ID, "enabled")) {
                // Reset clears just this level's shape history and weaverFog snapshot.
                // Other levels' painted state is independent and must survive a reset on
                // this level. Dropping the weaverFog slot prevents toggling OFF then ON
                // after a reset from replaying the pre-reset FW state.
                await _setShapesForCurrentLevel([]);
                await _setWeaverFogForCurrentLevel(null);
            }
            return wrapped(...args);
        },
        "WRAPPER"
    );

    libWrapper.register(
        MODULE_ID,
        "foundry.canvas.perception.FogManager.prototype.commit",
        function (wrapped, ...args) {
            if (game.settings.get(MODULE_ID, "enabled")) return;
            return wrapped(...args);
        },
        "MIXED"
    );

    // Replace the visibility shader's compositing logic so fog is driven purely by the GM's
    // fog texture, not by token vision. Original (visibility.mjs:155-158):
    //     vec4 fow = mix(unexplored, explored, max(r,v));
    //     gl_FragColor = mix(fow, vec4(0.0), v);
    // Patched: fog gradient comes only from r (GM-drawn fog texture); any revealed area (r=1)
    // is always fully visible regardless of token LOS — matching the "manual fog" model where
    // the GM decides what is seen, not token position.
    //
    // VisibilityFilter's shader factory was renamed between v13 and v14.
    // Wrapping a non-existent path throws, so we must target the correct name per version.
    const shaderTarget = game.release.generation >= 14
        ? "foundry.canvas.rendering.filters.VisibilityFilter._createFragmentShader"
        : "foundry.canvas.rendering.filters.VisibilityFilter.fragmentShader";

    libWrapper.register(
        MODULE_ID,
        shaderTarget,
        function (wrapped, options) {
            const src = wrapped(options);
            if (!game.settings.get(MODULE_ID, "enabled")) return src;
            if (options?.persistentVision) return src; // distinct shader path; no change needed
            return src
                .replace("mix(unexplored, explored, max(r,v))",
                         "mix(unexplored, explored, r)")
                .replace("mix(fow, vec4(0.0), v)",
                         "mix(fow, vec4(0.0), r)")
                // Declare the uFogAlpha uniform after the unexploredColor declaration.
                .replace("uniform vec3 unexploredColor;",
                         "uniform vec3 unexploredColor;\nuniform float uFogAlpha;")
                // Replace both occurrences of vec4(unexploredColor, 1.0) — each call targets
                // the first remaining match.
                .replace("vec4(unexploredColor, 1.0)", "vec4(unexploredColor, uFogAlpha)")
                .replace("vec4(unexploredColor, 1.0)", "vec4(unexploredColor, uFogAlpha)")
                // Scale the overlay-texture branch.
                .replace("vec4(fogColor.rgb * backgroundColor, 1.0)",
                         "vec4(fogColor.rgb * backgroundColor, uFogAlpha)")
                // Scale explored alpha proportionally so explored areas are always lighter than unexplored.
                .replace("vec3(1.0)), 0.5)", "vec3(1.0)), uFogAlpha * 0.5)");
        },
        "WRAPPER"
    );

    // Force canvas.visibility to remain visible for the GM while the FogWeaver layer is the
    // active scene control. Stock logic (visibility.mjs:497) hides it for GMs without active
    // vision sources; we override that here so the GM sees the actual fog state while painting.
    // Also re-apply the GM's custom fog tint — effects.mjs resets unexploredColor on every
    // perception refresh (canvas/groups/effects.mjs: canvas.colors.fogUnexplored.applyRGB(
    // v.uniforms.unexploredColor)) so we must reassert it here after the stock refresh runs.
    libWrapper.register(
        MODULE_ID,
        "foundry.canvas.groups.CanvasVisibility.prototype.refresh",
        function (wrapped, ...args) {
            wrapped(...args);
            if (!game.settings.get(MODULE_ID, "enabled")) return;
            if (!canvas.scene?.tokenVision) return;

            // In v14, VisibilityFilter.defaultUniforms is a static getter that returns a new
            // object on each call, so assigning uFogAlpha to it in the init hook has no
            // persistent effect. The filter instance starts with uFogAlpha undefined (GLSL
            // defaults to 0), making the fog completely transparent for all clients.
            // Fix: set uFogAlpha directly on the live filter instance on every refresh.
            const isFogweaverActive = game.user.isGM && ui.controls?.control?.name === "fogweaver";
            if (this.filter) {
                this.filter.uniforms.uFogAlpha = isFogweaverActive
                    ? game.settings.get(MODULE_ID, "gmFogAlpha")
                    : 1.0;
            }

            if (!game.user.isGM) return;
            if (!isFogweaverActive) return;

            // Force visibility on so the GM sees what players see. Stock logic at
            // visibility.mjs:499 hides this for GMs without vision sources; we override that
            // exclusively while the FogWeaver tool is the active scene control.
            this.visible = true;
            // Re-apply the custom tint — effects.mjs resets unexploredColor back to the scene
            // default on every perception refresh, so we must reassert the GM's chosen color.
            const tint = hexToRgbArray(game.settings.get(MODULE_ID, "gmFogTint"));
            if (this.filter) {
                this.filter.uniforms.unexploredColor = tint;
            }
            // Keep the GM overlay's fogColor in sync with the tint setting.
            const overlay = canvas.fogweaver?._gmOverlay;
            if (overlay?.filters?.[0]) {
                const fc = overlay.filters[0].uniforms.fogColor;
                overlay.filters[0].uniforms.fogColor = [tint[0], tint[1], tint[2], fc?.[3] ?? 0.75];
            }
        },
        "WRAPPER"
    );
}

/**
 * Swap the user's fog state between FW (per-level scene flag) and normal (per-user).
 *
 * Behavior depends on the new value of the `enabled` setting:
 * - On enable (true): snapshot the current `canvas.fog.exploration.explored` to the
 *   user's `FogExploration.flags.fogweaver.normalSnapshot`, then load the current
 *   level's weaverFog (or null/blank) into `explored`. Sets `activeMode: "weaver"`.
 * - On disable (false): the GM extracts the current canvas state into the current
 *   level's weaverFog slot. Each user (including GM) then loads their own
 *   `flags.fogweaver.normalSnapshot` (or null/blank) into `explored`. Sets
 *   `activeMode: "normal"`.
 *
 * The atomic FogExploration update writes both the new `explored` value and the
 * snapshot/activeMode flags in one DB roundtrip, with `loadFog: false` to suppress the
 * auto-reload triggered by `_onUpdate`. The caller must run `canvas.visibility.draw()`
 * afterwards to actually load the new texture.
 *
 * @param {boolean} enabled - The new value of the FW enabled setting.
 */
async function _swapFogState(enabled) {
    if (!game.settings.get(MODULE_ID, "isolateStates")) return;

    // Bail out gracefully if the canvas / FogExploration aren't ready. This can happen
    // if the setting is changed before the world's first scene load. The toggle still
    // proceeds with the rest of _onEnabledChange — there's just nothing to swap.
    const exploration = canvas.fog?.exploration;
    if (!exploration?.id) return;

    const currentExplored = exploration.explored ?? null;
    // base64 is ~75% efficient; dividing length by ~1365 gives KB.
    const kb = str => Math.round((str?.length ?? 0) * 0.75 / 1024);
    const threshold = game.settings.get(MODULE_ID, "snapshotSizeWarning");

    if (enabled) {
        // Toggle ON: save current normal state to user's snapshot, load FW state from the
        // current level's slot. Single update with all fields keeps it atomic.
        const weaverFog = _getWeaverFogForCurrentLevel();
        const normalSize = kb(currentExplored);
        console.log(`[Fog Weaver] Swap → FW active | level=${_getLevelKey()} | normalSnapshot saved: ${normalSize} KB, weaverFog loaded: ${kb(weaverFog)} KB`);
        if (normalSize > threshold) {
            ui.notifications.warn(game.i18n.format("FOGWEAVER.Warnings.SnapshotLarge", { size: normalSize, threshold, type: game.i18n.localize("FOGWEAVER.Warnings.SnapshotTypeNormal") }));
        }
        await exploration.update({
            flags: { [MODULE_ID]: { normalSnapshot: currentExplored, activeMode: "weaver" } },
            explored: weaverFog
        }, { loadFog: false });
        return;
    }

    // Toggle OFF: GM saves current FW state to the current level's scene flag slot (canonical
    // FW state). Every client then restores their own normal-state snapshot.
    const normalSnapshot = exploration.getFlag(MODULE_ID, "normalSnapshot") ?? null;
    if (game.user.isGM) {
        const weaverSize = kb(currentExplored);
        console.log(`[Fog Weaver] Swap → normal active | level=${_getLevelKey()} | weaverFog saved: ${weaverSize} KB, normalSnapshot loaded: ${kb(normalSnapshot)} KB`);
        if (weaverSize > threshold) {
            ui.notifications.warn(game.i18n.format("FOGWEAVER.Warnings.SnapshotLarge", { size: weaverSize, threshold, type: game.i18n.localize("FOGWEAVER.Warnings.SnapshotTypeWeaver") }));
        }
        await _setWeaverFogForCurrentLevel(currentExplored);
    } else {
        console.log(`[Fog Weaver] Swap → normal active | level=${_getLevelKey()} | normalSnapshot loaded: ${kb(normalSnapshot)} KB`);
    }
    await exploration.update({
        flags: { [MODULE_ID]: { activeMode: "normal" } },
        explored: normalSnapshot
    }, { loadFog: false });
}

export async function commitShape(shape) {
    if (!canvas.scene.tokenVision) return;
    const tex = _ensureRenderTexture();
    if (!tex) return;

    _renderShapeToTexture(tex, shape);
    await _saveAndSync();

    await _persistShape(shape);
    canvas.perception.initialize();
}

// FogExploration data is persisted as a base64 WebP. When loaded, canvas.fog.sprite.texture
// is a plain Texture wrapping a BaseTexture — not a BaseRenderTexture — so it has no
// maskStack and cannot be bound as a render target (PIXI's ScissorSystem crashes).
// This mirrors FogManager.commit's promotion path: copy the saved-image sprite into a fresh
// RenderTexture, swap the sprite's texture, and destroy the old one. Subsequent commits then
// render directly into a real RenderTexture.
function _ensureRenderTexture() {
    const sprite = canvas.fog.sprite;
    if (!sprite?.texture?.valid) return null;
    if (sprite.texture instanceof PIXI.RenderTexture) return sprite.texture;

    const Canvas = foundry.canvas.Canvas;
    const newTex = Canvas.getRenderTexture({
        clearColor: [0, 0, 0, 1],
        textureConfiguration: canvas.fog.textureConfiguration
    });
    // Render via a zero-positioned temporary sprite so we don't inherit the fog sprite's
    // worldTransform offset (sceneX, sceneY). Rendering the original sprite directly would
    // shift the existing fog content by +(sceneX, sceneY) in the new texture, causing all
    // previously-drawn shapes to drift on the next commit after a disable/re-enable cycle.
    const tempSprite = new PIXI.Sprite(sprite.texture);
    canvas.app.renderer.render(tempSprite, { renderTexture: newTex, clear: false });
    tempSprite.destroy({ texture: false });
    const oldTex = sprite.texture;
    sprite.texture = newTex;
    // Re-point the GM overlay at the new texture before destroying the old one.
    if (canvas.fogweaver?._gmOverlay) canvas.fogweaver._gmOverlay.texture = newTex;
    oldTex.destroy(true);
    return newTex;
}

// Render the shape into the fog RenderTexture by attaching the Graphics to the stage,
// rendering it, then removing/destroying. Adding to the stage briefly guarantees the
// renderer has a valid scene-graph context for the object; we apply the scene offset on
// the object since `transform` passed to renderer.render() is unreliable in PIXI v8.
function _renderShapeToTexture(tex, shape) {
    const dims = canvas.dimensions;

    const g = new PIXI.LegacyGraphics();
    g.position.set(-dims.sceneX, -dims.sceneY);
    g.beginFill(0xFF0000);
    if (shape.isErase) g.blendMode = PIXI.BLEND_MODES.ERASE;
    drawShapeGeometry(g, shape);
    g.endFill();

    canvas.stage.addChild(g);
    try {
        canvas.app.renderer.render(g, { renderTexture: tex, clear: false });
    } finally {
        canvas.stage.removeChild(g);
        g.destroy();
    }
}

// canvas.fog.exploration is normally initialized inside FogManager.commit(), which our intercept
// bypasses. Initialize it here so that save() doesn't bail out at its null-guard.
async function _saveAndSync() {
    if (!canvas.fog.exploration) {
        // v14 requires a `level` field on FogExploration documents; _createExplorationDocument()
        // handles all required fields including `level`. Fall back to manual construction on v13.
        canvas.fog.exploration = typeof canvas.fog._createExplorationDocument === "function"
            ? canvas.fog._createExplorationDocument()
            : new (getDocumentClass("FogExploration"))({ scene: canvas.scene.id, user: game.user.id });
    }
    canvas.fog._updated = true;
    await canvas.fog.save();
    try {
        await canvas.fog.sync(game.user);
    } catch(err) {
        // sync fails when there are no other connected users; not fatal
        console.warn(`${MODULE_ID} | fog sync skipped:`, err.message);
    }
}

// If two GMs draw shapes simultaneously, this read-modify-write is racy on the scene flag —
// last write wins. The fog texture itself is fine (it's the canonical state for players);
// only the undo history (scene.flags.fogweaver.shapes) can drop entries. Acceptable for v1.
async function _persistShape(shapeData) {
    const shapes = _getShapesForCurrentLevel().slice();
    shapes.push({ id: foundry.utils.randomID(), ...shapeData });
    await _setShapesForCurrentLevel(shapes);
}

export async function _undoLastShape() {
    const shapes = _getShapesForCurrentLevel().slice();
    if (!shapes.length) return;
    shapes.pop();
    await _setShapesForCurrentLevel(shapes);
    await _rebuildFogFromShapes(shapes);
}

async function _rebuildFogFromShapes(shapes) {
    const tex = _ensureRenderTexture();
    if (!tex) return;

    // Empty-container render with clear:true zeroes the texture without destroying the sprite.
    // The Container is briefly attached to the stage to give the renderer a valid scene-graph context.
    const blanker = new PIXI.Container();
    canvas.stage.addChild(blanker);
    try {
        canvas.app.renderer.render(blanker, { renderTexture: tex, clear: true });
    } finally {
        canvas.stage.removeChild(blanker);
        blanker.destroy();
    }

    for (const s of shapes) _renderShapeToTexture(tex, s);

    await _saveAndSync();
    canvas.perception.initialize();
}
