/* WayinStudio — worker wrapper + word→segment assembly. */
import { chunkAudio } from './media.js';

export class Transcriber {
  constructor() { this.worker = null; }

  _spawn() {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    return this.worker;
  }

  cancel() { this.worker?.postMessage({ type: 'cancel' }); }
  destroy() { this.worker?.terminate(); this.worker = null; }

  /**
   * @returns {Promise<{segments:Array, words:Array, device:string}>}
   * onEvent receives {kind:'model'|'chunk', ...} for progress reporting.
   */
  run(pcm, { size, language, translate }, onEvent = () => {}) {
    const w = this._spawn();
    const chunks = chunkAudio(pcm);
    const words = [];
    let device = 'wasm';

    return new Promise((resolve, reject) => {
      const handle = ({ data }) => {
        switch (data.type) {
          case 'model':
            onEvent({ kind: 'model', ...data });
            break;
          case 'partial': {
            device = data.device || device;
            for (const c of data.chunks) {
              const text = (c.text || '').trim();
              if (!text) continue;
              words.push({ w: text, start: c.start, end: Math.max(c.end, c.start + .08) });
            }
            onEvent({ kind: 'chunk', index: data.index, count: data.count, text: data.text, words: words.length });
            break;
          }
          case 'cancelled':
            cleanup(); reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
            break;
          case 'done':
            cleanup();
            resolve({ words, segments: assemble(words), device });
            break;
          case 'error':
            cleanup(); reject(new Error(data.message));
            break;
        }
      };
      const cleanup = () => w.removeEventListener('message', handle);
      w.addEventListener('message', handle);
      w.postMessage({
        type: 'run', size, language, translate,
        chunks: chunks.map(c => ({ start: c.start, end: c.end, pcm: c.pcm }))
      }, chunks.map(c => c.pcm.buffer));
    });
  }
}

/** Group word timings into readable caption-sized segments. */
export function assemble(words, { maxDur = 6.5, maxChars = 92, gap = .62 } = {}) {
  const segments = [];
  let cur = null;
  for (const wd of words) {
    const t = wd.w.trim();
    if (!t) continue;
    const openNew = !cur ||
      (wd.start - cur.end) > gap ||
      (wd.end - cur.start) > maxDur ||
      (cur.text.length + t.length + 1) > maxChars ||
      /[.!?…]["')\]]?$/.test(cur.text.trim());
    if (openNew) {
      cur = { id: segments.length, start: wd.start, end: wd.end, text: t, words: [wd] };
      segments.push(cur);
    } else {
      cur.text += (/^[,.!?;:…'’]/.test(t) ? '' : ' ') + t;
      cur.end = wd.end;
      cur.words.push(wd);
    }
  }
  return segments.map(s => ({ ...s, text: s.text.replace(/\s+/g, ' ').trim() }));
}
