# Adding webcam control and fluid dynamics to a browser based simulation game

I came across this awesome project on reddit from Maksymilian Dendura. SNOWFLOW is a WebGPU demo featuring a character walking across a snow field (there's a desert/sand version as well), carving it up and throwing spells at it, with nothing shipped as an asset. No textures, no meshes, no HDRIs, no animation data. It's all generated on the GPU at load time.

I have been playing around a lot with different face and gesture tracking software so thought it would be cool to add in those features to this demo, along with some additional simulated features. So I added a river, put a fluid solver in it, then added face and hand tracking so you can walk and cast without touching the keyboard.

This was truly vibe-coded with OpenCode + GLM-5.2/Minimax M3 and it was fun just to see the capabilities of some of the models out there. 

Try out the demo here: 

This is the technical writeup: what changed, in the order it happened, and what broke on the way (mostly AI generated but I did actually go through and edit so it reads a little nicer).

## The Webcam layer
The webcam layer is about a hundred lines of MediaPipe glue plus the mapping logic. I put it in this repo rather than bridging it from the sibling React app: that app is React and Three.js, this one is vanilla JavaScript and Babylon, and a postMessage bridge would have added latency and a second app to run for no reuse worth having.

Both models run in one loop at about 30 Hz, driven by a `setTimeout` rather than the render loop, so inference never sits inside a frame's budget. It watches its own cost with a smoothed average, and if a combined face-plus-hands pass ever goes over 25 ms it degrades to alternating: face on even passes, hands on odd. Both stay alive at half the rate instead of one of them eating the frame.

The models are vendored into `public/models` rather than pulled from a content delivery network, so nothing about the tracking touches the network. They're also the first third-party assets in the repo, and the rendered world is still entirely procedural. The `.task` files are machine-learning models, not art.

## Face tracking and parallax effect
One thing I thought would be cool was controlling where you look in the scene using actual face tracking. If you look up, the camera perspective shifts up with you, turn left or right, and the view follows. The idea was inspired by the off-axis perspective work in [off-axis-sneaker](https://github.com/icurtis1/off-axis-sneaker), but I wanted something that would fit cleanly into the existing rendering pipeline.

For the tracking itself, I’m using MediaPipe’s FaceLandmarker, which runs on the webcam at roughly 30 Hz and returns a 4×4 facial transformation matrix. From that matrix, yaw can be extracted with atan2(m[8], m[10]), while pitch comes from asin(-m[9]). Those angles are then converted into absolute camera offsets using a gain of about 2.2, clamped to roughly 60 degrees, and smoothly interpolated toward the target so the camera never snaps abruptly from one orientation to another.

There’s also a small amount of tolerance for tracking loss. If your face disappears, the system holds the last known offset for 250 milliseconds before smoothly easing back to zero. That prevents brief detection failures from causing visible camera movement. 

Movement also follows your gaze. The movement basis uses the same tracking offset as the camera, so if you glance left and hold W, you move in the direction you’re looking rather than continuing straight ahead. Because the tracking offset automatically returns to centre, facing the screen again restores W to its original direction.

This isn’t a true off-axis projection but more so just the tracking offset composed into the camera rig’s transform. A real off-axis projection would start interacting with things like temporal anti-aliasing jitter, the post-processing chain, and shadow cascades. Maybe for future work. 

## Gesture tracking: movement and spells
I also added MediaPipe’s hand tracking so the game can be controlled with gestures, including casting spells or moving without touching the keyboard. The right hand controls movement, while the left hand handles spellcasting.

Handedness is anatomical rather than screen-relative. MediaPipe identifies whether it is looking at your actual left or right hand, instead of simply checking which side of the webcam frame the hand appears on. That means the controls still behave correctly even if the webcam preview is mirrored.

On your right hand:
* **Open Palm** —  makes the character walk, while rolling the palm left or right steers. Small movements are deliberately ignored: there is effectively a dead zone below about 15 degrees, with steering reaching full lock around 45 degrees.
* **Raised palm** - Raising the hand above the shoulder line switches movement into a sprint.
* **Thumb up** -  Extending the right thumb in any direction activates **snow-surfing**. Once that mode is active, the angle of the thumb controls the carve, turning what is normally a simple hand pose into a more continuous steering input.

The left hand is dedicated entirely to spells, with one gesture mapped to each ability:

* **Palm forward** — an open hand held toward the camera casts **water push**
* **Victory** — two fingers held up casts **water stream**, which continues for as long as the gesture is maintained
* **Thumb up** — casts a **tower column of water**
* **Thumb down** — casts **ice spikes**
* **Shaking fist** — shaking a closed fist casts the **vortex**

I added a couple of safeguards to stop the system from becoming overly trigger-happy. Any gesture that the recognizer is less than 60 percent confident about is ignored, and a spell needs to be detected on two consecutive frames before it is allowed to fire. That means a single bad classification or stray frame should never accidentally cast something but calibration could definitely be improved.

The gesture system also feeds into the same input structure used by the keyboard and mouse rather than replacing it with a separate control path. WASD and mouse input therefore continue to work normally while hand tracking is active. If your hands leave the camera frame for more than 250 milliseconds, the gesture layer clears only the inputs it controls and cleanly hands movement back to the traditional controls.

Finally, all of the MediaPipe models are vendored directly into the repository. Nothing needs to be fetched from the network at runtime, so the tracking remains local and the entire demo continues to work offline.

## River and fluid simulation
The river channel is generated once when the world loads, in much the same way as the dune terrain. A handful of settings control its shape — how strongly the terrain should behave like a river, how wide and deep the channel is, and which direction the water flows. 

Getting the water itself to actually look like water took more iteration than expected. The first shader was technically rendering, but it was almost invisible. From the starting camera angle, the surface reflected so much of the sky that it effectively became a mirror, while the underlying colours were being washed out by the snow and wet terrain beneath it.

To fix it, I reduced the strength of the sky reflection, shifted the deep-water colour away from navy and toward teal, increased the sense of absorption with depth, and reduced how much of the snowy ground was allowed to show through the water. 

For the fluid simulation itself, the original design allowed either SPH, a particle-based fluid technique, or PIC/FLIP, which combines particles with a background grid. For this kind of scene — a steady river flowing through a channel, with water entering one end, leaving the other, and a character moving through it — I chose PIC/FLIP, which tends to be more stable and easier to control at the boundaries. 

The water particles pass their motion into an invisible grid laid over the river, the GPU works out how the water should flow, and the result is passed back to the particles. This combination gives PIC/FLIP much of its stability while still allowing the water to move naturally.

Most of the grid-based simulation reuses infrastructure that was already in the project with existing rendering shaders. It runs by repeatedly updating two textures back and forth — essentially reading the previous state from one texture while writing the next state into another, then swapping them. The existing terrain deformation system already worked this way, so I didn't need to invent a second simulation framework.

For the particles, PIC/FLIP requires each particle to feed its mass and momentum back into the nearby cells of the simulation grid. With 16,000 particles trying to this simultaneously, and many trying to update the same cell at once, those additions have to be performed safely without one particle overwriting another. That kind of many-to-one operation is awkward in an ordinary rendering shader, so I added in a compute shader, which is designed for general parallel calculation rather than simply drawing pixels.

## What's next
- I'd love to do more sophisticated gaze tracking (not just face tracking) to improve how the perspective changes when you look at different areas
- Adding in more spells and tracking more complex body movements would also be fun. I've seen some comments of an Avatar Last Airbender-esque game which I think would be awesome.
- The particles are still rendered using simple camera-facing quads rather than a full screen-space fluid renderer & sometimes appear through the terrain in places (depth-rendering issue). Because of that, the full particle version is still experimental and disabled by default.
- Plenty of improvements to be made on shading and other game elements