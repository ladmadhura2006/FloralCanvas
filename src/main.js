import './style.css';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

/* =====================================================================
   SETTINGS  (beginner tip: change these numbers to tune the feel)
   ===================================================================== */

// Which flower each finger draws.
const FINGER_FLOWERS = {
  Left: { index: '🌸', middle: '🪻', ring: '🍀', little: '🪷' },
  Right: { index: '🌹', middle: '🌻', ring: '🌼', little: '🌷' },
};

// MediaPipe landmark numbers.
const WRIST = 0;
const THUMB_TIP = 4;
const MIDDLE_MCP = 9; // knuckle of the middle finger (used to measure hand size)
const FINGER_TIP = { index: 8, middle: 12, ring: 16, little: 20 };
const FINGER_NAMES = Object.keys(FINGER_TIP);

// Pinch detection. Distances are measured relative to hand size,
// so it works whether your hand is close to or far from the camera.
// Two thresholds (start < end) = "hysteresis": it stops flickering.
const PINCH_START = 0.28; // pinch begins when ratio drops below this
const PINCH_END = 0.42; // pinch ends when ratio rises above this

const GRACE_FRAMES = 14; // how many lost frames before a pinch is released
// (a hand near the bottom edge is partly out of the camera picture,
//  so tracking drops out more often there)
const SMOOTHING = 0.55; // 0..1, higher = follows finger faster (less smooth)

// If MediaPipe labels the hands the wrong way round on your device,
// change this to true.
const SWAP_HANDS = false;

// Butterflies
const MAX_BUTTERFLIES = 8;
const BUTTERFLY_COOLDOWN_MS = 1500;

const BLOOM_MS = 450; // flower grow-in time

// Stems: a thin line growing from the bottom of the screen up to each flower.
const SHOW_STEMS = true;
const STEM_COLOR = 'rgba(140, 214, 160, 0.8)';
const STEM_WIDTH = 2.5;
const STEM_GROW_MS = 600; // how long a stem takes to grow up
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

/* =====================================================================
   PAGE ELEMENTS
   ===================================================================== */
const video = document.getElementById('cam');
const canvas = document.getElementById('fx');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const hintEl = document.getElementById('hint');
const flashEl = document.getElementById('flash');
const undoBtn = document.getElementById('undo');
const redoBtn = document.getElementById('redo');
const clearBtn = document.getElementById('clear');
const saveBtn = document.getElementById('save');

/* =====================================================================
   STATE
   ===================================================================== */
let W = 0; // screen size in CSS pixels
let H = 0;
let dpr = 1;
let vw = 0; // video frame size
let vh = 0;

let strokes = []; // each stroke = { flowers: [...] } (one pinch = one stroke)
let redoStack = [];
let clearedBackup = null; // lets "undo" bring back a cleared screen

let butterflies = [];
let placements = 0;
let nextButterflyAt = randInt(3, 4);
let lastButterflyTime = 0;

let handLandmarker = null;
let lastVideoTime = -1;
let hintShown = false;

// Offscreen canvas holding a MIRRORED copy of the video.
// MediaPipe's left/right labels assume a mirrored (selfie) image.
const mirror = document.createElement('canvas');
const mctx = mirror.getContext('2d');

// One independent state object per hand.
const hands = { Left: makeHandState(), Right: makeHandState() };

function makeHandState() {
  return {
    finger: null, // which finger is pinching right now (or null)
    stroke: null, // the stroke being drawn
    x: null, // smoothed screen position
    y: null,
    lastX: null, // last flower position (for trail spacing)
    lastY: null,
    wx: null, // last wrist position (normalized) for label recovery
    wy: null,
    missing: 999, // frames since this hand was last seen
  };
}

/* =====================================================================
   SMALL HELPERS
   ===================================================================== */
function rand(a, b) {
  return a + Math.random() * (b - a);
}
function randInt(a, b) {
  return Math.floor(rand(a, b + 1));
}
function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}
function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

/* =====================================================================
   EMOJI SPRITES  (draw each emoji once, then reuse it = fast)
   ===================================================================== */
const sprites = new Map();
function getSprite(emoji) {
  let s = sprites.get(emoji);
  if (s) return s;
  s = document.createElement('canvas');
  s.width = 200;
  s.height = 200;
  const c = s.getContext('2d');
  c.font = `150px ${EMOJI_FONT}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(emoji, 100, 108);
  sprites.set(emoji, s);
  return s;
}

/* =====================================================================
   SIZING + COORDINATES
   ===================================================================== */
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);

// The video is shown with "object-fit: cover" (crops to fill the screen).
// This converts a landmark (0..1 in the mirrored video) to screen pixels.
function coverMetrics() {
  const s = Math.max(W / vw, H / vh);
  return { s, ox: (vw * s - W) / 2, oy: (vh * s - H) / 2 };
}
function toScreen(nx, ny) {
  const { s, ox, oy } = coverMetrics();
  return [nx * vw * s - ox, ny * vh * s - oy];
}

function flowerBaseSize() {
  return Math.min(72, Math.max(34, Math.min(W, H) * 0.085));
}

/* =====================================================================
   FLOWERS
   ===================================================================== */
function placeFlower(hs, label, x, y) {
  if (!hs.stroke) {
    hs.stroke = { flowers: [] };
    strokes.push(hs.stroke);
    redoStack = [];
    clearedBackup = null;
    updateButtons();
  }
  const emoji = FINGER_FLOWERS[label][hs.finger];
  const size = flowerBaseSize() * rand(0.85, 1.15);
  // Keep every flower fully on screen (no half-cut flowers at the edges).
  const half = size / 2;
  x = Math.min(W - half, Math.max(half, x));
  y = Math.min(H - half, Math.max(half, y));
  hs.stroke.flowers.push({
    emoji,
    x,
    y,
    size,
    rot: rand(-0.35, 0.35),
    phase: rand(0, Math.PI * 2),
    born: performance.now(),
    // stem: where it starts at the bottom, and how much it curves
    bx: Math.min(W, Math.max(0, x + rand(-45, 45))),
    bend: rand(-45, 45),
  });

  if (!hintShown) {
    hintShown = true;
    hintEl.classList.add('hidden');
  }

  // Butterflies appear after every 3-4 flower placements.
  placements++;
  if (placements >= nextButterflyAt) {
    placements = 0;
    nextButterflyAt = randInt(3, 4);
    spawnButterfly();
  }
}

function drawFlower(c, f, now) {
  const t = Math.min(1, (now - f.born) / BLOOM_MS);
  const s = f.size * easeOutBack(t);
  if (s <= 0.5) return;
  const sway = Math.sin(now * 0.0018 + f.phase) * 0.06;
  c.save();
  c.translate(f.x, f.y);
  c.rotate(f.rot + sway);
  c.globalAlpha = Math.min(1, t * 2.5);
  c.drawImage(getSprite(f.emoji), -s / 2, -s / 2, s, s);
  c.restore();
}

/* =====================================================================
   BUTTERFLIES  (wander on their own over the whole screen)
   ===================================================================== */
function spawnButterfly() {
  const now = performance.now();
  if (now - lastButterflyTime < BUTTERFLY_COOLDOWN_MS) return;
  lastButterflyTime = now;

  // Keep the number sensible: fade out the oldest if we are full.
  const alive = butterflies.filter((b) => !b.dying);
  if (alive.length >= MAX_BUTTERFLIES) alive[0].dying = true;

  // Start just outside a random edge and drift inwards.
  const edge = randInt(0, 3);
  let x, y;
  if (edge === 0) { x = rand(0, W); y = -20; }
  else if (edge === 1) { x = W + 20; y = rand(0, H); }
  else if (edge === 2) { x = rand(0, W); y = H + 20; }
  else { x = -20; y = rand(0, H); }

  const size = rand(28, 62);
  const depth = (size - 28) / 34; // 0 = small/far, 1 = big/near
  butterflies.push({
    x,
    y,
    angle: Math.atan2(H / 2 - y, W / 2 - x) + rand(-0.6, 0.6),
    speed: 35 + depth * 65 + rand(-8, 8),
    size,
    turn: 0,
    turnTarget: rand(-1.2, 1.2),
    turnTimer: rand(0.8, 2.2),
    phase: rand(0, Math.PI * 2),
    bob: rand(0, Math.PI * 2),
    alpha: 0,
    dying: false,
  });
}

function updateButterflies(dt) {
  for (const b of butterflies) {
    // Pick a new gentle turning direction every second or two.
    b.turnTimer -= dt;
    if (b.turnTimer <= 0) {
      b.turnTarget = rand(-1.3, 1.3);
      b.turnTimer = rand(0.8, 2.2);
    }
    b.turn += (b.turnTarget - b.turn) * Math.min(1, dt * 1.5);
    b.angle += b.turn * dt;

    // Steer softly back toward the screen when near an edge.
    const m = 50;
    if (b.x < m || b.x > W - m || b.y < m || b.y > H - m) {
      const toCenter = Math.atan2(H / 2 - b.y, W / 2 - b.x);
      let diff = toCenter - b.angle;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      b.angle += diff * dt * 2.5;
    }

    b.phase += dt * (11 + b.speed * 0.04); // wing flapping
    b.bob += dt * 2.4;
    b.x += Math.cos(b.angle) * b.speed * dt;
    b.y += Math.sin(b.angle) * b.speed * dt + Math.sin(b.bob) * 6 * dt; // floating

    if (b.dying) b.alpha -= dt * 1.2;
    else b.alpha = Math.min(1, b.alpha + dt * 1.2);
  }
  butterflies = butterflies.filter((b) => b.alpha > 0 || !b.dying);
}

function drawButterfly(c, b) {
  if (b.alpha <= 0) return;
  const flap = 0.45 + 0.55 * Math.abs(Math.sin(b.phase)); // wing squash
  c.save();
  c.translate(b.x, b.y);
  c.rotate(Math.cos(b.angle) * 0.45); // lean left/right, stay upright
  c.scale(flap, 1);
  c.globalAlpha = b.alpha;
  c.drawImage(getSprite('🦋'), -b.size / 2, -b.size / 2, b.size, b.size);
  c.restore();
}

/* =====================================================================
   HAND TRACKING + PINCH GESTURES
   ===================================================================== */
function detect(now) {
  // Mirrored copy of the current video frame.
  mctx.setTransform(-1, 0, 0, 1, mirror.width, 0);
  mctx.drawImage(video, 0, 0, mirror.width, mirror.height);

  const res = handLandmarker.detectForVideo(mirror, now);
  const lms = res.landmarks || [];
  const n = lms.length;

  // Labels come from MediaPipe's handedness, not detection order.
  let labels = (res.handedness || []).map((h) => h[0].categoryName);
  if (SWAP_HANDS) labels = labels.map((l) => (l === 'Left' ? 'Right' : 'Left'));

  // Two hands with the same label = a mistake. Fall back to position:
  // in a mirrored view your left hand is on the left of the screen.
  if (n === 2 && labels[0] === labels[1]) {
    labels = lms[0][WRIST].x < lms[1][WRIST].x ? ['Left', 'Right'] : ['Right', 'Left'];
  }

  // One hand only: sometimes the label flips mid-drawing. If the other
  // hand was pinching a moment ago and this wrist is right where it was,
  // keep it as that hand.
  if (n === 1) {
    const L = labels[0];
    const O = L === 'Left' ? 'Right' : 'Left';
    const other = hands[O];
    const same = hands[L];
    const w = lms[0][WRIST];
    if (
      other.finger &&
      other.missing <= 2 &&
      same.missing > 0 &&
      other.wx !== null &&
      dist(w.x, w.y, other.wx, other.wy) < 0.25
    ) {
      labels[0] = O;
    }
  }

  const found = {};
  for (let i = 0; i < n; i++) {
    if (!found[labels[i]]) found[labels[i]] = lms[i];
  }
  for (const label of ['Left', 'Right']) {
    if (found[label]) processHand(label, found[label]);
    else loseHand(label);
  }
}

function processHand(label, lm) {
  const hs = hands[label];
  hs.missing = 0;
  hs.wx = lm[WRIST].x;
  hs.wy = lm[WRIST].y;

  // Work in video pixels so distances are not squashed by the aspect ratio.
  const px = (i) => lm[i].x * vw;
  const py = (i) => lm[i].y * vh;
  const handSize = dist(px(WRIST), py(WRIST), px(MIDDLE_MCP), py(MIDDLE_MCP)) || 1;

  let best = null;
  let bestRatio = Infinity;
  const ratios = {};
  for (const name of FINGER_NAMES) {
    const tip = FINGER_TIP[name];
    const r = dist(px(THUMB_TIP), py(THUMB_TIP), px(tip), py(tip)) / handSize;
    ratios[name] = r;
    if (r < bestRatio) {
      bestRatio = r;
      best = name;
    }
  }

  // Release when the active finger moves away from the thumb.
  if (hs.finger && ratios[hs.finger] > PINCH_END) endPinch(hs);

  // Start when the closest finger gets close enough to the thumb.
  if (!hs.finger && bestRatio < PINCH_START) {
    hs.finger = best;
    hs.x = null;
    hs.lastX = null;
  }

  if (hs.finger) {
    const tip = FINGER_TIP[hs.finger];
    const mx = (lm[THUMB_TIP].x + lm[tip].x) / 2;
    const my = (lm[THUMB_TIP].y + lm[tip].y) / 2;
    const [sx, sy] = toScreen(mx, my);

    if (hs.x === null) {
      hs.x = sx;
      hs.y = sy;
    } else {
      // A big jump (hand came back after tracking loss): don't draw a streak.
      if (dist(sx, sy, hs.x, hs.y) > Math.min(W, H) * 0.35) hs.lastX = null;
      hs.x += (sx - hs.x) * SMOOTHING;
      hs.y += (sy - hs.y) * SMOOTHING;
    }
    drawTrail(hs, label);
  }
}

function loseHand(label) {
  const hs = hands[label];
  hs.missing++;
  // Short tracking drop-outs keep the pinch alive; long ones release it.
  // Flowers already drawn always stay.
  if (hs.missing > GRACE_FRAMES && hs.finger) endPinch(hs);
}

function endPinch(hs) {
  hs.finger = null;
  hs.stroke = null;
  hs.x = null;
  hs.lastX = null;
}

// Place flowers along the path so moving a finger makes a smooth trail.
function drawTrail(hs, label) {
  const spacing = flowerBaseSize() * 0.6;

  if (hs.lastX === null) {
    placeFlower(hs, label, hs.x, hs.y);
    hs.lastX = hs.x;
    hs.lastY = hs.y;
    return;
  }

  let d = dist(hs.x, hs.y, hs.lastX, hs.lastY);
  let count = 0;
  while (d >= spacing && count < 6) {
    const t = spacing / d;
    hs.lastX += (hs.x - hs.lastX) * t;
    hs.lastY += (hs.y - hs.lastY) * t;
    placeFlower(hs, label, hs.lastX, hs.lastY);
    d = dist(hs.x, hs.y, hs.lastX, hs.lastY);
    count++;
  }
  if (count === 6 && d >= spacing) {
    hs.lastX = hs.x;
    hs.lastY = hs.y;
  }
}

/* =====================================================================
   RENDERING
   ===================================================================== */
// All stems are drawn as ONE path, so it stays fast with many flowers.
function drawStems(c, now) {
  c.save();
  c.strokeStyle = STEM_COLOR;
  c.lineWidth = STEM_WIDTH;
  c.lineCap = 'round';
  c.beginPath();
  for (const stroke of strokes) {
    for (const f of stroke.flowers) {
      const sway = Math.sin(now * 0.0015 + f.phase) * 6;
      const sx = f.bx;
      const sy = H + 4;
      const cx = (f.bx + f.x) / 2 + f.bend + sway;
      const cy = sy + (f.y - sy) * 0.55;
      const t = Math.min(1, (now - f.born) / STEM_GROW_MS);
      c.moveTo(sx, sy);
      if (t >= 1) {
        c.quadraticCurveTo(cx, cy, f.x, f.y);
      } else {
        // still growing: draw only the first part of the curve
        const e = 1 - Math.pow(1 - t, 3);
        const steps = 12;
        for (let i = 1; i <= steps; i++) {
          const u = (i / steps) * e;
          const a = (1 - u) * (1 - u);
          const b = 2 * (1 - u) * u;
          const d = u * u;
          c.lineTo(a * sx + b * cx + d * f.x, a * sy + b * cy + d * f.y);
        }
      }
    }
  }
  c.stroke();
  c.restore();
}

function drawScene(c, now) {
  if (SHOW_STEMS) drawStems(c, now); // stems first, flowers on top
  for (const stroke of strokes) {
    for (const f of stroke.flowers) drawFlower(c, f, now);
  }
  for (const b of butterflies) drawButterfly(c, b);
}

// A soft ring at each pinch point (live view only, not saved).
function drawCursors() {
  for (const label of ['Left', 'Right']) {
    const hs = hands[label];
    if (!hs.finger || hs.x === null) continue;
    ctx.save();
    ctx.beginPath();
    ctx.arc(hs.x, hs.y, flowerBaseSize() * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 209, 232, 0.18)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.stroke();
    ctx.restore();
  }
}

let lastFrameTime = performance.now();
function loop(now) {
  requestAnimationFrame(loop);

  // Keep sizes right if the camera rotates / changes resolution.
  if (video.videoWidth && (video.videoWidth !== vw || video.videoHeight !== vh)) {
    setVideoSize();
  }

  // Only run the (heavier) hand detection when a new video frame arrives.
  if (handLandmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    try {
      detect(now);
    } catch (err) {
      console.error('Hand detection error:', err);
    }
  }

  const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
  lastFrameTime = now;
  updateButterflies(dt);

  ctx.clearRect(0, 0, W, H);
  drawScene(ctx, now);
  drawCursors();
}

/* =====================================================================
   BUTTONS: undo / redo / clear / save
   ===================================================================== */
function updateButtons() {
  undoBtn.disabled = strokes.length === 0 && !clearedBackup;
  redoBtn.disabled = redoStack.length === 0;
}

function detachStroke(stroke) {
  // If a hand is still drawing this stroke, let it start a fresh one.
  for (const label of ['Left', 'Right']) {
    if (hands[label].stroke === stroke) hands[label].stroke = null;
  }
}

function undo() {
  if (strokes.length) {
    const s = strokes.pop();
    redoStack.push(s);
    detachStroke(s);
  } else if (clearedBackup) {
    strokes = clearedBackup;
    clearedBackup = null;
  }
  updateButtons();
}

function redo() {
  if (!redoStack.length) return;
  strokes.push(redoStack.pop());
  updateButtons();
}

function clearAll() {
  if (strokes.length) clearedBackup = strokes;
  strokes.forEach(detachStroke);
  strokes = [];
  redoStack = [];
  butterflies = [];
  placements = 0;
  nextButterflyAt = randInt(3, 4);
  updateButtons();
}

function savePhoto() {
  if (!vw || !vh) return;
  const out = document.createElement('canvas');
  out.width = Math.round(W * dpr);
  out.height = Math.round(H * dpr);
  const c = out.getContext('2d');
  c.scale(dpr, dpr);

  // 1) the mirrored camera picture, cropped the same way as on screen
  const { s, ox, oy } = coverMetrics();
  c.save();
  c.translate(W, 0);
  c.scale(-1, 1);
  c.drawImage(video, -ox, -oy, vw * s, vh * s);
  c.restore();

  // 2) all visible flowers and butterflies on top
  drawScene(c, performance.now());

  out.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `floralcanvas-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }, 'image/png');

  flashEl.classList.remove('go');
  void flashEl.offsetWidth; // restart the animation
  flashEl.classList.add('go');
}

undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);
clearBtn.addEventListener('click', clearAll);
saveBtn.addEventListener('click', savePhoto);

/* =====================================================================
   START-UP
   ===================================================================== */
function setStatus(text, keep = false) {
  statusEl.textContent = text;
  statusEl.classList.remove('hidden');
  if (!keep) {
    setTimeout(() => statusEl.classList.add('hidden'), 0);
  }
}

function setVideoSize() {
  vw = video.videoWidth;
  vh = video.videoHeight;
  mirror.width = Math.min(vw, 640);
  mirror.height = Math.round((mirror.width * vh) / vw);
}

async function init() {
  resize();
  updateButtons();

  // 1) Camera
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
  } catch (err) {
    console.error(err);
    setStatus('Please allow camera access, then reload', true);
    return;
  }
  setVideoSize();

  // 2) Hand tracker (model files are downloaded from the internet once)
  try {
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
    );
    const options = (delegate) => ({
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
        delegate,
      },
      runningMode: 'VIDEO',
      numHands: 2, // track both hands at the same time
      // Lower values keep tracking a hand that is partly out of frame
      // (like when you draw near the bottom edge).
      minHandDetectionConfidence: 0.4,
      minHandPresenceConfidence: 0.3,
      minTrackingConfidence: 0.3,
    });
    try {
      handLandmarker = await HandLandmarker.createFromOptions(vision, options('GPU'));
    } catch (gpuErr) {
      console.warn('GPU not available, using CPU instead.', gpuErr);
      handLandmarker = await HandLandmarker.createFromOptions(vision, options('CPU'));
    }
  } catch (err) {
    console.error(err);
    setStatus('Could not load hand tracking. Check your internet', true);
    return;
  }

  // 3) Ready!
  statusEl.classList.add('hidden');
  hintEl.classList.remove('hidden');
  setTimeout(() => hintEl.classList.add('hidden'), 9000);
  requestAnimationFrame(loop);
}

init();
