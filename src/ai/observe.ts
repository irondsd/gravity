// What the AI rider is allowed to see: the bike's own state and only the stretch of track a
// human player has on screen (a little behind, about one screen ahead). Nothing further.
import { segmentIndex, type BikeConfig, type SimState, type Track } from "../sim";

/** How far behind and ahead of the bike the rider can see, in meters (about what the camera shows). */
export const SEE_BEHIND = 4;
export const SEE_AHEAD = 16;

// The visible stretch is cut into strips, finer near the bike. For each strip the rider gets
// the lowest and highest ground in it, so narrow holes and teeth are not missed between samples.
const EDGES = [-4, -2.5, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16];
const STRIPS = EDGES.length - 1;
const STATE_VALUES = 12;
export const OBS_SIZE = STATE_VALUES + STRIPS * 2;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function observe(s: SimState, track: Track, cfg: BikeConfig, out: Float64Array): Float64Array {
  let i = 0;
  out[i++] = s.vx / 20;
  out[i++] = s.vy / 15;
  out[i++] = s.rx;
  out[i++] = s.ry;
  out[i++] = clamp(s.w / 6, -2, 2);
  out[i++] = s.rear.grounded;
  out[i++] = s.front.grounded;
  // wheel spin relative to road speed: tells wheelspin and lock-up apart from rolling
  out[i++] = clamp((-s.rear.w * cfg.wheelRadius - s.vx) / 10, -2, 2);
  out[i++] = s.lean;
  out[i++] = s.headDamage / cfg.headDamageMax;
  out[i++] = s.fenderBroken;
  out[i++] = 1; // constant input

  const xs = track.xs;
  const ys = track.ys;
  let seg = segmentIndex(track, s.x + EDGES[0]!);
  let x0 = s.x + EDGES[0]!;
  let y0 = heightIn(track, seg, x0);
  for (let k = 0; k < STRIPS; k++) {
    const x1 = s.x + EDGES[k + 1]!;
    let lo = y0;
    let hi = y0;
    // every track vertex inside the strip
    while (seg < track.n - 2 && xs[seg + 1]! < x1) {
      seg++;
      const y = ys[seg]!;
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    const y1 = heightIn(track, seg, x1);
    if (y1 < lo) lo = y1;
    if (y1 > hi) hi = y1;
    out[i++] = clamp((lo - s.y) / 4, -2.5, 2.5);
    out[i++] = clamp((hi - s.y) / 4, -2.5, 2.5);
    x0 = x1;
    y0 = y1;
  }
  return out;
}

function heightIn(t: Track, seg: number, x: number): number {
  const xa = t.xs[seg]!;
  const ya = t.ys[seg]!;
  return ya + ((t.ys[seg + 1]! - ya) * (x - xa)) / (t.xs[seg + 1]! - xa);
}
