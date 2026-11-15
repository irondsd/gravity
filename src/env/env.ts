// Gym-style wrapper around the sim for AI training. No DOM, runs headless in Bun.
import {
  cloneState,
  copyState,
  createState,
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
import { OBS_SIZE, observe } from "../ai/observe";

export { OBS_SIZE };

/** 9 discrete actions: (coast | throttle | brake) x (no lean | lean back | lean forward). */
export const ACTION_COUNT = 9;

export function actionToInput(action: number): number {
  const drive = Math.floor(action / 3);
  const lean = action % 3;
  return (drive === 1 ? IN_THROTTLE : drive === 2 ? IN_BRAKE : 0) | (lean === 1 ? IN_LEAN_BACK : lean === 2 ? IN_LEAN_FWD : 0);
}

export interface StepResult {
  obs: Float64Array;
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

  reset(): Float64Array {
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

  /** What the rider can see: its own state and about one screen of track (see ai/observe.ts). */
  observe(out = new Float64Array(OBS_SIZE)): Float64Array {
    return observe(this.state, this.track, this.cfg, out);
  }

  /** Snapshot / restore, for search-based methods and curriculum resets. */
  saveState(): SimState {
    return cloneState(this.state);
  }

  loadState(snapshot: SimState): void {
    copyState(this.state, snapshot);
  }
}
