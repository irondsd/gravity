import type { Track } from "../sim/track";
import { TrackBuilder } from "./builder";

/** Hand-made track that exercises every kind of terrain, for tuning the bike. */
export function buildTestTrack(): Track {
  const b = new TrackBuilder();
  b.flat(20);
  // gentle hill
  b.smooth(20, 3).smooth(20, -3).flat(10);
  // small bumps
  b.bump(6, 0.5).bump(6, 0.5).bump(6, 0.6).flat(12);
  // kicker with a drop
  b.slope(9, 2.6).step(-3.2).flat(28);
  // valley
  b.smooth(30, -6).smooth(25, 5).flat(10);
  // stairs up
  b.step(0.22).flat(3).step(0.22).flat(3).step(0.25).flat(12);
  // big hill
  b.smooth(16, 5).smooth(16, -5).flat(6);
  // jump over a pit
  b.slope(7, 1.6).step(-3.2).flat(8).slope(2, 1.6).flat(22);
  // rollers
  for (let i = 0; i < 5; i++) b.bump(8, 0.9);
  b.flat(15);
  // steep climb and long descent
  b.slope(13, 7).flat(10).smooth(24, -9).flat(40);
  return b.build(6, 15);
}
