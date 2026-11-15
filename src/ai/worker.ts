// Worker thread for the trainer: builds verified levels and scores candidate riders.
import { generateTrack, makeRng } from "../level/generator";
import { buildLevel } from "../level/level";
import { defaultConfig, type Track } from "../sim";
import { fitness, runEpisode } from "./episode";
import { PARAM_COUNT } from "./policy";

declare const self: Worker;

export interface LevelRef {
  seed: number;
  difficulty: number;
  length: number;
  attempt: number;
}

export type Job =
  | { type: "build"; id: number; seed: number; difficulty: number; length: number }
  | { type: "score"; id: number; theta: Float64Array; sigma: number; seeds: number[]; levels: LevelRef[] }
  | { type: "eval"; id: number; theta: Float64Array; levels: LevelRef[] };

const tracks = new Map<string, Track>();
function trackFor(l: LevelRef): Track {
  const key = `${l.seed}/${l.difficulty}/${l.length}/${l.attempt}`;
  let t = tracks.get(key);
  if (!t) {
    t = generateTrack(l);
    if (tracks.size > 3000) tracks.clear();
    tracks.set(key, t);
  }
  return t;
}

/** Fill `out` with standard normal noise for a given seed (same on every thread). */
export function noise(seed: number, out: Float64Array): void {
  const rng = makeRng(seed);
  for (let i = 0; i < out.length; i += 2) {
    const r = Math.sqrt(-2 * Math.log(1 - rng()));
    const a = 2 * Math.PI * rng();
    out[i] = r * Math.cos(a);
    if (i + 1 < out.length) out[i + 1] = r * Math.sin(a);
  }
}

const eps = new Float64Array(PARAM_COUNT);
const cand = new Float64Array(PARAM_COUNT);

function score(theta: Float64Array, levels: Track[]): number {
  let sum = 0;
  for (const t of levels) sum += fitness(runEpisode(t, defaultConfig, theta), t);
  return sum / levels.length;
}

self.onmessage = (e: MessageEvent<Job>) => {
  const job = e.data;
  if (job.type === "build") {
    const level = buildLevel({ seed: job.seed, difficulty: job.difficulty, length: job.length });
    self.postMessage({ id: job.id, attempt: level.attempt, verified: level.verified, failures: level.failures });
  } else if (job.type === "score") {
    const levels = job.levels.map(trackFor);
    const plus: number[] = [];
    const minus: number[] = [];
    for (const seed of job.seeds) {
      noise(seed, eps);
      for (let i = 0; i < PARAM_COUNT; i++) cand[i] = job.theta[i]! + job.sigma * eps[i]!;
      plus.push(score(cand, levels));
      for (let i = 0; i < PARAM_COUNT; i++) cand[i] = job.theta[i]! - job.sigma * eps[i]!;
      minus.push(score(cand, levels));
    }
    self.postMessage({ id: job.id, plus, minus });
  } else {
    const results = job.levels.map((l) => {
      const t = trackFor(l);
      const r = runEpisode(t, defaultConfig, job.theta);
      return { finished: r.finished, progress: r.progress, seconds: r.ticks / 120, fitness: fitness(r, t) };
    });
    self.postMessage({ id: job.id, results });
  }
};
