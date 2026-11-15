// A playable level: a generated track that has been checked by the solver.
// If a track cannot be finished (or is too easy for its rating), the next attempt for the
// same seed is generated instead, so a seed + difficulty + length always names one verified level.
import { defaultConfig, type Track } from "../sim";
import { generateTrack, type LevelParams } from "./generator";
import { Solver, throttleOnlyFinishes, type SolveResult } from "./solver";

export interface Level {
  track: Track;
  /** Which generation attempt was accepted (0 = the first). */
  attempt: number;
  /** True if the solver finished it. False means no passable attempt was found in time. */
  verified: boolean;
  /** The solver's winning run (inputs per tick, default bike config), if verified. */
  solution: Uint8Array | null;
  solutionTicks: number;
  /** Times the solver crashed or got stuck before finishing: the measured difficulty. */
  failures: number;
}

const MAX_ATTEMPTS = 14;
const SOLVE_BUDGET = 400000; // sim ticks per attempt
/** Above this difficulty a level must not be finishable by just holding the throttle. */
const THROTTLE_ONLY_LIMIT = 0.2;

/** Builds a level a slice at a time, so the game can stay responsive while a hard one is searched. */
export class LevelBuilder {
  attempt = 0;
  private track: Track;
  private solver: Solver | null = null;
  private best: { attempt: number; progress: number } = { attempt: 0, progress: -1 };
  level: Level | null = null;

  constructor(private params: LevelParams) {
    this.track = this.begin();
  }

  /** 0..1 progress of the solver on the current attempt, for display. */
  get progress(): number {
    return this.solver ? this.solver.progress : 0;
  }

  private begin(): Track {
    this.track = generateTrack({ ...this.params, attempt: this.attempt });
    this.solver = null;
    return this.track;
  }

  /** Do about `work` sim ticks of checking. Returns the level when it is ready. */
  run(work: number): Level | null {
    if (this.level) return this.level;
    if (!this.solver) {
      // Too easy for its rating: skip without spending solver time.
      if (this.params.difficulty > THROTTLE_ONLY_LIMIT && throttleOnlyFinishes(this.track, defaultConfig)) {
        return this.next(null);
      }
      this.solver = new Solver(this.track, defaultConfig, SOLVE_BUDGET);
    }
    const r = this.solver.run(work);
    if (!r) return null;
    if (r.solved) return (this.level = this.finish(this.track, this.attempt, r));
    return this.next(r);
  }

  private next(r: SolveResult | null): Level | null {
    if (r && r.progress > this.best.progress) this.best = { attempt: this.attempt, progress: r.progress };
    this.attempt++;
    if (this.attempt < MAX_ATTEMPTS) {
      this.begin();
      return null;
    }
    // Nothing verified in time: hand back the attempt the solver got furthest on, marked unverified.
    const track = generateTrack({ ...this.params, attempt: this.best.attempt });
    return (this.level = { track, attempt: this.best.attempt, verified: false, solution: null, solutionTicks: 0, failures: 0 });
  }

  private finish(track: Track, attempt: number, r: SolveResult): Level {
    return { track, attempt, verified: true, solution: r.inputs, solutionTicks: r.ticks, failures: r.failures };
  }
}

export function buildLevel(params: LevelParams): Level {
  const b = new LevelBuilder(params);
  let level: Level | null = null;
  while (!level) level = b.run(200000);
  return level;
}
