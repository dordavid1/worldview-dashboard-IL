/* WayinStudio — speech-to-text worker (Transformers.js / Whisper ONNX, on-device). */
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5';

env.allowLocalModels = false;

const MODELS = {
  tiny:  ['onnx-community/whisper-tiny_timestamped',  'Xenova/whisper-tiny'],
  base:  ['onnx-community/whisper-base_timestamped',  'Xenova/whisper-base'],
  small: ['onnx-community/whisper-small_timestamped', 'Xenova/whisper-small']
};

let asr = null, loadedKey = null, cancelled = false;

const post = (type, payload = {}) => self.postMessage({ type, ...payload });

async function hasWebGPU() {
  try {
    if (!('gpu' in navigator)) return false;
    const a = await navigator.gpu.requestAdapter();
    return !!a;
  } catch { return false; }
}

async function load(size) {
  const device = (await hasWebGPU()) ? 'webgpu' : 'wasm';
  const dtype = device === 'webgpu'
    ? (size === 'small' ? { encoder_model: 'fp16', decoder_model_merged: 'q4' } : { encoder_model: 'fp32', decoder_model_merged: 'fp32' })
    : 'q8';
  const key = size + '|' + device;
  if (asr && loadedKey === key) return device;

  let lastErr;
  for (const id of MODELS[size] || MODELS.base) {
    try {
      post('model', { stage: 'loading', model: id, device });
      asr = await pipeline('automatic-speech-recognition', id, {
        device, dtype,
        progress_callback: p => {
          if (p.status === 'progress' && p.total) {
            post('model', { stage: 'download', file: p.file, progress: p.loaded / p.total });
          } else if (p.status === 'ready' || p.status === 'done') {
            post('model', { stage: p.status, file: p.file });
          }
        }
      });
      loadedKey = key;
      post('model', { stage: 'ready', model: id, device });
      return device;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Could not load a speech model');
}

self.onmessage = async ({ data }) => {
  if (data.type === 'cancel') { cancelled = true; return; }
  if (data.type !== 'run') return;
  cancelled = false;

  const { chunks, size = 'base', language = 'auto', translate = false } = data;
  try {
    const device = await load(size);
    const opts = {
      chunk_length_s: 30, stride_length_s: 4,
      return_timestamps: 'word',
      task: translate ? 'translate' : 'transcribe'
    };
    if (language && language !== 'auto') opts.language = language;

    for (let i = 0; i < chunks.length; i++) {
      if (cancelled) { post('cancelled'); return; }
      const { start, pcm } = chunks[i];
      let out;
      try {
        out = await asr(pcm, opts);
      } catch (e) {
        // word timestamps are unavailable on some builds — retry at segment level
        out = await asr(pcm, { ...opts, return_timestamps: true });
      }
      post('partial', {
        index: i, count: chunks.length, offset: start, device,
        text: (out.text || '').trim(),
        chunks: (out.chunks || []).map(c => ({
          text: c.text, start: (c.timestamp?.[0] ?? 0) + start, end: (c.timestamp?.[1] ?? c.timestamp?.[0] ?? 0) + start
        }))
      });
    }
    post('done');
  } catch (err) {
    post('error', { message: String(err?.message || err) });
  }
};
