# Free Image to Video for Obsidian

Free image to video AI with no daily cap: start with no sign-up, keep going on a free account. Every video comes with sound and no watermark. This is the official plugin for [Free Image to Video](https://freeimagetovideo.ai/?utm_source=obsidian&utm_medium=plugin): turn an image in your vault into a video clip without leaving your note.

Right-click any PNG, JPEG or WebP in your vault and choose **Turn into a video clip**, describe the motion, and the finished clip — with sound — is saved to your vault and embedded at the cursor. Your image is the first frame, the same way [image to video](https://freeimagetovideo.ai/) works on the site.

## Commands

- **Animate the image under the cursor** (or **Turn into a video clip** in the file menu): the image becomes the first frame of the clip.
- **Generate video from a prompt into this note**: text to video, no image needed.
- **Show remaining credits**: free to call.

Clips land in the `Free Image to Video` folder (configurable) and `![[…]]` is inserted where you were typing. A clip takes a few minutes; the notice tells you when it is saved.

## Setup

1. Sign in on [freeimagetovideo.ai](https://freeimagetovideo.ai/?utm_source=obsidian&utm_medium=plugin) and create a key at [freeimagetovideo.ai/settings/apikeys](https://freeimagetovideo.ai/settings/apikeys).
2. Paste it into **Settings → Free Image to Video → API key**.

API runs need a paid plan: each run draws on the plan's full-speed allowance, then waits in the relaxed queue ([pricing](https://freeimagetovideo.ai/pricing)). Settings choose the clip length (4–15 s), resolution (480p or 768p) and default aspect ratio (16:9, 9:16 or 1:1). Model: MiniMax H3.

## Network use and privacy

The plugin talks only to `https://freeimagetovideo.ai`: your prompt and settings go to `/api/ai/generate`, the run is polled at `/api/ai/query`, and for **Animate** the image you picked is uploaded to `/api/storage/upload-image` so it can be used as the first frame. The finished clip is downloaded into your vault. Your API key is stored in this plugin's data in your vault. Nothing else is sent, and there is no telemetry. A Free Image to Video account is required.

MIT licensed.
