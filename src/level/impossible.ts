// The impossible modes: tracks built to sit at the very edge of what the bike can do.
// They are not checked by the solver (a solver-proven track is one you can always ride slowly);
// instead each climbing wall is measured as it is built, by riding it with a simple climbing bot.
// Deterministic like the standard generator: the bot uses no trig, and the sim is deterministic.
import { createState, defaultConfig, heightAt, IN_LEAN_BACK, IN_LEAN_FWD, IN_THROTTLE, RUNNING, tick, type BikeConfig, type SimState, type Track } from "../sim";
import { TrackBuilder } from "./builder";
import { makeRng, setGapScale, standardFeature, type LevelParams, type Rnd, type TrackKind } from "./generator";

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const START_FLAT = 18;
const END_FLAT = 30;

type Build = (b: TrackBuilder, d: number, rnd: Rnd) => void;
interface Piece {
  name: string;
  weight: (d: number) => number;
  build: Build;
}

function pick(pieces: Piece[], d: number, rng: () => number): Piece {
  let total = 0;
  for (const p of pieces) total += Math.max(0, p.weight(d));
  let r = rng() * total;
  for (const p of pieces) {
    const w = Math.max(0, p.weight(d));
    if (w <= 0) continue;
    r -= w;
    if (r < 0) return p;
  }
  return pieces[0]!;
}

// ---------------------------------------------------------------- the climbing bot

/** Full throttle, bike kept in line with the ground just ahead (nose a little down so it does not loop out). */
export function climbInput(s: SimState, track: Track): number {
  const slope = (heightAt(track, s.x + 1.4) - heightAt(track, s.x - 0.6)) / 2;
  const tilt = -0.08;
  const tx = 1 - slope * tilt;
  const ty = slope + tilt;
  const err = (s.rx * ty - s.ry * tx) / Math.sqrt(tx * tx + ty * ty);
  const want = err * 6 - s.w * 0.6;
  let input = s.vx < -0.3 ? 0 : IN_THROTTLE;
  if (want > 0.4) input |= IN_LEAN_BACK;
  else if (want < -0.4) input |= IN_LEAN_FWD;
  return input;
}

/** How high up a face (above `baseY`) the bot gets, starting from rest, before it stalls or crashes. */
export function reach(track: Track, baseY: number, cfg: BikeConfig = defaultConfig): number {
  const s = createState(track, cfg);
  let top = -Infinity;
  let moved = false;
  for (let i = 0; i < 120 * 14 && s.status === RUNNING; i++) {
    tick(s, climbInput(s, track), track, cfg);
    if (s.vx > 1) moved = true;
    if (s.y > top) top = s.y;
    if (moved && s.vx < -0.3) break; // stalled and rolling back
  }
  return top - baseY;
}

// ---------------------------------------------------------------- climb pieces

/** Roughness used both on the real track and on the probe a wall is measured on. */
const climbRough = (d: number) => ({ amp: 0.015 + 0.09 * d, spacing: mix(2, 1.1, d) });

/**
 * The heart of Climb: a face steeper than the bike can drive up, with a dip and a run-up before it.
 * Its height is set from how far the bot gets up it from a standstill: comfortably short of that
 * on easy levels, right at it (or a little past) on the last ones.
 */
function wall(b: TrackBuilder, d: number, rnd: Rnd): void {
  const k = rnd(mix(1.1, 1.5, d), mix(1.4, 2.6, d));
  const plateau = rnd(mix(7, 4, d), mix(12, 8, d));
  const dip = rnd(mix(1, 0, d), mix(3.5, 1.5, d));
  const dipLen = 2 + dip * rnd(3, 4.5);
  const run = rnd(mix(8, 2, d), mix(22, 12, d));
  const bendIn = rnd(2.5, 5) * mix(1, 0.6, d);
  const bendOut = rnd(2, 3.5);
  const fraction = mix(0.45, 0.98, d) * rnd(0.94, 1.06);
  const rough = climbRough(d);
  const roughSeed = Math.floor(rnd(0, 2 ** 31));

  const shape = (t: TrackBuilder, height: number) => {
    t.flat(plateau);
    if (dip > 0.2) t.smooth(dipLen, -dip);
    t.flat(run);
    // faces too short for the full bends get sharper ones
    const bendRise = (k * (bendIn + bendOut)) / 2;
    const squeeze = Math.min(1, height / bendRise);
    t.bend(bendIn * squeeze, 0, k);
    const straight = height - bendRise * squeeze;
    if (straight > 0.01) t.slope(straight / k, straight);
    t.bend(bendOut * squeeze, k, 0);
  };

  // measure: the same face, very tall, ridden from rest at the start of the plateau
  const probe = new TrackBuilder();
  probe.sample = b.sample;
  probe.flat(3);
  shape(probe, 60);
  probe.flat(20);
  probe.roughen(makeRng(roughSeed), rough.amp, rough.spacing, 4, probe.x - 21);
  const track = probe.build(2, 1);
  const best = reach(track, -dip);
  // quantized so that tiny float differences between engines cannot change the track
  const height = Math.max(1.5 + 2 * d, Math.round(best * fraction * 4) / 4);
  shape(b, height + dip);
}

const CLIMB: Piece[] = [
  { name: "wall", weight: (d) => 1.5 + 3 * d, build: wall },
  {
    // A long drag just under the steepest slope the engine can hold.
    name: "ramp",
    weight: (d) => 2 - d,
    build: (b, d, rnd) => {
      const k = rnd(mix(0.45, 0.75, d), mix(0.7, 0.98, d));
      const h = rnd(4, 8 + 14 * d);
      const bend = rnd(2, 4);
      b.bend(bend, 0, k);
      b.slope(h / k, h);
      b.bend(bend, k, 0).flat(rnd(3, 6));
    },
  },
  {
    // Ledges on a slope: lift the front or stop dead.
    name: "ledges",
    weight: (d) => 0.6 + 1.2 * d,
    build: (b, d, rnd) => {
      const n = 3 + Math.floor(rnd(0, 2 + 4 * d));
      const k = rnd(0.2, 0.35 + 0.35 * d);
      for (let i = 0; i < n; i++) {
        const len = rnd(mix(3.5, 1.8, d), 4.5);
        b.slope(len, len * k).step(rnd(0.2, 0.3 + 0.35 * d));
      }
      b.flat(rnd(3, 6));
    },
  },
  {
    // Bumps that eat speed right where it is needed.
    name: "rollers",
    weight: () => 0.8,
    build: (b, d, rnd) => {
      const n = 2 + Math.floor(rnd(0, 3));
      const h = rnd(0.3, 0.5 + 1.2 * d);
      for (let i = 0; i < n; i++) b.bump(rnd(4, 7), h * rnd(0.6, 1));
    },
  },
];

// ---------------------------------------------------------------- descent pieces

/** A downward slope with smooth ends, `k` steep and `h` deep. */
function chute(b: TrackBuilder, k: number, h: number, bendIn: number, bendOut: number): void {
  const bendDrop = (k * (bendIn + bendOut)) / 2;
  const squeeze = Math.min(1, h / bendDrop);
  b.bend(bendIn * squeeze, 0, -k);
  const straight = h - bendDrop * squeeze;
  if (straight > 0.01) b.slope(straight / k, -straight);
  b.bend(bendOut * squeeze, -k, 0);
}

/** A stretch of loose rocks on a downhill: sharp edges that throw the bike around. */
function rocks(b: TrackBuilder, d: number, rnd: Rnd, scale = 1): void {
  const n = 4 + Math.floor(rnd(0, 4 + 9 * d));
  const fall = rnd(0.1, 0.2 + 0.45 * d);
  for (let i = 0; i < n; i++) {
    const h = rnd(0.12 + 0.3 * d * d, 0.25 + 1.4 * d) * scale;
    const w1 = rnd(0.5, 1.5);
    const w2 = rnd(0.4, 1.4);
    const kind = rnd(0, 1);
    if (kind < 0.4) b.slope(w1, h - fall * w1).slope(w2, -h - fall * w2);
    else if (kind < 0.7) b.step(h).slope(w1 + w2, -h - fall * (w1 + w2));
    else b.slope(w1 + w2, h - fall * (w1 + w2)).step(-h);
  }
}

const DESCENT: Piece[] = [
  {
    name: "chute",
    weight: () => 2.2,
    build: (b, d, rnd) => {
      const k = rnd(mix(0.45, 1.1, d), mix(0.75, 2.4, d));
      const h = rnd(5, 10 + 26 * d);
      chute(b, k, h, rnd(2, 4) * mix(1, 0.5, d), rnd(3, 7) * mix(1, 0.4, d));
      // hard chutes run straight out into rocks
      if (rnd(0, 1) < d * 0.7) rocks(b, d, rnd, 0.8);
      b.flat(rnd(mix(8, 1.5, d), 10));
    },
  },
  {
    // A vertical drop. Easy ones land on a downslope; hard ones land on flat ground or straight into rocks.
    name: "cliff",
    weight: (d) => 0.6 + 2.6 * d,
    build: (b, d, rnd) => {
      b.flat(rnd(mix(8, 3, d), 10));
      const h = rnd(1.5 + 3 * d, 2.5 + 17 * d);
      b.step(-h);
      const r = rnd(0, 1);
      if (r < mix(0.75, 0.2, d)) {
        const k = rnd(0.5, 0.9);
        chute(b, k, h * rnd(0.5, 1) + 1, 1.5, 3);
      } else if (r < mix(0.95, 0.5, d)) {
        b.flat(rnd(0.5, 2));
      } else {
        rocks(b, d, rnd);
      }
      b.flat(rnd(mix(10, 1.5, d), 12));
    },
  },
  {
    name: "rocks",
    weight: (d) => 0.4 + 3 * d,
    build: (b, d, rnd) => {
      rocks(b, d, rnd);
      b.flat(rnd(mix(6, 2, d), 8));
    },
  },
  {
    // Drops one after another, too close to settle between them.
    name: "stairs",
    weight: (d) => 1 + d,
    build: (b, d, rnd) => {
      const n = 2 + Math.floor(rnd(0, 2 + 4 * d));
      for (let i = 0; i < n; i++) b.step(-rnd(0.5, 1 + 2.5 * d)).flat(rnd(mix(5, 1.4, d), 5.5));
    },
  },
  {
    // A dive that ends in a kicker: arrive too fast and it fires the bike into the air.
    name: "compression",
    weight: (d) => (d < 0.15 ? 0 : 0.5 + 2 * d),
    build: (b, d, rnd) => {
      const h = rnd(3, 5 + 10 * d);
      b.smooth(h * rnd(mix(2.5, 1.4, d), 3), -h);
      const kick = rnd(0.8 + d, 1.4 + 2.2 * d);
      b.slope(kick * rnd(1.4, 2.4), kick);
      b.step(-(kick + rnd(1, 3 + 6 * d)));
      if (rnd(0, 1) < mix(0.8, 0.4, d)) chute(b, rnd(0.4, 0.8), rnd(2, 5), 1, 2.5);
      b.flat(rnd(mix(10, 3, d), 12));
    },
  },
  {
    name: "breather",
    weight: (d) => 1.2 - 0.8 * d,
    build: (b, d, rnd) => {
      const n = 1 + Math.floor(rnd(0, 3));
      for (let i = 0; i < n; i++) b.bump(rnd(5, 9), rnd(0.3, 0.6 + 1.2 * d));
      b.flat(rnd(2, 6));
    },
  },
];

// ---------------------------------------------------------------- generators

export function generateImpossible(p: LevelParams, kind: TrackKind): Track {
  const rng = makeRng((p.seed ^ Math.imul((p.attempt ?? 0) + 7, 0x9e3779b9)) >>> 0);
  const rnd: Rnd = (lo, hi) => lo + (hi - lo) * rng();
  const difficulty = Math.min(1, Math.max(0, p.difficulty));
  setGapScale(p.gapScale ?? 1);
  const b = new TrackBuilder();
  b.sample = mix(0.5, 1.4, difficulty);
  b.flat(START_FLAT);

  while (b.x < p.length) {
    const t = Math.min(1, b.x / p.length);
    // like the standard levels, each one starts a little easier and ends at its rating
    const d = difficulty * (0.8 + 0.2 * t);
    if (kind === "climb") pick(CLIMB, d, rng).build(b, d, rnd);
    else if (kind === "descent") pick(DESCENT, d, rng).build(b, d, rnd);
    else campaignPiece(b, d, rng, rnd);
    b.flat(mix(6, 1.5, d) + rnd(0, 3));
  }

  const end = b.x;
  b.flat(END_FLAT);
  const amp = kind === "climb" ? climbRough(difficulty).amp : 0.03 + 0.24 * difficulty * difficulty;
  const spacing = kind === "climb" ? climbRough(difficulty).spacing : mix(2, 0.9, difficulty);
  b.roughen(rng, amp, spacing, START_FLAT - 2, end + 2);
  return b.build(6, 14);
}

/** Campaign: the standard pieces at full strength, mixed with climbs and descents; the track wanders up and down. */
function campaignPiece(b: TrackBuilder, d: number, rng: () => number, rnd: Rnd): void {
  const LIMIT = 45;
  const up = b.y < LIMIT;
  const down = b.y > -LIMIT;
  const r = rng();
  if (r < 0.4) standardFeature(b, d, rng, rnd, up, down);
  else if ((r < 0.7 && up) || !down) pick(CLIMB, d, rng).build(b, d, rnd);
  else pick(DESCENT, d, rng).build(b, d, rnd);
}
