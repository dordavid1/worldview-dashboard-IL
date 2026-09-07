# WayinStudio

A browser-native AI video studio in the spirit of WayinVideo: drop in a long video, get a
transcript, a summary, timestamped chapters, ranked auto-clips, searchable moments, animated
captions and reframed vertical exports.

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
| **Transcription** | Whisper (tiny/base/small ONNX) via Transformers.js in a Web Worker. Audio is decoded, down-mixed and resampled to 16 kHz, then split at the quietest point inside a 20–28 s window so words are never cut in half. Word-level timestamps drive the karaoke captions. |
| **Summary** | TF-IDF sentence vectors + TextRank produce the one-paragraph overview; a cosine-similarity boundary scan produces the timestamped outline. |
| **Auto-clip** | Every sentence boundary is a candidate start. Windows are scored on information density, pacing (words/second), length fit, on-topic keyword hits, hook language, questions, concrete numbers and whether the clip starts and ends on a complete thought. Overlapping candidates are removed greedily. |
| **Moment search** | IDF-weighted term scoring with phrase bonus, prefix matching and query-coverage weighting over a sliding segment window, so a phrase split across two cues still matches. |
| **Captions** | Five templates (Bold Pop, Clean, Neon, Subtitle Bar, Ticker), position, size, words-per-line, colour, uppercase, word-level highlighting. Right-to-left scripts (Hebrew, Arabic) are detected and laid out accordingly. |
| **Reframe** | 9:16 / 1:1 / 4:5 / 16:9 / source, with a focus slider that moves the crop window across the frame. |
| **Export** | `.srt`, `.vtt`, `.txt`, project `.json`, summary `.md`, clips `.csv`, per-clip `.srt` with rebased timestamps, and a rendered `.webm` (canvas + audio through `MediaRecorder`) with captions burned in. |

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
    ├── transcriber.js  worker wrapper + word→segment assembly
    ├── media.js        audio decode, resample, waveform peaks, silence-aware chunking
    ├── nlp.js          keywords, chapters, TextRank summary, auto-clip, moment search
    ├── renderer.js     reframing + animated caption rendering
    ├── exporters.js    subtitle/text exports, transcript import, clip recording
    └── demo.js         built-in demo project
```

## Limits worth knowing

* Rendering plays the clip once in real time while capturing, so a 30 s clip takes ~30 s.
* `MediaRecorder` writes WebM (VP9/Opus). Re-wrap to MP4 with ffmpeg if a platform requires it.
* Transcription speed depends on WebGPU. On a WASM fallback, `tiny` is the practical choice for
  anything longer than a few minutes.
* Importing an SRT/VTT gives you every downstream feature (summary, clips, search, captions)
  without running the model at all.
