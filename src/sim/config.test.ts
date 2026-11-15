import { expect, test } from "bun:test";
import { Game } from "../game/game";
import { makeRng } from "../level/generator";
import { buildTestTrack } from "../level/testTrack";
import { Effects } from "../render/effects";
import { Renderer } from "../render/renderer";
import { CONFIG_LIMITS, createState, defaultConfig, sanitizeConfig, tick, TICK_DT, type BikeConfig, type SimState } from "./index";

type Key = keyof BikeConfig;
const KEYS = Object.keys(defaultConfig) as Key[];
const track = buildTestTrack();

function stateIsFinite(s: SimState): boolean {
  const nums = [s.x, s.y, s.vx, s.vy, s.rx, s.ry, s.w, s.lean, s.headDamage, s.bounce];
  for (const wh of [s.rear, s.front]) nums.push(wh.x, wh.y, wh.vx, wh.vy, wh.w, wh.stick);
  // "finite" alone is not enough: a blown-up sim can stay finite while flying off at absurd speed
  return nums.every((n) => Number.isFinite(n)) && Math.abs(s.vx) < 500 && Math.abs(s.vy) < 500 && Math.abs(s.w) < 500;
}

/** Ride for a while with erratic inputs; returns whether the physics stayed sane. */
function survives(cfg: BikeConfig, seed: number, seconds: number): boolean {
  const rng = makeRng(seed);
  const s = createState(track, cfg);
  let input = 1;
  for (let i = 0; i < 120 * seconds; i++) {
    if (rng() < 0.04) input = Math.floor(rng() * 16);
    tick(s, input, track, cfg);
    if (!stateIsFinite(s)) return false;
  }
  return true;
}

test("defaults are inside the allowed ranges", () => {
  for (const k of KEYS) {
    const [lo, hi] = CONFIG_LIMITS[k];
    expect(lo).toBeLessThan(hi);
    expect(defaultConfig[k]).toBeGreaterThanOrEqual(lo);
    expect(defaultConfig[k]).toBeLessThanOrEqual(hi);
  }
});

test("sanitizeConfig repairs anything it is given", () => {
  expect(sanitizeConfig(null)).toEqual(defaultConfig);
  expect(sanitizeConfig("nonsense")).toEqual(defaultConfig);
  const bad = sanitizeConfig({ wheelRadius: -5, gravity: 1e9, chassisMass: NaN, tireMu: "2", suspK: Infinity, extra: 1 });
  expect(bad.wheelRadius).toBe(CONFIG_LIMITS.wheelRadius[0]);
  expect(bad.gravity).toBe(CONFIG_LIMITS.gravity[1]);
  expect(bad.chassisMass).toBe(defaultConfig.chassisMass);
  expect(bad.tireMu).toBe(defaultConfig.tireMu);
  expect(bad.suspK).toBe(defaultConfig.suspK);
  expect(Object.keys(bad)).toEqual(KEYS);
});

test("physics stays stable with each setting at either end of its range", () => {
  for (const k of KEYS) {
    for (const end of [0, 1] as const) {
      const cfg = { ...defaultConfig, [k]: CONFIG_LIMITS[k][end] };
      if (!survives(cfg, 11, 6)) throw new Error(`unstable with ${k} = ${CONFIG_LIMITS[k][end]}`);
    }
  }
});

test("physics stays stable with random combinations of settings", () => {
  const rng = makeRng(2024);
  const combos: BikeConfig[] = [];
  for (const end of [0, 1] as const) {
    const cfg = { ...defaultConfig };
    for (const k of KEYS) cfg[k] = CONFIG_LIMITS[k][end];
    combos.push(cfg);
  }
  for (let n = 0; n < 250; n++) {
    const cfg = { ...defaultConfig };
    for (const k of KEYS) {
      const [lo, hi] = CONFIG_LIMITS[k];
      const r = rng();
      // favor the extremes, where trouble lives
      cfg[k] = r < 0.25 ? lo : r > 0.75 ? hi : lo + (hi - lo) * rng();
    }
    combos.push(cfg);
  }
  combos.forEach((cfg, i) => {
    if (!survives(cfg, i, 4)) throw new Error(`unstable combination #${i}: ${JSON.stringify(cfg)}`);
  });
});

test("renderer never passes bad numbers to the canvas, at any allowed setting", () => {
  // A stand-in canvas that checks every number it is handed, like a real one would.
  let calls = 0;
  const check = (name: string, args: unknown[]) => {
    calls++;
    for (const a of args) if (typeof a === "number" && !Number.isFinite(a)) throw new Error(`${name} got ${a}`);
    if (name === "arc" && (args[2] as number) < 0) throw new Error(`arc radius ${args[2]}`);
    if (name === "ellipse" && ((args[2] as number) < 0 || (args[3] as number) < 0)) throw new Error("ellipse radius < 0");
    if (name.startsWith("createRadialGradient") && ((args[2] as number) < 0 || (args[5] as number) < 0)) throw new Error("gradient radius < 0");
  };
  const gradient = { addColorStop: () => {} };
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, prop: string) => {
      if (prop in target) return target[prop];
      return (...args: unknown[]) => {
        check(prop, args);
        return prop.startsWith("create") ? gradient : undefined;
      };
    },
    set: (target, prop: string, value) => {
      if (prop === "lineWidth" && !(value >= 0)) throw new Error(`lineWidth ${value}`);
      target[prop] = value;
      return true;
    },
  });
  const g = globalThis as Record<string, unknown>;
  g.window = { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1, addEventListener: () => {} };
  const canvas = { getContext: () => ctx, width: 0, height: 0 } as unknown as HTMLCanvasElement;

  const configs: BikeConfig[] = [];
  for (const k of KEYS) for (const end of [0, 1] as const) configs.push({ ...defaultConfig, [k]: CONFIG_LIMITS[k][end] });
  for (const cfg of configs) {
    const game = new Game(track, cfg);
    const fx = new Effects();
    const renderer = new Renderer(canvas, fx);
    // ride until a crash so the ragdoll and effects get drawn too
    for (let i = 0; i < 120 * 6; i++) {
      const alpha = game.update(TICK_DT, 1 | 4);
      for (const e of game.events) fx.onEvent(e, game);
      game.events.length = 0;
      fx.update(game, TICK_DT);
      if (i % 6 === 0) renderer.draw(game, alpha, TICK_DT * 6);
    }
  }
  expect(calls).toBeGreaterThan(1000);
});
