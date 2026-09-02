# Control SNOWFLOW with your webcam

I came across this awesome project on reddit from Maksymilian Dendura. SNOWFLOW is a WebGPU demo featuring a character walking across a snow field (there's a desert/sand version as well), carving it up and throwing spells at it, with nothing shipped as an asset. No textures, no meshes, no HDRIs, no animation data. It's all generated on the GPU at load time.

I have been playing around a lot with different face and gesture tracking software so thought it would be cool to add in those features to this demo, along with some additional simulated features. So I added a river, put a fluid solver in it, then added face and hand tracking so you can walk and cast without touching the keyboard.

This was truly vibe-coded with OpenCode + GLM-5.2/Minimax M3 and it was fun just to see the capabilities of some of the models out there. 

Try out the demo here: 

The webcam layer is about a hundred lines of MediaPipe glue plus the mapping logic.

## Face tracking and parallax effect
- I thought it would be cool to be able to control where you were looking in the scene based on actual face tracking.
- If you look up, the camera perspective would also shift up.
- Inspired by https://github.com/icurtis1/off-axis-sneaker
- Walking follows the look. The movement basis composes the same offset the view does, so glancing left and holding `W` takes you left. Because the offset self-centres, facing the screen again puts `W` back where it was.
- Lose the face and the last offset holds for 250 ms, then eases back to zero. The avatar's head follows your gaze the whole time.

## Gesture tracking: movement and spells
- I added in Mediapipe and their hand detection software so you could cast spells just with a gesture. Of the five spells, all are cast using the left hand, with different gestures.
- Handedness is anatomical. MediaPipe reports which of your hands it's looking at, not which side of the frame it's on, so the roles survive the mirrored preview you watch yourself in.
- The right hand drives movement: an open palm walks, rolling that palm steers (nothing under about 15 degrees, full lock at 45), raising it above the shoulder line sprints, and an extended thumb in any direction turns on snow-surf, with the thumb's tilt steering the carve.
- The left hand casts. One gesture per spell:
    - **Palm forward**, open hand held out at the camera — water push
    - **Victory**, two fingers up — water stream, held for as long as the fingers stay up
    - **Thumb up** — tower column of water
    - **Thumb down** — ice spikes
    - **Closed fist**, held for 100 ms — vortex
- Anything the recognizer is less than 60% sure about is ignored, and a spell needs two consecutive sightings before it fires, so one stray frame never casts.
- Gestures write into the same input struct the keyboard writes to, so WASD and the mouse keep working the entire time. Take your hands out of frame for 250 ms and the gesture layer zeroes what it owns and hands movement back.
- The models are vendored into the repo, so the tracking never touches the network and the demo still works offline.

## What's next
- I'd love to do more sophisticated gaze tracking to improve how the perspective changes when you look at different areas
- Adding in more spells and tracking more complex body movements would also be fun. I've seen some comments of an Avatar Last Airbender-esque game which I think would be awesome.

I have a longer writeup with more details on my substack.

