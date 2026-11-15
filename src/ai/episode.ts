// One ride by the AI rider, and how good it was.
import { createState, FINISHED, IN_BRAKE, IN_THROTTLE, RUNNING, tick, type BikeConfig, type Track } from "../sim";
import { OBS_SIZE, observe } from "./observe";
import { DECISION_TICKS, decide } from "./policy";

export interface EpisodeResult {
  finished: boolean;
  crashed: boolean;
  /** Furthest point reached, 0..1 of the way to the finish. */
  progress: number;
  ticks: number;
  /** Inputs per tick, when recording was asked for. */
  inputs: Uint8Array | null;
}

const STUCK_TICKS = 120 * 4;
const obs = new Float64Array(OBS_SIZE);

/**
 * `maxSpeed` (m/s) holds a rider back: above it the throttle is cut, a little more above and it brakes.
 * This is how the easier race opponents are made slower than the trained rider.
 */
export function runEpisode(track: Track, cfg: BikeConfig, theta: Float64Array, record = false, maxSpeed = Infinity): EpisodeResult {
  const s = createState(track, cfg);
  const span = track.finishX - track.startX;
  // give up on rides slower than 2.5 m/s on average
  const maxTicks = Math.ceil((span / 2.5) * 120);
  const log: number[] | null = record ? [] : null;
  let bestX = s.x;
  let sinceBest = 0;
  let input = 0;
  while (s.status === RUNNING && s.tick < maxTicks && sinceBest < STUCK_TICKS) {
    if (s.tick % DECISION_TICKS === 0) {
      input = decide(theta, observe(s, track, cfg, obs));
      if (maxSpeed !== Infinity) {
        const v2 = s.vx * s.vx + s.vy * s.vy;
        if (v2 > maxSpeed * maxSpeed) input &= ~IN_THROTTLE;
        if (v2 > (maxSpeed + 4) * (maxSpeed + 4) && s.rear.grounded === 1) input = (input & ~IN_THROTTLE) | IN_BRAKE;
      }
    }
    log?.push(input);
    tick(s, input, track, cfg);
    if (s.x > bestX + 0.05) {
      bestX = s.x;
      sinceBest = 0;
    } else sinceBest++;
  }
  const finished = s.status === FINISHED;
  return {
    finished,
    crashed: s.status !== RUNNING && !finished,
    progress: finished ? 1 : Math.max(0, Math.min(1, (bestX - track.startX) / span)),
    ticks: finished ? s.endTick : s.tick,
    inputs: log ? Uint8Array.from(log) : null,
  };
}

/**
 * Score for training: how far the rider got, and how quickly.
 * Unfinished: 0..1 for distance, plus a little for pace. Finished: 2, plus up to about 1 for a fast time.
 */
export function fitness(r: EpisodeResult, track: Track): number {
  const span = track.finishX - track.startX;
  const seconds = Math.max(1, r.ticks / 120);
  if (r.finished) return 2 + Math.min(1.2, span / 20 / seconds);
  const pace = Math.min(1, (r.progress * span) / seconds / 15);
  return r.progress * (1 + 0.15 * pace);
}
