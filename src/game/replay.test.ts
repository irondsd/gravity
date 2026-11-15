import { expect, test } from "bun:test";
import { buildTestTrack } from "../level/testTrack";
import {
  CRASHED,
  createState,
  defaultConfig,
  FINISHED,
  hashState,
  IN_LEAN_BACK,
  IN_LEAN_FWD,
  IN_THROTTLE,
  RUNNING,
  tick,
  TICK_DT,
  type SimState,
} from "../sim";
import { Game } from "./game";
import { decodeReplay, encodeReplay, makeReplay, verifyReplay } from "./replay";

// Simple rider that finishes the test track: full throttle, lean against the tilt.
export function autopilot(s: SimState): number {
  return IN_THROTTLE | (s.ry > 0.25 ? IN_LEAN_FWD : s.ry < -0.25 ? IN_LEAN_BACK : 0);
}

function recordRun() {
  const track = buildTestTrack();
  const s = createState(track, defaultConfig);
  const inputs: number[] = [];
  while (s.status === RUNNING && s.tick < 120 * 120) {
    const inp = autopilot(s);
    inputs.push(inp);
    tick(s, inp, track, defaultConfig);
  }
  expect(s.status).toBe(FINISHED);
  return { track, replay: makeReplay(track, defaultConfig, inputs, s) };
}

test("a recorded run verifies, also after a save/load round trip", () => {
  const { track, replay } = recordRun();
  expect(verifyReplay(track, replay)).toBe(true);
  const loaded = decodeReplay(encodeReplay(replay))!;
  expect(loaded.inputs).toEqual(replay.inputs);
  expect(verifyReplay(track, loaded)).toBe(true);
});

test("a tampered run does not verify", () => {
  const { track, replay } = recordRun();
  const inputs = replay.inputs.slice();
  inputs[200] = inputs[200]! ^ IN_LEAN_BACK;
  expect(verifyReplay(track, { ...replay, inputs })).toBe(false);
  expect(verifyReplay(track, { ...replay, ticks: replay.ticks - 1 })).toBe(false);
  expect(verifyReplay(track, { ...replay, cfg: { ...replay.cfg, engineTorque: 600 } })).toBe(false);
});

test("game records a best run, shows it as a ghost, and replays it exactly", () => {
  const game = new Game(buildTestTrack(), defaultConfig);
  let saved = 0;
  game.onNewBest = () => saved++;
  for (let i = 0; i < 120 * 120 && game.state.status === RUNNING; i++) game.update(TICK_DT, autopilot(game.state));
  expect(game.state.status).toBe(FINISHED);
  expect(saved).toBe(1);
  expect(game.result?.newBest).toBe(true);
  const best = game.best!;
  expect(verifyReplay(game.track, best)).toBe(true);
  const finalHash = hashState(game.state);

  // next attempt races the ghost, which stays in lockstep with the player's clock
  game.restart();
  expect(game.ghost).not.toBeNull();
  for (let i = 0; i < 600; i++) game.update(TICK_DT, IN_THROTTLE);
  expect(game.ghost!.tick).toBe(game.state.tick);

  // watching the best run lands in exactly the recorded state
  game.watch(best);
  while (game.state.status === RUNNING) game.update(TICK_DT, 0);
  expect(game.state.endTick).toBe(best.ticks);
  // the sim keeps ticking after the finish, so compare at the finish tick via verify + endTick
  expect(finalHash).toBe(best.hash);
});

test("crash spawns a ragdoll and the game restarts itself", () => {
  const game = new Game(buildTestTrack(), defaultConfig);
  // throttle + lean back loops out
  for (let i = 0; i < 120 * 30 && game.state.status === RUNNING; i++) game.update(TICK_DT, IN_THROTTLE | IN_LEAN_BACK);
  expect(game.state.status).toBe(CRASHED);
  expect(game.ragdoll).not.toBeNull();
  const r = game.ragdoll!;
  for (let i = 0; i < 200; i++) game.update(TICK_DT, 0);
  for (let i = 0; i < r.x.length; i++) expect(Number.isFinite(r.x[i]! + r.y[i]!)).toBe(true);
  for (let i = 0; i < 120; i++) game.update(TICK_DT, 0);
  expect(game.state.tick).toBe(0);
  expect(game.ragdoll).toBeNull();
});
