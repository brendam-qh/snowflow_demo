/**
 * Central tuning + toggle store.
 *
 * `S` is a flat plain object read directly by systems every frame — no getters,
 * no proxies, no allocation. `SCHEMA` is metadata the settings overlay builds
 * its widgets from, and `onChange` lets systems react to edits that need work
 * (rebuilding a render target, re-freezing a material) rather than just being
 * sampled next frame.
 */

/** @type {Record<string, number|boolean|string>} */
export const S = {
    // ---------------------------------------------------------------- quality
    preset: "ultra",
    resolutionScale: 1.0,

    // ------------------------------------------------------------------- sun
    sunAzimuth: 118, // degrees, compass bearing of the sun
    // Low enough for long raking shadows, high enough that the beam still
    // carries real energy — below ~10 degrees the air mass eats so much of it
    // that the scene goes flat and sky-lit.
    sunElevation: 13.0,
    sunIntensity: 4.2,
    sunTempWarm: 1.0, // 0 = neutral white, 1 = full warm low-sun tint
    ambientIntensity: 1.0,
    ambientBlue: 1.0, // strength of the cool shadow shift

    // ------------------------------------------------------------- atmosphere
    fogDensity: 0.0072,
    fogHeightFalloff: 0.045,
    fogStart: 24,
    aerialStrength: 1.0,
    // Degrees. Drives sastrugi shear and dune orientation. Held 70-80 degrees
    // away from `sunAzimuth`: sastrugi ridges run along the wind, so when the
    // two align the sun rakes down every ridge, lights both flanks identically
    // and the fine structure reads as flat ground.
    windDirection: 42,
    windStrength: 1.0,
    /** Far-field mountain range on the skybox. */
    showMountains: true,
    /** Peak height of that range, metres. */
    mountainHeight: 2150,
    /** Strength of the volumetric shafts spilling past dune crests. */
    shaftStrength: 0.30,

    // ------------------------------------------------------------------- snow
    glintIntensity: 0.55,
    glintGrazing: 0.72, // how hard the grazing-angle gate bites
    sssStrength: 1.0,
    sssRadius: 1.0,
    detailNormalStrength: 1.0,
    macroHeightScale: 1.0,
    sastrugiStrength: 1.0,

    // ----------------------------------------------------------- deformation
    deformDepth: 1.0,
    deformBerm: 1.0,
    refillRate: 1.0,
    deformResolution: 2048,

    // ------------------------------------------------------------- snow-surf
    /** Height of the breaking wall thrown by a carve, as a multiple of 1.45 m. */
    wakeHeight: 1.0,
    /** Density of the plume shed off the wake's lip. */
    wakeSpray: 1.0,
    /** Screen-space speed streaks while surfing. */
    windStreaks: true,
    streakStrength: 1.0,

    // ---------------------------------------------------------------- spells
    /** Master toggle. Off cancels everything in flight and hides both meshes. */
    showSpells: true,
    /** Brightness of the dynamic lights the spells emit. */
    spellLight: 1.0,
    /** Density of the spray every spell throws. */
    spellSpray: 1.0,
    /**
     * Artistic scale on the water's absorption path — glacial melt at one end,
     * tap water at the other. The right value depends on the sun elevation, so
     * it is a slider rather than a constant.
     */
    waterDepthTint: 1.0,

    // ------------------------------------------------------------------ river
    // The river channel is carved at bake time, so most river-shape knobs need
    // a reload to take effect — same contract as `macroHeightScale` and the
    // dune parameters. `riverFlowSpeed` is runtime-live (it drives the MVP
    // surface, below).
    /** Master toggle for the valley carvable. 0 = pure dune field. */
    showRiver: true,
    /** Master scale on the whole channel cut (depth + width follow). Needs re-bake. */
    riverness: 1.0,
    /** Compass bearing the river flows toward, in degrees. Needs re-bake. */
    riverFlowDir: 92.0,
    /** Multiplier on channel width (valley + bed). Needs re-bake. */
    riverWidth: 0.35,
    /**
     * Water depth at the channel centre, as a multiple of 1.1 m. Scales the bed
     * trough only — the valley floor is pinned to the waterline — so 1.0 is
     * waist-deep on a 1.8 m character and the river stays wadeable. Above ~1.6
     * the centre is over head height. Needs re-bake.
     */
    riverDepth: 1.0,
    /** Runtime: speed of the MVP river surface flow (m/s, visual). */
    riverFlowSpeed: 2.6,
    /** Show the MVP kinematic river surface and (later) the SPH particles. */
    showRiverSurface: true,

    /**
     * Fluid simulation mode (M3).
     *   "off"        MVP kinematic surface only — no particle solve.
     *   "particles"  StorageBuffer + @compute particles running, grid solve on.
     *   "full"       particles + rendering replaces the kinematic surface.
     * Defaults to "off" so the solver is opt-in until M3 is verified.
     */
    fluidMode: "full",
    /** Marker particle count. Powers-of-two are friendly to workgroups; 16384
     *  is a starting point, the slider lets you push it for visual density and
     *  pull it for perf. */
    fluidParticleCount: 16384,
    /** Grid solve resolution (cells across). Higher = stiffer incompressibility,
     *  costs more fragment texels. 128 cells over the bed AABB is a start. */
    fluidGridRes: 128,

    // ------------------------------------------------------------------ post
    taa: true,
    ssr: true,
    dof: true,
    bloom: true,
    grain: true,
    sharpen: true,
    tonemap: "agx", // "agx" | "aces" | "none"
    // Measured, not guessed: sunlit snow here sits around 12 in linear, and at
    // this exposure it lands near AgX normalised 0.79, where the curve's slope
    // is 0.09 per stop. Higher exposures push it into the shoulder, where the
    // slope collapses and every lit slope resolves to the same flat white.
    exposure: 0.105,
    contrast: 1.14,
    bloomStrength: 0.22,
    grainStrength: 0.022,
    sharpenStrength: 0.55,

    // --------------------------------------------------------------- systems
    showTerrain: true,
    showCharacter: true,
    showWake: true,
    showLightShafts: true,
    wireframe: false,
    freezeTime: false,

    // ----------------------------------------------------------------- debug
    debugView: "beauty", // beauty | deform | normals | depth | cascades | footprint | fineNormals

    // -------------------------------------------------------------- tracking
    /** Master switch for webcam head-look + gesture input. */
    trackingEnabled: true,
    /** Head-rotation -> view-rotation multiplier. */
    trackingHeadGain: 2.2,
    /** Palm-roll -> steering multiplier. */
    trackingSteerGain: 1.0,
    /** Minimum MediaPipe gesture confidence. */
    trackingGestureScore: 0.6,
    /** Match the mirrored camera preview: leaning right on screen steers right. */
    trackingMirror: true,
};

/**
 * Widget metadata. `t`: "f" float slider, "b" bool toggle, "e" enum.
 * @type {{group:string, items:Array<{k:string,l:string,t:string,min?:number,max?:number,step?:number,opts?:string[]}>}[]}
 */
export const SCHEMA = [
    {
        group: "Sun & Sky",
        items: [
            { k: "sunAzimuth", l: "Azimuth", t: "f", min: 0, max: 360, step: 1 },
            { k: "sunElevation", l: "Elevation", t: "f", min: 0.5, max: 45, step: 0.1 },
            { k: "sunIntensity", l: "Intensity", t: "f", min: 0, max: 10, step: 0.05 },
            { k: "sunTempWarm", l: "Warmth", t: "f", min: 0, max: 1, step: 0.01 },
            { k: "ambientIntensity", l: "Ambient", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "ambientBlue", l: "Ambient blue", t: "f", min: 0, max: 2, step: 0.01 },
        ],
    },
    {
        group: "Atmosphere",
        items: [
            { k: "fogDensity", l: "Fog density", t: "f", min: 0, max: 0.03, step: 0.0001 },
            { k: "fogHeightFalloff", l: "Height falloff", t: "f", min: 0, max: 0.3, step: 0.001 },
            { k: "aerialStrength", l: "Aerial persp.", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "windDirection", l: "Wind dir", t: "f", min: 0, max: 360, step: 1 },
            { k: "windStrength", l: "Wind strength", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "showMountains", l: "Far range", t: "b" },
            { k: "mountainHeight", l: "Range height", t: "f", min: 0, max: 2500, step: 10 },
            { k: "showLightShafts", l: "Light shafts", t: "b" },
            { k: "shaftStrength", l: "Shaft amt", t: "f", min: 0, max: 2, step: 0.01 },
        ],
    },
    {
        group: "Snow",
        items: [
            { k: "glintIntensity", l: "Glint", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "glintGrazing", l: "Glint gate", t: "f", min: 0, max: 1, step: 0.01 },
            { k: "sssStrength", l: "SSS strength", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "sssRadius", l: "SSS radius", t: "f", min: 0.1, max: 3, step: 0.01 },
            { k: "detailNormalStrength", l: "Detail normals", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "macroHeightScale", l: "Dune height", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "sastrugiStrength", l: "Sastrugi", t: "f", min: 0, max: 2, step: 0.01 },
        ],
    },
    {
        group: "Deformation",
        items: [
            { k: "deformDepth", l: "Depth", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "deformBerm", l: "Berm mass", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "refillRate", l: "Refill rate", t: "f", min: 0, max: 4, step: 0.01 },
        ],
    },
    {
        group: "Snow-surf",
        items: [
            { k: "wakeHeight", l: "Wake height", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "wakeSpray", l: "Plume density", t: "f", min: 0, max: 2.5, step: 0.01 },
            { k: "windStreaks", l: "Speed streaks", t: "b" },
            { k: "streakStrength", l: "Streak amt", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "showWake", l: "Wake mesh", t: "b" },
        ],
    },
    {
        group: "Spells",
        items: [
            { k: "showSpells", l: "Spells", t: "b" },
            { k: "spellLight", l: "Spell light", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "spellSpray", l: "Spell spray", t: "f", min: 0, max: 2.5, step: 0.01 },
            { k: "waterDepthTint", l: "Water depth", t: "f", min: 0, max: 3, step: 0.01 },
        ],
    },
    {
        group: "River",
        items: [
            { k: "showRiver", l: "River", t: "b" },
            { k: "riverness", l: "Channel cut", t: "f", min: 0, max: 1.5, step: 0.01 },
            { k: "riverFlowDir", l: "Flow dir°", t: "f", min: 0, max: 360, step: 1 },
            { k: "riverWidth", l: "Width", t: "f", min: 0.15, max: 2.5, step: 0.01 },
            { k: "riverDepth", l: "Depth", t: "f", min: 0.3, max: 2.0, step: 0.01 },
            { k: "showRiverSurface", l: "Surface", t: "b" },
            { k: "fluidMode", l: "Solver", t: "e", opts: ["off", "particles", "full"] },
            { k: "fluidParticleCount", l: "Particles", t: "f", min: 1024, max: 65536, step: 1024 },
            { k: "fluidGridRes", l: "Grid cells", t: "f", min: 32, max: 256, step: 8 },
            { k: "riverFlowSpeed", l: "Flow speed", t: "f", min: 0, max: 8, step: 0.05 },
        ],
    },
    {
        group: "Post",
        items: [
            { k: "taa", l: "TAA", t: "b" },
            { k: "ssr", l: "SSR (ice)", t: "b" },
            { k: "dof", l: "Depth of field", t: "b" },
            { k: "bloom", l: "Bloom", t: "b" },
            { k: "grain", l: "Film grain", t: "b" },
            { k: "sharpen", l: "Sharpen", t: "b" },
            { k: "tonemap", l: "Tonemap", t: "e", opts: ["agx", "aces", "none"] },
            { k: "exposure", l: "Exposure", t: "f", min: 0.01, max: 0.6, step: 0.005 },
            { k: "contrast", l: "Contrast", t: "f", min: 0.5, max: 2, step: 0.01 },
            { k: "bloomStrength", l: "Bloom amt", t: "f", min: 0, max: 1, step: 0.005 },
            { k: "grainStrength", l: "Grain amt", t: "f", min: 0, max: 0.1, step: 0.001 },
            { k: "sharpenStrength", l: "Sharpen amt", t: "f", min: 0, max: 1, step: 0.01 },
        ],
    },
    {
        group: "Systems",
        items: [
            { k: "showTerrain", l: "Terrain", t: "b" },
            { k: "showCharacter", l: "Character", t: "b" },
            { k: "wireframe", l: "Wireframe", t: "b" },
            { k: "freezeTime", l: "Freeze time", t: "b" },
            { k: "resolutionScale", l: "Resolution", t: "f", min: 0.5, max: 1.5, step: 0.05 },
            {
                k: "debugView", l: "Debug view", t: "e",
                opts: ["beauty", "deform", "normals", "depth", "cascades", "footprint",
                       "fineNormals", "shadow", "ndotl", "shadowMap", "albedo"],
            },
        ],
    },
    {
        group: "Tracking",
        items: [
            { k: "trackingEnabled", l: "Webcam control", t: "b" },
            { k: "trackingHeadGain", l: "Head gain", t: "f", min: 0.5, max: 4, step: 0.05 },
            { k: "trackingSteerGain", l: "Steer gain", t: "f", min: 0.25, max: 2.5, step: 0.05 },
            { k: "trackingGestureScore", l: "Gesture conf.", t: "f", min: 0.3, max: 0.9, step: 0.05 },
            { k: "trackingMirror", l: "Mirror steering", t: "b" },
        ],
    },
];

/** Quality presets. Only the keys that differ from `ultra` need listing. */
export const PRESETS = {
    ultra: {},
    high: { deformResolution: 2048, resolutionScale: 1.0, ssr: true, dof: true },
    balanced: {
        deformResolution: 1024, resolutionScale: 0.85,
        ssr: false, dof: false,
    },
};

/** @type {Map<string, Set<(v:any, k:string) => void>>} */
const listeners = new Map();

/**
 * Subscribe to a settings key. Returns an unsubscribe function.
 * @param {string|string[]} keys
 * @param {(v:any, k:string) => void} fn
 */
export function onChange(keys, fn) {
    const list = typeof keys === "string" ? [keys] : keys;
    for (let i = 0; i < list.length; i++) {
        let set = listeners.get(list[i]);
        if (!set) {
            set = new Set();
            listeners.set(list[i], set);
        }
        set.add(fn);
    }
    return () => {
        for (let i = 0; i < list.length; i++) listeners.get(list[i])?.delete(fn);
    };
}

/**
 * Write a settings value and notify subscribers. Never called from the render
 * loop — only from the overlay and preset application.
 * @param {string} k
 * @param {number|boolean|string} v
 */
export function set(k, v) {
    if (S[k] === v) return;
    S[k] = v;
    const set_ = listeners.get(k);
    if (set_) for (const fn of set_) fn(v, k);
}

/** @param {keyof typeof PRESETS} name */
export function applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    S.preset = name;
    for (const k in p) set(k, p[k]);
}
