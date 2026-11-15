// Trains the general AI rider with an evolution strategy, in parallel on all CPU cores.
// Each generation tries many small variations of the network on a handful of levels and moves
// the network toward the variations that got further, faster. Difficulty rises as it improves.
//
//   bun src/ai/train.ts            train (resumes from data/rider.json if present)
//   MINUTES=30 bun src/ai/train.ts train for a fixed time
//   EVAL=1 bun src/ai/train.ts     only measure the saved rider on held-out levels
import { cpus } from "node:os";
import { makeRng } from "../level/generator";
import { LAYERS, DECISION_TICKS, PARAM_COUNT, type RiderFile } from "./policy";
import type { PoolFile } from "./pool";
import { noise, type LevelRef } from "./worker";
import { WorkerPool } from "./workers";

const env = (k: string, d: number) => Number(process.env[k] ?? d);
const MINUTES = env("MINUTES", 20);
const PAIRS = env("PAIRS", 96); // each pair is one variation tried in both directions
const LEVELS_PER_GEN = env("LEVELS", 6);
const SIGMA = env("SIGMA", 0.06);
const LR = env("LR", 0.03);
const HOLDOUT = 6; // levels per difficulty kept out of training, for honest measurement
const POOL = process.env.POOL ?? "data/pool-500.json";
const OUT = process.env.OUT ?? "data/rider.json";
const FRESH = process.env.FRESH === "1";

interface Checkpoint extends RiderFile {
  generation: number;
  difficulty: number;
}

const poolFile = (await Bun.file(POOL).json()) as PoolFile;
const trainSet = poolFile.buckets.map((b) => b.levels.slice(0, Math.max(1, b.levels.length - HOLDOUT)));
const testSet = poolFile.buckets.map((b) => b.levels.slice(Math.max(1, b.levels.length - HOLDOUT)));

const theta = new Float64Array(PARAM_COUNT);
let generation = 0;
let difficulty = 0; // top of the difficulty range currently trained on, 0..1
const saved = !FRESH && (await Bun.file(OUT).exists()) ? ((await Bun.file(OUT).json()) as Checkpoint) : null;
if (saved && saved.theta.length === PARAM_COUNT) {
  theta.set(saved.theta);
  generation = saved.generation ?? 0;
  difficulty = saved.difficulty ?? 0;
  console.log(`resuming from ${OUT}: generation ${generation}, difficulty ${Math.round(difficulty * 100)}`);
} else {
  noise(12345, theta);
  for (let i = 0; i < PARAM_COUNT; i++) theta[i] = theta[i]! * 0.1;
  // start out wanting to hold the throttle: bias of the "throttle" output
  const lastLayer = PARAM_COUNT - (LAYERS[LAYERS.length - 2]! + 1) * LAYERS[LAYERS.length - 1]!;
  theta[lastLayer + (LAYERS[LAYERS.length - 2]! + 1) * 1] = 1;
}

const pool = new WorkerPool(Math.max(1, cpus().length - 1));

interface EvalRow {
  finished: boolean;
  progress: number;
  seconds: number;
  fitness: number;
}

async function evaluate(levels: LevelRef[]): Promise<EvalRow[]> {
  const chunk = Math.ceil(levels.length / pool.size);
  const jobs: Promise<{ results: EvalRow[] }>[] = [];
  for (let i = 0; i < levels.length; i += chunk) jobs.push(pool.run({ type: "eval", theta, levels: levels.slice(i, i + chunk) }));
  return (await Promise.all(jobs)).flatMap((r) => r.results);
}

/** Held-out levels, grouped by difficulty: how often the rider finishes and how far it gets. */
async function report(): Promise<string> {
  const lines: string[] = ["difficulty  finished  avg progress  avg time when finished"];
  for (let b = 0; b <= 20; b += 2) {
    const levels = [...(testSet[b] ?? []), ...(b + 1 <= 20 && b > 0 ? [] : [])];
    if (levels.length === 0) continue;
    const rows = await evaluate(levels);
    const fin = rows.filter((r) => r.finished);
    const prog = rows.reduce((a, r) => a + r.progress, 0) / rows.length;
    const time = fin.length ? (fin.reduce((a, r) => a + r.seconds, 0) / fin.length).toFixed(1) + "s" : "-";
    lines.push(`${String(b * 5).padStart(6)}      ${fin.length}/${rows.length}       ${(prog * 100).toFixed(0).padStart(3)}%         ${time}`);
  }
  return lines.join("\n");
}

async function save(note: string): Promise<void> {
  const file: Checkpoint = { layers: LAYERS, decisionTicks: DECISION_TICKS, theta: Array.from(theta), note, generation, difficulty };
  await Bun.write(OUT, JSON.stringify(file));
}

if (process.env.EVAL === "1") {
  console.log(await report());
  pool.close();
  process.exit(0);
}

console.log(`training: ${PARAM_COUNT} weights, ${PAIRS * 2} rides x ${LEVELS_PER_GEN} levels per generation, ${pool.size} threads, ${MINUTES} min`);
const adamM = new Float64Array(PARAM_COUNT);
const adamV = new Float64Array(PARAM_COUNT);
const grad = new Float64Array(PARAM_COUNT);
const eps = new Float64Array(PARAM_COUNT);
let adamT = 0;
let finishEma = 0;
const started = performance.now();
let lastLog = started;

while ((performance.now() - started) / 60000 < MINUTES) {
  generation++;
  const rng = makeRng(generation * 7919);
  // levels for this generation: spread over the difficulties learned so far, one right at the top
  const levels: LevelRef[] = [];
  for (let k = 0; k < LEVELS_PER_GEN; k++) {
    const d = k === 0 ? difficulty : Math.max(0, difficulty - 0.4 * rng());
    const bucket = trainSet[Math.min(20, Math.round(d * 20))]!;
    levels.push(bucket[Math.floor(rng() * bucket.length)]!);
  }

  const seeds = Array.from({ length: PAIRS }, (_, i) => generation * 100003 + i);
  const chunk = Math.ceil(PAIRS / pool.size);
  const jobs: Promise<{ plus: number[]; minus: number[] }>[] = [];
  for (let i = 0; i < PAIRS; i += chunk) jobs.push(pool.run({ type: "score", theta, sigma: SIGMA, seeds: seeds.slice(i, i + chunk), levels }));
  const centerJob = pool.run<{ results: EvalRow[] }>({ type: "eval", theta, levels });
  const parts = await Promise.all(jobs);
  const center = (await centerJob).results;
  const plus = parts.flatMap((p) => p.plus);
  const minus = parts.flatMap((p) => p.minus);

  // rank the rides; only the order matters, which keeps one lucky run from dominating
  const all = [...plus, ...minus];
  const order = all.map((f, i) => [f, i] as const).sort((a, b) => a[0] - b[0]);
  const util = new Float64Array(all.length);
  order.forEach(([, idx], rank) => (util[idx] = rank / (all.length - 1) - 0.5));

  grad.fill(0);
  for (let p = 0; p < PAIRS; p++) {
    const w = util[p]! - util[PAIRS + p]!;
    if (w === 0) continue;
    noise(seeds[p]!, eps);
    for (let i = 0; i < PARAM_COUNT; i++) grad[i] = grad[i]! + w * eps[i]!;
  }
  adamT++;
  const c1 = 1 - Math.pow(0.9, adamT);
  const c2 = 1 - Math.pow(0.999, adamT);
  for (let i = 0; i < PARAM_COUNT; i++) {
    const g = grad[i]! / (PAIRS * SIGMA);
    adamM[i] = 0.9 * adamM[i]! + 0.1 * g;
    adamV[i] = 0.999 * adamV[i]! + 0.001 * g * g;
    theta[i] = theta[i]! * 0.9995 + (LR * (adamM[i]! / c1)) / (Math.sqrt(adamV[i]! / c2) + 1e-8);
  }

  // raise the difficulty once the rider finishes most of what it is given
  const finishRate = center.filter((r) => r.finished).length / center.length;
  finishEma = 0.85 * finishEma + 0.15 * finishRate;
  if (finishEma > 0.6 && difficulty < 1) difficulty = Math.min(1, difficulty + 0.01);

  const now = performance.now();
  if (now - lastLog > 30000) {
    lastLog = now;
    const mean = all.reduce((a, b) => a + b, 0) / all.length;
    const prog = center.reduce((a, r) => a + r.progress, 0) / center.length;
    console.log(
      `gen ${generation}  ${((now - started) / 60000).toFixed(1)}min  difficulty ${Math.round(difficulty * 100)}  finishing ${(finishEma * 100).toFixed(0)}%  progress ${(prog * 100).toFixed(0)}%  score ${mean.toFixed(2)}`,
    );
    await save("in training");
  }
}

await save(`trained ${generation} generations, reached difficulty ${Math.round(difficulty * 100)}`);
console.log(`\nsaved ${OUT} after ${generation} generations. Held-out levels:`);
console.log(await report());
pool.close();

process.exit(0);
