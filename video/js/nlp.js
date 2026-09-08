/* WayinStudio — text intelligence: keywords, chapters, summary, auto-clips, moment search.
   Pure functions over a transcript array: [{ id, start, end, text, words? }] */

const STOP = new Set(`a about above after again against all am an and any are aren't as at be because been
before being below between both but by can cannot could couldn't did didn't do does doesn't doing don't down
during each few for from further had hadn't has hasn't have haven't having he her here hers herself him himself
his how i if in into is isn't it its itself let's me more most mustn't my myself no nor not of off on once only
or other ought our ours ourselves out over own same shan't she should shouldn't so some such than that the their
theirs them themselves then there these they this those through to too under until up very was wasn't we were
weren't what when where which while who whom why with won't would wouldn't you your yours yourself yourselves
just really like okay ok yeah yes right well gonna wanna kind sort thing things stuff going get got know think
one two three four five six seven eight nine ten eleven twelve twenty thirty forty fifty sixty seventy eighty
ninety hundred thousand million first second third next last per percent point number thing
say said says want need make made take going lot bit way also even still much many one two say im ive dont thats
של את זה הוא היא אני אתה אנחנו הם הן על עם גם כי אבל אז מה זאת יש אין לא כן הזה הזאת אשר כדי אחרי לפני בין כמו
עוד רק כל אחד אחת הרבה יותר פחות מאוד ככה בגלל אם או אשר להיות היה הייתי אפשר צריך יכול ממש בעצם כאילו טוב
de la el los las que y en un una es por con para del al se lo como más pero sus le ya o este si`
  .split(/\s+/).filter(Boolean));

const HOOKS = [
  'how','why','what','secret','mistake','never','always','biggest','best','worst','stop','start','truth',
  'nobody','everyone','actually','surprising','wrong','right way','the key','here is','here\'s','listen',
  'important','remember','warning','free','proven','simple','fast','hack','tip','lesson','story','imagine',
  'איך','למה','מה','סוד','טעות','אף פעם','תמיד','הכי','הפסיקו','תפסיקו','האמת','חשוב','תזכרו','טיפ','שיטה'
];

export const isRTL = (s='') => /[֐-׿؀-ۿ]/.test(s);

export function tokenize(text = '') {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [])
    .map(w => w.replace(/['’-]+$/, ''))
    .filter(w => w.length > 1);
}

const contentTokens = t => tokenize(t).filter(w => !STOP.has(w) && w.length > 2);

/* ── tf-idf model over segments ───────────────────────────────────────── */
export function buildIndex(segments) {
  const df = new Map(), docs = [];
  for (const s of segments) {
    const toks = contentTokens(s.text), tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    docs.push(tf);
  }
  const N = Math.max(1, segments.length);
  const idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log(1 + N / (1 + d)) + 1);
  return { docs, idf, N };
}

function vector(tf, idf) {
  const v = new Map(); let norm = 0;
  for (const [t, c] of tf) {
    const w = (1 + Math.log(c)) * (idf.get(t) || 1);
    v.set(t, w); norm += w * w;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [t, w] of v) v.set(t, w / norm);
  return v;
}
function cosine(a, b) {
  let s = 0; const [x, y] = a.size < b.size ? [a, b] : [b, a];
  for (const [t, w] of x) { const o = y.get(t); if (o) s += w * o; }
  return s;
}
function tfOf(text) {
  const tf = new Map();
  for (const t of contentTokens(text)) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

/* ── keywords ─────────────────────────────────────────────────────────── */
export function keywords(segments, limit = 12) {
  const { idf } = buildIndex(segments);
  const total = new Map();
  for (const s of segments) for (const t of contentTokens(s.text)) total.set(t, (total.get(t) || 0) + 1);
  return [...total.entries()]
    .map(([t, c]) => [t, (1 + Math.log(c)) * (idf.get(t) || 1) * (c > 1 ? 1.2 : .7)])
    .sort((a, b) => b[1] - a[1]).slice(0, limit).map(([t]) => t);
}

/* ── sentences with timing ────────────────────────────────────────────── */
export function sentences(segments) {
  const out = [];
  let buf = '', start = null, end = 0, ids = [];
  const flush = () => {
    const text = buf.trim();
    if (text.length > 1) out.push({ text, start, end, ids: [...ids] });
    buf = ''; start = null; ids = [];
  };
  for (const s of segments) {
    if (start === null) start = s.start;
    end = s.end; ids.push(s.id);
    buf += (buf ? ' ' : '') + s.text.trim();
    if (/[.!?…]["')\]]?\s*$/.test(s.text.trim()) || buf.length > 260) { end = s.end; flush(); }
  }
  flush();
  return out;
}

/* ── chapters (topic segmentation) ────────────────────────────────────── */
export function chapters(segments, target = 6) {
  if (segments.length < 4) {
    return segments.length ? [{ start: segments[0].start, end: segments.at(-1).end, ids: segments.map(s => s.id) }] : [];
  }
  const { idf } = buildIndex(segments);
  const vecs = segments.map(s => vector(tfOf(s.text), idf));
  const W = Math.min(4, Math.max(2, Math.floor(segments.length / 12)));
  const scores = [];
  for (let i = W; i < segments.length - W; i++) {
    const left = new Map(), right = new Map();
    for (let k = i - W; k < i; k++) for (const [t, w] of vecs[k]) left.set(t, (left.get(t) || 0) + w);
    for (let k = i; k < i + W; k++) for (const [t, w] of vecs[k]) right.set(t, (right.get(t) || 0) + w);
    const gap = segments[i].start - segments[i - 1].end;
    scores.push({ i, s: (1 - cosine(left, right)) + Math.min(gap, 1.5) * .18 });
  }
  const dur = segments.at(-1).end - segments[0].start;
  const minGap = Math.max(25, dur / (target * 2.2));
  const picks = [];
  for (const c of scores.sort((a, b) => b.s - a.s)) {
    if (picks.length >= target - 1) break;
    if (picks.every(p => Math.abs(segments[p].start - segments[c.i].start) > minGap)) picks.push(c.i);
  }
  picks.sort((a, b) => a - b);
  const bounds = [0, ...picks, segments.length];
  const out = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const part = segments.slice(bounds[k], bounds[k + 1]);
    if (!part.length) continue;
    out.push({ start: part[0].start, end: part.at(-1).end, ids: part.map(s => s.id), segments: part });
  }
  return out;
}

/* ── summary: TextRank over sentences + timestamped outline ───────────── */
export function summarize(segments, { abstractSentences = 3, outlineTarget = 7 } = {}) {
  const sents = sentences(segments);
  if (!sents.length) return { abstract: '', outline: [], keywords: [] };

  const { idf } = buildIndex(sents.map((s, i) => ({ id: i, text: s.text, start: s.start, end: s.end })));
  const vecs = sents.map(s => vector(tfOf(s.text), idf));

  // TextRank
  const n = sents.length;
  const sim = Array.from({ length: n }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const c = cosine(vecs[i], vecs[j]); sim[i][j] = sim[j][i] = c > .06 ? c : 0;
  }
  let rank = new Float32Array(n).fill(1 / n);
  for (let it = 0; it < 24; it++) {
    const next = new Float32Array(n).fill(.15 / n);
    for (let i = 0; i < n; i++) {
      let out = 0; for (let j = 0; j < n; j++) out += sim[i][j];
      if (!out) { next[i] += .85 * rank[i]; continue; }
      for (let j = 0; j < n; j++) if (sim[i][j]) next[j] += .85 * rank[i] * (sim[i][j] / out);
    }
    rank = next;
  }
  const scored = sents.map((s, i) => ({
    ...s, i,
    score: rank[i] * (1 + Math.min(tokenize(s.text).length, 30) / 60) * (i < n * .12 ? 1.25 : 1)
  }));
  const abstract = [...scored].sort((a, b) => b.score - a.score)
    .slice(0, Math.min(abstractSentences, n)).sort((a, b) => a.i - b.i)
    .map(s => s.text.trim().replace(/\s+/g, ' ')).join(' ');

  const chaps = chapters(segments, outlineTarget);
  const outline = chaps.map(c => {
    const inChap = scored.filter(s => s.start >= c.start - .01 && s.start <= c.end + .01);
    const best = inChap.sort((a, b) => b.score - a.score)[0];
    const kws = keywords(c.segments || segments.filter(s => c.ids.includes(s.id)), 4);
    return {
      start: c.start, end: c.end,
      title: titleCase(kws.slice(0, 3).join(' · ')) || clip(best?.text || '', 48),
      text: clip(best?.text || (c.segments || []).map(s => s.text).join(' '), 180),
      keywords: kws
    };
  });
  return { abstract, outline, keywords: keywords(segments, 12) };
}

const clip = (s = '', n) => { s = s.trim().replace(/\s+/g, ' '); return s.length <= n ? s : s.slice(0, n - 1).replace(/\s\S*$/, '') + '…'; };
const titleCase = s => s.replace(/\b\p{Ll}/gu, m => m.toUpperCase());

/* ── auto-clip ────────────────────────────────────────────────────────── */
export function autoClips(segments, { target = 30, count = 6, min = 8 } = {}) {
  if (!segments.length) return [];
  const { idf } = buildIndex(segments);
  const total = segments.at(-1).end - segments[0].start;
  // short sources still deserve clips: scale the window down to the material
  target = Math.min(target, Math.max(4, total * .9));
  min = Math.min(min, Math.max(2, total * .3));
  const kw = new Set(keywords(segments, 20));

  // candidate starts: segments that begin after a pause, or open a sentence
  const starts = segments.map((s, i) => {
    const prev = segments[i - 1];
    const pause = prev ? s.start - prev.end : 2;
    const opens = !prev || /[.!?…]\s*$/.test(prev.text.trim());
    return { i, w: (pause > .45 ? 1 : 0) + (opens ? 1 : 0) };
  }).filter(c => c.w > 0 || segments.length < 12).map(c => c.i);

  const cands = [];
  for (const si of starts) {
    let end = si;
    while (end < segments.length - 1 && segments[end].end - segments[si].start < target) end++;
    const part = segments.slice(si, end + 1);
    const dur = part.at(-1).end - part[0].start;
    if (dur < min) continue;
    const text = part.map(s => s.text.trim()).join(' ');
    const toks = tokenize(text);
    if (toks.length < Math.min(8, Math.max(3, Math.round(dur * 1.2)))) continue;

    const content = contentTokens(text);
    const uniq = new Set(content);
    const kwHits = [...uniq].filter(t => kw.has(t)).length;
    const wps = toks.length / dur;
    const lower = text.toLowerCase();
    const hook = HOOKS.reduce((a, h) => a + (lower.slice(0, 140).includes(h) ? 1 : 0), 0);
    const question = /[?？]/.test(text.slice(0, 200)) ? 1 : 0;
    const numbers = (text.match(/\b\d[\d.,%]*\b/g) || []).length;
    const closes = /[.!?…]["')\]]?\s*$/.test(text.trim()) ? 1 : 0;
    const pauseBefore = si > 0 ? Math.min(segments[si].start - segments[si - 1].end, 1.5) : 1.5;
    const posPenalty = (segments[si].start < total * .03 && total > 180) ? .82 : 1;

    const density = Math.min(uniq.size / Math.max(dur, 1) / 1.6, 1);
    const pacing = 1 - Math.min(Math.abs(wps - 2.9) / 2.9, 1);
    const fit = Math.exp(-Math.pow(dur - target, 2) / (2 * Math.pow(target * .45, 2)));
    const score = (
      .26 * density + .18 * pacing + .16 * fit + .13 * Math.min(kwHits / 6, 1) +
      .10 * Math.min(hook / 2, 1) + .07 * question + .05 * Math.min(numbers / 3, 1) +
      .05 * closes + (pauseBefore / 1.5) * .04
    ) * posPenalty;

    const first = part[0].text.trim();
    cands.push({
      start: part[0].start, end: part.at(-1).end, dur, text,
      title: clip(first.length > 18 ? first : text, 60),
      score: Math.round(Math.min(score * 118, 99)),
      tags: [...uniq].filter(t => kw.has(t)).slice(0, 4),
      reason: [
        hook ? 'strong hook' : null, question ? 'opens with a question' : null,
        closes ? 'complete thought' : null, wps > 3.2 ? 'fast pacing' : null,
        kwHits >= 4 ? 'on-topic' : null, numbers ? 'concrete numbers' : null
      ].filter(Boolean).slice(0, 3).join(' · ') || 'balanced highlight',
      segIds: part.map(s => s.id)
    });
  }

  // greedy non-overlapping selection
  cands.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of cands) {
    if (picked.length >= count) break;
    if (picked.some(p => c.start < p.end - .5 && c.end > p.start + .5)) continue;
    picked.push(c);
  }
  return picked.sort((a, b) => a.start - b.start)
    .map((c, i) => ({ ...c, id: 'clip' + (i + 1), index: i + 1 }));
}

/* ── moment search ────────────────────────────────────────────────────── */
export function searchMoments(segments, query, { window = 2, limit = 25 } = {}) {
  const q = (query || '').trim();
  if (!q) return [];
  const { idf } = buildIndex(segments);
  const qTokens = tokenize(q).filter(t => !STOP.has(t) || tokenize(q).length === 1);
  const qSet = new Set(qTokens);
  const phrase = q.toLowerCase();

  const scored = segments.map((s, i) => {
    // merge a small window so a phrase split across segments still matches
    const part = segments.slice(Math.max(0, i - 0), Math.min(segments.length, i + window));
    const text = part.map(p => p.text).join(' ');
    const lower = text.toLowerCase();
    const toks = tokenize(text);
    let score = 0;
    const counted = new Set();
    for (const t of toks) {
      if (qSet.has(t) && !counted.has(t)) { score += (idf.get(t) || 1) * 1.0; counted.add(t); }
      else if (qSet.has(t)) score += (idf.get(t) || 1) * .25;
    }
    for (const qt of qSet) {                       // prefix / stem-ish partial match
      if (counted.has(qt)) continue;
      if (qt.length > 3 && toks.some(t => t.startsWith(qt.slice(0, Math.max(4, qt.length - 2))))) score += .5;
    }
    if (qTokens.length > 1 && lower.includes(phrase)) score += 4;
    const coverage = counted.size / Math.max(qSet.size, 1);
    score *= (.55 + .45 * coverage);
    return { seg: s, i, score, coverage, text: part.map(p => p.text.trim()).join(' '), end: part.at(-1).end };
  }).filter(r => r.score > .35);

  scored.sort((a, b) => b.score - a.score);
  const out = [];
  for (const r of scored) {
    if (out.length >= limit) break;
    if (out.some(o => Math.abs(o.start - r.seg.start) < 4)) continue;
    out.push({
      start: r.seg.start, end: r.end, segId: r.seg.id, text: r.text,
      score: r.score, confidence: Math.min(99, Math.round(r.score / (scored[0].score || 1) * 99))
    });
  }
  return out;
}

export function highlight(text, query) {
  const toks = [...new Set(tokenize(query))].filter(t => t.length > 1);
  if (!toks.length) return escapeHTML(text);
  const re = new RegExp('(' + toks.map(escapeRe).join('|') + ')', 'giu');
  return escapeHTML(text).replace(re, '<mark>$1</mark>');
}
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const escapeHTML = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── language detection ──────────────────────────────────────────────── */
const SCRIPTS = [
  ['he', /[\u0590-\u05FF]/g], ['am', /[\u1200-\u137F]/g], ['el', /[\u0370-\u03FF]/g],
  ['hi', /[\u0900-\u097F]/g], ['bn', /[\u0980-\u09FF]/g], ['th', /[\u0E00-\u0E7F]/g],
  ['ko', /[\uAC00-\uD7AF]/g],  ['ja', /[\u3040-\u30FF]/g], ['zh', /[\u4E00-\u9FFF]/g]
];
const LATIN_HINTS = {
  en: 'the and that with have this from they will your what about which would there',
  es: 'que de los las por para con una como pero más este cuando muy porque',
  fr: 'que les des dans pour avec sur pas plus vous nous être cette mais tout',
  de: 'der die das und ist nicht ein eine auch mit für auf sich wir dass',
  pt: 'que não uma para com dos como mais mas quando muito isso porque você',
  it: 'che non una per con del sono come più anche quando questo perché sempre',
  nl: 'het een van dat niet voor met zijn maar deze ook nog naar worden',
  pl: 'nie jest się tego które przez jako oraz tylko można bardzo jeszcze',
  ro: 'este care pentru din nu mai sunt când foarte dacă acest despre',
  tr: 'bir bu için ile daha çok ama gibi olarak sonra kadar değil',
  id: 'yang dan untuk dengan tidak dari ini itu pada adalah akan bisa',
  sv: 'och att det som för med inte den har vi kan men'
};
const ARABIC_VARIANTS = [['fa', /[\u067E\u0686\u0698\u06AF\u06CC]/g], ['ur', /[\u0679\u0688\u0691\u06BA\u06BE\u06D2]/g]];
const CYRILLIC_VARIANTS = [['uk', /[іїєґІЇЄҐ]/g]];

/** Best-effort source-language guess: script first, then Latin stopword frequency. */
export function detectLanguage(text = '') {
  const sample = text.slice(0, 4000);
  if (!sample.trim()) return { code: 'en', confidence: 0 };
  const letters = (sample.match(/\p{L}/gu) || []).length || 1;

  const arabic = (sample.match(/[\u0600-\u06FF]/g) || []).length;
  if (arabic / letters > .25) {
    for (const [code, re] of ARABIC_VARIANTS) if ((sample.match(re) || []).length > 2) return { code, confidence: .8 };
    return { code: 'ar', confidence: arabic / letters };
  }
  const cyr = (sample.match(/[\u0400-\u04FF]/g) || []).length;
  if (cyr / letters > .25) {
    for (const [code, re] of CYRILLIC_VARIANTS) if ((sample.match(re) || []).length > 2) return { code, confidence: .8 };
    return { code: 'ru', confidence: cyr / letters };
  }
  for (const [code, re] of SCRIPTS) {
    const n = (sample.match(re) || []).length;
    if (n / letters > .2) return { code, confidence: n / letters };
  }
  const toks = tokenize(sample);
  if (!toks.length) return { code: 'en', confidence: 0 };
  const counts = new Set(toks);
  let best = ['en', 0];
  for (const [code, words] of Object.entries(LATIN_HINTS)) {
    const hits = words.split(' ').filter(w => counts.has(w)).length;
    if (hits > best[1]) best = [code, hits];
  }
  return { code: best[0], confidence: Math.min(best[1] / 8, 1) };
}
