/* WayinStudio — auto-reframe: find the subject, then hold the crop still.
   Samples frames off the decoded video, scores each column of the frame for
   skin tone, edge energy and motion, and emits a small set of keyframes.
   The goal is a crop that sits still and cuts to a new position, never a
   camera that drifts — viewers do not notice good reframing, only bad. */

const W = 160, H = 90;

export async function analyzeReframe(video, { onProgress = () => {}, shouldStop = () => false } = {}) {
  const duration = video.duration;
  if (!isFinite(duration) || !duration || !video.videoWidth) {
    return { keyframes: [{ t: 0, x: .5 }], samples: [], confidence: 0 };
  }
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const interval = Math.min(4, Math.max(.8, duration / 150));
  const wasTime = video.currentTime, wasMuted = video.muted, wasPaused = video.paused;
  video.pause(); video.muted = true;

  const samples = [];
  let prevLuma = null;
  try {
    for (let t = 0; t < duration - .05; t += interval) {
      if (shouldStop()) break;
      await seekFrame(video, t);
      ctx.drawImage(video, 0, 0, W, H);
      const { data } = ctx.getImageData(0, 0, W, H);
      const { cols, luma } = columnScores(data, prevLuma);
      prevLuma = luma;
      samples.push({ t, ...centroid(cols) });
      onProgress(Math.min(1, t / duration));
    }
  } finally {
    video.muted = wasMuted;
    video.currentTime = wasTime;
    if (!wasPaused) video.play().catch(() => {});
  }
  onProgress(1);
  return { ...toKeyframes(samples), samples };
}

/** Per-column subject score: skin pixels + local contrast + motion. */
function columnScores(data, prevLuma) {
  const cols = new Float32Array(W);
  const luma = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const l = (r * .299 + g * .587 + b * .114);
      luma[y * W + x] = l;

      // skin-tone heuristic — the cheapest reliable "there is a face here" signal
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const skin = (r > 90 && g > 38 && b > 18 && mx - mn > 14 && r > g + 12 && r > b) ? 1 : 0;

      // local contrast against the pixel to the left (edge energy)
      const edge = x ? Math.min(Math.abs(l - luma[y * W + x - 1]) / 48, 1) : 0;

      const motion = prevLuma ? Math.min(Math.abs(l - prevLuma[y * W + x]) / 40, 1) : 0;

      // faces sit in the upper-middle of a frame far more often than the edges
      const yWeight = 1 - Math.abs((y / H) - .42) * .9;
      cols[x] += (skin * 2.6 + edge * .5 + motion * .9) * Math.max(.15, yWeight);
    }
  }
  return { cols, luma };
}

function centroid(cols) {
  // soften, then sharpen: blur removes speckle, the power keeps the peak dominant
  const sm = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let k = -6; k <= 6; k++) { const i = x + k; if (i >= 0 && i < W) { s += cols[i]; n++; } }
    sm[x] = s / n;
  }
  let total = 0, acc = 0, peak = 0;
  for (let x = 0; x < W; x++) {
    const w = Math.pow(sm[x], 2);
    total += w; acc += w * x;
    if (sm[x] > peak) peak = sm[x];
  }
  if (!total) return { x: .5, score: 0 };
  const mean = sm.reduce((a, v) => a + v, 0) / W;
  return { x: (acc / total) / (W - 1), score: mean ? Math.min(peak / mean / 3, 1) : 0 };
}

/** Median filter, then emit a keyframe only when the subject really moved. */
function toKeyframes(samples, { move = .085, confirm = 2, snap = .5 } = {}) {
  if (!samples.length) return { keyframes: [{ t: 0, x: .5 }], confidence: 0 };
  const xs = samples.map(s => s.x);
  const med = xs.map((_, i) => {
    const w = [xs[i - 1] ?? xs[i], xs[i], xs[i + 1] ?? xs[i]].sort((a, b) => a - b);
    return w[1];
  });
  const conf = samples.reduce((a, s) => a + s.score, 0) / samples.length;

  const keyframes = [];
  let cur = med[0], pending = 0, pendingX = cur;
  keyframes.push({ t: 0, x: clamp01(cur) });
  for (let i = 1; i < med.length; i++) {
    const x = samples[i].score < .12 ? snap : med[i];   // low confidence → recentre
    if (Math.abs(x - cur) > move) {
      pending++; pendingX = (pendingX * (pending - 1) + x) / pending;
      if (pending >= confirm) {
        cur = pendingX; pending = 0; pendingX = cur;
        keyframes.push({ t: samples[i].t, x: clamp01(cur) });
      }
    } else { pending = 0; pendingX = cur; }
  }
  return { keyframes, confidence: conf };
}
const clamp01 = v => Math.max(0, Math.min(1, v));

/** Seek and wait until a decoded frame for that position is really on screen. */
export function seekFrame(video, t) {
  return new Promise(res => {
    let done = false;
    const finish = () => { if (done) return; done = true; video.removeEventListener('seeked', onSeek); res(); };
    const onSeek = () => {
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => finish());
      else requestAnimationFrame(() => finish());
    };
    video.addEventListener('seeked', onSeek);
    video.currentTime = Math.min(t, Math.max(0, (video.duration || t) - .05));
    setTimeout(finish, 900);
  });
}
