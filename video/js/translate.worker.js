/* WayinStudio — translation worker (NLLB-200 / M2M100 via Transformers.js, on-device).
   Whisper alone can only translate into English; this gives any-language → any-language
   for the transcript and for subtitles read out of the video file. */
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5';

env.allowLocalModels = false;

const MODELS = {
  nllb: { id: 'Xenova/nllb-200-distilled-600M', codes: 'flores' },
  m2m:  { id: 'Xenova/m2m100_418M',             codes: 'iso' }
};

let tr = null, loadedKey = null, cancelled = false;
const post = (type, payload = {}) => self.postMessage({ type, ...payload });

async function hasWebGPU() {
  try { return 'gpu' in navigator && !!(await navigator.gpu.requestAdapter()); } catch { return false; }
}

async function load(which) {
  const spec = MODELS[which] || MODELS.nllb;
  const device = (await hasWebGPU()) ? 'webgpu' : 'wasm';
  const key = which + '|' + device;
  if (tr && loadedKey === key) return { device, codes: spec.codes };

  post('model', { stage: 'loading', model: spec.id, device });
  tr = await pipeline('translation', spec.id, {
    device, dtype: 'q8',
    progress_callback: p => {
      if (p.status === 'progress' && p.total) post('model', { stage: 'download', file: p.file, progress: p.loaded / p.total });
    }
  });
  loadedKey = key;
  post('model', { stage: 'ready', model: spec.id, device, codes: spec.codes });
  return { device, codes: spec.codes };
}

self.onmessage = async ({ data }) => {
  if (data.type === 'cancel') { cancelled = true; return; }
  if (data.type !== 'run') return;
  cancelled = false;

  const { items, src, tgt, model = 'nllb', batch = 4 } = data;
  try {
    await load(model);
    for (let i = 0; i < items.length; i += batch) {
      if (cancelled) { post('cancelled'); return; }
      const slice = items.slice(i, i + batch);
      let texts;
      try {
        const out = await tr(slice.map(s => s.text), { src_lang: src, tgt_lang: tgt, max_new_tokens: 220 });
        texts = (Array.isArray(out) ? out : [out]).map(o => (o.translation_text || '').trim());
      } catch (e) {
        // fall back to one-at-a-time so a single bad segment cannot kill the batch
        texts = [];
        for (const s of slice) {
          try {
            const o = await tr(s.text, { src_lang: src, tgt_lang: tgt, max_new_tokens: 220 });
            texts.push(((Array.isArray(o) ? o[0] : o).translation_text || '').trim());
          } catch { texts.push(''); }
        }
      }
      post('partial', { results: slice.map((s, k) => ({ id: s.id, text: texts[k] || '' })), done: Math.min(i + batch, items.length), total: items.length });
    }
    post('done');
  } catch (err) {
    post('error', { message: String(err?.message || err) });
  }
};
