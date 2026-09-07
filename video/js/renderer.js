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
      const sx = (vw - sw) * this.focus;
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

  _captions(ctx, W, H, time) {
    const seg = this.segmentAt(time);
    if (!seg || !seg.text) return;
    const st = this.style;
    const tpl = TEMPLATES[st.template] || TEMPLATES.pop;
    const fontSize = Math.round(H * (st.size / 1000));
    const rtl = isRTL(seg.text);

    const words = (seg.words && seg.words.length ? seg.words : seg.text.split(/\s+/).map((w, i, a) => {
      const d = (seg.end - seg.start) / a.length;
      return { w, start: seg.start + i * d, end: seg.start + (i + 1) * d };
    })).map(w => ({ ...w, w: st.uppercase ? w.w.toUpperCase() : w.w }));

    const perLine = tpl.single ? 99 : Math.max(1, st.wordsPerLine);
    // Show only the active window of words (a caption "page"), like short-form editors do.
    let page = words;
    if (!tpl.single) {
      const idx = Math.max(0, words.findIndex(w => time >= w.start && time <= w.end + .12));
      const active = idx < 0 ? 0 : idx;
      const pageIdx = Math.floor(active / perLine);
      page = words.slice(pageIdx * perLine, pageIdx * perLine + perLine);
    }
    if (!page.length) return;

    ctx.font = `${tpl.weight} ${fontSize}px Inter, system-ui, sans-serif`;
    ctx.textBaseline = 'alphabetic';
    ctx.direction = rtl ? 'rtl' : 'ltr';

    // wrap the page into lines that fit the safe area
    const safe = W * .88;
    const lines = [[]];
    let lw = 0;
    const space = ctx.measureText(' ').width;
    for (const wd of page) {
      const m = ctx.measureText(wd.w).width;
      if (lw + m > safe && lines.at(-1).length) { lines.push([]); lw = 0; }
      lines.at(-1).push({ ...wd, w: wd.w, width: m });
      lw += m + space;
    }

    const lineH = fontSize * 1.22;
    const blockH = lines.length * lineH;
    let top;
    if (st.position === 'top') top = H * .10;
    else if (st.position === 'center') top = (H - blockH) / 2;
    else top = H - blockH - H * .10;

    if (tpl.box) {
      const pad = fontSize * .38;
      let boxW = tpl.fullBar ? W : Math.max(...lines.map(l => l.reduce((a, x) => a + x.width + space, 0))) + pad * 2;
      const x = tpl.fullBar ? 0 : (W - boxW) / 2;
      ctx.fillStyle = tpl.box;
      roundRect(ctx, x, top - pad * .8, boxW, blockH + pad * 1.5, tpl.fullBar ? 0 : fontSize * .28);
      ctx.fill();
    }

    lines.forEach((line, li) => {
      const total = line.reduce((a, x) => a + x.width, 0) + space * (line.length - 1);
      let x = (W - total) / 2;
      const y = top + li * lineH + fontSize;
      for (const wd of line) {
        const active = st.karaoke && time >= wd.start - .02 && time <= wd.end + .12;
        ctx.save();
        if (st.shadow) { ctx.shadowColor = 'rgba(0,0,0,.75)'; ctx.shadowBlur = fontSize * .28; ctx.shadowOffsetY = fontSize * .05; }
        if (tpl.glow) { ctx.shadowColor = active ? st.color : '#28e6ff'; ctx.shadowBlur = tpl.glow; }
        if (tpl.stroke) {
          ctx.lineWidth = fontSize * tpl.stroke;
          ctx.strokeStyle = 'rgba(0,0,0,.9)';
          ctx.lineJoin = 'round';
          ctx.strokeText(wd.w, x, y);
        }
        ctx.fillStyle = active ? st.color : tpl.color;
        ctx.fillText(wd.w, x, y);
        ctx.restore();
        x += wd.width + space;
      }
    });
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
