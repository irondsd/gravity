// Builds the training set: verified-passable levels at every difficulty, saved as a small list
// of level names (seed, difficulty, attempt). Run with: bun src/ai/pool.ts
import { cpus } from "node:os";
import type { LevelRef } from "./worker";
import { WorkerPool } from "./workers";

const LENGTH = Number(process.env.LENGTH ?? 500);
const PER_BUCKET = Number(process.env.PER_BUCKET ?? 24);
const OUT = process.env.OUT ?? `data/pool-${LENGTH}.json`;
const FIRST_SEED = Number(process.env.FIRST_SEED ?? 100000); // away from the seeds a player is likely to pick

export interface PoolFile {
  length: number;
  /** One list of levels per difficulty step: 0, 0.05, ... 1. */
  buckets: { difficulty: number; levels: LevelRef[] }[];
}

const pool = new WorkerPool(Math.max(1, cpus().length - 2));
const file: PoolFile = { length: LENGTH, buckets: [] };
const t0 = performance.now();
const jobs: Promise<void>[] = [];
let done = 0;
for (let b = 0; b <= 20; b++) {
  const difficulty = b / 20;
  const bucket = { difficulty, levels: [] as LevelRef[] };
  file.buckets.push(bucket);
  for (let i = 0; i < PER_BUCKET; i++) {
    const seed = FIRST_SEED + b * 1000 + i;
    jobs.push(
      pool.run<{ attempt: number; verified: boolean }>({ type: "build", seed, difficulty, length: LENGTH }).then((r) => {
        if (r.verified) bucket.levels.push({ seed, difficulty, length: LENGTH, attempt: r.attempt });
        if (++done % 50 === 0) console.log(`${done}/${21 * PER_BUCKET} levels checked, ${((performance.now() - t0) / 1000).toFixed(0)}s`);
      }),
    );
  }
}
await Promise.all(jobs);
for (const b of file.buckets) b.levels.sort((a, c) => a.seed - c.seed);
await Bun.write(OUT, JSON.stringify(file));
console.log(`wrote ${OUT}: ` + file.buckets.map((b) => `${Math.round(b.difficulty * 100)}:${b.levels.length}`).join(" "));
pool.close();

process.exit(0);
