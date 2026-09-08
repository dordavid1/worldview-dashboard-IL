/* WayinStudio — read subtitle tracks that are already inside the video file.
   Browsers do not expose in-band subtitle tracks (Chromium reports an empty
   textTracks list for both MP4/mov_text and WebM/WebVTT), so the containers are
   parsed here directly. Reads are ranged through Blob.slice, so a 4 GB file
   never has to be pulled into memory. */

/* ── ranged reader over a Blob/File ──────────────────────────────────── */
class Reader {
  constructor(blob) { this.blob = blob; this.size = blob.size; }
  async view(offset, length) {
    if (offset >= this.size) return new DataView(new ArrayBuffer(0));
    const buf = await this.blob.slice(offset, Math.min(this.size, offset + length)).arrayBuffer();
    return new DataView(buf);
  }
  async bytes(offset, length) {
    const v = await this.view(offset, length);
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
}
const TXT = new TextDecoder('utf-8');
const fourcc = (v, o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));

/* ── public entry point ──────────────────────────────────────────────── */
export async function extractEmbeddedSubtitles(file) {
  const r = new Reader(file);
  const head = await r.view(0, 16);
  if (head.byteLength < 8) return [];
  try {
    if (head.getUint32(0) === 0x1A45DFA3) return await readMatroska(r);
    if (fourcc(head, 4) === 'ftyp' || fourcc(head, 4) === 'moov') return await readMP4(r);
  } catch (e) {
    console.warn('subtitle extraction failed', e);
  }
  return [];
}

/** Cues the browser does expose (sidecar <track> elements, some in-band WebVTT). */
export function readTextTracks(video) {
  const out = [];
  for (const t of video.textTracks || []) {
    if (!/subtitles|captions/.test(t.kind)) continue;
    t.mode = 'hidden';
    const cues = [...(t.cues || [])].map(c => ({ start: c.startTime, end: c.endTime, text: String(c.text || '').replace(/<[^>]+>/g, '').trim() }));
    if (cues.length) out.push({ language: t.language || '', label: t.label || t.language || 'track', codec: 'webvtt', cues });
  }
  return out;
}

/* ── MP4 / MOV ───────────────────────────────────────────────────────── */
async function boxes(r, start, end, cb) {
  let off = start;
  while (off < end - 8) {
    const h = await r.view(off, 16);
    if (h.byteLength < 8) return;
    let size = h.getUint32(0), header = 8;
    const type = fourcc(h, 4);
    if (size === 1) { size = Number(h.getBigUint64(8)); header = 16; }
    else if (size === 0) size = end - off;
    if (size < header) return;
    if (await cb(type, off + header, off + size) === false) return;
    off += size;
  }
}

async function readMP4(r) {
  let moov = null;
  await boxes(r, 0, r.size, (type, s, e) => { if (type === 'moov') { moov = [s, e]; return false; } });
  if (!moov) return [];

  const tracks = [];
  await boxes(r, moov[0], moov[1], async (type, s, e) => {
    if (type !== 'trak') return;
    const t = await readTrak(r, s, e);
    if (t) tracks.push(t);
  });
  return tracks;
}

async function readTrak(r, start, end) {
  let handler = '', timescale = 1000, language = '', stbl = null;
  await boxes(r, start, end, async (type, s, e) => {
    if (type !== 'mdia') return;
    await boxes(r, s, e, async (t2, s2, e2) => {
      if (t2 === 'hdlr') { handler = fourcc(await r.view(s2 + 8, 4), 0); }
      else if (t2 === 'mdhd') {
        const v = await r.view(s2, 32);
        const version = v.getUint8(0);
        timescale = version === 1 ? v.getUint32(20) : v.getUint32(12);
        const packed = version === 1 ? v.getUint16(28) : v.getUint16(20);
        language = [10, 5, 0].map(sh => String.fromCharCode(((packed >> sh) & 0x1f) + 0x60)).join('');
      } else if (t2 === 'minf') {
        await boxes(r, s2, e2, (t3, s3, e3) => { if (t3 === 'stbl') stbl = [s3, e3]; });
      }
    });
  });
  if (!/^(text|sbtl|subt|clcp)$/.test(handler) || !stbl) return null;

  let codec = '', stts = null, stsz = null, stsc = null, chunks = null;
  await boxes(r, stbl[0], stbl[1], async (t, s, e) => {
    if (t === 'stsd') { await boxes(r, s + 8, e, (t2) => { codec = t2; return false; }); }
    else if (t === 'stts') stts = await table(r, s, e, 8);
    else if (t === 'stsz') stsz = await r.bytes(s, e - s);
    else if (t === 'stsc') stsc = await table(r, s, e, 12);
    else if (t === 'stco') chunks = { wide: false, data: await table(r, s, e, 4) };
    else if (t === 'co64') chunks = { wide: true, data: await table(r, s, e, 8) };
  });
  if (!stts || !stsz || !stsc || !chunks) return null;

  const sizes = sampleSizes(stsz);
  const times = sampleTimes(stts, sizes.length);
  const offsets = sampleOffsets(stsc, chunks, sizes);

  const cues = [];
  for (let i = 0; i < sizes.length; i++) {
    if (!sizes[i] || offsets[i] == null) continue;
    const buf = await r.bytes(offsets[i], sizes[i]);
    const text = codec === 'wvtt' ? decodeWVTT(buf) : decodeTX3G(buf);
    if (!text) continue;
    cues.push({ start: times[i].start / timescale, end: times[i].end / timescale, text });
  }
  return cues.length ? { language: language === '```' || /[^a-z]/.test(language) ? '' : language, label: language || codec, codec, cues: mergeCues(cues) } : null;
}

async function table(r, start, end, entrySize) {
  const v = await r.view(start, 8);
  const count = v.getUint32(4);
  const need = Math.min(count * entrySize, end - start - 8);
  const body = await r.view(start + 8, need);
  return { count, entrySize, body };
}
function sampleSizes(stsz) {
  const v = new DataView(stsz.buffer, stsz.byteOffset, stsz.byteLength);
  const uniform = v.getUint32(4), count = v.getUint32(8);
  const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = uniform || v.getUint32(12 + i * 4);
  return out;
}
function sampleTimes(stts, sampleCount) {
  const out = []; let t = 0;
  for (let i = 0; i < stts.count && out.length < sampleCount; i++) {
    const n = stts.body.getUint32(i * 8), d = stts.body.getUint32(i * 8 + 4);
    for (let k = 0; k < n && out.length < sampleCount; k++) { out.push({ start: t, end: t + d }); t += d; }
  }
  while (out.length < sampleCount) out.push({ start: t, end: t + 1 });
  return out;
}
function sampleOffsets(stsc, chunks, sizes) {
  const entries = [];
  for (let i = 0; i < stsc.count; i++) {
    entries.push({ first: stsc.body.getUint32(i * 12), per: stsc.body.getUint32(i * 12 + 4) });
  }
  const chunkCount = chunks.data.count;
  const offsets = new Array(sizes.length).fill(null);
  let sample = 0;
  for (let c = 0; c < chunkCount && sample < sizes.length; c++) {
    let per = 1;
    for (const e of entries) if (c + 1 >= e.first) per = e.per;
    let off = chunks.wide ? Number(chunks.data.body.getBigUint64(c * 8)) : chunks.data.body.getUint32(c * 4);
    for (let k = 0; k < per && sample < sizes.length; k++) {
      offsets[sample] = off; off += sizes[sample]; sample++;
    }
  }
  return offsets;
}
function decodeTX3G(buf) {
  if (buf.length < 2) return '';
  const len = (buf[0] << 8) | buf[1];
  return TXT.decode(buf.subarray(2, 2 + Math.min(len, buf.length - 2))).trim();
}
function decodeWVTT(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 0, text = '';
  while (off + 8 <= buf.length) {
    const size = v.getUint32(off), type = fourcc(v, off + 4);
    if (size < 8) break;
    if (type === 'vttc' || type === 'vtte') {
      const inner = buf.subarray(off + 8, off + size);
      const iv = new DataView(inner.buffer, inner.byteOffset, inner.byteLength);
      let io = 0;
      while (io + 8 <= inner.length) {
        const is = iv.getUint32(io), it = fourcc(iv, io + 4);
        if (is < 8) break;
        if (it === 'payl') text += TXT.decode(inner.subarray(io + 8, io + is));
        io += is;
      }
    }
    off += size;
  }
  return text.trim();
}
/** Drop empty samples and join cues that repeat the same text back-to-back. */
function mergeCues(cues) {
  const out = [];
  for (const c of cues) {
    const prev = out.at(-1);
    if (prev && prev.text === c.text && c.start - prev.end < .25) prev.end = c.end;
    else out.push({ ...c });
  }
  return out;
}

/* ── Matroska / WebM ─────────────────────────────────────────────────── */
const ID = { SEGMENT: 0x18538067, INFO: 0x1549A966, TIMESCALE: 0x2AD7B1, TRACKS: 0x1654AE6B, ENTRY: 0xAE,
  NUM: 0xD7, TYPE: 0x83, CODEC: 0x86, LANG: 0x22B59C, CLUSTER: 0x1F43B675, TIME: 0xE7,
  SIMPLE: 0xA3, GROUP: 0xA0, BLOCK: 0xA1, DUR: 0x9B };

function vint(buf, off, keepMarker) {
  const first = buf[off];
  if (first === undefined) return null;
  let len = 1, mask = 0x80;
  while (len <= 8 && !(first & mask)) { mask >>= 1; len++; }
  if (len > 8) return null;
  let value = keepMarker ? first : (first & (mask - 1));
  for (let i = 1; i < len; i++) value = value * 256 + buf[off + i];
  return { value, length: len };
}

async function readMatroska(r) {
  const tracks = new Map();
  let timecodeScale = 1e6, out = [];

  const walk = async (start, end, depth) => {
    let off = start;
    while (off < end) {
      const head = await r.bytes(off, 16);
      const id = vint(head, 0, true); if (!id) return;
      const size = vint(head, id.length, false); if (!size) return;
      const dataStart = off + id.length + size.length;
      const dataEnd = size.value >= 0xFFFFFFFFFFFFF ? end : Math.min(end, dataStart + size.value);

      if (id.value === ID.SEGMENT) await walk(dataStart, dataEnd, depth + 1);
      else if (id.value === ID.INFO) await readInfo(dataStart, dataEnd);
      else if (id.value === ID.TRACKS) await readTracks(dataStart, dataEnd);
      else if (id.value === ID.CLUSTER) await readCluster(dataStart, dataEnd);
      off = dataEnd;
      if (dataEnd <= dataStart) return;
    }
  };
  const readInfo = async (s, e) => {
    const buf = await r.bytes(s, e - s);
    each(buf, (id, data) => { if (id === ID.TIMESCALE) timecodeScale = uint(data); });
  };
  const readTracks = async (s, e) => {
    const buf = await r.bytes(s, e - s);
    each(buf, (id, data) => {
      if (id !== ID.ENTRY) return;
      const t = { number: 0, type: 0, codec: '', language: '' };
      each(data, (id2, d2) => {
        if (id2 === ID.NUM) t.number = uint(d2);
        else if (id2 === ID.TYPE) t.type = uint(d2);
        else if (id2 === ID.CODEC) t.codec = TXT.decode(d2);
        else if (id2 === ID.LANG) t.language = TXT.decode(d2);
      });
            // S_TEXT/UTF8, S_TEXT/WEBVTT (Matroska) and D_WEBVTT/* (WebM) are all plain text
      if (t.type === 0x11 && /^(S_TEXT|D_WEBVTT)/.test(t.codec)) tracks.set(t.number, { ...t, cues: [] });
    });
  };
  const readCluster = async (s, e) => {
    if (!tracks.size) return;
    if (e - s > 24 * 1024 * 1024) return;
    const buf = await r.bytes(s, e - s);
    let clusterTime = 0;
    each(buf, (id, data) => {
      if (id === ID.TIME) clusterTime = uint(data);
      else if (id === ID.SIMPLE) block(data, clusterTime, 0);
      else if (id === ID.GROUP) {
        let payload = null, dur = 0;
        each(data, (id2, d2) => {
          if (id2 === ID.BLOCK) payload = d2;
          else if (id2 === ID.DUR) dur = uint(d2);
        });
        if (payload) block(payload, clusterTime, dur);
      }
    });
  };
  const block = (data, clusterTime, dur) => {
    const tn = vint(data, 0, false); if (!tn) return;
    const track = tracks.get(tn.value); if (!track) return;
    const o = tn.length;
    const rel = (data[o] << 8 | data[o + 1]) << 16 >> 16;      // signed int16
    const text = TXT.decode(data.subarray(o + 3)).replace(/<[^>]+>/g, '').trim();
    if (!text) return;
    const scale = timecodeScale / 1e9;
    const start = (clusterTime + rel) * scale;
    track.cues.push({ start, end: start + (dur ? dur * scale : 0), text });
  };

  await walk(0, r.size, 0);
  for (const t of tracks.values()) {
    if (!t.cues.length) continue;
    t.cues.sort((a, b) => a.start - b.start);
    t.cues.forEach((c, i) => {                                  // SimpleBlocks carry no duration
      if (c.end <= c.start) c.end = Math.min(t.cues[i + 1]?.start ?? c.start + 4, c.start + 8);
    });
    out.push({ language: t.language, label: t.language || t.codec, codec: t.codec, cues: mergeCues(t.cues) });
  }
  return out;
}

/** Iterate the EBML children of an in-memory element. */
function each(buf, cb) {
  let off = 0;
  while (off < buf.length) {
    const id = vint(buf, off, true); if (!id) return;
    const size = vint(buf, off + id.length, false); if (!size) return;
    const s = off + id.length + size.length;
    const e = Math.min(buf.length, s + size.value);
    cb(id.value, buf.subarray(s, e));
    if (e <= s && size.value !== 0) return;
    off = e;
  }
}
const uint = d => { let v = 0; for (const b of d) v = v * 256 + b; return v; };

/** Turn extracted cues into the transcript segment shape used everywhere else. */
export const cuesToSegments = cues => cues
  .filter(c => c.text)
  .map((c, i) => ({ id: i, start: c.start, end: Math.max(c.end, c.start + .4), text: c.text.replace(/\s*\n\s*/g, ' ').trim() }));
