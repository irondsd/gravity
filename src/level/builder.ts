import { makeTrack, type Track } from "../sim/track";

/** Small helper for describing a track as a sequence of pieces. Arithmetic only (no trig). */
export class TrackBuilder {
  private pts: [number, number][] = [[0, 0]];
  x = 0;
  y = 0;
  /** Spacing of points along smooth curves. Larger = more angular. */
  sample = 0.5;

  private add(dx: number, dy: number): this {
    this.x += dx;
    this.y += dy;
    this.pts.push([this.x, this.y]);
    return this;
  }

  flat(len: number): this {
    return this.add(len, 0);
  }

  /** Straight slope. */
  slope(len: number, dy: number): this {
    return this.add(len, dy);
  }

  /** Smooth S-shaped rise or fall (flat at both ends). */
  smooth(len: number, dy: number): this {
    const steps = Math.max(2, Math.ceil(len / this.sample));
    const x0 = this.x;
    const y0 = this.y;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t * t * (3 - 2 * t);
      this.x = x0 + len * t;
      this.y = y0 + dy * e;
      this.pts.push([this.x, this.y]);
    }
    return this;
  }

  /** Smooth bump (or dip, with negative height). */
  bump(len: number, height: number): this {
    return this.smooth(len / 2, height).smooth(len / 2, -height);
  }

  /** Near-vertical step up or down. */
  step(dy: number): this {
    return this.add(0.05, dy);
  }

  /**
   * Make the surface jagged between fromX and toX: long segments are broken up every
   * `spacing` meters and every point is moved up or down by up to `amp`.
   */
  roughen(rng: () => number, amp: number, spacing: number, fromX: number, toX: number): this {
    const src = this.pts;
    const out: [number, number][] = [src[0]!];
    let lastOffset = 0;
    for (let i = 1; i < src.length; i++) {
      const [x0, y0] = src[i - 1]!;
      const [x1, y1] = src[i]!;
      const inside = x0 >= fromX && x1 <= toX;
      if (inside) {
        const n = Math.floor((x1 - x0) / spacing);
        for (let k = 1; k < n; k++) {
          const t = k / n;
          lastOffset = (rng() * 2 - 1) * amp;
          out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t + lastOffset]);
        }
        // the two ends of a near-vertical step move together, so steps keep their height
        if (x1 - x0 > 0.1) lastOffset = (rng() * 2 - 1) * amp;
        out.push([x1, y1 + lastOffset]);
      } else {
        lastOffset = 0;
        out.push([x1, y1]);
      }
    }
    this.pts = out;
    return this;
  }

  build(startX: number, finishBeforeEnd: number): Track {
    return makeTrack(this.pts, startX, this.x - finishBeforeEnd);
  }
}
