/* WayinStudio — subtitle/text exports, transcript import and real clip rendering. */

const pad = (n, l = 2) => String(Math.floor(n)).padStart(l, '0');
export function stamp(t, sep = ',') {
  t = Math.max(0, t || 0);
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms, 3)}`;
}

const shift = (segs, offset = 0) => segs.map(s => ({ ...s, start: s.start - offset, end: s.end - offset }));
const plain = s => s.text;

/** Text pickers for subtitle exports. */
export const original = plain;
export const translated = lang => s => (s.tr && s.tr[lang]) || s.text;
export const bilingual = (lang, translationFirst = true) => s => {
  const t = s.tr && s.tr[lang];
  if (!t) return s.text;
  return translationFirst ? `${t}\n${s.text}` : `${s.text}\n${t}`;
};

export function toSRT(segments, offset = 0, textOf = plain) {
  return shift(segments, offset).filter(s => s.end > 0).map((s, i) =>
    `${i + 1}\n${stamp(s.start)} --> ${stamp(s.end)}\n${String(textOf(s)).trim()}\n`).join('\n');
}
export function toVTT(segments, offset = 0, textOf = plain) {
  return 'WEBVTT\n\n' + shift(segments, offset).filter(s => s.end > 0).map((s, i) =>
    `${i + 1}\n${stamp(s.start, '.')} --> ${stamp(s.end, '.')}\n${String(textOf(s)).trim()}\n`).join('\n');
}
export function toTXT(segments) {
  return segments.map(s => `[${stamp(s.start).slice(0, 8)}] ${s.text.trim()}`).join('\n');
}
export function toCSV(clips) {
  const rows = [['#', 'title', 'start', 'end', 'duration_s', 'score', 'reason', 'tags', 'text']];
  clips.forEach(c => rows.push([c.index, c.title, stamp(c.start), stamp(c.end), c.dur.toFixed(2), c.score, c.reason, (c.tags || []).join(' '), c.text]));
  return rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
}
export function toMarkdown(project) {
  const { name, summary, clips, segments } = project;
  const L = [`# ${name || 'Video summary'}`, ''];
  if (summary?.abstract) L.push('## Overview', '', summary.abstract, '');
  if (summary?.keywords?.length) L.push('**Topics:** ' + summary.keywords.join(', '), '');
  if (summary?.outline?.length) {
    L.push('## Outline', '');
    for (const o of summary.outline) L.push(`- **${stamp(o.start).slice(0, 8)} — ${o.title}**  \n  ${o.text}`);
    L.push('');
  }
  if (clips?.length) {
    L.push('## Suggested clips', '');
    for (const c of clips) L.push(`### ${c.index}. ${c.title}\n\`${stamp(c.start).slice(0, 8)} → ${stamp(c.end).slice(0, 8)}\` · ${Math.round(c.dur)}s · score ${c.score} · _${c.reason}_\n\n> ${c.text}\n`);
  }
  L.push(`---`, `${segments?.length || 0} transcript segments.`);
  return L.join('\n');
}
export const toJSON = project => JSON.stringify(project, null, 2);

/* ── import ──────────────────────────────────────────────────────────── */
const toSec = ts => {
  const m = ts.trim().replace(',', '.').match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
};

export function parseTranscript(text, filename = '') {
  const trimmed = text.trim();
  if (filename.endsWith('.json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const data = JSON.parse(trimmed);
    const segs = Array.isArray(data) ? data : (data.segments || data.transcript || []);
    return segs.map((s, i) => ({
      id: i, start: +(s.start ?? s.from ?? 0), end: +(s.end ?? s.to ?? 0),
      text: String(s.text ?? s.content ?? '').trim(), words: s.words
    })).filter(s => s.text);
  }
  const blocks = trimmed.replace(/^WEBVTT.*?\n/s, '').split(/\r?\n\s*\r?\n/);
  const out = [];
  for (const b of blocks) {
    const lines = b.split(/\r?\n/).filter(Boolean);
    const tIdx = lines.findIndex(l => l.includes('-->'));
    if (tIdx === -1) continue;
    const [a, z] = lines[tIdx].split('-->');
    const text = lines.slice(tIdx + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!text) continue;
    out.push({ id: out.length, start: toSec(a), end: toSec(z), text });
  }
  if (!out.length) {   // plain text fallback: 4s per line
    return trimmed.split(/\r?\n/).filter(Boolean).map((line, i) => ({ id: i, start: i * 4, end: i * 4 + 4, text: line.trim() }));
  }
  return out;
}

/* ── downloads ───────────────────────────────────────────────────────── */
export function download(content, filename, mime = 'text/plain;charset=utf-8') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ── clip rendering (canvas + WebAudio → MediaRecorder) ──────────────── */
const audioGraphs = new WeakMap();
function audioStream(video) {
  let g = audioGraphs.get(video);
  if (!g) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaElementSource(video);
    const dest = ctx.createMediaStreamDestination();
    src.connect(ctx.destination);
    src.connect(dest);
    g = { ctx, dest };
    audioGraphs.set(video, g);
  }
  if (g.ctx.state === 'suspended') g.ctx.resume();
  return g;
}
/** Must be called once from a user gesture so autoplay policies don't block audio. */
export function primeAudio(video) { try { audioStream(video); } catch { /* no audio track */ } }

function pickMime() {
  for (const m of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', '']) {
    if (!m || (window.MediaRecorder && MediaRecorder.isTypeSupported(m))) return m;
  }
  return '';
}

export async function renderClip({ video, renderer, start, end, ratio, height, captions = true, fps = 30, onProgress = () => {} }) {
  if (!window.MediaRecorder) throw new Error('MediaRecorder is not supported in this browser');
  const { width: W, height: H } = renderer.dimensions(ratio, height);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });

  const stream = canvas.captureStream(fps);
  try {
    const { dest } = audioStream(video);
    dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
  } catch { /* video without audio track */ }

  const rec = new MediaRecorder(stream, { mimeType: pickMime(), videoBitsPerSecond: H >= 1080 ? 8e6 : 5e6 });
  const parts = [];
  rec.ondataavailable = e => e.data.size && parts.push(e.data);

  const wasPaused = video.paused, wasTime = video.currentTime, wasRate = video.playbackRate;
  video.playbackRate = 1;
  await seek(video, start);

  return new Promise((resolve, reject) => {
    let raf = 0;
    rec.onstop = () => {
      cancelAnimationFrame(raf);
      video.pause();
      video.playbackRate = wasRate;
      video.currentTime = wasTime;
      if (wasPaused) video.pause();
      resolve(new Blob(parts, { type: rec.mimeType || 'video/webm' }));
    };
    rec.onerror = e => { cancelAnimationFrame(raf); reject(e.error || new Error('Recording failed')); };

    const tick = () => {
      const t = video.currentTime;
      renderer.draw(ctx, W, H, t, { captions });
      onProgress(Math.min(1, (t - start) / Math.max(.1, end - start)));
      if (t >= end - .02 || video.ended) { rec.stop(); return; }
      raf = requestAnimationFrame(tick);
    };
    rec.start(250);
    video.play().then(tick).catch(err => { rec.stop(); reject(err); });
  });
}

export function seek(video, t) {
  return new Promise(res => {
    if (Math.abs(video.currentTime - t) < .02) return res();
    const done = () => { video.removeEventListener('seeked', done); res(); };
    video.addEventListener('seeked', done);
    video.currentTime = Math.max(0, t);
    setTimeout(done, 2500);
  });
}
