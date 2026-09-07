/* WayinStudio — built-in demo project so every panel is explorable without a download. */

const SCRIPT = [
  "Everyone tells you to post more. Post daily, post twice a day, feed the algorithm.",
  "We ran that experiment for six months and it almost killed our channel.",
  "So today I want to walk you through what actually moved the numbers for us.",
  "Here is the setup. We had a hundred and forty hours of long form interviews sitting in a drive.",
  "Nobody watched them. The average view duration was under two minutes.",
  "The first thing we changed was not the volume. It was the entry point.",
  "Every long video got cut into eight to twelve short clips, and each clip had to survive on its own.",
  "That is the rule. If a clip needs context from the full episode, it is not a clip. It is a trailer.",
  "Our editor spent about four hours per episode finding those moments by hand.",
  "So we built a pipeline that scores every candidate window on three things.",
  "Density, which is how much new information is packed into the segment.",
  "Pacing, roughly words per second, because a highlight that drags loses people at second three.",
  "And completeness, meaning it starts on a real sentence and it ends on a real sentence.",
  "The model gave us a ranked list, and the editor kept veto power over the top ten.",
  "Editing time per episode went from four hours to about twenty five minutes.",
  "Now the part everyone asks about. Did the clips actually perform better?",
  "Watch time on shorts went up two hundred and thirty percent in the first quarter.",
  "But the number I care about is different. Subscribers per thousand views went from one point one to four point six.",
  "That is the real signal, because it means the right people are finding us.",
  "The second change was captions. This one is boring and it is the highest leverage thing on the list.",
  "Eighty five percent of our mobile viewers watch with the sound off in the first three seconds.",
  "If there is no text on screen in those three seconds, you never earned the fourth.",
  "We tested four caption styles. Big bold word by word highlighting beat everything else.",
  "Static subtitle bars performed worst, about thirty percent lower completion rate.",
  "Third change, and this is where most teams lose money. Reframing.",
  "A sixteen by nine talking head cropped to nine by sixteen usually cuts somebody's face in half.",
  "We anchor the crop on the active speaker and hold it. No jitter, no constant panning.",
  "Viewers do not consciously notice good reframing. They absolutely notice bad reframing.",
  "So what does the workflow look like end to end today?",
  "Upload the episode. Transcribe it once. Everything downstream reads from that transcript.",
  "Search the transcript for the moment you remember, jump straight to it, trim, export.",
  "The transcript is the index. The video is just the rendering of it.",
  "One warning before you copy this. Do not automate the veto step.",
  "The model is good at finding candidates. It is bad at knowing what your audience is tired of.",
  "Keep a human on the final ten. That is the whole trick.",
  "If you take one thing from this, take the completeness rule. Clips that start mid sentence die.",
  "That is it. Next episode we will break down the thumbnail tests, which were far less obvious.",
  "Thanks for watching, and if this was useful the transcript is linked below."
];

export function demoProject() {
  let t = 1.2;
  const segments = SCRIPT.flatMap((line, li) => {
    const parts = line.match(/[^.!?]+[.!?]*/g) || [line];
    return parts.map(p => {
      const text = p.trim();
      const words = text.split(/\s+/).length;
      const dur = Math.max(1.1, words / 2.85);
      const seg = { id: 0, start: +t.toFixed(2), end: +(t + dur).toFixed(2), text };
      t += dur + (/[.!?]$/.test(text) ? 0.32 : 0.1) + (li % 7 === 6 ? 0.7 : 0);
      return seg;
    });
  }).map((s, i) => ({ ...s, id: i }));

  return {
    name: 'DEMO — “We stopped posting daily” (podcast cut)',
    duration: segments.at(-1).end + 2,
    segments,
    synthetic: true
  };
}

/** Procedural waveform so the timeline looks alive in demo mode. */
export function demoPeaks(segments, duration, buckets = 1200) {
  const out = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    const t = b / buckets * duration;
    const speaking = segments.some(s => t >= s.start && t <= s.end);
    const env = speaking ? .45 + .55 * Math.abs(Math.sin(t * 7.3) * Math.cos(t * 2.1)) : .04;
    out[b] = Math.min(1, env * (.75 + .25 * Math.random()));
  }
  return out;
}
