/* WayinStudio — application shell: state, player, timeline, panels, exports. */
import { decodeAudio, peaks, speechRatio, fmtTime, fmtBytes } from './media.js';
import { Transcriber } from './transcriber.js';
import { Renderer, defaultCaptionStyle } from './renderer.js';
import { summarize, autoClips, searchMoments, chapters, keywords, highlight, escapeHTML, isRTL } from './nlp.js';
import { demoProject, demoPeaks } from './demo.js';
import * as X from './exporters.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const video = $('#video');
const stage = $('#stage-canvas');
const sctx = stage.getContext('2d', { alpha: false });
const tl = $('#timeline');
const tctx = tl.getContext('2d');

const renderer = new Renderer(video);
const transcriber = new Transcriber();

const S = {
  file: null, url: null, name: '', duration: 0,
  pcm: null, peaks: null, speech: 0,
  segments: [], words: [], clips: [], chapters: [], summary: null,
  hits: [], query: '', activeClip: null,
  synthetic: false, busy: false,
  vtime: 0, vplaying: false, lastTick: 0,
  loopClip: false, activeSegId: -1
};

/* ── small helpers ───────────────────────────────────────────────────── */
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toast').append(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3200);
  setTimeout(() => el.remove(), 3600);
}
const status = m => { $('#status-line').textContent = m; };
const progress = p => { $('#progress-bar').style.width = Math.round(p * 100) + '%'; };
function step(name, state, note = '') {
  const li = $(`.steps li[data-step="${name}"]`);
  if (!li) return;
  li.classList.remove('run', 'done', 'err');
  if (state) li.classList.add(state);
  li.querySelector('em').textContent = note;
}
function resetSteps() { ['decode', 'model', 'asr', 'nlp'].forEach(s => step(s, '', '')); progress(0); }

/* ── time & playback (real video or synthetic demo clock) ────────────── */
const now = () => S.synthetic ? S.vtime : (video.currentTime || 0);
const isPlaying = () => S.synthetic ? S.vplaying : !video.paused;

function seekTo(t) {
  t = Math.max(0, Math.min(S.duration || 0, t));
  if (S.synthetic) S.vtime = t; else video.currentTime = t;
  paint();
}
function play() {
  if (!S.duration) return;
  if (S.synthetic) { S.vplaying = true; S.lastTick = performance.now(); }
  else video.play().catch(() => {});
  $('#btn-play').textContent = '❚❚';
}
function pause() {
  if (S.synthetic) S.vplaying = false; else video.pause();
  $('#btn-play').textContent = '▶';
}
const toggle = () => isPlaying() ? pause() : play();

/* ── media loading ───────────────────────────────────────────────────── */
async function loadFile(file) {
  if (!file) return;
  if (S.url) URL.revokeObjectURL(S.url);
  Object.assign(S, {
    file, name: file.name, url: URL.createObjectURL(file), synthetic: false,
    segments: [], words: [], clips: [], summary: null, chapters: [], hits: [],
    pcm: null, peaks: null, activeClip: null, vtime: 0
  });
  video.src = S.url;
  video.muted = false;
  $('#proj-name').textContent = file.name;
  $('#viewport-empty').hidden = true;
  $('#btn-analyze').disabled = false;
  resetSteps();
  status('Media loaded. Press “Analyze video” to transcribe on-device.');
  renderAll();

  await new Promise(res => {
    const on = () => { video.removeEventListener('loadedmetadata', on); res(); };
    video.addEventListener('loadedmetadata', on);
    setTimeout(res, 6000);
  });
  S.duration = isFinite(video.duration) ? video.duration : 0;
  $('#media-meta').hidden = false;
  $('#m-dur').textContent = fmtTime(S.duration);
  $('#m-res').textContent = video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : 'audio only';
  $('#m-size').textContent = fmtBytes(file.size);
  $('#m-type').textContent = (file.type || '—').replace(/^\w+\//, '');
  $('#t-dur').textContent = fmtTime(S.duration);
  sizeStage();
  paint();
  drawTimeline();
}

function loadDemo() {
  const d = demoProject();
  if (S.url) { URL.revokeObjectURL(S.url); S.url = null; }
  video.removeAttribute('src'); video.load();
  Object.assign(S, {
    file: null, name: d.name, synthetic: true, duration: d.duration,
    segments: d.segments, words: [], hits: [], activeClip: null, vtime: 0,
    pcm: null, peaks: demoPeaks(d.segments, d.duration), speech: .78
  });
  $('#proj-name').textContent = d.name;
  $('#viewport-empty').hidden = true;
  $('#btn-analyze').disabled = true;
  $('#media-meta').hidden = false;
  $('#m-dur').textContent = fmtTime(d.duration);
  $('#m-res').textContent = '1080×1920 (slate)';
  $('#m-size').textContent = '—';
  $('#m-type').textContent = 'demo';
  $('#t-dur').textContent = fmtTime(d.duration);
  resetSteps(); ['decode', 'model', 'asr'].forEach(s => step(s, 'done', 'demo'));
  runNLP();
  step('nlp', 'done', `${S.clips.length} clips`); progress(1);
  sizeStage(); paint(); drawTimeline();
  status('Demo project loaded — transcript, clips, summary and captions are all live.');
  toast('Demo project loaded', 'ok');
}

/* ── analysis pipeline ───────────────────────────────────────────────── */
async function analyze() {
  if (!S.file || S.busy) return;
  S.busy = true;
  $('#btn-analyze').disabled = true;
  $('#btn-cancel').hidden = false;
  resetSteps();
  const t0 = performance.now();

  try {
    step('decode', 'run');
    status('Decoding audio…');
    const { pcm, duration } = await decodeAudio(S.file, (p, m) => { progress(p * .12); status(m); });
    S.pcm = pcm;
    S.peaks = peaks(pcm);
    S.speech = speechRatio(pcm);
    if (!S.duration) S.duration = duration;
    step('decode', 'done', fmtTime(duration));
    drawTimeline();

    step('model', 'run');
    const size = $('#sel-model').value;
    const language = $('#sel-lang').value;
    const translate = $('#chk-translate').checked;

    const res = await transcriber.run(pcm, { size, language, translate }, ev => {
      if (ev.kind === 'model') {
        if (ev.stage === 'download') {
          progress(.12 + ev.progress * .18);
          status(`Downloading model — ${ev.file || ''} ${Math.round(ev.progress * 100)}%`);
          step('model', 'run', Math.round(ev.progress * 100) + '%');
        } else if (ev.stage === 'loading') {
          status(`Loading ${ev.model} on ${ev.device}…`);
          $('#engine-pill').textContent = 'engine: ' + ev.device;
          $('#engine-pill').classList.add('on');
        } else if (ev.stage === 'ready') {
          step('model', 'done', ev.device);
          step('asr', 'run');
          status('Transcribing…');
        }
      } else if (ev.kind === 'chunk') {
        const done = (ev.index + 1) / ev.count;
        progress(.3 + done * .6);
        step('asr', 'run', `${ev.index + 1}/${ev.count}`);
        status(`Transcribing chunk ${ev.index + 1} of ${ev.count} — ${ev.words} words so far`);
      }
    });

    S.words = res.words;
    S.segments = res.segments;
    step('asr', 'done', `${res.words.length} words`);
    $('#engine-pill').textContent = 'engine: ' + res.device;

    step('nlp', 'run');
    progress(.94);
    runNLP();
    step('nlp', 'done', ((performance.now() - t0) / 1000).toFixed(1) + 's');
    progress(1);
    status(`Done in ${((performance.now() - t0) / 1000).toFixed(1)}s — ${S.segments.length} segments, ${S.clips.length} clips.`);
    toast('Analysis complete', 'ok');
  } catch (err) {
    if (err.cancelled) { status('Cancelled.'); step('asr', '', ''); }
    else {
      console.error(err);
      ['decode', 'model', 'asr', 'nlp'].forEach(s => { if ($(`.steps li[data-step="${s}"]`).classList.contains('run')) step(s, 'err'); });
      status('Failed: ' + err.message);
      toast('Analysis failed — ' + err.message, 'err');
    }
  } finally {
    S.busy = false;
    $('#btn-cancel').hidden = true;
    $('#btn-analyze').disabled = !S.file;
  }
}

function runNLP() {
  if (!S.segments.length) return;
  renderer.setSegments(S.segments);
  S.summary = summarize(S.segments);
  S.chapters = chapters(S.segments, 7);
  S.clips = autoClips(S.segments, {
    target: +$('#sel-cliplen').value,
    count: +$('#num-clips').value
  });
  renderAll();
  drawTimeline();
}

function renderAll() {
  renderTranscript();
  renderClips();
  renderSummary();
  renderMoments();
  renderStats();
  fillClipSelect();
}

/* ── stats ───────────────────────────────────────────────────────────── */
function renderStats() {
  const words = S.segments.reduce((a, s) => a + s.text.split(/\s+/).filter(Boolean).length, 0);
  $('#s-seg').textContent = S.segments.length;
  $('#s-words').textContent = words.toLocaleString();
  $('#s-speech').textContent = Math.round((S.speech || 0) * 100) + '%';
  $('#s-clips').textContent = S.clips.length;
}

/* ── transcript ──────────────────────────────────────────────────────── */
function renderTranscript() {
  const box = $('#transcript-list');
  const q = $('#tr-filter').value.trim();
  const list = q ? S.segments.filter(s => s.text.toLowerCase().includes(q.toLowerCase())) : S.segments;
  if (!list.length) {
    box.innerHTML = `<div class="placeholder">${S.segments.length ? 'No segment matches that filter.' : 'No transcript yet. Analyze a video, import an SRT/VTT, or open the demo project.'}</div>`;
    return;
  }
  box.innerHTML = list.map(s =>
    `<div class="seg" data-t="${s.start}" data-id="${s.id}"${isRTL(s.text) ? ' dir="rtl"' : ''}>
       <time>${fmtTime(s.start)}</time><p>${q ? highlight(s.text, q) : escapeHTML(s.text)}</p>
     </div>`).join('');
}

/* ── clips ───────────────────────────────────────────────────────────── */
function renderClips() {
  const box = $('#clip-list');
  if (!S.clips.length) {
    box.innerHTML = `<div class="placeholder">Auto-clipping finds self-contained highlights using topic shifts, pacing and hook language.</div>`;
    return;
  }
  box.innerHTML = S.clips.map(c => `
    <article class="rescard" data-t="${c.start}" data-clip="${c.id}">
      <div class="rc-top">
        <span class="badge">#${c.index}</span>
        <h5>${escapeHTML(c.title)}</h5>
        <span class="badge ${c.score >= 70 ? 'hot' : 'score'}">${c.score}</span>
      </div>
      <p${isRTL(c.text) ? ' dir="rtl"' : ''}>${escapeHTML(c.text)}</p>
      <div class="rc-tags">
        <span>${fmtTime(c.start)} → ${fmtTime(c.end)}</span>
        <span>${Math.round(c.dur)}s</span>
        <span>${escapeHTML(c.reason)}</span>
        ${c.tags.map(t => `<span>#${escapeHTML(t)}</span>`).join('')}
      </div>
      <div class="rc-actions">
        <button class="btn small" data-act="play">▶ Play clip</button>
        <button class="btn small" data-act="srt">.srt</button>
        <button class="btn small" data-act="render">Render</button>
      </div>
    </article>`).join('');
}

function fillClipSelect() {
  const sel = $('#exp-clip');
  const opts = [`<option value="full">Full timeline (${fmtTime(S.duration)})</option>`]
    .concat(S.clips.map(c => `<option value="${c.id}">#${c.index} · ${fmtTime(c.start)}–${fmtTime(c.end)} · ${escapeHTML(c.title).slice(0, 40)}</option>`));
  sel.innerHTML = opts.join('');
  if (S.clips.length) sel.value = S.clips[0].id;
}

/* ── summary ─────────────────────────────────────────────────────────── */
function renderSummary() {
  const box = $('#summary-pane');
  if (!S.summary?.abstract) {
    box.innerHTML = `<div class="placeholder">A one-paragraph overview plus a timestamped outline appears here after analysis.</div>`;
    return;
  }
  box.innerHTML = `
    <div class="sum-abstract"${isRTL(S.summary.abstract) ? ' dir="rtl"' : ''}>${escapeHTML(S.summary.abstract)}</div>
    <div class="sum-h">Topics</div>
    <div class="chips">${S.summary.keywords.map(k => `<button class="chip" data-q="${escapeHTML(k)}">${escapeHTML(k)}</button>`).join('')}</div>
    <div class="sum-h">Outline</div>
    <ul class="outline">
      ${S.summary.outline.map(o => `<li data-t="${o.start}">
        <time>${fmtTime(o.start)}</time>
        <div><b>${escapeHTML(o.title)}</b><em>${escapeHTML(o.text)}</em></div>
      </li>`).join('')}
    </ul>`;
}

/* ── moment search ───────────────────────────────────────────────────── */
function renderMoments() {
  const chips = $('#moment-chips');
  chips.innerHTML = (S.summary?.keywords || keywords(S.segments, 8)).slice(0, 8)
    .map(k => `<button class="chip" data-q="${escapeHTML(k)}">${escapeHTML(k)}</button>`).join('');

  const box = $('#moment-list');
  if (!S.query) {
    box.innerHTML = `<div class="placeholder">Type a keyword or a question. Results are ranked across the whole transcript.</div>`;
    return;
  }
  if (!S.hits.length) {
    box.innerHTML = `<div class="placeholder">Nothing found for “${escapeHTML(S.query)}”.</div>`;
    return;
  }
  box.innerHTML = S.hits.map((h, i) => `
    <article class="rescard" data-t="${h.start}">
      <div class="rc-top">
        <span class="badge">${i + 1}</span>
        <h5>${fmtTime(h.start)} → ${fmtTime(h.end)}</h5>
        <span class="badge score">${h.confidence}%</span>
      </div>
      <p${isRTL(h.text) ? ' dir="rtl"' : ''}>${highlight(h.text, S.query)}</p>
    </article>`).join('');
}

function doSearch(q) {
  S.query = (q ?? $('#moment-q').value).trim();
  $('#moment-q').value = S.query;
  S.hits = S.query ? searchMoments(S.segments, S.query) : [];
  renderMoments();
  drawTimeline();
  if (S.query) status(`${S.hits.length} moment${S.hits.length === 1 ? '' : 's'} for “${S.query}”.`);
}

/* ── stage rendering ─────────────────────────────────────────────────── */
function sizeStage() {
  const { width, height } = renderer.dimensions(renderer.ratio, 720);
  if (stage.width !== width || stage.height !== height) { stage.width = width; stage.height = height; }
  const box = $('#viewport').getBoundingClientRect();
  const scale = Math.min((box.width - 20) / width, (box.height - 20) / height);
  stage.style.width = Math.max(40, width * scale) + 'px';
  stage.style.height = Math.max(40, height * scale) + 'px';
}

function paint() {
  const t = now();
  renderer.draw(sctx, stage.width, stage.height, t);
  $('#t-cur').textContent = fmtTime(t);
  syncActiveSegment(t);
}

function syncActiveSegment(t) {
  const seg = renderer.segmentAt(t);
  const id = seg ? seg.id : -1;
  if (id === S.activeSegId) return;
  S.activeSegId = id;
  $$('#transcript-list .seg.active').forEach(e => e.classList.remove('active'));
  if (id < 0) return;
  const row = $(`#transcript-list .seg[data-id="${id}"]`);
  if (!row) return;
  row.classList.add('active');
  if ($('#chk-follow').checked && $('.tab.active')?.dataset.tab === 'transcript') {
    const box = $('#transcript-list');
    const rb = row.getBoundingClientRect(), bb = box.getBoundingClientRect();
    if (rb.top < bb.top + 40 || rb.bottom > bb.bottom - 40) {
      box.scrollTop += rb.top - bb.top - box.clientHeight * .4;
    }
  }
}

function frame(ts) {
  if (S.synthetic && S.vplaying) {
    const dt = (ts - S.lastTick) / 1000;
    S.lastTick = ts;
    S.vtime += dt * (parseFloat($('#sel-speed').value) || 1);
    if (S.vtime >= S.duration) { S.vtime = S.duration; pause(); }
  } else if (S.synthetic) S.lastTick = ts;

  const t = now();
  const c = S.activeClip;
  if (c && t >= c.end - .02) {
    if (S.loopClip) seekTo(c.start);
    else { pause(); S.activeClip = null; }
  }
  if (S.duration && (isPlaying() || tlDirty)) { paint(); drawPlayhead(); }
  requestAnimationFrame(frame);
}

/* ── timeline ────────────────────────────────────────────────────────── */
let tlDirty = true;
function drawTimeline() { tlDirty = true; }

function paintTimeline() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = tl.clientWidth, h = tl.clientHeight;
  if (!w) return;
  if (tl.width !== w * dpr || tl.height !== h * dpr) { tl.width = w * dpr; tl.height = h * dpr; }
  tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  tctx.clearRect(0, 0, w, h);

  tctx.fillStyle = '#0b0e1a';
  tctx.fillRect(0, 0, w, h);
  if (!S.duration) {
    tctx.fillStyle = '#4a5170';
    tctx.font = '11px Inter, sans-serif';
    tctx.fillText('timeline', 10, h / 2);
    return;
  }
  const waveTop = 16, waveH = h - 30;

  // chapters
  for (const c of S.chapters) {
    const x = c.start / S.duration * w;
    tctx.fillStyle = 'rgba(34,211,238,.35)';
    tctx.fillRect(x, 0, 1, h);
  }
  // waveform
  const pk = S.peaks;
  if (pk) {
    tctx.fillStyle = '#3b4468';
    const n = pk.length;
    for (let x = 0; x < w; x++) {
      const i = Math.floor(x / w * n);
      const v = pk[i] || 0;
      const bh = Math.max(1, v * waveH);
      tctx.fillRect(x, waveTop + (waveH - bh) / 2, 1, bh);
    }
  } else {
    tctx.fillStyle = '#232a42';
    for (const s of S.segments) {
      const x = s.start / S.duration * w, x2 = s.end / S.duration * w;
      tctx.fillRect(x, waveTop + waveH * .3, Math.max(1, x2 - x), waveH * .4);
    }
  }
  // clips
  for (const c of S.clips) {
    const x = c.start / S.duration * w, cw = Math.max(2, (c.end - c.start) / S.duration * w);
    tctx.fillStyle = S.activeClip?.id === c.id ? 'rgba(109,94,252,.42)' : 'rgba(109,94,252,.22)';
    tctx.fillRect(x, waveTop, cw, waveH);
    tctx.fillStyle = '#8b7dff';
    tctx.fillRect(x, waveTop, 1.5, waveH);
    tctx.font = '600 9px Inter, sans-serif';
    tctx.fillStyle = '#b9b1ff';
    tctx.fillText('#' + c.index, x + 4, waveTop + 10);
  }
  // search hits
  for (const hh of S.hits) {
    const x = hh.start / S.duration * w;
    tctx.fillStyle = '#ffb020';
    tctx.fillRect(x - 1, h - 12, 3, 10);
  }
  // ruler
  tctx.fillStyle = '#5b6486';
  tctx.font = '9px JetBrains Mono, monospace';
  const stepSec = niceStep(S.duration, w);
  for (let t = 0; t <= S.duration; t += stepSec) {
    const x = t / S.duration * w;
    tctx.fillRect(x, 0, 1, 5);
    if (x < w - 26) tctx.fillText(fmtTime(t), x + 3, 10);
  }
  drawPlayhead(true);
}
function niceStep(dur, w) {
  const target = dur / (w / 90);
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return steps.find(s => s >= target) || 3600;
}

let phLayer = null;
function drawPlayhead(force) {
  if (!S.duration || !tl.clientWidth) return;
  if (tlDirty) { tlDirty = false; phLayer = null; paintTimeline(); return; }
  const w = tl.clientWidth, h = tl.clientHeight;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  if (!phLayer) {                                   // cache the static layer once
    phLayer = document.createElement('canvas');
    phLayer.width = tl.width; phLayer.height = tl.height;
    phLayer.getContext('2d').drawImage(tl, 0, 0);
    if (!force) return;
  }
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.drawImage(phLayer, 0, 0);
  tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const x = now() / S.duration * w;
  tctx.fillStyle = '#fff';
  tctx.fillRect(x - .5, 0, 1.5, h);
  tctx.beginPath(); tctx.arc(x, 4, 3.5, 0, 7); tctx.fill();
}

/* ── clip actions ────────────────────────────────────────────────────── */
function playClip(c) {
  S.activeClip = c;
  S.loopClip = $('#chk-loop').checked;
  seekTo(c.start);
  play();
  drawTimeline();
  status(`Playing clip #${c.index} — ${fmtTime(c.start)} → ${fmtTime(c.end)}`);
}
const clipById = id => S.clips.find(c => c.id === id);
const segmentsBetween = (a, b) => S.segments.filter(s => s.end > a && s.start < b);

async function doRender() {
  if (S.synthetic) { toast('Rendering needs a real video file — the demo has no frames.', 'err'); return; }
  if (!S.file) { toast('Load a video first', 'err'); return; }
  const sel = $('#exp-clip').value;
  const c = sel === 'full' ? { start: 0, end: S.duration, index: 0, title: S.name } : clipById(sel);
  if (!c) return;
  const ratio = $('#exp-ratio').value === 'current' ? renderer.ratio : $('#exp-ratio').value;
  const height = +$('#exp-height').value;
  const btn = $('#btn-render');
  btn.disabled = true;
  $('#rec-badge').hidden = false;
  pause();
  try {
    status('Rendering — playing the clip once in real time…');
    const blob = await X.renderClip({
      video, renderer, start: c.start, end: c.end, ratio, height,
      captions: $('#exp-captions').checked,
      onProgress: p => { progress(p); btn.textContent = `Rendering… ${Math.round(p * 100)}%`; }
    });
    X.download(blob, `${slug(S.name)}-clip${c.index || 'full'}-${ratio.replace(':', 'x')}.webm`);
    toast('Clip rendered', 'ok');
    status(`Rendered ${fmtBytes(blob.size)} — download started.`);
  } catch (e) {
    console.error(e);
    toast('Render failed — ' + e.message, 'err');
    status('Render failed: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Render & download .webm';
    $('#rec-badge').hidden = true; progress(0);
  }
}
const slug = s => (s || 'wayin').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'wayin';

function projectJSON() {
  return {
    name: S.name, duration: S.duration, generator: 'WayinStudio',
    createdAt: new Date().toISOString(),
    summary: S.summary, clips: S.clips, segments: S.segments
  };
}

function doExport(kind) {
  if (!S.segments.length && kind !== 'json') { toast('Nothing to export yet', 'err'); return; }
  const base = slug(S.name);
  const map = {
    srt: () => X.download(X.toSRT(S.segments), base + '.srt', 'application/x-subrip'),
    vtt: () => X.download(X.toVTT(S.segments), base + '.vtt', 'text/vtt'),
    txt: () => X.download(X.toTXT(S.segments), base + '.txt'),
    json: () => X.download(X.toJSON(projectJSON()), base + '.json', 'application/json'),
    md: () => X.download(X.toMarkdown({ name: S.name, ...projectJSON() }), base + '-summary.md', 'text/markdown'),
    csv: () => X.download(X.toCSV(S.clips), base + '-clips.csv', 'text/csv')
  };
  map[kind]?.();
  toast('Exported ' + kind.toUpperCase(), 'ok');
}

/* ── captions panel binding ──────────────────────────────────────────── */
function bindCaptions() {
  const st = renderer.style = defaultCaptionStyle();
  const sync = () => {
    st.template = $('#cap-template').value;
    st.position = $('#cap-pos').value;
    st.size = +$('#cap-size').value;
    st.wordsPerLine = +$('#cap-wpl').value;
    st.color = $('#cap-color').value;
    st.uppercase = $('#cap-upper').checked;
    st.karaoke = $('#cap-karaoke').checked;
    st.shadow = $('#cap-shadow').checked;
    $('#cap-size-v').textContent = (st.size / 10).toFixed(1) + '%';
    $('#cap-wpl-v').textContent = st.wordsPerLine;
    paint();
  };
  ['#cap-template', '#cap-pos', '#cap-size', '#cap-wpl', '#cap-color', '#cap-upper', '#cap-karaoke', '#cap-shadow']
    .forEach(sel => $(sel).addEventListener('input', sync));
  sync();
}

/* ── events ──────────────────────────────────────────────────────────── */
function bind() {
  // file input / dropzone
  $('#btn-pick').onclick = () => $('#file-input').click();
  $('#file-input').onchange = e => e.target.files[0] && loadFile(e.target.files[0]);
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('hover'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('hover'); }));
  drop.addEventListener('drop', e => e.dataTransfer.files[0] && loadFile(e.dataTransfer.files[0]));
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f && /^(video|audio)\//.test(f.type)) loadFile(f);
  });

  $('#btn-analyze').onclick = analyze;
  $('#btn-cancel').onclick = () => { transcriber.cancel(); status('Cancelling…'); };
  $('#btn-demo').onclick = loadDemo;
  $('#btn-demo-2').onclick = loadDemo;
  $('#btn-import-transcript').onclick = () => $('#transcript-input').click();
  $('#transcript-input').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const segs = X.parseTranscript(await f.text(), f.name);
      if (!segs.length) throw new Error('no cues found');
      S.segments = segs;
      if (!S.duration) { S.duration = segs.at(-1).end + 1; S.synthetic = !S.file; $('#viewport-empty').hidden = true; }
      if (!S.name) { S.name = f.name; $('#proj-name').textContent = f.name; }
      $('#t-dur').textContent = fmtTime(S.duration);
      runNLP();
      sizeStage(); paint();
      toast(`Imported ${segs.length} cues`, 'ok');
      status(`Imported ${segs.length} cues from ${f.name}.`);
    } catch (err) { toast('Could not parse that file — ' + err.message, 'err'); }
    e.target.value = '';
  };

  // transport
  $('#btn-play').onclick = () => { X.primeAudio(video); toggle(); };
  $('#btn-back').onclick = () => seekTo(now() - 5);
  $('#btn-fwd').onclick = () => seekTo(now() + 5);
  $('#sel-speed').value = '1';
  $('#sel-speed').onchange = e => { video.playbackRate = parseFloat(e.target.value) || 1; };
  $('#sel-ratio').onchange = e => { renderer.ratio = e.target.value; sizeStage(); paint(); };
  $('#rng-focus').oninput = e => { renderer.focus = e.target.value / 100; paint(); };
  $('#chk-captions').onchange = e => { renderer.showCaptions = e.target.checked; paint(); };
  $('#chk-loop').onchange = e => { S.loopClip = e.target.checked; };
  video.addEventListener('play', () => { $('#btn-play').textContent = '❚❚'; });
  video.addEventListener('pause', () => { $('#btn-play').textContent = '▶'; });
  video.addEventListener('ended', () => { $('#btn-play').textContent = '▶'; });

  // tabs
  $('#tabs').addEventListener('click', e => {
    const t = e.target.closest('.tab'); if (!t) return;
    $$('.tab').forEach(x => x.classList.toggle('active', x === t));
    $$('.tabpane').forEach(p => p.classList.toggle('active', p.dataset.pane === t.dataset.tab));
  });

  // panel interactions (delegated)
  document.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (chip?.dataset.q) {
      $$('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === 'search'));
      $$('.tabpane').forEach(p => p.classList.toggle('active', p.dataset.pane === 'search'));
      doSearch(chip.dataset.q);
      return;
    }
    const act = e.target.closest('[data-act]');
    if (act) {
      const card = act.closest('[data-clip]');
      const c = clipById(card?.dataset.clip);
      if (!c) return;
      e.stopPropagation();
      if (act.dataset.act === 'play') playClip(c);
      if (act.dataset.act === 'srt') X.download(X.toSRT(segmentsBetween(c.start, c.end), c.start), `${slug(S.name)}-clip${c.index}.srt`, 'application/x-subrip');
      if (act.dataset.act === 'render') {
        $$('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === 'export'));
        $$('.tabpane').forEach(p => p.classList.toggle('active', p.dataset.pane === 'export'));
        $('#exp-clip').value = c.id;
        doRender();
      }
      return;
    }
    const row = e.target.closest('[data-t]');
    if (row) {
      const clip = row.dataset.clip && clipById(row.dataset.clip);
      if (clip) playClip(clip);
      else { S.activeClip = null; seekTo(+row.dataset.t); play(); }
    }
  });

  $('#tr-filter').addEventListener('input', () => renderTranscript());
  $('#btn-moment').onclick = () => doSearch();
  $('#moment-q').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  $('#btn-reclip').onclick = () => {
    if (!S.segments.length) return toast('Nothing to clip yet', 'err');
    S.clips = autoClips(S.segments, { target: +$('#sel-cliplen').value, count: +$('#num-clips').value });
    renderClips(); fillClipSelect(); renderStats(); drawTimeline();
    toast(`${S.clips.length} clips`, 'ok');
  };
  $$('[data-export]').forEach(b => b.onclick = () => doExport(b.dataset.export));
  $('#btn-render').onclick = doRender;

  // timeline scrubbing
  let scrubbing = false;
  const scrub = e => {
    const r = tl.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, (e.clientX ?? e.touches?.[0]?.clientX) - r.left));
    S.activeClip = null;
    seekTo(x / r.width * S.duration);
  };
  tl.addEventListener('pointerdown', e => { scrubbing = true; tl.setPointerCapture(e.pointerId); scrub(e); });
  tl.addEventListener('pointermove', e => scrubbing && scrub(e));
  tl.addEventListener('pointerup', () => { scrubbing = false; });

  // keyboard
  document.addEventListener('keydown', e => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); X.primeAudio(video); toggle(); }
    else if (k === 'arrowleft') seekTo(now() - (e.shiftKey ? 10 : 5));
    else if (k === 'arrowright') seekTo(now() + (e.shiftKey ? 10 : 5));
    else if (k === 'j') seekTo(now() - 10);
    else if (k === 'l') seekTo(now() + 10);
    else if (k === 'k') toggle();
    else if (k === 'c') { const cb = $('#chk-captions'); cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
    else if (k === '/') { e.preventDefault(); $$('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === 'search')); $$('.tabpane').forEach(p => p.classList.toggle('active', p.dataset.pane === 'search')); $('#moment-q').focus(); }
  });

  addEventListener('resize', () => { sizeStage(); drawTimeline(); paint(); });
}

/* ── boot ────────────────────────────────────────────────────────────── */
bind();
bindCaptions();
sizeStage();
drawTimeline();
requestAnimationFrame(frame);
status('Idle — load a file to begin, or open the demo project.');
window.WayinStudio = { S, renderer, doSearch, loadDemo };
