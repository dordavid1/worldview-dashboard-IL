/* WayinStudio — translation queue. Segments closest to the playhead go first, so
   captions for what is about to play appear while the rest is still running. */

/* FLORES-200 codes for NLLB, ISO codes for M2M100. */
export const LANGUAGES = [
  ['en', 'English',    'eng_Latn'], ['he', 'עברית (Hebrew)', 'heb_Hebr'], ['ar', 'العربية (Arabic)', 'arb_Arab'],
  ['es', 'Español',    'spa_Latn'], ['fr', 'Français',       'fra_Latn'], ['de', 'Deutsch',          'deu_Latn'],
  ['pt', 'Português',  'por_Latn'], ['it', 'Italiano',       'ita_Latn'], ['ru', 'Русский',          'rus_Cyrl'],
  ['uk', 'Українська', 'ukr_Cyrl'], ['pl', 'Polski',         'pol_Latn'], ['nl', 'Nederlands',       'nld_Latn'],
  ['tr', 'Türkçe',     'tur_Latn'], ['fa', 'فارسی (Persian)', 'pes_Arab'], ['hi', 'हिन्दी',            'hin_Deva'],
  ['bn', 'বাংলা',       'ben_Beng'], ['ur', 'اردو',           'urd_Arab'], ['zh', '中文 (Simplified)', 'zho_Hans'],
  ['ja', '日本語',      'jpn_Jpan'], ['ko', '한국어',          'kor_Hang'], ['vi', 'Tiếng Việt',       'vie_Latn'],
  ['id', 'Indonesia',  'ind_Latn'], ['th', 'ไทย',            'tha_Thai'], ['ro', 'Română',           'ron_Latn'],
  ['el', 'Ελληνικά',   'ell_Grek'], ['sv', 'Svenska',        'swe_Latn'], ['am', 'አማርኛ',            'amh_Ethi'],
  ['yi', 'ייִדיש (Yiddish)', 'ydd_Hebr']
];
export const langName = code => LANGUAGES.find(l => l[0] === code)?.[1] || code;
export const codeFor = (code, scheme) => {
  const row = LANGUAGES.find(l => l[0] === code);
  if (!row) return code;
  return scheme === 'flores' ? row[2] : row[0];
};

export class Translator {
  constructor() { this.worker = null; this.codes = 'flores'; }
  _spawn() {
    if (!this.worker) this.worker = new Worker(new URL('./translate.worker.js', import.meta.url), { type: 'module' });
    return this.worker;
  }
  cancel() { this.worker?.postMessage({ type: 'cancel' }); }
  destroy() { this.worker?.terminate(); this.worker = null; }

  /**
   * @param items  [{id, text, start}]
   * @param opts   {src, tgt, model, priorityTime}
   * @param onEvent({kind:'model'|'batch', ...}) — 'batch' carries results as they land
   */
  run(items, { src, tgt, model = 'nllb', priorityTime = 0 }, onEvent = () => {}) {
    const w = this._spawn();
    const scheme = model === 'nllb' ? 'flores' : 'iso';
    // nearest-to-playhead first: the viewer sees translated captions almost immediately
    const ordered = [...items].sort((a, b) =>
      Math.abs((a.start ?? 0) - priorityTime) - Math.abs((b.start ?? 0) - priorityTime));

    return new Promise((resolve, reject) => {
      const results = new Map();
      const handle = ({ data }) => {
        switch (data.type) {
          case 'model': onEvent({ kind: 'model', ...data }); break;
          case 'partial':
            for (const r of data.results) results.set(r.id, r.text);
            onEvent({ kind: 'batch', results: data.results, done: data.done, total: data.total });
            break;
          case 'cancelled': cleanup(); reject(Object.assign(new Error('Cancelled'), { cancelled: true })); break;
          case 'done': cleanup(); resolve(results); break;
          case 'error': cleanup(); reject(new Error(data.message)); break;
        }
      };
      const cleanup = () => w.removeEventListener('message', handle);
      w.addEventListener('message', handle);
      w.postMessage({
        type: 'run', model,
        src: codeFor(src, scheme), tgt: codeFor(tgt, scheme),
        items: ordered.map(s => ({ id: s.id, text: s.text }))
      });
    });
  }
}
