# FloralCanvas 🌸

Paint with flowers using just your fingers. FloralCanvas is a full-screen, two-handed augmented-reality filter that runs in your browser: pinch your thumb with any finger, move your hand, and flowers bloom on stems over your live camera while butterflies drift across the screen.

**Live demo:** https://your-app.vercel.app  <!-- replace after deploying -->

> Everything runs locally in your browser. Your camera video is never uploaded or stored anywhere.

## Features

- Live, mirrored webcam filling the whole screen
- Tracks **both hands at once** with MediaPipe Hand Landmarker
- Each finger grows its own flower:

| Hand | Index | Middle | Ring | Little |
|---|---|---|---|---|
| Left | 🌸 | 🪻 | 🍀 | 🪷 |
| Right | 🌹 | 🌻 | 🌼 | 🌷 |

- Smooth blooming flowers on swaying stems
- Butterflies appear after every 3-4 flowers and roam the whole screen
- Undo, redo, clear, and save your artwork as a PNG

## How to use

1. Open the app and allow camera access.
2. Hold your hands in front of the camera, fully in frame.
3. Pinch your thumb to a fingertip and move to draw. Release to stop.
4. Use the round buttons at the bottom: undo, redo, clear, save.

## How it works

1. The webcam feed is mirrored and sent to MediaPipe, which returns 21 landmarks per hand plus a Left/Right label.
2. A pinch is detected when the thumb-to-fingertip distance, divided by hand size, drops below a threshold. Two thresholds (hysteresis) stop flickering.
3. Positions are smoothed and mapped onto the screen, then flowers are placed along the path.
4. A Canvas 2D layer draws flowers, stems and butterflies over the video every frame.

For the full walkthrough, see [LEARNING_GUIDE.md](LEARNING_GUIDE.md).

## Tech stack

Vite, vanilla JavaScript, HTML, CSS, Canvas 2D API, MediaPipe Tasks Vision, browser `getUserMedia` API.

## Run locally

Requires [Node.js](https://nodejs.org) 18 or newer.

```bash
git clone https://github.com/<your-username>/FloralCanvas.git
cd FloralCanvas
npm install
npm run dev
```

Open the link shown in the terminal (usually http://localhost:5173) and allow camera access. The camera only works on `localhost` or `https://`.

## Build

```bash
npm run build
npm run preview
```

## Customize

Edit the constants at the top of `src/main.js`:

| Setting | What it does |
|---|---|
| `FINGER_FLOWERS` | Change which emoji each finger draws |
| `PINCH_START` / `PINCH_END` | How tight a pinch must be |
| `SMOOTHING` | Lower is smoother, higher is snappier |
| `SHOW_STEMS`, `STEM_COLOR` | Turn stems off or recolour them |
| `MAX_BUTTERFLIES` | Limit how many butterflies appear |
| `SWAP_HANDS` | Set to `true` if Left and Right are swapped on your device |

## Troubleshooting

- **No camera prompt:** use `localhost` or an `https://` link.
- **Hands not detected:** use good lighting and keep hands fully in frame.
- **Hand tracking fails to load:** the model downloads from the internet on first load, so check your connection.
- **🪻 shows as a blank box:** your device's emoji font is older. Update your OS or browser.

## Known limitations

- One finger per hand draws at a time.
- Thousands of flowers will eventually slow things down. Press clear to reset.

## Roadmap

- Gesture shortcuts (for example, an open palm to clear)
- Sparkle effects and more flower sets
- Custom gesture recognition trained on hand-landmark data

## Acknowledgements

Hand tracking by [MediaPipe](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker).

## License

MIT
