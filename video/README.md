# WayinStudio

A browser-native AI video studio in the spirit of WayinVideo: drop in a long video, get a
transcript, a summary, timestamped chapters, ranked auto-clips, searchable moments, animated
captions, live translation into any language, and reframed vertical exports.

Everything runs **client-side**. No API keys, no upload, no backend — the speech model is
downloaded once from a CDN and executed in the browser (WebGPU, falling back to WASM).

## Run it

ES modules and a module Web Worker need to be served over HTTP (opening `index.html` from the
filesystem will not work):

```bash
npx http-server -p 8080 .          # from the repository root
# then open http://localhost:8080/video/
```

Click **Demo project** to explore every panel instantly with a built-in transcript — no model
download required.

## What it does

| Feature | How it works |
| --- | --- |
| **Speech in any language** | Whisper is multilingual: Hebrew, Arabic, Russian, Spanish… audio is transcribed in its own language. The source language is also auto-detected from the text (script detection first, Latin-stopword scoring second) so translation can start without asking. |
| **Translation to any language** | Whisper alone can only translate *into English*. A second on-device engine (NLLB-200 distilled 600M, or M2M100 418M) translates the transcript between any of the listed languages — Hebrew speech → English, Spanish or Arabic subtitles. Segments nearest the playhead are translated first, so captions for what is about to play appear while the rest is still running. |
| **Reading the video's own subtitles** | If the file already carries subtitles, they are read straight out of the container and can be used instead of transcribing — then translated like anything else. Browsers do not expose in-band subtitle tracks (Chromium reports an empty `textTracks` list for both MP4/mov_text and WebM/WebVTT), so MP4/MOV (`tx3g`, `wvtt`) and Matroska/WebM (`S_TEXT/UTF8`, `S_TEXT/WEBVTT`, `D_WEBVTT/*`) are parsed directly. Reads are ranged through `Blob.slice`, so a 4 GB file is never pulled into memory. |
| **Bilingual captions** | Captions can show the original, the translation, or both at once — translation large, original smaller underneath. Right-to-left scripts are laid out right-to-left, word by word. |
| **Auto-reframe** | Frames are sampled off the video and each column scored for skin tone, edge energy and motion. The subject's centre is median-filtered and only committed as a keyframe when it moves and stays moved, so the crop cuts and holds instead of drifting — viewers do not notice good reframing, only bad. |
| **Transcription** | Whisper (tiny/base/small ONNX) via Transformers.js in a Web Worker. Audio is decoded, down-mixed and resampled to 16 kHz, then split at the quietest point inside a 20–28 s window so words are never cut in half. Word-level timestamps drive the karaoke captions. |
| **Summary** | TF-IDF sentence vectors + TextRank produce the one-paragraph overview; a cosine-similarity boundary scan produces the timestamped outline. |
| **Auto-clip** | Every sentence boundary is a candidate start. Windows are scored on information density, pacing (words/second), length fit, on-topic keyword hits, hook language, questions, concrete numbers and whether the clip starts and ends on a complete thought. Overlapping candidates are removed greedily. |
| **Moment search** | IDF-weighted term scoring with phrase bonus, prefix matching and query-coverage weighting over a sliding segment window, so a phrase split across two cues still matches. |
| **Captions** | Five templates (Bold Pop, Clean, Neon, Subtitle Bar, Ticker), position, size, words-per-line, colour, uppercase, word-level highlighting. Right-to-left scripts (Hebrew, Arabic) are detected and laid out accordingly. |
| **Reframe** | 9:16 / 1:1 / 4:5 / 16:9 / source, with a focus slider that moves the crop window across the frame. |
| **Export** | `.srt`, `.vtt`, `.txt`, project `.json`, summary `.md`, clips `.csv`, translated `.srt`, bilingual `.srt`, per-clip `.srt` with rebased timestamps, and a rendered `.webm` (canvas + audio through `MediaRecorder`) with captions burned in. |

The preview canvas and the exported file go through the same `renderer.draw()` call, so what you
see in the player is exactly what gets rendered.

## Keyboard

`space` / `k` play-pause · `←` `→` ±5 s (`shift` ±10 s) · `j` `l` ±10 s · `c` toggle captions ·
`/` jump to moment search

## Files

```
video/
├── index.html          UI shell
├── css/app.css         theme and layout
└── js/
    ├── app.js          state, player, timeline, panels, exports
    ├── worker.js       Whisper inference worker (Transformers.js)
    ├── translate.worker.js  NLLB-200 / M2M100 translation worker
    ├── translator.js   translation queue, playhead-first ordering, language codes
    ├── subtitles.js    MP4 and Matroska/WebM subtitle-track extraction
    ├── vision.js       auto-reframe: subject tracking → held crop keyframes
    ├── transcriber.js  worker wrapper + word→segment assembly
    ├── media.js        audio decode, resample, waveform peaks, silence-aware chunking
    ├── nlp.js          keywords, chapters, TextRank summary, auto-clip, moment search
    ├── renderer.js     reframing + animated caption rendering
    ├── exporters.js    subtitle/text exports, transcript import, clip recording
    └── demo.js         built-in demo project
```

## Typical Hebrew workflow

1. Drop in the video. If it already has a subtitle track, a banner offers to use it — otherwise
   pick **Language: עברית** (or leave it on auto) and press **Analyze video**.
2. Open **Translate**, leave *From* on auto (it will say `Auto detect — עברית`), pick a target
   language and press **Translate transcript**. Captions switch to the translation as the first
   segments land.
3. In **Captions** switch to *Bilingual* if you want the original underneath the translation.
4. Export `.srt` in the target language, a bilingual `.srt`, or render a 9:16 clip with the
   translated captions burned in.

## Limits worth knowing

* Rendering plays the clip once in real time while capturing, so a 30 s clip takes ~30 s.
* `MediaRecorder` writes WebM (VP9/Opus). Re-wrap to MP4 with ffmpeg if a platform requires it.
* Transcription speed depends on WebGPU. On a WASM fallback, `tiny` is the practical choice for
  anything longer than a few minutes.
* Importing an SRT/VTT — or reading the video's own subtitle track — gives you every downstream
  feature (summary, clips, search, captions, translation) without running the speech model at all.
* The translation engine is a real download: NLLB-200-distilled-600M is several hundred MB the
  first time. M2M100 418M is smaller and a little weaker. Both are cached by the browser afterwards.
* Caption layout for right-to-left text reverses word order per line, which is correct for plain
  Hebrew or Arabic. Mixed RTL sentences containing Latin words or numbers are not run through a
  full bidi algorithm, so such a line can order those runs wrongly.
* Auto-reframe tracks one subject. It is a saliency heuristic, not a face-recognition model: on a
  wide shot with several people it will settle on the strongest signal rather than the speaker.
