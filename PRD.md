# Product Requirements Document: SNOWFLOW — the river extension

---

## 1. Executive Summary

This document outlines the strategy for forking the "SNOWFLOW" WebGPU repository/prompt structure and extending it with a real-time, compute-driven **river**. By leveraging the existing structural constraints, performance budgets, and AI-driven workflow (Claude Code Opus 5) of the base project, we will replace the granular snowdrift physics with a high-performance fluid dynamics engine. The primary hardware target is Apple Silicon (M-Series), with a strict optimization focus on achieving maximum framerates (up to 160 FPS) through native Metal efficiencies.

## 2. Project Metadata

| Attribute | Details |
| --- | --- |
| **Product Name** | SNOWFLOW |
| **Base Architecture** | SNOWFLOW (Procedural WebGPU Engine) |
| **Platform** | Web (Targeting macOS Safari for native Metal translation) |
| **Core Technologies** | WebGPU, Three.js, TSL (Three.js Shading Language), Claude Code |
| **Target Hardware** | Apple Silicon (M3 Focus) |

---

## 3. Core Physics Migration: Snow to Water

The fundamental shift requires moving from thermal weathering and granular accumulation (snow) to continuous fluid mechanics (water).

* **Fluid Simulation Engine:** Implement a WebGPU Compute Shader-based fluid solver. Replace the snow displacement compute kernels with either a Smoothed Particle Hydrodynamics (SPH) or PIC/FLIP solver.
* **Buffer Management:** Utilize WebGPU's `atomicAdd` capabilities for the scatter phase of particle-to-grid data transfers, avoiding CPU readbacks entirely.
* **Spatial Sorting:** Implement a parallel Prefix-Sum and Linear Grid system within the compute shaders to manage neighbor searches for fluid particles, allowing the simulation of tens of thousands of water particles simultaneously.
* **Terrain Interaction:** Map the existing procedural terrain height map to the fluid simulation's collision boundaries so the river flows naturally down gradients and pools in procedural valleys.

---

## 4. Visual Rendering Pipeline

Water requires a fundamentally different rendering approach than opaque snow or sand to look realistic and performant.

* **Screen-Space Fluid Rendering (SSFR):** Build a multi-pass TSL pipeline to render fluid particles as a cohesive surface.
* **Depth Pass:** Render particle depths to an off-screen texture.
* **Smoothing Pass:** Apply a bilateral blur to the depth texture to merge discrete particles into a continuous fluid volume.
* **Thickness Pass:** Calculate volume thickness to simulate light absorption (deep water appears darker, shallow water appears clearer).
* **Surface Reconstruction:** Generate surface normals dynamically from the smoothed depth buffer to allow for physically-based specular highlights (sun glints on the water).

---

## 5. Apple Silicon (M-Series) Optimizations

Because the original SNOWFLOW and Desert demos were built for immediate-mode discrete GPUs (like the RTX 5070), the architecture must be strictly adapted for Apple's M3 Tile-Based Deferred Rendering (TBDR).

* **Half-Precision (f16) Implementation:** Request the `shader-f16` WebGPU extension. All fluid pressure, density, and velocity compute buffers must be cast to `f16` to halve memory bandwidth and maximize Apple's arithmetic throughput.
* **TBDR Awareness:** Consolidate the SSFR multi-pass rendering as much as possible. Avoid splitting render passes unnecessarily to prevent forcing tile memory flushes to main system memory.
* **Native Telemetry:** Abandon the headless-Chrome V8 testing loop. Rebuild the automated AI testing harness to use Playwright targeting WebKit/Safari, and manually verify bottlenecks using Xcode Instruments' Metal System Trace.
* **Loop Unrolling:** Ensure any raymarching loops (for the skybox or water volumetric checks) are unrolled in the fragment shader to avoid known Tint translation penalties on Apple platforms.

---

## 6. Implementation Milestones

### Phase 1: Infrastructure Pivot

* Clone the SNOWFLOW prompt structure and initialize the Vite/Three.js/WebGPU stack.
* Configure the Safari/WebKit headless harness for Claude Code testing.
* Establish the base procedural terrain (keeping the macro-noise algorithms from SNOWFLOW but adjusting the parameters to generate river valleys instead of dunes).

### Phase 2: Compute Foundation (The Fluid)

* Build the `f16` storage buffers for particle position, velocity, and density.
* Write the SPH or PIC/FLIP compute kernels.
* Implement spatial hashing and parallel sorting for particle neighbor detection.
* Verify simulation performance (Target: < 5ms compute time per frame).

### Phase 3: Screen-Space Rendering

* Implement the SSFR pipeline in TSL (Depth, Blur, Normal reconstruction).
* Apply environment mapping so the river reflects the procedural sky.
* Integrate terrain collision so the water interacts correctly with the shorelines.

### Phase 4: Integration and Polish

* Adapt the third-person character controller to wade through the river (altering movement speed based on water depth).
* Add whitewater/foam generation compute passes where particle kinetic energy exceeds a threshold or collides rapidly with terrain.
* Conduct final optimization passes using Xcode Instruments to hit the maximum possible framerate on the M3.

---

## Webcam Tracking (added 2026-08-18)

The demo accepts webcam input alongside keyboard/mouse (design spec:
`docs/superpowers/specs/2026-08-18-snowflow-webcam-tracking-design.md` at the
repo root; implementation plan under `docs/superpowers/plans/`).

* **Head-look:** face orientation (MediaPipe FaceLandmarker) pans the camera as an absolute, self-centering offset composed into the camera rig; the avatar's head follows the user's gaze.
* **Gestures:** right hand drives locomotion (open palm walk, palm-roll steering, raised palm sprint, fist stop); left hand fires the five spells (Victory is Ribbon's held cast).
* **Architecture:** everything lands in the existing `input` struct via `applyTracking()` immediately after `pollInput()`; keyboard/mouse are untouched and regain ownership the moment tracking drops.
* **Testing:** pure mapping logic under `node:test` (`npm test`); a scripted `?track=mock` source drives a Playwright smoke test (`npm run test:e2e`) with no webcam.
