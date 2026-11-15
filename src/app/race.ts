// Races against the AI: who the opponents are, and picking a track they can actually finish.
import { runEpisode } from "../ai/episode";
import { variantRider } from "../ai/policy";
import { generateTrack, type LevelParams } from "../level/generator";
import type { Level } from "../level/level";
import type { BikeConfig, Track } from "../sim";
import type { RaceTier } from "./modes";

/**
 * One opponent: which weights it rides with (0 = the trained rider, others are slight variations)
 * and its speed limit in m/s. The trained rider flat out is hard to beat, so easier tiers hold it back.
 */
interface Opponent {
  variant: number;
  maxSpeed: number;
}

const FULL = Infinity;
export const OPPONENTS: Record<RaceTier, Opponent[]> = {
  easy: [{ variant: 0, maxSpeed: 12 }],
  medium: [
    { variant: 0, maxSpeed: 18 },
    { variant: 1, maxSpeed: 16.5 },
    { variant: 2, maxSpeed: 15 },
  ],
  hard: [
    { variant: 0, maxSpeed: FULL },
    { variant: 1, maxSpeed: FULL },
    { variant: 2, maxSpeed: FULL },
    { variant: 3, maxSpeed: 26 },
    { variant: 4, maxSpeed: 25 },
    { variant: 5, maxSpeed: 24 },
    { variant: 6, maxSpeed: 23 },
    { variant: 7, maxSpeed: 22 },
    { variant: 8, maxSpeed: 21 },
    { variant: 9, maxSpeed: 20 },
  ],
};
const VARIANT_SIGMA = 0.04;

export interface RaceRun {
  inputs: Uint8Array;
  finished: boolean;
  /** Finish time in ticks (only meaningful when finished). */
  ticks: number;
}

export interface RaceLevel extends Level {
  /** Opponent runs, fastest finisher first. */
  runs: RaceRun[];
}

function ride(track: Track, cfg: BikeConfig, rider: Float64Array, tier: RaceTier): RaceRun[] {
  const runs = OPPONENTS[tier].map((o) => {
    const theta = o.variant === 0 ? rider : variantRider(rider, 1000 + o.variant, VARIANT_SIGMA);
    const r = runEpisode(track, cfg, theta, true, o.maxSpeed);
    return { inputs: r.inputs!, finished: r.finished, ticks: r.ticks };
  });
  return runs.sort((a, b) => Number(b.finished) - Number(a.finished) || a.ticks - b.ticks);
}

const MAX_TRIES = 12;

/**
 * Finds a track for a race, a candidate per call so the page stays responsive. A track is accepted
 * when at least half the opponents finish it, which also proves a human can.
 */
export class RaceBuilder {
  attempt = 0;
  level: RaceLevel | null = null;
  private best: { attempt: number; finishers: number } = { attempt: 0, finishers: -1 };

  constructor(
    private params: LevelParams,
    private cfg: BikeConfig,
    private rider: Float64Array,
    private tier: RaceTier,
  ) {}

  get progress(): number {
    return this.attempt / MAX_TRIES;
  }

  run(): RaceLevel | null {
    if (this.level) return this.level;
    const need = Math.ceil(OPPONENTS[this.tier].length / 2);
    const track = generateTrack({ ...this.params, attempt: this.attempt });
    const runs = ride(track, this.cfg, this.rider, this.tier);
    const finishers = runs.filter((r) => r.finished).length;
    if (finishers >= need) return (this.level = this.make(track, this.attempt, runs, true));
    if (finishers > this.best.finishers) this.best = { attempt: this.attempt, finishers };
    if (++this.attempt < MAX_TRIES) return null;
    // nothing good enough: use the track most opponents finished
    const fallback = generateTrack({ ...this.params, attempt: this.best.attempt });
    return (this.level = this.make(fallback, this.best.attempt, ride(fallback, this.cfg, this.rider, this.tier), this.best.finishers > 0));
  }

  private make(track: Track, attempt: number, runs: RaceRun[], verified: boolean): RaceLevel {
    const lead = runs[0]!;
    return { track, attempt, verified, solution: lead.finished ? lead.inputs : null, solutionTicks: lead.finished ? lead.ticks : 0, failures: 0, runs };
  }
}

/** Place the player would take (1 = won) with this finish time. Opponents who never finish count as beaten. */
export function racePlace(playerTicks: number, runs: RaceRun[]): number {
  return 1 + runs.filter((r) => r.finished && r.ticks <= playerTicks).length;
}
