// Seeded level generator. The same parameters always give exactly the same track,
// on any JS engine: only integer math and + - * / are used (no trig, no Math.random).
import type { Track } from "../sim/track";
import { TrackBuilder } from "./builder";
import { generateImpossible } from "./impossible";

export interface LevelParams {
  seed: number;
  /** 0 (gentle) .. 1 (barely passable) */
  difficulty: number;
  /** Approximate track length in meters. */
  length: number;
  /** Which try this is, when earlier tries for the same seed were rejected as unpassable. */
  attempt?: number;
  /** Multiplier on how wide jumps are: below 1 for heavy gravity (short jumps), above 1 for light. Default 1. */
  gapScale?: number;
  /** Which generator: the standard mixed terrain (default), or one of the impossible modes. */
  kind?: TrackKind;
}

export type TrackKind = "standard" | "climb" | "descent" | "campaign";

/** mulberry32: small, fast, well-distributed 32-bit PRNG. Returns values in [0, 1). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Net = "up" | "down" | "level";
export type Rnd = (lo: number, hi: number) => number;
/** Set for the duration of one generateTrack call. */
let gapScale = 1;

interface Feature {
  name: string;
  /** Whether the piece ends higher, lower, or level; used to keep the track from drifting away. */
  net: Net;
  /** Relative chance of being picked at difficulty d (0..1). */
  weight: (d: number) => number;
  /** d is the difficulty 0..1 at this point of the track. */
  build: (b: TrackBuilder, d: number, rnd: Rnd) => void;
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
/** 0 below `from`, rising linearly to 1 at difficulty 1. */
const above = (d: number, from: number) => (d <= from ? 0 : (d - from) / (1 - from));

// Rough bike limits these pieces are sized against (default tuning): gravity 15 m/s^2,
// top speed about 27 m/s, a jump from a 20-degree ramp carries about v^2 * 0.043 meters.
const FEATURES: Feature[] = [
  // ---- terrain: gets bigger and steeper with difficulty ----
  {
    name: "hill",
    net: "level",
    weight: (d) => 4 - 3 * d,
    build: (b, d, rnd) => {
      const h = rnd(1.2, 2 + 9 * d);
      const half = h * rnd(mix(6, 2.2, d), mix(8, 3.2, d));
      b.smooth(half, h).smooth(half, -h);
    },
  },
  {
    name: "valley",
    net: "level",
    weight: () => 2,
    build: (b, d, rnd) => {
      const h = rnd(1.2, 2 + 8 * d);
      const half = h * rnd(mix(6, 2.4, d), mix(8, 3.4, d));
      b.smooth(half, -h).smooth(half, h);
    },
  },
  {
    name: "rollers",
    net: "level",
    weight: () => 2,
    build: (b, d, rnd) => {
      const n = 3 + Math.floor(rnd(0, 4));
      const h = rnd(0.3, 0.5 + 1.8 * d);
      const len = rnd(6, 9) - 3 * d;
      for (let i = 0; i < n; i++) b.bump(len, h * rnd(0.6, 1));
    },
  },
  {
    name: "tabletop",
    net: "level",
    weight: () => 1.5,
    build: (b, d, rnd) => {
      const h = rnd(1, 1.5 + 4 * d);
      const ramp = h * rnd(mix(2.6, 1.6, d), mix(3.5, 2.2, d));
      b.slope(ramp, h).flat(rnd(4, 8 + 6 * d)).slope(ramp, -h);
    },
  },
  {
    name: "kicker",
    net: "down",
    weight: (d) => 1 + 2 * d,
    build: (b, d, rnd) => {
      const h = rnd(0.8, 1.2 + 3.5 * d);
      b.slope(h * rnd(2.4, 4), h).step(-(h + rnd(0, 3 * d))).flat(rnd(mix(18, 7, d), 22));
    },
  },
  {
    name: "stairsUp",
    net: "up",
    weight: (d) => 0.5 + 2.5 * d,
    build: (b, d, rnd) => {
      const n = 2 + Math.floor(rnd(0, 2 + 4 * d));
      const rise = rnd(0.12, 0.16 + 0.24 * d);
      for (let i = 0; i < n; i++) b.step(rise * rnd(0.7, 1)).flat(rnd(mix(2.5, 1.2, d), 4));
    },
  },
  {
    name: "stairsDown",
    net: "down",
    weight: (d) => 0.5 + 2 * d,
    build: (b, d, rnd) => {
      const n = 2 + Math.floor(rnd(0, 2 + 4 * d));
      const rise = rnd(0.2, 0.3 + 1.0 * d);
      for (let i = 0; i < n; i++) b.step(-rise * rnd(0.6, 1)).flat(rnd(mix(3, 1.5, d), 5));
    },
  },
  {
    name: "climb",
    net: "up",
    weight: (d) => 0.5 + 2 * d,
    build: (b, d, rnd) => {
      const h = rnd(2, 3 + 7 * d);
      const steepness = rnd(0.3, 0.38 + 0.4 * d);
      b.slope(h / steepness, h).flat(rnd(4, 10));
    },
  },
  {
    name: "descent",
    net: "down",
    weight: () => 1.5,
    build: (b, d, rnd) => {
      const h = rnd(3, 5 + 8 * d);
      b.smooth(h * rnd(mix(3, 1.6, d), 4), -h);
    },
  },
  {
    name: "drop",
    net: "down",
    weight: (d) => 0.5 + 2 * d,
    build: (b, d, rnd) => {
      b.step(-rnd(0.8, 1.2 + 4 * d)).flat(rnd(mix(12, 5, d), 16));
    },
  },
  {
    name: "washboard",
    net: "level",
    weight: (d) => 0.5 + 2 * d,
    build: (b, d, rnd) => {
      const n = 6 + Math.floor(rnd(0, 8));
      const h = rnd(0.08, 0.1 + 0.35 * d);
      const half = rnd(0.6, 1.1);
      for (let i = 0; i < n; i++) b.slope(half, h).slope(half, -h);
    },
  },

  // ---- gates: pieces that need a particular way of riding ----
  {
    // Needs speed: a pit to clear. Easy versions have a way out; hard ones are a trap with teeth.
    name: "gap",
    net: "level",
    weight: (d) => (d < 0.12 ? 0 : 1 + 4 * d),
    build: (b, d, rnd) => {
      const h = rnd(0.8, 1.2 + 1.2 * d);
      const width = rnd(3, 4 + 11 * d) * gapScale;
      const depth = rnd(1.5, 2.5 + 2 * d);
      // enough room to build the speed the jump needs, less generously as difficulty rises
      b.flat(width * rnd(mix(1.6, 0.7, d), 1.8));
      b.slope(h * rnd(2.6, 3.4), h).step(-(h + depth));
      if (d > 0.45) {
        const teeth = Math.max(1, Math.floor(width / 1.6));
        const w = width / teeth / 2;
        for (let i = 0; i < teeth; i++) b.slope(w, rnd(0.4, 0.9)).slope(w, -rnd(0.4, 0.9));
        b.step(depth);
      } else {
        b.flat(width).slope(depth * 2.2, depth);
      }
      b.flat(rnd(mix(14, 6, d), 18));
    },
  },
  {
    // Needs momentum: a face too steep to climb from a standstill.
    name: "wall",
    net: "up",
    weight: (d) => (d < 0.2 ? 0 : 0.5 + 3.5 * d),
    build: (b, d, rnd) => {
      const h = rnd(1, 1.3 + 2.4 * d);
      const steepness = rnd(0.95, 1.1 + 0.7 * d);
      b.flat(rnd(mix(14, 4, d), 16)).slope(h / steepness, h).flat(rnd(4, 9));
    },
  },
  {
    // Needs the front wheel lifted: a ledge too tall to simply roll into.
    name: "ledge",
    net: "up",
    weight: (d) => (d < 0.25 ? 0 : 3 * d),
    build: (b, d, rnd) => {
      b.flat(rnd(5, 9)).step(rnd(0.3, 0.32 + 0.4 * d)).flat(rnd(3, 7));
    },
  },
  {
    // Needs speed kept up: holes that swallow a slow wheel.
    name: "potholes",
    net: "level",
    weight: (d) => (d < 0.2 ? 0 : 0.5 + 3 * d),
    build: (b, d, rnd) => {
      const n = 1 + Math.floor(rnd(0, 1 + 3 * d));
      for (let i = 0; i < n; i++) {
        const depth = rnd(0.35, 0.45 + 0.8 * d);
        b.step(-depth).flat(rnd(0.7, 0.9 + 0.9 * d)).step(depth).flat(rnd(mix(4, 1.3, d), 5));
      }
    },
  },
  {
    // Needs the brakes: a ditch with a face that punishes arriving fast.
    name: "ditch",
    net: "level",
    weight: (d) => (d < 0.15 ? 0 : 1 + 3 * d),
    build: (b, d, rnd) => {
      const h = rnd(0.7, 0.9 + 2 * d);
      b.slope(h * rnd(1.4, 2.4), -h).slope(h * rnd(mix(1.6, 0.7, d), 1.8), h).flat(rnd(3, 6));
    },
  },
  {
    // Needs throttle control: a row of sharp teeth.
    name: "sawtooth",
    net: "level",
    weight: (d) => (d < 0.2 ? 0 : 3.5 * d),
    build: (b, d, rnd) => {
      const n = 3 + Math.floor(rnd(0, 3 + 5 * d));
      const forward = rnd(0, 1) < 0.5;
      for (let i = 0; i < n; i++) {
        const h = rnd(0.2, 0.3 + 0.9 * d);
        const base = rnd(1.1, 2.4);
        if (forward) b.slope(base, h).step(-h);
        else b.step(h).slope(base, -h);
      }
      b.flat(rnd(2, 4));
    },
  },
];

/** Tries at full difficulty before the generator starts easing off. */
export const EASE_AFTER = 14;
const MAX_DRIFT = 12; // meters above or below the start before the generator steers back
const START_FLAT = 18;
const END_FLAT = 30;

export function generateTrack(p: LevelParams): Track {
  if (p.kind && p.kind !== "standard") return generateImpossible(p, p.kind);
  // each attempt for a seed is its own independent random stream
  const rng = makeRng((p.seed ^ Math.imul(p.attempt ?? 0, 0x9e3779b9)) >>> 0);
  const rnd: Rnd = (lo, hi) => lo + (hi - lo) * rng();
  // After many rejected tries the rating is eased a little per try, so a passable track always turns up.
  const eased = 1 - 0.02 * Math.max(0, (p.attempt ?? 0) - (EASE_AFTER - 1));
  const difficulty = Math.min(1, Math.max(0, p.difficulty)) * Math.max(0.5, eased);
  gapScale = p.gapScale ?? 1;
  const b = new TrackBuilder();
  // smooth curves turn angular as difficulty rises
  b.sample = mix(0.5, 2.2, difficulty);
  b.flat(START_FLAT);

  while (b.x < p.length) {
    // Levels start a little easier than their rating and end at it.
    const d = difficulty * (0.75 + 0.25 * Math.min(1, b.x / p.length));
    standardFeature(b, d, rng, rnd, !(b.y > MAX_DRIFT), !(b.y < -MAX_DRIFT));
    // breathing room between features shrinks to almost nothing at the top
    b.flat(mix(9, 0.8, d) + rnd(0, mix(4, 1.5, d)));
  }

  const end = b.x;
  b.flat(END_FLAT);
  // Jaggedness: nothing on easy levels, real chaos at the top.
  const rough = above(difficulty, 0.15);
  if (rough > 0) {
    const amp = 0.02 + 0.2 * rough * rough;
    const spacing = mix(2.4, 0.9, rough);
    b.roughen(rng, amp, spacing, START_FLAT - 2, end + 2);
  }
  return b.build(6, 14);
}

/** Pick and build one standard piece at difficulty `d`, leaving out pieces that climb or fall when not allowed. */
export function standardFeature(b: TrackBuilder, d: number, rng: () => number, rnd: Rnd, up: boolean, down: boolean): void {
  const allowed = (f: Feature) => (up || f.net !== "up") && (down || f.net !== "down");
  let total = 0;
  for (const f of FEATURES) total += allowed(f) ? f.weight(d) : 0;
  let pick = rng() * total;
  let chosen = FEATURES[0]!;
  for (const f of FEATURES) {
    if (!allowed(f)) continue;
    const w = f.weight(d);
    if (w <= 0) continue;
    chosen = f;
    pick -= w;
    if (pick < 0) break;
  }
  chosen.build(b, d, rnd);
}

/** Standard pieces size jumps by this; the impossible generators set it too. */
export function setGapScale(s: number): void {
  gapScale = s;
}
