/* WayinStudio — audio decoding, resampling, waveform peaks and silence-aware chunking. */

export const SAMPLE_RATE = 16000;

/** Decode any media file to a mono Float32Array at 16 kHz (what Whisper expects). */
export async function decodeAudio(file, onProgress = () => {}) {
  const buf = await file.arrayBuffer();
  onProgress(.25, 'Decoding container…');
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(buf.slice(0));
  } finally {
    ctx.close();
  }
  onProgress(.6, 'Resampling to 16 kHz…');
  const frames = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE));
  const off = new OfflineAudioContext(1, frames, SAMPLE_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  // down-mix to mono
  if (decoded.numberOfChannels > 1) {
    const merger = off.createGain();
    src.connect(merger); merger.connect(off.destination);
  } else {
    src.connect(off.destination);
  }
  src.start();
  const rendered = await off.startRendering();
  onProgress(1, 'Audio ready');
  return { pcm: rendered.getChannelData(0), duration: decoded.duration, sampleRate: SAMPLE_RATE };
}

/** Peak envelope for the timeline waveform. */
export function peaks(pcm, buckets = 1200) {
  const out = new Float32Array(buckets);
  const step = pcm.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * step), e = Math.min(pcm.length, Math.floor((b + 1) * step));
    let peak = 0;
    for (let i = s; i < e; i += 2) { const v = Math.abs(pcm[i]); if (v > peak) peak = v; }
    out[b] = peak;
  }
  const max = out.reduce((a, v) => Math.max(a, v), 0) || 1;
  for (let i = 0; i < buckets; i++) out[i] /= max;
  return out;
}

/** Per-window RMS in dB-ish scale, used for silence detection. */
function rmsWindows(pcm, win) {
  const n = Math.floor(pcm.length / win);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = i * win; k < (i + 1) * win; k++) s += pcm[k] * pcm[k];
    out[i] = Math.sqrt(s / win);
  }
  return out;
}

/**
 * Split audio into ≤ maxLen chunks, cutting at the quietest point inside a
 * search window so words are not sliced in half. Returns [{start,end,pcm}].
 */
export function chunkAudio(pcm, { maxLen = 28, minLen = 20 } = {}) {
  const total = pcm.length / SAMPLE_RATE;
  if (total <= maxLen) return [{ start: 0, end: total, pcm }];
  const win = Math.floor(SAMPLE_RATE * 0.05);           // 50 ms
  const rms = rmsWindows(pcm, win);
  const chunks = [];
  let cursor = 0;
  while (cursor < pcm.length) {
    const remain = (pcm.length - cursor) / SAMPLE_RATE;
    if (remain <= maxLen) { chunks.push(slice(pcm, cursor, pcm.length)); break; }
    const lo = cursor + minLen * SAMPLE_RATE;
    const hi = Math.min(pcm.length, cursor + maxLen * SAMPLE_RATE);
    let bestIdx = hi, best = Infinity;
    for (let s = lo; s < hi; s += win) {
      const w = Math.floor(s / win);
      const v = (rms[w] ?? 1) + (rms[w + 1] ?? 1) * .5;
      if (v < best) { best = v; bestIdx = s; }
    }
    chunks.push(slice(pcm, cursor, bestIdx));
    cursor = bestIdx;
  }
  return chunks;
  function slice(p, a, b) {
    return { start: a / SAMPLE_RATE, end: b / SAMPLE_RATE, pcm: p.slice(a, b) };
  }
}

/** Speech-activity ratio, reported in the stats panel. */
export function speechRatio(pcm) {
  const win = Math.floor(SAMPLE_RATE * .05);
  const rms = rmsWindows(pcm, win);
  const sorted = Float32Array.from(rms).sort();
  const noise = sorted[Math.floor(sorted.length * .2)] || 0.001;
  const thr = Math.max(noise * 3, 0.006);
  let active = 0;
  for (const v of rms) if (v > thr) active++;
  return rms.length ? active / rms.length : 0;
}

export const fmtTime = (t, withMs = false) => {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = Math.floor(t % 60);
  const base = (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(s).padStart(2, '0');
  return withMs ? base + '.' + String(Math.floor((t % 1) * 100)).padStart(2, '0') : base;
};

export const fmtBytes = b => {
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return b.toFixed(b < 10 && i ? 1 : 0) + ' ' + u[i];
};
