# Launch list

Three destinations: GitHub, Substack, Reddit. Everything below is either a decision only you can make, a step I can run once you say go, or a thing I've already checked.

## Decide first

- [ ] **What the repo is.** `snowflow_demo-main/` on its own, or the whole `off-axis-sneaker` checkout it currently sits inside. I'd push the folder on its own: nothing in it reaches outside, the MediaPipe models are vendored in, and it builds and tests from inside the folder.
- [ ] **If you push the parent instead, read this first.** Its remote is `icurtis1/off-axis-sneaker`, not yours, so you'd need a new remote either way. It also has a tracked `.env` carrying `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, committed back in `f1ebbfe`. Both are `VITE_`-prefixed, so Vite compiles them into the client bundle anyway and the anon key is meant to be public — but check that project has row-level security on before the file sits in a public repo under your name.
- [ ] **`amplify.yml` ends with `appRoot: snowflow_demo-main`.** That only makes sense when the build runs from the parent. Drop the line if the folder becomes its own repo, or the deploy won't find the app.
- [ ] **The README demo link still points at `riverwalk.qualityhealth.app`.** Either redeploy under a snowflow name and update the link, or leave it and mention the old name in the README.

## GitHub

- [ ] Create the empty repo on your account first (no README, no licence, no .gitignore — the folder has all three).
- [ ] Then, from inside `snowflow_demo-main`:

```bash
git init -b main && git add -A && git commit -m "SNOWFLOW: webcam control, river, fluid solver"
```

- [ ] Point it at your repo and push:

```bash
git remote add origin https://github.com/<you>/<repo>.git && git push -u origin main
```

- **What lands:** source, docs, and the vendored MediaPipe models. That's 45 MB of `public/models`, largest single file 11 MB, so nothing near GitHub's 100 MB per-file limit. Clones will be chunky but fine.
- **What doesn't:** `node_modules`, `dist`, and every image — `.gitignore` has a blanket `*.png`, so the 45 MB of `shots/` stays local.
- [ ] **That same rule blocks a README screenshot.** If you want images on the repo page, add an exception like `!docs/img/*.png` to `.gitignore` and put them there.
- [ ] `LICENSE` (MIT) and the upstream credit in the README are both already in place. Keep them — this is a fork of Maksymilian Dendura's SNOWFLOW.
- [ ] Decide whether `BLOG.md`, `SUBSTACK.md` and this file ship in the repo or stay local drafts.

## Substack

- [ ] Paste `SUBSTACK.md` (1,928 words). Check the headings and the `inline code` survive the paste — Substack's editor handles backticks inconsistently, and this post leans on them.
- [ ] Add images. The four stills I captured are in `/tmp/shots/` and won't survive a reboot; ask and I'll regenerate them somewhere you keep. The before/after pair on the water push is the one worth including.
- [ ] Link the GitHub repo and the live demo near the top, not just at the end.
- [ ] Once it's published, send me the URL — `BLOG.md` still says "I have a full writeup on my substack" with nothing linked.

## Reddit

- [ ] Create the account yourself. I can't create accounts, and I won't post on your behalf without you asking each time.
- [ ] Use it normally for a few days before you post. Large subs auto-filter brand-new accounts, and a removed launch post is hard to retry.
- [ ] Read each sub's self-promotion rules before posting. Several want a top-level comment explaining the tech, and some don't allow blog links at all. I can't check current rules from here.
- Candidates worth looking at: r/webgpu, r/GraphicsProgramming, r/proceduralgeneration, r/computervision (for the MediaPipe angle), r/gamedev's Screenshot Saturday, r/InternetIsBeautiful (that one wants the live demo, not the repo).
- [ ] **Record a video.** Stills undersell this completely. Twenty to thirty seconds, screen capture with the webcam preview visible in the corner — the app already draws that tracking picture-in-picture — showing a hand gesture and the spell it fires. Head turn first, then two or three spells. That clip is the entire pitch.
- [ ] Title it as what it is: a procedural WebGPU snow demo you control with your face and hands. Lead with the control, not the renderer.

## I can do these when you want

- Regenerate the screenshots into a folder that persists.
- Run the `git init` and first commit once you've made the repo and given me the URL.
- Draft the Reddit post text and a Substack subtitle.
- Fill in the Substack link across `BLOG.md` and the README.
