// Rider ragdoll, thrown from the bike on a crash. Cosmetic: it never affects the sim,
// but it is stepped per tick with plain arithmetic, so a replay shows the same tumble.
import { collideCircle, TICK_DT, type BikeConfig, type Hit, type SimState, type Track } from "../sim";
import { J_ELBOW, J_FOOT, J_HAND, J_HEAD, J_HIP, J_KNEE, J_SHOULDER, JOINTS, riderPose } from "./rider";

// Points: head, shoulder, hip, then two legs and two arms.
export const R_HEAD = 0;
export const R_SHOULDER = 1;
export const R_HIP = 2;
export const R_KNEE_A = 3;
export const R_FOOT_A = 4;
export const R_KNEE_B = 5;
export const R_FOOT_B = 6;
export const R_ELBOW_A = 7;
export const R_HAND_A = 8;
export const R_ELBOW_B = 9;
export const R_HAND_B = 10;
const N = 11;

const SOURCE = [J_HEAD, J_SHOULDER, J_HIP, J_KNEE, J_FOOT, J_KNEE, J_FOOT, J_ELBOW, J_HAND, J_ELBOW, J_HAND];
const RADIUS = [0.13, 0.09, 0.09, 0.06, 0.06, 0.06, 0.06, 0.045, 0.045, 0.045, 0.045];

const STICKS: readonly (readonly [number, number])[] = [
  [R_HEAD, R_SHOULDER],
  [R_SHOULDER, R_HIP],
  [R_HIP, R_KNEE_A],
  [R_KNEE_A, R_FOOT_A],
  [R_HIP, R_KNEE_B],
  [R_KNEE_B, R_FOOT_B],
  [R_SHOULDER, R_ELBOW_A],
  [R_ELBOW_A, R_HAND_A],
  [R_SHOULDER, R_ELBOW_B],
  [R_ELBOW_B, R_HAND_B],
];
// Pairs that may not get closer than a fraction of their starting distance (crude joint limits).
const MIN_DIST: readonly (readonly [number, number, number])[] = [
  [R_HEAD, R_HIP, 0.85],
  [R_SHOULDER, R_KNEE_A, 0.6],
  [R_SHOULDER, R_KNEE_B, 0.6],
  [R_HIP, R_FOOT_A, 0.5],
  [R_HIP, R_FOOT_B, 0.5],
  [R_SHOULDER, R_HAND_A, 0.4],
  [R_SHOULDER, R_HAND_B, 0.4],
];

export interface Ragdoll {
  x: Float64Array;
  y: Float64Array;
  px: Float64Array; // previous positions (Verlet)
  py: Float64Array;
  stickLen: Float64Array;
  minLen: Float64Array;
}

const pose = new Float64Array(JOINTS * 2);
const hit: Hit = { nx: 0, ny: 0, depth: 0 };

export function spawnRagdoll(s: SimState, cfg: BikeConfig): Ragdoll {
  const r: Ragdoll = {
    x: new Float64Array(N),
    y: new Float64Array(N),
    px: new Float64Array(N),
    py: new Float64Array(N),
    stickLen: new Float64Array(STICKS.length),
    minLen: new Float64Array(MIN_DIST.length),
  };
  riderPose(cfg, s.lean, pose);
  for (let i = 0; i < N; i++) {
    const j = SOURCE[i]!;
    // the second leg and arm start slightly offset so the limbs separate
    const second = i === R_KNEE_B || i === R_FOOT_B || i === R_ELBOW_B || i === R_HAND_B;
    const lx = pose[j * 2]! + (second ? 0.05 : 0);
    const ly = pose[j * 2 + 1]! + (second ? 0.03 : 0);
    const ox = s.rx * lx - s.ry * ly;
    const oy = s.ry * lx + s.rx * ly;
    r.x[i] = s.x + ox;
    r.y[i] = s.y + oy;
    // inherit the velocity of that point on the chassis
    r.px[i] = r.x[i]! - (s.vx - s.w * oy) * TICK_DT;
    r.py[i] = r.y[i]! - (s.vy + s.w * ox) * TICK_DT;
  }
  for (let k = 0; k < STICKS.length; k++) {
    const [a, b] = STICKS[k]!;
    r.stickLen[k] = dist(r, a, b);
  }
  for (let k = 0; k < MIN_DIST.length; k++) {
    const [a, b, f] = MIN_DIST[k]!;
    r.minLen[k] = f * dist(r, a, b);
  }
  return r;
}

function dist(r: Ragdoll, a: number, b: number): number {
  const dx = r.x[a]! - r.x[b]!;
  const dy = r.y[a]! - r.y[b]!;
  return Math.sqrt(dx * dx + dy * dy);
}

function solve(r: Ragdoll, a: number, b: number, len: number, onlyIfShorter: boolean): void {
  const dx = r.x[b]! - r.x[a]!;
  const dy = r.y[b]! - r.y[a]!;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < 1e-9 || (onlyIfShorter && d >= len)) return;
  const k = ((d - len) / d) * 0.5;
  r.x[a] = r.x[a]! + dx * k;
  r.y[a] = r.y[a]! + dy * k;
  r.x[b] = r.x[b]! - dx * k;
  r.y[b] = r.y[b]! - dy * k;
}

export function stepRagdoll(r: Ragdoll, track: Track, gravity: number): void {
  const g = gravity * TICK_DT * TICK_DT;
  for (let i = 0; i < N; i++) {
    const vx = (r.x[i]! - r.px[i]!) * 0.999;
    const vy = (r.y[i]! - r.py[i]!) * 0.999;
    r.px[i] = r.x[i]!;
    r.py[i] = r.y[i]!;
    r.x[i] = r.x[i]! + vx;
    r.y[i] = r.y[i]! + vy - g;
  }
  for (let iter = 0; iter < 8; iter++) {
    for (let k = 0; k < STICKS.length; k++) solve(r, STICKS[k]![0], STICKS[k]![1], r.stickLen[k]!, false);
    for (let k = 0; k < MIN_DIST.length; k++) solve(r, MIN_DIST[k]![0], MIN_DIST[k]![1], r.minLen[k]!, true);
    for (let i = 0; i < N; i++) {
      if (!collideCircle(track, r.x[i]!, r.y[i]!, RADIUS[i]!, hit)) continue;
      r.x[i] = r.x[i]! + hit.nx * hit.depth;
      r.y[i] = r.y[i]! + hit.ny * hit.depth;
      if (iter === 7) {
        // On the ground: kill the bounce and rub off sliding speed.
        const vx = r.x[i]! - r.px[i]!;
        const vy = r.y[i]! - r.py[i]!;
        const vn = vx * hit.nx + vy * hit.ny;
        const tx = hit.ny;
        const ty = -hit.nx;
        const vt = (vx * tx + vy * ty) * 0.9;
        const keepN = vn > 0 ? vn : -vn * 0.15;
        r.px[i] = r.x[i]! - (tx * vt + hit.nx * keepN);
        r.py[i] = r.y[i]! - (ty * vt + hit.ny * keepN);
      }
    }
  }
}
