// Track: a polyline with strictly increasing x. Ground is everything below it.

export interface Track {
  xs: Float64Array;
  ys: Float64Array;
  n: number;
  startX: number;
  finishX: number;
}

export function makeTrack(points: readonly (readonly [number, number])[], startX: number, finishX: number): Track {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  // Long flat run-offs so queries never fall off the ends.
  const all: (readonly [number, number])[] = [[first[0] - 1000, first[1]], ...points, [last[0] + 1000, last[1]]];
  const n = all.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = all[i]![0];
    ys[i] = all[i]![1];
    if (i > 0 && !(xs[i]! > xs[i - 1]!)) throw new Error(`track x must strictly increase (point ${i})`);
  }
  return { xs, ys, n, startX, finishX };
}

/** Index i of the segment [i, i+1] containing x (clamped to valid segments). */
export function segmentIndex(t: Track, x: number): number {
  const xs = t.xs;
  let lo = 0;
  let hi = t.n - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xs[mid]! <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function heightAt(t: Track, x: number): number {
  const i = segmentIndex(t, x);
  const x0 = t.xs[i]!;
  const x1 = t.xs[i + 1]!;
  const y0 = t.ys[i]!;
  const y1 = t.ys[i + 1]!;
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}

export interface Hit {
  nx: number;
  ny: number;
  depth: number;
}

/**
 * Circle vs ground. Writes a single combined contact (normal pointing out of the
 * ground, penetration depth) into `out`. Returns false if not touching.
 */
export function collideCircle(t: Track, cx: number, cy: number, r: number, out: Hit): boolean {
  const xs = t.xs;
  const ys = t.ys;

  // Center below the surface: push out along the normal of the segment above it.
  const ic = segmentIndex(t, cx);
  {
    const x0 = xs[ic]!;
    const y0 = ys[ic]!;
    const ex = xs[ic + 1]! - x0;
    const ey = ys[ic + 1]! - y0;
    const surf = y0 + (ey * (cx - x0)) / ex;
    if (cy < surf) {
      const inv = 1 / Math.sqrt(ex * ex + ey * ey);
      const nx = -ey * inv;
      const ny = ex * inv;
      const dist = (cx - x0) * nx + (cy - y0) * ny;
      out.nx = nx;
      out.ny = ny;
      out.depth = r - dist;
      return true;
    }
  }

  const a = segmentIndex(t, cx - r);
  const b = segmentIndex(t, cx + r);
  let dxSum = 0;
  let dySum = 0;
  for (let j = a; j <= b; j++) {
    const x0 = xs[j]!;
    const y0 = ys[j]!;
    const ex = xs[j + 1]! - x0;
    const ey = ys[j + 1]! - y0;
    let u = ((cx - x0) * ex + (cy - y0) * ey) / (ex * ex + ey * ey);
    // A shared vertex is handled by the segment that starts at it.
    if (u >= 1 && j < t.n - 2) continue;
    if (u < 0) u = 0;
    else if (u > 1) u = 1;
    const dx = cx - (x0 + u * ex);
    const dy = cy - (y0 + u * ey);
    const d2 = dx * dx + dy * dy;
    if (d2 < r * r && d2 > 1e-18) {
      const d = Math.sqrt(d2);
      const pen = (r - d) / d;
      dxSum += dx * pen;
      dySum += dy * pen;
    }
  }
  const m2 = dxSum * dxSum + dySum * dySum;
  if (m2 <= 0) return false;
  const m = Math.sqrt(m2);
  out.nx = dxSum / m;
  out.ny = dySum / m;
  out.depth = m;
  return true;
}
