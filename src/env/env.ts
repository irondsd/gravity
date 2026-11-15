// Gym-style wrapper around the sim for AI training. No DOM, runs headless in Bun.
import {
  cloneState,
  copyState,
  createState,
  heightAt,
  IN_BRAKE,
  IN_LEAN_BACK,
  IN_LEAN_FWD,
  IN_THROTTLE,
  RUNNING,
  FINISHED,
  tick,
  type BikeConfig,
  type SimState,
  type Track,
} from "../sim";

/** 9 discrete actions: (coast | throttle | brake) x (no lean | lean back | lean forward). */
export const ACTION_COUNT = 9;

export function actionToInput(action: number): number {
  const drive = Math.floor(action / 3);
  const lean = action % 3;
  return (drive === 1 ? IN_THROTTLE : drive === 2 ? IN_BRAKE : 0) | (lean === 1 ? IN_LEAN_BACK : lean === 2 ? IN_LEAN_FWD : 0);
}

const TERRAIN_SAMPLES = 20;
const TERRAIN_START = -3;
const TERRAIN_SPACING = 1.5;
export const OBS_SIZE = 11 + TERRAIN_SAMPLES;

export interface StepResult {
  obs: Float32Array;
  reward: number;
  done: boolean;
  finished: boolean;
}

export class BikeEnv {
  state: SimState;

  constructor(
    public track: Track,
    public cfg: BikeConfig,
    /** Sim ticks per env step (frame skip). */
    public ticksPerStep = 4,
    public maxTicks = 120 * 120,
  ) {
    this.state = createState(track, cfg);
  }

  reset(): Float32Array {
    this.state = createState(this.track, this.cfg);
    return this.observe();
  }

  step(action: number): StepResult {
    const s = this.state;
    const input = actionToInput(action);
    const x0 = s.x;
    for (let i = 0; i < this.ticksPerStep && s.status === RUNNING; i++) tick(s, input, this.track, this.cfg);
    const finished = s.status === FINISHED;
    const done = s.status !== RUNNING || s.tick >= this.maxTicks;
    // Placeholder reward: forward progress, bonus for finishing, penalty for crashing.
    let reward = (s.x - x0) * 0.1;
    if (finished) reward += 50;
    else if (s.status !== RUNNING) reward -= 10;
    return { obs: this.observe(), reward, done, finished };
  }

  observe(out = new Float32Array(OBS_SIZE)): Float32Array {
    const s = this.state;
    const cfg = this.cfg;
    let i = 0;
    // velocity in the bike's own frame
    out[i++] = (s.vx * s.rx + s.vy * s.ry) / 20;
    out[i++] = (-s.vx * s.ry + s.vy * s.rx) / 20;
    out[i++] = s.rx;
    out[i++] = s.ry;
    out[i++] = s.w / 10;
    out[i++] = s.rear.grounded;
    out[i++] = s.front.grounded;
    out[i++] = (s.rear.w * cfg.wheelRadius) / 30;
    out[i++] = (s.front.w * cfg.wheelRadius) / 30;
    out[i++] = s.lean;
    out[i++] = s.headDamage / cfg.headDamageMax;
    for (let k = 0; k < TERRAIN_SAMPLES; k++) {
      out[i++] = (heightAt(this.track, s.x + TERRAIN_START + k * TERRAIN_SPACING) - s.y) / 5;
    }
    return out;
  }

  /** Snapshot / restore, for search-based methods and curriculum resets. */
  saveState(): SimState {
    return cloneState(this.state);
  }

  loadState(snapshot: SimState): void {
    copyState(this.state, snapshot);
  }
}
