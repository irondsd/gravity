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
  /** Ride this many variations of the rider and keep the fastest (default 1). */
  bestOf?: number;
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
  // Ten riders flat out, each the fastest of a few slightly different riders on this very track.
  impossible: Array.from({ length: 10 }, (_, i) => ({ variant: i, maxSpeed: FULL, bestOf: 3 })),
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

function riderFor(rider: Float64Array, variant: number): Float64Array {
  return variant === 0 ? rider : variantRider(rider, 1000 + variant, VARIANT_SIGMA);
}

/** One opponent's run: the fastest finish among its tries, or else the one that got furthest. */
function rideOne(track: Track, cfg: BikeConfig, rider: Float64Array, o: Opponent): RaceRun {
  let best: (RaceRun & { progress: number }) | null = null;
  for (let k = 0; k < (o.bestOf ?? 1); k++) {
    const r = runEpisode(track, cfg, riderFor(rider, o.variant + 100 * k), true, o.maxSpeed);
    const better = !best || (r.finished && (!best.finished || r.ticks < best.ticks)) || (!r.finished && !best.finished && r.progress > best.progress);
    if (better) best = { inputs: r.inputs!, finished: r.finished, ticks: r.ticks, progress: r.progress };
  }
  return { inputs: best!.inputs, finished: best!.finished, ticks: best!.ticks };
}

const sortRuns = (runs: RaceRun[]) => runs.sort((a, b) => Number(b.finished) - Number(a.finished) || a.ticks - b.ticks);

const MAX_TRIES = 12;

/**
 * Finds a track for a race, one opponent ride per call so the page stays responsive. A track is
 * accepted when at least half the opponents finish it (three on impossible), which also proves a human can.
 */
export class RaceBuilder {
  attempt = 0;
  level: RaceLevel | null = null;
  private best: { attempt: number; finishers: number } = { attempt: 0, finishers: -1 };
  private track: Track | null = null;
  private runs: RaceRun[] = [];
  /** Riding the best attempt again after nothing was good enough. */
  private fallback = false;

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
    const field = OPPONENTS[this.tier];
    if (!this.track) {
      this.track = generateTrack({ ...this.params, attempt: this.attempt });
      this.runs = [];
    }
    this.runs.push(rideOne(this.track, this.cfg, this.rider, field[this.runs.length]!));
    if (this.runs.length < field.length) return null;

    const runs = sortRuns(this.runs);
    const finishers = runs.filter((r) => r.finished).length;
    if (this.fallback) return (this.level = this.make(this.track, this.attempt, runs, finishers > 0));
    const need = this.tier === "impossible" ? 3 : Math.ceil(field.length / 2);
    if (finishers >= need) return (this.level = this.make(this.track, this.attempt, runs, true));
    if (finishers > this.best.finishers) this.best = { attempt: this.attempt, finishers };
    this.track = null;
    if (++this.attempt < MAX_TRIES) return null;
    // nothing good enough: ride again the track most opponents finished
    this.attempt = this.best.attempt;
    this.fallback = true;
    return null;
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
