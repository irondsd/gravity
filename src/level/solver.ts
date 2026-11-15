// Level solver: proves a track can be finished by actually finishing it.
// It rides with a handful of simple riding styles, and whenever it crashes or gets stuck it
// rewinds a little and tries a different style, rewinding further the more it fails.
// Fully deterministic (seeded, no trig that feeds the sim), so a level's verdict is the same everywhere.
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
import { makeRng } from "./generator";

/** A riding style: hold a speed, keep the bike at an angle relative to the ground ahead. */
interface Style {
  speed: number; // target speed, m/s
  look: number; // how far ahead to read the slope, m
  tilt: number; // extra nose-up (+) or nose-down (-) relative to the ground
  raw?: number; // if set, just hold these buttons
}

const STYLES: Style[] = [
  { speed: 15, look: 2.5, tilt: 0 },
  { speed: 10, look: 2, tilt: 0 },
  { speed: 21, look: 3, tilt: 0 },
  { speed: 6, look: 1.5, tilt: 0 },
  { speed: 28, look: 3.5, tilt: 0.05 },
  { speed: 13, look: 2, tilt: 0.25 },
  { speed: 18, look: 3, tilt: -0.15 },
  { speed: 8, look: 1.5, tilt: 0.35 },
  { speed: 40, look: 3, tilt: 0.12 },
  { speed: 3.5, look: 1.2, tilt: 0 },
  { speed: 24, look: 2, tilt: 0.25 },
  { speed: 11, look: 1.5, tilt: -0.25 },
  { speed: 0, look: 0, tilt: 0, raw: IN_THROTTLE | IN_LEAN_BACK },
  { speed: 0, look: 0, tilt: 0, raw: IN_THROTTLE | IN_LEAN_FWD },
  { speed: 0, look: 0, tilt: 0, raw: IN_BRAKE },
  { speed: 0, look: 0, tilt: 0, raw: 0 },
];

function styleInput(st: Style, s: SimState, track: Track): number {
  if (st.raw !== undefined) return st.raw;
  const airborne = s.rear.grounded === 0 && s.front.grounded === 0;
  // In the air, line up with the ground where the bike is heading; on it, with the ground just ahead.
  const from = airborne ? s.x + s.vx * 0.35 : s.x - 0.5;
  const slope = (heightAt(track, from + st.look + 0.5) - heightAt(track, from)) / (st.look + 0.5);
  // cross product of bike axis with the (unnormalized) target direction: > 0 means rotate back
  const tx = 1 - slope * st.tilt;
  const ty = slope + st.tilt;
  const err = (s.rx * ty - s.ry * tx) / Math.sqrt(tx * tx + ty * ty);
  const want = err * 6 - s.w * 0.6;
  const speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
  let input = speed < st.speed ? IN_THROTTLE : 0;
  if (speed > st.speed + 3) input = IN_BRAKE;
  if (want > 0.5) input |= IN_LEAN_BACK;
  else if (want < -0.5) input |= IN_LEAN_FWD;
  return input;
}

export interface SolveResult {
  solved: boolean;
  /** Inputs of the winning run, one per tick (only when solved). */
  inputs: Uint8Array | null;
  /** Finish time of the winning run, in ticks. */
  ticks: number;
  /** How many times the solver crashed or got stuck before finishing: a measure of how hard the level is. */
  failures: number;
  /** Simulation ticks spent searching. */
  work: number;
  /** Furthest point reached, 0..1 of the way to the finish. */
  progress: number;
}

const SEGMENT = 36; // ticks per decision (0.3 s)
const STUCK_TICKS = 120 * 5; // no forward progress for this long counts as stuck

interface Checkpoint {
  state: SimState;
  inputs: number; // length of the input log at this point
  bestX: number; // furthest x on this path
  sinceBest: number; // ticks since bestX last improved
}

/** How many failures at one spot before the solver decides that spot cannot be passed. */
const GIVE_UP_FAILS = 320;

/** Resumable search for a finishing run, so a caller can spread the work over several frames. */
export class Solver {
  private rng: () => number;
  private s: SimState;
  private log: number[] = [];
  private cps: Checkpoint[];
  private style = 0;
  private calm = 0; // segments survived since the last failure
  private failures = 0;
  private failsHere = 0; // failures since the search last got further than ever before
  private frontier: number;
  private work = 0;
  private bestX: number;
  private sinceBest = 0;
  result: SolveResult | null = null;

  constructor(
    private track: Track,
    private cfg: BikeConfig,
    private budget: number,
    seed = 1,
  ) {
    this.rng = makeRng(seed);
    this.s = createState(track, cfg);
    this.cps = [{ state: cloneState(this.s), inputs: 0, bestX: this.s.x, sinceBest: 0 }];
    this.frontier = this.s.x;
    this.bestX = this.s.x;
  }

  /** Furthest point reached so far, 0..1 of the way to the finish. */
  get progress(): number {
    const span = this.track.finishX - this.track.startX;
    return Math.max(0, Math.min(1, (this.frontier - this.track.startX) / span));
  }

  /** Do about `work` more ticks of searching. Returns the result once finished, else null. */
  run(work: number): SolveResult | null {
    const stopAt = this.work + work;
    while (!this.result && this.work < stopAt) this.segment();
    return this.result;
  }

  private segment(): void {
    const { s, track, cfg, log, cps } = this;
    if (this.work >= this.budget || this.failsHere > GIVE_UP_FAILS) {
      this.result = { solved: false, inputs: null, ticks: 0, failures: this.failures, work: this.work, progress: this.progress };
      return;
    }
    for (let i = 0; i < SEGMENT; i++) {
      const input = styleInput(STYLES[this.style]!, s, track);
      log.push(input);
      tick(s, input, track, cfg);
      this.work++;
      if (s.x > this.bestX + 0.05) {
        this.bestX = s.x;
        this.sinceBest = 0;
      } else this.sinceBest++;
      if (s.status !== RUNNING) break;
    }
    if (s.status === FINISHED) {
      this.result = { solved: true, inputs: Uint8Array.from(log), ticks: s.endTick, failures: this.failures, work: this.work, progress: 1 };
      return;
    }

    if (s.status === RUNNING && this.sinceBest <= STUCK_TICKS) {
      cps.push({ state: cloneState(s), inputs: log.length, bestX: this.bestX, sinceBest: this.sinceBest });
      if (s.x > this.frontier + 1) {
        this.frontier = s.x;
        this.failsHere = 0;
      }
      // once past trouble, drift back to the normal style
      if (++this.calm >= 5 && this.style !== 0) this.style = 0;
      return;
    }

    // Failed: rewind. The more failures at this spot, the further back the retry starts,
    // because the mistake may have been made well before the crash.
    this.failures++;
    this.failsHere++;
    this.calm = 0;
    const maxBack = Math.min(cps.length - 1, 1 + Math.floor(this.failsHere / 2));
    const back = Math.floor(this.rng() * (maxBack + 1));
    cps.length = Math.max(1, cps.length - back);
    const cp = cps[cps.length - 1]!;
    copyState(s, cp.state);
    log.length = cp.inputs;
    this.bestX = cp.bestX;
    this.sinceBest = cp.sinceBest;
    this.style = Math.floor(this.rng() * STYLES.length);
  }
}

/** Search for a finishing run within `budget` simulation ticks. */
export function solve(track: Track, cfg: BikeConfig, budget: number, seed = 1): SolveResult {
  const solver = new Solver(track, cfg, budget, seed);
  let r: SolveResult | null = null;
  while (!r) r = solver.run(100000);
  return r;
}

/** Does simply holding the throttle finish the track? */
export function throttleOnlyFinishes(track: Track, cfg: BikeConfig): boolean {
  const s = createState(track, cfg);
  let bestX = s.x;
  let since = 0;
  while (s.status === RUNNING && since < STUCK_TICKS) {
    tick(s, IN_THROTTLE, track, cfg);
    if (s.x > bestX + 0.05) {
      bestX = s.x;
      since = 0;
    } else since++;
  }
  return s.status === FINISHED;
}
