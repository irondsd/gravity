import { expect, test } from "bun:test";
import { BikeEnv } from "../env/env";
import { buildTestTrack } from "../level/testTrack";
import { TrackBuilder } from "../level/builder";
import {
  cloneState,
  createState,
  defaultConfig,
  hashState,
  IN_BRAKE,
  IN_THROTTLE,
  RUNNING,
  tick,
  TICK_RATE,
} from "./index";

// Small deterministic PRNG so tests do not depend on Math.random.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInputs(seed: number, ticks: number): number[] {
  const r = rng(seed);
  const out: number[] = [];
  let cur = 1;
  for (let i = 0; i < ticks; i++) {
    if (r() < 0.05) cur = Math.floor(r() * 16);
    out.push(cur);
  }
  return out;
}

function flatTrack() {
  return new TrackBuilder().flat(600).build(10, 10);
}

test("same inputs produce the same run, bit for bit", () => {
  const track = buildTestTrack();
  const inputs = randomInputs(42, TICK_RATE * 30);
  const run = () => {
    const s = createState(track, defaultConfig);
    const hashes: number[] = [];
    for (const inp of inputs) {
      tick(s, inp, track, defaultConfig);
      hashes.push(hashState(s));
    }
    return hashes;
  };
  expect(run()).toEqual(run());
});

test("a cloned state continues identically", () => {
  const track = buildTestTrack();
  const inputs = randomInputs(7, TICK_RATE * 20);
  const a = createState(track, defaultConfig);
  for (let i = 0; i < 600; i++) tick(a, inputs[i]!, track, defaultConfig);
  const b = cloneState(a);
  for (let i = 600; i < inputs.length; i++) {
    tick(a, inputs[i]!, track, defaultConfig);
    tick(b, inputs[i]!, track, defaultConfig);
  }
  expect(hashState(b)).toBe(hashState(a));
});

test("bike settles and stays still with no input", () => {
  const track = flatTrack();
  const s = createState(track, defaultConfig);
  for (let i = 0; i < TICK_RATE * 3; i++) tick(s, 0, track, defaultConfig);
  const x = s.x;
  for (let i = 0; i < TICK_RATE * 3; i++) tick(s, 0, track, defaultConfig);
  expect(s.status).toBe(RUNNING);
  expect(Math.abs(s.x - x)).toBeLessThan(0.01);
  expect(Math.hypot(s.vx, s.vy)).toBeLessThan(0.01);
  expect(s.rear.grounded + s.front.grounded).toBe(2);
});

test("throttle accelerates on flat ground without flipping, brake stops it", () => {
  const track = flatTrack();
  const s = createState(track, defaultConfig);
  for (let i = 0; i < TICK_RATE * 4; i++) tick(s, IN_THROTTLE, track, defaultConfig);
  expect(s.status).toBe(RUNNING);
  expect(s.vx).toBeGreaterThan(15);
  expect(s.rx).toBeGreaterThan(0.9);
  for (let i = 0; i < TICK_RATE * 5; i++) tick(s, IN_BRAKE, track, defaultConfig);
  expect(s.status).toBe(RUNNING);
  expect(Math.abs(s.vx)).toBeLessThan(0.05);
});

test("env steps and reports observations", () => {
  const env = new BikeEnv(buildTestTrack(), defaultConfig);
  const obs = env.reset();
  expect(obs.length).toBeGreaterThan(10);
  const snap = env.saveState();
  const r1 = env.step(3);
  env.loadState(snap);
  const r2 = env.step(3);
  expect(Array.from(r2.obs)).toEqual(Array.from(r1.obs));
  expect(r1.reward).toBe(r2.reward);
});

import { generateTrack } from "../level/generator";
import { trackHash } from "../game/replay";

test("level generator is deterministic and always produces a valid track", () => {
  for (const difficulty of [0, 0.3, 0.7, 1]) {
    for (let seed = 0; seed < 60; seed++) {
      const p = { seed, difficulty, length: 400 };
      const a = generateTrack(p); // makeTrack throws if x is not strictly increasing
      expect(trackHash(generateTrack(p))).toBe(trackHash(a));
      expect(a.finishX).toBeGreaterThan(380);
      for (let i = 0; i < a.n; i++) expect(Number.isFinite(a.ys[i]!)).toBe(true);
    }
  }
  const base = trackHash(generateTrack({ seed: 1, difficulty: 0.3, length: 400 }));
  expect(trackHash(generateTrack({ seed: 2, difficulty: 0.3, length: 400 }))).not.toBe(base);
  expect(trackHash(generateTrack({ seed: 1, difficulty: 0.4, length: 400 }))).not.toBe(base);
});
