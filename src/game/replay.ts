// Replays: a run is fully described by the track, the bike config, and one input per tick.
// Pure code (no DOM), so Bun can verify runs headlessly.
import {
  createState,
  FINISHED,
  hashState,
  RUNNING,
  sanitizeConfig,
  tick,
  type BikeConfig,
  type SimState,
  type Track,
} from "../sim";

export interface Replay {
  trackId: number;
  cfg: BikeConfig;
  inputs: Uint8Array;
  /** Tick at which the run finished. */
  ticks: number;
  /** State hash at the finish tick. */
  hash: number;
}

/** Identifies a track by its exact geometry. */
export function trackHash(track: Track): number {
  const data = new Float64Array(track.n * 2 + 2);
  data.set(track.xs, 0);
  data.set(track.ys, track.n);
  data[track.n * 2] = track.startX;
  data[track.n * 2 + 1] = track.finishX;
  const bytes = new Uint8Array(data.buffer);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function makeReplay(track: Track, cfg: BikeConfig, inputs: readonly number[], final: SimState): Replay {
  return {
    trackId: trackHash(track),
    cfg: { ...cfg },
    inputs: Uint8Array.from(inputs),
    ticks: final.endTick,
    hash: hashState(final),
  };
}

/** Re-simulate a replay and check that it finishes at the recorded tick in the recorded state. */
export function verifyReplay(track: Track, r: Replay): boolean {
  if (trackHash(track) !== r.trackId) return false;
  const s = createState(track, r.cfg);
  for (let i = 0; i < r.inputs.length && s.status === RUNNING; i++) tick(s, r.inputs[i]!, track, r.cfg);
  return s.status === FINISHED && s.endTick === r.ticks && hashState(s) === r.hash;
}

// Serialized form: inputs are run-length encoded as [mask, count, mask, count, ...].
interface ReplayJson {
  v: 1;
  trackId: number;
  cfg: BikeConfig;
  rle: number[];
  ticks: number;
  hash: number;
}

export function encodeReplay(r: Replay): string {
  const rle: number[] = [];
  for (let i = 0; i < r.inputs.length; ) {
    const m = r.inputs[i]!;
    let j = i + 1;
    while (j < r.inputs.length && r.inputs[j] === m) j++;
    rle.push(m, j - i);
    i = j;
  }
  const json: ReplayJson = { v: 1, trackId: r.trackId, cfg: r.cfg, rle, ticks: r.ticks, hash: r.hash };
  return JSON.stringify(json);
}

export function decodeReplay(text: string): Replay | null {
  try {
    const j = JSON.parse(text) as ReplayJson;
    if (j.v !== 1 || !Array.isArray(j.rle)) return null;
    let n = 0;
    for (let i = 1; i < j.rle.length; i += 2) n += j.rle[i]!;
    const inputs = new Uint8Array(n);
    let k = 0;
    for (let i = 0; i < j.rle.length; i += 2) {
      inputs.fill(j.rle[i]!, k, k + j.rle[i + 1]!);
      k += j.rle[i + 1]!;
    }
    return { trackId: j.trackId, cfg: sanitizeConfig(j.cfg), inputs, ticks: j.ticks, hash: j.hash };
  } catch {
    return null;
  }
}
