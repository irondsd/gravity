import { expect, test } from "bun:test";
import { TrackBuilder } from "../level/builder";
import { buildLevel } from "../level/level";
import { throttleOnlyFinishes } from "../level/solver";
import {
  BODY_FENDER,
  collideCircle,
  CRASHED,
  createState,
  defaultConfig as cfg,
  FINISHED,
  IN_LEAN_BACK,
  IN_THROTTLE,
  RUNNING,
  tick,
  type SimEvent,
  type SimState,
} from "./index";

const flat = new TrackBuilder().flat(2000).build(10, 10);

/** A bike in the air above flat ground, pitched by `deg` (positive = nose up), moving forward. */
function airborne(deg: number, vx: number, height: number): SimState {
  const s = createState(flat, cfg);
  const a = (deg * Math.PI) / 180;
  s.rx = Math.cos(a);
  s.ry = Math.sin(a);
  s.x = 50;
  s.y = height + 1.2;
  s.vx = vx;
  const wheels = [
    [s.rear, cfg.rearAnchorX, cfg.rearAnchorY],
    [s.front, cfg.frontAnchorX, cfg.frontAnchorY],
  ] as const;
  for (const [wh, ax, ay] of wheels) {
    wh.x = s.x + s.rx * ax - s.ry * ay;
    wh.y = s.y + s.ry * ax + s.rx * ay;
    wh.vx = vx;
    wh.w = -vx / cfg.wheelRadius;
  }
  return s;
}

function speedAfterLanding(deg: number): number {
  const s = airborne(deg, 15, 2);
  for (let i = 0; i < 120 * 3; i++) tick(s, 0, flat, cfg);
  expect(s.status).toBe(RUNNING);
  return s.vx;
}

test("landing in line with the ground keeps speed; landing at an angle costs speed", () => {
  const level = speedAfterLanding(0);
  const noseDown = speedAfterLanding(-25);
  const noseUp = speedAfterLanding(25);
  expect(level).toBeGreaterThan(14);
  expect(noseDown).toBeLessThan(level - 1);
  expect(noseUp).toBeLessThan(level - 1);
  // and a bigger angle costs more
  expect(speedAfterLanding(-35)).toBeLessThan(noseDown);
});

test("throttle alone keeps the front wheel down; throttle with lean back lifts it into a wheelie", () => {
  const a = createState(flat, cfg);
  let maxPitch = 0;
  for (let i = 0; i < 120 * 4; i++) {
    tick(a, IN_THROTTLE, flat, cfg);
    maxPitch = Math.max(maxPitch, a.ry);
  }
  expect(maxPitch).toBeLessThan(0.15);

  const b = createState(flat, cfg);
  let lifted = false;
  for (let i = 0; i < 120 * 2 && !lifted; i++) {
    tick(b, IN_THROTTLE | IN_LEAN_BACK, flat, cfg);
    lifted = b.front.grounded === 0 && b.rear.grounded === 1 && b.ry > 0.4;
  }
  expect(lifted).toBe(true);
});

test("a wheelie can be held by feathering the controls", () => {
  // a rider who only reacts ten times a second
  const s = createState(flat, cfg);
  let input = 0;
  let onRearOnly = 0;
  for (let i = 0; i < 120 * 10 && s.status === RUNNING; i++) {
    if (i % 12 === 0) {
      const pitch = Math.atan2(s.ry, s.rx) + s.w * 0.15;
      input = pitch < 0.7 ? IN_THROTTLE | IN_LEAN_BACK : pitch < 0.9 ? IN_THROTTLE : pitch < 1.08 ? 0 : 8;
    }
    tick(s, input, flat, cfg);
    if (s.front.grounded === 0 && s.rear.grounded === 1) onRearOnly++;
  }
  expect(s.status).toBe(RUNNING);
  expect(onRearOnly / 120).toBeGreaterThan(3);
});

test("in-air lean is weak: a full flip takes over two seconds", () => {
  const s = airborne(0, 10, 200);
  let turned = 0;
  for (let i = 0; i < 120 * 2; i++) {
    tick(s, IN_LEAN_BACK, flat, cfg);
    turned += s.w / 120;
  }
  expect(turned).toBeGreaterThan(Math.PI * 0.8);
  expect(turned).toBeLessThan(Math.PI * 2);
});

test("the rear fender snaps when the bike comes down on it, and the rider does not survive", () => {
  // tipped over backwards past vertical, dropped from a small height
  const s = airborne(115, 0, 0.6);
  const events: SimEvent[] = [];
  for (let i = 0; i < 120 * 4 && s.status === RUNNING; i++) tick(s, 0, flat, cfg, events);
  expect(events.some((e) => e.type === "fenderBreak")).toBe(true);
  expect(s.fenderBroken).toBe(1);
  expect(s.status).toBe(CRASHED);
});

test("the bike can never rest on its tail: it either recovers onto its wheels or the rider dies", () => {
  for (let deg = 60; deg <= 130; deg += 5) {
    for (const input of [0, 4, 8, 1, 1 | 8, 2]) {
      const s = airborne(deg, 0, 0.5);
      for (let i = 0; i < 120 * 8 && s.status === RUNNING; i++) tick(s, input, flat, cfg);
      if (s.status !== RUNNING) continue;
      const upright = s.rx > 0.7 && s.rear.grounded === 1;
      // balancing on the rear wheel alone is a standing wheelie, which is fine; resting on the
      // fender or frame is the trap this guards against
      const fx = s.x + s.rx * BODY_FENDER.x - s.ry * BODY_FENDER.y;
      const fy = s.y + s.ry * BODY_FENDER.x + s.rx * BODY_FENDER.y;
      const onTail = collideCircle(flat, fx, fy, BODY_FENDER.r + 0.02, { nx: 0, ny: 0, depth: 0 });
      if (!upright && (onTail || s.front.grounded === 1)) {
        throw new Error(`stuck: dropped at ${deg} deg holding input ${input}, pitch now ${Math.atan2(s.ry, s.rx) * 57.3}`);
      }
    }
  }
});

test("a light tap on the fender does not break it", () => {
  const s = airborne(62, 3, 0.25);
  const events: SimEvent[] = [];
  for (let i = 0; i < 120 * 2; i++) tick(s, 0, flat, cfg, events);
  expect(s.fenderBroken).toBe(0);
});

test("built levels are verified: the stored solution really finishes, and throttle alone does not", () => {
  for (const [seed, difficulty] of [
    [1, 0.3],
    [2, 0.5],
    [3, 0.7],
  ] as const) {
    const params = { seed, difficulty, length: 300 };
    const level = buildLevel(params);
    expect(level.verified).toBe(true);
    const s = createState(level.track, cfg);
    for (const input of level.solution!) tick(s, input, level.track, cfg);
    expect(s.status).toBe(FINISHED);
    expect(s.endTick).toBe(level.solutionTicks);
    expect(throttleOnlyFinishes(level.track, cfg)).toBe(false);
    // same parameters, same level
    const again = buildLevel(params);
    expect(again.attempt).toBe(level.attempt);
    expect(again.solutionTicks).toBe(level.solutionTicks);
  }
}, 120000);

test("landings soak up the impact instead of launching the bike back up", () => {
  // drops from up to 6 m onto flat ground, at a range of angles, with no input
  for (const height of [1, 3, 6]) {
    for (const deg of [-35, -20, 0, 20, 35]) {
      const s = airborne(deg, 12, height);
      let touched = -1;
      let peakUp = 0;
      for (let i = 0; i < 120 * 3 && s.status === RUNNING; i++) {
        tick(s, 0, flat, cfg);
        if (touched < 0 && (s.rear.grounded || s.front.grounded)) touched = i;
        if (touched >= 0 && i - touched < 60) peakUp = Math.max(peakUp, s.vy);
      }
      // 3 m/s up is about 0.3 m of rise; it used to reach 8.5 m/s (over 2 m)
      if (peakUp > 3) throw new Error(`dropped ${height} m at ${deg} deg: popped up at ${peakUp.toFixed(1)} m/s`);
    }
  }
});
