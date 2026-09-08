/* WayinStudio — frame renderer: reframing (smart crop) + burned-in animated captions.
   The player preview and the exported file go through this exact code path. */
import { isRTL } from './nlp.js';

export const RATIOS = { '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '16:9': 16 / 9 };

const TEMPLATES = {
  pop:    { weight: 800, stroke: 0.14, box: null,                   glow: 0,  upperDefault: true,  color: '#fff' },
  clean:  { weight: 600, stroke: 0.04, box: 'rgba(8,9,14,.62)',     glow: 0,  upperDefault: false, color: '#fff' },
  neon:   { weight: 800, stroke: 0.05, box: null,                   glow: 22, upperDefault: true,  color: '#eafcff' },
  bar:    { weight: 600, stroke: 0,    box: 'rgba(0,0,0,.78)',      glow: 0,  upperDefault: false, color: '#fff', fullBar: true },
  ticker: { weight: 700, stroke: 0,    box: 'rgba(109,94,252,.92)', glow: 0,  upperDefault: true,  color: '#fff', single: true }
};

export const defaultCaptionStyle = () => ({
  template: 'pop', position: 'bottom', size: 60, wordsPerLine: 4,
  color: '#ffd60a', uppercase: false, karaoke: true, shadow: true
});

export class Renderer {
  constructor(video) {
    this.video = video;
    this.segments = [];
    this.ratio = 'source';
    this.focus = .5;
    this.style = defaultCaptionStyle();
    this.showCaptions = true;
    this.captionMode = 'original';   // 'original' | 'translated' | 'both'
    this.translationLang = null;     // key into seg.tr
    this.focusKeys = null;           // auto-reframe keyframes [{t, x}]
    this.focusMode = 'manual';       // 'manual' | 'auto'
  }

  setSegments(s) { this.segments = s || []; }

  /** Output pixel size for a given ratio and target height. */
  dimensions(ratio = this.ratio, height) {
    const vw = this.video.videoWidth || 1280, vh = this.video.videoHeight || 720;
    const ar = ratio === 'source' ? vw / vh : (RATIOS[ratio] || vw / vh);
    const H = Math.round(height || Math.min(vh || 720, 1080));
    const W = Math.round(H * ar / 2) * 2;
    return { width: W, height: (H % 2 ? H + 1 : H) };
  }

  segmentAt(t) {
    const s = this.segments;
    let lo = 0, hi = s.length - 1, found = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t < s[mid].start) hi = mid - 1;
      else if (t > s[mid].end) lo = mid + 1;
      else { found = s[mid]; break; }
    }
    if (found) return found;
    // tolerate small gaps between segments so captions do not flicker
    const prev = s[hi];
    return prev && t - prev.end < .35 ? prev : null;
  }

  draw(ctx, W, H, time = this.video.currentTime, { captions = this.showCaptions } = {}) {
    const v = this.video;
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    if (v.videoWidth && v.videoHeight) {
      const vw = v.videoWidth, vh = v.videoHeight, ar = W / H;
      let sw = vw, sh = vw / ar;
      if (sh > vh) { sh = vh; sw = vh * ar; }
      const sx = (vw - sw) * this.focusAt(time);
      const sy = (vh - sh) * .5;
      ctx.drawImage(v, sx, sy, sw, sh, 0, 0, W, H);
    } else {
      // No decoded frames (demo project / audio-only source): draw a slate so the
      // caption engine, reframing and timing are still fully previewable.
      const g = ctx.createLinearGradient(0, 0, W, H);
      const k = (Math.sin(time * .25) + 1) / 2;
      g.addColorStop(0, `hsl(${248 + k * 12} 45% 12%)`);
      g.addColorStop(1, `hsl(${190 + k * 20} 40% 7%)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.globalAlpha = .12;
      ctx.strokeStyle = '#9fb0ff';
      ctx.lineWidth = Math.max(1, H / 720);
      const gridN = 12;
      for (let i = 1; i < gridN; i++) {
        const x = W * i / gridN, y = H * i / gridN;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = .5;
      ctx.fillStyle = '#8ea0d8';
      ctx.textAlign = 'center';
      ctx.font = `600 ${Math.round(H * .028)}px Inter, system-ui, sans-serif`;
      ctx.fillText('NO VIDEO TRACK — CAPTION PREVIEW', W / 2, H * .12);
      ctx.restore();
      ctx.textAlign = 'left';
    }

    if (captions) this._captions(ctx, W, H, time);
    ctx.restore();
  }

  /** Crop centre for this instant: a held keyframe path in auto mode, the slider otherwise. */
  focusAt(time) {
    const keys = this.focusKeys;
    if (this.focusMode !== 'auto' || !keys || !keys.length) return this.focus;
    if (keys.length === 1 || time <= keys[0].t) return keys[0].x;
    let i = keys.length - 1;
    while (i > 0 && keys[i].t > time) i--;
    const a = keys[i], b = keys[i + 1];
    if (!b) return a.x;
    // ease across a short window, then hold — a cut that glides, never a slow drift
    const span = Math.min(.7, Math.max(.2, b.t - a.t));
    const k = Math.max(0, Math.min(1, (time - (b.t - span)) / span));
    return a.x + (b.x - a.x) * (k * k * (3 - 2 * k));
  }

  /** Words with timings for a caption line; translated text gets an even spread. */
  _wordsFor(seg, text, words) {
    if (words && words.length) return words;
    const parts = String(text || '').split(/\s+/).filter(Boolean);
    const d = (seg.end - seg.start) / Math.max(parts.length, 1);
    return parts.map((w, i) => ({ w, start: seg.start + i * d, end: seg.start + (i + 1) * d }));
  }

  /** The lines to draw right now, given the original/translated/bilingual mode. */
  _blocks(seg) {
    const lang = this.translationLang;
    const translated = lang && seg.tr && seg.tr[lang];
    if (this.captionMode === 'translated' && translated) return [{ text: translated, words: null, scale: 1 }];
    if (this.captionMode === 'both' && translated) return [
      { text: translated, words: null, scale: 1 },
      { text: seg.text, words: seg.words, scale: .62, dim: .72, karaoke: false }
    ];
    return [{ text: seg.text, words: seg.words, scale: 1 }];
  }

  _captions(ctx, W, H, time) {
    const seg = this.segmentAt(time);
    if (!seg || !seg.text) return;
    const st = this.style;
    const tpl = TEMPLATES[st.template] || TEMPLATES.pop;
    const base = Math.round(H * (st.size / 1000));
    const perLine = tpl.single ? 99 : Math.max(1, st.wordsPerLine);
    const space = ' ';

    // measure every block into laid-out lines first, so the stack can be centred as one
    const laid = [];
    for (const block of this._blocks(seg)) {
      const fontSize = Math.max(10, Math.round(base * (block.scale || 1)));
      ctx.font = `${tpl.weight} ${fontSize}px Inter, system-ui, sans-serif`;
      const rtl = isRTL(block.text);

      let words = this._wordsFor(seg, block.text, block.words)
        .map(w => ({ ...w, w: st.uppercase ? String(w.w).toUpperCase() : String(w.w) }));
      if (!words.length) continue;

      if (!tpl.single) {                       // show one "page" of words at a time
        let active = words.findIndex(w => time >= w.start && time <= w.end + .12);
        if (active < 0) active = time > words.at(-1).end ? words.length - 1 : 0;
        const page = Math.floor(active / perLine);
        words = words.slice(page * perLine, page * perLine + perLine);
      }

      const spaceW = ctx.measureText(space).width;
      const safe = W * .88;
      const lines = [[]];
      let lw = 0;
      for (const wd of words) {
        const width = ctx.measureText(wd.w).width;
        if (lw + width > safe && lines.at(-1).length) { lines.push([]); lw = 0; }
        lines.at(-1).push({ ...wd, width });
        lw += width + spaceW;
      }
      laid.push({ lines, fontSize, spaceW, rtl, dim: block.dim || 1, karaoke: block.karaoke !== false && !!block.words });
    }
    if (!laid.length) return;

    const gap = base * .22;
    const blockH = laid.reduce((a, b) => a + b.lines.length * b.fontSize * 1.22, 0) + gap * (laid.length - 1);
    let top;
    if (st.position === 'top') top = H * .10;
    else if (st.position === 'center') top = (H - blockH) / 2;
    else top = H - blockH - H * .10;

    if (tpl.box) {
      const pad = base * .38;
      const widest = Math.max(...laid.flatMap(b => b.lines.map(l => l.reduce((a, x) => a + x.width + b.spaceW, 0))));
      const boxW = tpl.fullBar ? W : widest + pad * 2;
      ctx.fillStyle = tpl.box;
      roundRect(ctx, tpl.fullBar ? 0 : (W - boxW) / 2, top - pad * .8, boxW, blockH + pad * 1.5, tpl.fullBar ? 0 : base * .28);
      ctx.fill();
    }

    let y = top;
    ctx.textAlign = 'left';
    ctx.direction = 'ltr';
    for (const b of laid) {
      ctx.font = `${tpl.weight} ${b.fontSize}px Inter, system-ui, sans-serif`;
      for (const line of b.lines) {
        const total = line.reduce((a, x) => a + x.width, 0) + b.spaceW * (line.length - 1);
        let x = (W - total) / 2;
        const baseline = y + b.fontSize;
        // words are positioned one by one, so a right-to-left line is laid out
        // in reverse: the first word of the sentence sits on the right
        for (const wd of (b.rtl ? [...line].reverse() : line)) {
          const active = st.karaoke && b.karaoke && time >= wd.start - .02 && time <= wd.end + .12;
          ctx.save();
          ctx.globalAlpha = b.dim;
          if (st.shadow) { ctx.shadowColor = 'rgba(0,0,0,.75)'; ctx.shadowBlur = b.fontSize * .28; ctx.shadowOffsetY = b.fontSize * .05; }
          if (tpl.glow) { ctx.shadowColor = active ? st.color : '#28e6ff'; ctx.shadowBlur = tpl.glow; }
          if (tpl.stroke) {
            ctx.lineWidth = b.fontSize * tpl.stroke;
            ctx.strokeStyle = 'rgba(0,0,0,.9)';
            ctx.lineJoin = 'round';
            ctx.strokeText(wd.w, x, baseline);
          }
          ctx.fillStyle = active ? st.color : tpl.color;
          ctx.fillText(wd.w, x, baseline);
          ctx.restore();
          x += wd.width + b.spaceW;
        }
        y += b.fontSize * 1.22;
      }
      y += gap;
    }
  }

}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (!r) { ctx.rect(x, y, w, h); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
