import type { BikeConfig } from "./config";
import { heightAt, type Track } from "./track";

export const RUNNING = 0;
export const CRASHED = 1;
export const FINISHED = 2;

export const CAUSE_NONE = 0;
export const CAUSE_HEAD_IMPACT = 1;
export const CAUSE_NECK = 2;
export const CAUSE_CRUSHED = 3;

export interface WheelState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number; // angular velocity
  angle: number; // for drawing only; does not affect physics
  stick: number; // tangential tire deflection (static friction)
  grounded: number; // 0 | 1
}

/** Complete simulation state. Plain numbers only, so it clones and hashes trivially. */
export interface SimState {
  tick: number;
  status: number;
  endTick: number; // tick at which the run crashed or finished
  crashCause: number;
  // chassis
  x: number;
  y: number;
  vx: number;
  vy: number;
  rx: number; // rotation as a unit vector (cos, sin); no trig in the sim
  ry: number;
  w: number;
  lean: number; // rider body position, -1 back .. +1 forward
  headDamage: number; // shared by head and torso: load the rider's body has taken recently
  headContact: number;
  fenderDamage: number;
  bounce: number; // upward impulse stored by a bad landing, released just after
  fenderBroken: number; // 0 | 1
  rear: WheelState;
  front: WheelState;
}

function wheel(x: number, y: number): WheelState {
  return { x, y, vx: 0, vy: 0, w: 0, angle: 0, stick: 0, grounded: 0 };
}

export function createState(track: Track, cfg: BikeConfig): SimState {
  const x = track.startX;
  const rearX = x + cfg.rearAnchorX;
  const frontX = x + cfg.frontAnchorX;
  const wy = Math.max(heightAt(track, rearX), heightAt(track, frontX)) + cfg.wheelRadius + 0.02;
  return {
    tick: 0,
    status: RUNNING,
    endTick: 0,
    crashCause: CAUSE_NONE,
    x,
    y: wy - cfg.rearAnchorY,
    vx: 0,
    vy: 0,
    rx: 1,
    ry: 0,
    w: 0,
    lean: 0,
    headDamage: 0,
    headContact: 0,
    fenderDamage: 0,
    bounce: 0,
    fenderBroken: 0,
    rear: wheel(rearX, wy),
    front: wheel(frontX, wy + (cfg.rearAnchorY - cfg.frontAnchorY)),
  };
}

function copyWheel(dst: WheelState, src: WheelState): void {
  dst.x = src.x;
  dst.y = src.y;
  dst.vx = src.vx;
  dst.vy = src.vy;
  dst.w = src.w;
  dst.angle = src.angle;
  dst.stick = src.stick;
  dst.grounded = src.grounded;
}

export function copyState(dst: SimState, src: SimState): void {
  dst.tick = src.tick;
  dst.status = src.status;
  dst.endTick = src.endTick;
  dst.crashCause = src.crashCause;
  dst.x = src.x;
  dst.y = src.y;
  dst.vx = src.vx;
  dst.vy = src.vy;
  dst.rx = src.rx;
  dst.ry = src.ry;
  dst.w = src.w;
  dst.lean = src.lean;
  dst.headDamage = src.headDamage;
  dst.headContact = src.headContact;
  dst.fenderDamage = src.fenderDamage;
  dst.bounce = src.bounce;
  dst.fenderBroken = src.fenderBroken;
  copyWheel(dst.rear, src.rear);
  copyWheel(dst.front, src.front);
}

export function cloneState(src: SimState): SimState {
  return { ...src, rear: { ...src.rear }, front: { ...src.front } };
}

const hashBuf = new Float64Array(34);
const hashBytes = new Uint8Array(hashBuf.buffer);

/** Bit-exact hash of the state, for determinism checks and replay verification. */
export function hashState(s: SimState): number {
  const b = hashBuf;
  let i = 0;
  b[i++] = s.tick;
  b[i++] = s.status;
  b[i++] = s.endTick;
  b[i++] = s.crashCause;
  b[i++] = s.x;
  b[i++] = s.y;
  b[i++] = s.vx;
  b[i++] = s.vy;
  b[i++] = s.rx;
  b[i++] = s.ry;
  b[i++] = s.w;
  b[i++] = s.lean;
  b[i++] = s.headDamage;
  b[i++] = s.headContact;
  b[i++] = s.fenderDamage;
  b[i++] = s.bounce;
  b[i++] = s.fenderBroken;
  for (const wh of [s.rear, s.front]) {
    b[i++] = wh.x;
    b[i++] = wh.y;
    b[i++] = wh.vx;
    b[i++] = wh.vy;
    b[i++] = wh.w;
    b[i++] = wh.angle;
    b[i++] = wh.stick;
    b[i++] = wh.grounded;
  }
  let h = 0x811c9dc5;
  for (let k = 0; k < i * 8; k++) {
    h ^= hashBytes[k]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
