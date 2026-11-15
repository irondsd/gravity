import { expect, test } from "bun:test";
import { TrackBuilder } from "../level/builder";
import { generateTrack } from "../level/generator";
import { createState, defaultConfig as cfg, tick } from "../sim";
import { fitness, runEpisode } from "./episode";
import { OBS_SIZE, observe, SEE_AHEAD, SEE_BEHIND } from "./observe";
import { decide, PARAM_COUNT } from "./policy";

test("the rider only sees about one screen: track beyond that does not change what it observes", () => {
  // two tracks, identical near the bike, completely different further on
  const near = (b: TrackBuilder) => b.flat(20).bump(6, 0.8).flat(6).step(-0.5).flat(4);
  const a = near(new TrackBuilder()).flat(200).build(6, 10);
  const b = near(new TrackBuilder()).slope(10, 6).step(-9).flat(180).build(6, 10);
  const sa = createState(a, cfg);
  const sb = createState(b, cfg);
  const oa = new Float64Array(OBS_SIZE);
  const ob = new Float64Array(OBS_SIZE);
  let compared = 0;
  // the tracks first differ at x = 36.05
  while (sa.x + SEE_AHEAD < 36) {
    expect(Array.from(observe(sa, a, cfg, oa))).toEqual(Array.from(observe(sb, b, cfg, ob)));
    compared++;
    tick(sa, 1, a, cfg);
    tick(sb, 1, b, cfg);
  }
  expect(compared).toBeGreaterThan(100);
  // ...and once the difference is on screen, the rider does see it
  while (sa.x + SEE_AHEAD < 40) {
    tick(sa, 1, a, cfg);
    tick(sb, 1, b, cfg);
  }
  expect(Array.from(observe(sa, a, cfg, oa))).not.toEqual(Array.from(observe(sb, b, cfg, ob)));
  expect(SEE_BEHIND).toBeLessThanOrEqual(6);
  expect(SEE_AHEAD).toBeLessThanOrEqual(20);
});

test("observations stay finite and bounded on rough levels", () => {
  const track = generateTrack({ seed: 9, difficulty: 1, length: 300 });
  const s = createState(track, cfg);
  const o = new Float64Array(OBS_SIZE);
  for (let i = 0; i < 120 * 20; i++) {
    tick(s, (i >> 5) % 16, track, cfg);
    observe(s, track, cfg, o);
    for (const v of o) expect(Math.abs(v)).toBeLessThanOrEqual(10);
  }
});

test("a rider's run is repeatable and scored by distance and pace", () => {
  const track = generateTrack({ seed: 4, difficulty: 0.1, length: 200 });
  const theta = new Float64Array(PARAM_COUNT);
  expect(decide(theta, new Float64Array(OBS_SIZE))).toBe(1); // all-zero network: ties resolve to plain throttle
  const r1 = runEpisode(track, cfg, theta, true);
  const r2 = runEpisode(track, cfg, theta, true);
  expect(r1.ticks).toBe(r2.ticks);
  expect(r1.inputs).toEqual(r2.inputs);
  expect(r1.progress).toBeGreaterThan(0.05);
  // further is better; finishing beats any unfinished run; faster finishing beats slower
  const base = { crashed: false, inputs: null };
  expect(fitness({ ...base, finished: false, progress: 0.6, ticks: 2400 }, track)).toBeGreaterThan(fitness({ ...base, finished: false, progress: 0.4, ticks: 2400 }, track));
  expect(fitness({ ...base, finished: true, progress: 1, ticks: 9000 }, track)).toBeGreaterThan(fitness({ ...base, finished: false, progress: 0.99, ticks: 1200 }, track));
  expect(fitness({ ...base, finished: true, progress: 1, ticks: 2000 }, track)).toBeGreaterThan(fitness({ ...base, finished: true, progress: 1, ticks: 3000 }, track));
});
