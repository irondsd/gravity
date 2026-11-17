import { describe, expect, test } from "bun:test";
import riderFile from "../../data/rider.json";
import { loadRider, type RiderFile } from "../ai/policy";
import { generateTrack } from "../level/generator";
import { reach } from "../level/impossible";
import { TrackBuilder } from "../level/builder";
import { trackHash } from "../game/replay";
import { buildLevel } from "../level/level";
import { createState, defaultConfig, FINISHED, IN_LEAN_BACK, IN_THROTTLE, RUNNING, tick } from "../sim";
import { ACHIEVEMENTS, finishAchievements, iconSvg, RunTracker, type FinishInfo } from "./achievements";
import { campaignDifficulty, customLevel, LADDERS, ladderById, ladderLevel } from "./modes";
import { planetConfig, planetGapScale, PLANETS } from "./planets";
import { OPPONENTS, RaceBuilder, racePlace } from "./race";
import { cleanName, hashText, newSave, parseSave, randomName } from "./save";
import { THEMES } from "../render/themes";

describe("save", () => {
  test("a new save has a generated name and nothing unlocked", () => {
    const s = newSave();
    expect(s.name.length).toBeGreaterThan(4);
    expect(s.progress).toEqual({});
    expect(s.achievements).toEqual({});
  });

  test("random names are seedable and vary", () => {
    let i = 0;
    const fake = () => [0.1, 0.5, 0.9][i++ % 3]!;
    expect(randomName(fake)).toBe(randomName(() => [0.1, 0.5, 0.9][i++ % 3]!));
    const names = new Set(Array.from({ length: 50 }, () => randomName()));
    expect(names.size).toBeGreaterThan(20);
  });

  test("a save survives a round trip", () => {
    const s = newSave("Tester");
    s.progress.standard = 12;
    s.records["a/standard/3"] = 2400;
    s.achievements.backflip = 123456;
    s.options.blood = false;
    s.options.volume = 0.3;
    s.stats.planets = ["earth", "moon"];
    expect(parseSave(JSON.stringify(s))).toEqual(s);
  });

  test("broken or hostile stored data falls back to safe values", () => {
    expect(parseSave("not json", "Fallback").name).toBe("Fallback");
    expect(parseSave(null, "Fallback").name).toBe("Fallback");
    expect(parseSave('{"v":99,"name":"Old"}', "Fallback").name).toBe("Fallback");
    const s = parseSave(
      JSON.stringify({ v: 1, name: "   ", options: { blood: "no", volume: 55 }, progress: { standard: "lots", moon: -3, mars: 4 }, custom: { difficulty: 900, length: 7, planet: 5 }, stats: { crashes: -5, planets: [1, "moon"] } }),
      "Fallback",
    );
    expect(s.name).toBe("Fallback");
    expect(s.options.blood).toBe(true);
    expect(s.options.volume).toBe(1);
    expect(s.progress).toEqual({ mars: 4 });
    expect(s.custom.difficulty).toBe(100);
    expect(s.custom.length).toBe(150);
    expect(s.custom.planet).toBe("earth");
    expect(s.stats.crashes).toBe(0);
    expect(s.stats.planets).toEqual(["moon"]);
  });

  test("names are trimmed and capped", () => {
    expect(cleanName("  Mad   Max  ")).toBe("Mad Max");
    expect(cleanName("x".repeat(80)).length).toBe(20);
    expect(cleanName("   ")).toBe("");
  });
});

describe("modes", () => {
  test("the same name always gets the same levels, and another name gets others", () => {
    const std = ladderById("standard")!;
    const a = ladderLevel("Rider", std, 7);
    const b = ladderLevel("  rider ", std, 7);
    const c = ladderLevel("Someone Else", std, 7);
    expect(a.params).toEqual(b.params);
    expect(a.id).toBe(b.id);
    expect(c.params.seed).not.toBe(a.params.seed);
    expect(c.id).not.toBe(a.id);
    expect(ladderLevel("Rider", std, 8).params.seed).not.toBe(a.params.seed);
  });

  test("standard is 100 levels of rising difficulty on the default bike", () => {
    const std = ladderById("standard")!;
    expect(std.count).toBe(100);
    let prev = 0;
    for (let n = 1; n <= 100; n++) {
      const s = ladderLevel("Rider", std, n);
      expect(s.params.difficulty).toBeGreaterThan(prev);
      expect(s.params.difficulty).toBeLessThanOrEqual(1);
      expect(s.params.length).toBeGreaterThanOrEqual(200);
      expect(s.params.length).toBeLessThanOrEqual(500);
      expect(s.cfg).toEqual(defaultConfig);
      prev = s.params.difficulty;
    }
    expect(prev).toBe(1);
  });

  test("every world has a ladder and a theme; light worlds have longer tracks", () => {
    for (const p of PLANETS) {
      expect(THEMES[p.theme]).toBeDefined();
      if (p.group === "standard") continue;
      const l = ladderById(p.id)!;
      expect(l.count).toBe(10);
      const first = ladderLevel("Rider", l, 1);
      const last = ladderLevel("Rider", l, 10);
      expect(last.params.difficulty).toBeGreaterThan(first.params.difficulty);
      expect(first.cfg.gravity).toBeCloseTo(defaultConfig.gravity * p.g, 9);
      if (p.group === "light") expect(first.params.length).toBeGreaterThanOrEqual(500);
    }
    expect(LADDERS.filter((l) => l.race).map((l) => l.id)).toEqual(["race-easy", "race-medium", "race-hard", "race-impossible"]);
  });

  test("level numbers outside a ladder are clamped", () => {
    const std = ladderById("standard")!;
    expect(ladderLevel("Rider", std, 0).index).toBe(1);
    expect(ladderLevel("Rider", std, 999).index).toBe(100);
  });

  test("custom levels follow their settings", () => {
    const base = { difficulty: 60, length: 2000, planet: "mars", variant: 0 };
    const a = customLevel("Rider", base);
    expect(a.params.difficulty).toBeCloseTo(0.6, 9);
    expect(a.params.length).toBe(2000);
    expect(a.planet.id).toBe("mars");
    expect(customLevel("Rider", { ...base, variant: 1 }).params.seed).not.toBe(a.params.seed);
    expect(customLevel("Rider", { ...base, planet: "nowhere" }).planet.id).toBe("earth");
  });

  test("hashing text is stable", () => {
    expect(hashText("")).toBe(0x811c9dc5);
    expect(hashText("gravity")).toBe(hashText("gravity"));
    expect(hashText("gravity")).not.toBe(hashText("Gravity"));
  });
});

describe("planets", () => {
  test("standard gravity leaves the bike alone", () => {
    expect(planetConfig(1)).toEqual(defaultConfig);
    expect(planetGapScale(1)).toBe(1);
  });

  test("jumps are narrower on heavy worlds and wider on light ones", () => {
    expect(planetGapScale(5)).toBeLessThan(planetGapScale(2));
    expect(planetGapScale(2)).toBeLessThan(1);
    expect(planetGapScale(0.165)).toBeGreaterThan(planetGapScale(0.38));
    expect(planetGapScale(0.38)).toBeGreaterThan(1);
  });

  test("on every world the bike rides flat ground on throttle alone without blowing up or flipping", () => {
    const flat = generateTrack({ seed: 1, difficulty: 0, length: 400 });
    for (const p of PLANETS) {
      const cfg = planetConfig(p.g);
      const s = createState(flat, cfg);
      for (let i = 0; i < 120 * 10 && s.status === RUNNING; i++) tick(s, IN_THROTTLE, flat, cfg);
      expect(Number.isFinite(s.x) && Number.isFinite(s.y)).toBe(true);
      expect(s.status === RUNNING || s.status === FINISHED).toBe(true);
      expect(s.x).toBeGreaterThan(60);
    }
  });

  test("an early level on every world can be proven passable", () => {
    for (const p of PLANETS) {
      if (p.group === "standard") continue;
      const spec = ladderLevel("Rider", ladderById(p.id)!, 2);
      expect(buildLevel(spec.params, spec.cfg).verified).toBe(true);
    }
  }, 60000);
});

describe("race", () => {
  const rider = loadRider(riderFile as RiderFile)!;

  test("places: finishing ahead of everyone wins; crashed opponents do not count", () => {
    const runs = [
      { inputs: new Uint8Array(), finished: true, ticks: 3000 },
      { inputs: new Uint8Array(), finished: true, ticks: 3500 },
      { inputs: new Uint8Array(), finished: false, ticks: 900 },
    ];
    expect(racePlace(2999, runs)).toBe(1);
    expect(racePlace(3000, runs)).toBe(2);
    expect(racePlace(3200, runs)).toBe(2);
    expect(racePlace(9999, runs)).toBe(3);
  });

  test("a race is built with the right number of opponents, sorted, and replayable", () => {
    const spec = ladderLevel("Rider", ladderById("race-medium")!, 1);
    const b = new RaceBuilder(spec.params, spec.cfg, rider, "medium");
    let level = b.run();
    while (!level) level = b.run();
    expect(level.runs.length).toBe(OPPONENTS.medium.length);
    expect(level.runs[0]!.finished).toBe(true);
    for (let i = 1; i < level.runs.length; i++) {
      const a = level.runs[i - 1]!;
      const c = level.runs[i]!;
      if (a.finished && c.finished) expect(a.ticks).toBeLessThanOrEqual(c.ticks);
    }
    // the recorded inputs really do finish the track at the recorded time
    const lead = level.runs[0]!;
    const s = createState(level.track, spec.cfg);
    for (let i = 0; i < lead.inputs.length && s.status === RUNNING; i++) tick(s, lead.inputs[i]!, level.track, spec.cfg);
    expect(s.status).toBe(FINISHED);
    expect(s.endTick).toBe(lead.ticks);
  }, 30000);

  test("the easy opponent is slower than the hard leader on the same track", () => {
    const spec = ladderLevel("Rider", ladderById("race-easy")!, 1);
    const run = (tier: "easy" | "hard") => {
      const b = new RaceBuilder(spec.params, spec.cfg, rider, tier);
      let l = b.run();
      while (!l) l = b.run();
      return l;
    };
    const easy = run("easy");
    const hard = run("hard");
    if (easy.attempt === hard.attempt && easy.runs[0]!.finished && hard.runs[0]!.finished) {
      expect(easy.runs[0]!.ticks).toBeGreaterThan(hard.runs[0]!.ticks * 1.2);
    }
    expect(hard.runs.length).toBe(10);
  }, 60000);
});

describe("achievements", () => {
  test("ids are unique and every icon is well-formed SVG", () => {
    expect(new Set(ACHIEVEMENTS.map((a) => a.id)).size).toBe(ACHIEVEMENTS.length);
    for (const a of ACHIEVEMENTS) {
      const svg = iconSvg(a);
      expect(svg.startsWith("<svg") && svg.endsWith("</svg>")).toBe(true);
      expect((svg.match(/<g/g) ?? []).length).toBe((svg.match(/<\/g>/g) ?? []).length);
      expect(a.title.length).toBeGreaterThan(2);
    }
  });

  const base: FinishInfo = {
    ladder: "standard",
    index: 5,
    difficulty: 0.05,
    length: 200,
    ticks: 3000,
    failsBefore: 0,
    previousBest: null,
    place: null,
    marginTicks: null,
    headScraped: false,
    fenderBroken: false,
    standardDone: 5,
    streak: 1,
    planets: ["earth"],
  };

  test("a plain finish earns nothing", () => {
    expect(finishAchievements(base)).toEqual([]);
  });

  test("each finish achievement has its own trigger", () => {
    const got = (over: Partial<FinishInfo>) => finishAchievements({ ...base, ...over });
    expect(got({ failsBefore: 10 })).toEqual(["persist"]);
    expect(got({ failsBefore: 9 })).toEqual([]);
    expect(got({ index: 30, standardDone: 30 })).toEqual(["firsttry", "std10"]);
    expect(got({ index: 30, standardDone: 30, failsBefore: 1 })).toEqual(["std10"]);
    expect(got({ previousBest: 3001 })).toEqual(["record"]);
    expect(got({ previousBest: 3000 })).toEqual([]);
    expect(got({ standardDone: 100, index: 100, failsBefore: 3 })).toEqual(["std10", "std50", "std100"]);
    expect(got({ ladder: "race-hard", place: 1, marginTicks: 400 })).toEqual(["ai-hard"]);
    expect(got({ ladder: "race-easy", place: 1, marginTicks: 30 })).toEqual(["ai-easy", "photo"]);
    expect(got({ ladder: "race-easy", place: 2, marginTicks: -30 })).toEqual([]);
    expect(got({ planets: ["earth", "moon", "mars"] })).toEqual([]);
    expect(got({ planets: ["moon", "mars", "mercury"] })).toEqual(["tourist"]);
    expect(got({ planets: ["super2", "super3", "super5", "super10"] })).toEqual(["heavy"]);
    expect(got({ ladder: "custom", length: 2000 })).toEqual(["marathon"]);
    expect(got({ headScraped: true, fenderBroken: true })).toEqual(["hardhead", "fender"]);
    expect(got({ streak: 5 })).toEqual(["streak"]);
    expect(got({ ladder: "custom", difficulty: 1 })).toEqual(["extreme"]);
    expect(got({ ladder: "standard", index: 100, difficulty: 1, standardDone: 4, failsBefore: 1 })).toEqual([]);
  });

  test("every achievement the game can award exists", () => {
    const awarded = new Set<string>(["backflip", "frontflip", "double", "triple", "wheelie", "airtime", "speed", "dummy"]);
    const all: Partial<FinishInfo>[] = [
      { failsBefore: 10 },
      { index: 30 },
      { previousBest: 9999 },
      { standardDone: 100 },
      { ladder: "race-easy", place: 1, marginTicks: 1 },
      { ladder: "race-medium", place: 1 },
      { ladder: "race-hard", place: 1 },
      { ladder: "race-impossible", place: 1 },
      { ladder: "impossible-climb", index: 10 },
      { ladder: "impossible-descent", index: 10 },
      { ladder: "impossible-campaign", index: 25 },
      { planets: PLANETS.map((p) => p.id) },
      { ladder: "custom", length: 2000, difficulty: 1 },
      { headScraped: true, fenderBroken: true, streak: 5 },
    ];
    for (const over of all) for (const id of finishAchievements({ ...base, ...over })) awarded.add(id);
    expect([...awarded].sort()).toEqual(ACHIEVEMENTS.map((a) => a.id).sort());
  });

  // A big ramp into open air: enough flight to rotate in.
  function jumpTrack() {
    return { track: generateTrack({ seed: 1, difficulty: 0, length: 300 }), cfg: planetConfig(0.165) };
  }

  test("a landed backflip is noticed, and only once the rider has ridden away", () => {
    // Drive the tracker with a hand-made state history: one full backward turn in the air, then a clean landing.
    const { track, cfg } = jumpTrack();
    const s = createState(track, cfg);
    const t = new RunTracker();
    const seen: string[] = [];
    const feed = (ticks: number, rear: number, front: number, w: number) => {
      for (let i = 0; i < ticks; i++) {
        s.tick++;
        s.rear.grounded = rear;
        s.front.grounded = front;
        s.w = w;
        seen.push(...t.tick(s));
      }
    };
    feed(30, 1, 1, 0);
    feed(120, 0, 0, 2 * Math.PI); // one full turn per second, for one second
    expect(seen).toEqual([]);
    feed(59, 1, 1, 0);
    expect(seen).toEqual([]);
    feed(5, 1, 1, 0);
    expect(seen).toEqual(["backflip"]);
  });

  test("two turns forward is a frontflip and a double; crashing on landing earns nothing", () => {
    const { track, cfg } = jumpTrack();
    const run = (crash: boolean) => {
      const s = createState(track, cfg);
      const t = new RunTracker();
      const seen: string[] = [];
      const feed = (ticks: number, grounded: number, w: number) => {
        for (let i = 0; i < ticks; i++) {
          s.tick++;
          s.rear.grounded = grounded;
          s.front.grounded = grounded;
          s.w = w;
          seen.push(...t.tick(s));
        }
      };
      feed(10, 1, 0);
      feed(240, 0, -2 * Math.PI);
      feed(10, 1, 0);
      if (crash) s.status = 1;
      feed(100, 1, 0);
      return seen;
    };
    expect(run(false)).toEqual(["frontflip", "double"]);
    expect(run(true)).toEqual([]);
  });

  test("a real wheelie in the sim is recognised", () => {
    // Balance on the rear wheel with a simple controller, and check the tracker agrees with the sim.
    const track = generateTrack({ seed: 3, difficulty: 0, length: 2000 });
    const s = createState(track, defaultConfig);
    const t = new RunTracker();
    const seen = new Set<string>();
    let wheelieTicks = 0;
    let best = 0;
    for (let i = 0; i < 120 * 60 && s.status === RUNNING; i++) {
      // lean back while the nose is low, ease off when it is high
      const input = s.ry < 0.45 ? IN_THROTTLE | IN_LEAN_BACK : s.ry > 0.62 ? 0 : IN_THROTTLE;
      tick(s, input, track, defaultConfig);
      for (const id of t.tick(s)) seen.add(id);
      if (s.rear.grounded === 1 && s.front.grounded === 0 && s.vx > 3) wheelieTicks++;
      else if (s.front.grounded === 1) wheelieTicks = 0;
      best = Math.max(best, wheelieTicks);
    }
    // whatever the controller managed, the tracker must agree with a direct count
    expect(seen.has("wheelie")).toBe(best >= 5 * 120);
  });
});

describe("impossible modes", () => {
  const climb = ladderById("impossible-climb")!;
  const descent = ladderById("impossible-descent")!;
  const campaign = ladderById("impossible-campaign")!;
  const extent = (n: number, ys: Float64Array) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 1; i < n - 1; i++) {
      lo = Math.min(lo, ys[i]!);
      hi = Math.max(hi, ys[i]!);
    }
    return { lo, hi };
  };

  test("climb and descent are ten levels each, from easy to the edge; none is checked by the solver", () => {
    for (const l of [climb, descent]) {
      expect(l.count).toBe(10);
      expect(ladderLevel("Rider", l, 1).params.difficulty).toBe(0);
      expect(ladderLevel("Rider", l, 10).params.difficulty).toBe(1);
      expect(ladderLevel("Rider", l, 5).verify).toBe(false);
      expect(ladderLevel("Rider", l, 5).cfg).toEqual(defaultConfig);
      expect(THEMES[ladderLevel("Rider", l, 5).theme]).toBeDefined();
    }
    expect(ladderLevel("Rider", ladderById("standard")!, 5).verify).toBe(true);
  });

  test("climbs go up and descents go down, further on harder levels", () => {
    const c1 = ladderLevel("Rider", climb, 1);
    const c10 = ladderLevel("Rider", climb, 10);
    const t1 = generateTrack(c1.params);
    const t10 = generateTrack(c10.params);
    expect(t1.ys[t1.n - 1]!).toBeGreaterThan(10);
    expect(t10.ys[t10.n - 1]!).toBeGreaterThan(t1.ys[t1.n - 1]!);
    const d1 = generateTrack(ladderLevel("Rider", descent, 1).params);
    const d10 = generateTrack(ladderLevel("Rider", descent, 10).params);
    expect(d1.ys[d1.n - 1]!).toBeLessThan(-10);
    expect(d10.ys[d10.n - 1]!).toBeLessThan(d1.ys[d1.n - 1]!);
    expect(extent(d10.n, d10.ys).hi).toBeLessThan(5);
  });

  test("impossible tracks are the same every time, and differ by name and level", () => {
    for (const l of [climb, descent, campaign]) {
      const a = ladderLevel("Rider", l, 7);
      expect(trackHash(generateTrack(a.params))).toBe(trackHash(generateTrack(a.params)));
      expect(trackHash(generateTrack(ladderLevel("Other", l, 7).params))).not.toBe(trackHash(generateTrack(a.params)));
    }
  });

  test("a wall the engine cannot hold stops the climbing bot partway; a longer run-up gets it higher", () => {
    const face = (run: number) => {
      const b = new TrackBuilder();
      b.flat(3 + run).bend(4, 0, 2).slope(30, 60).bend(3, 2, 0).flat(20);
      return b.build(2, 1);
    };
    const short = reach(face(3), 0);
    const long = reach(face(40), 0);
    expect(short).toBeGreaterThan(3);
    expect(short).toBeLessThan(40);
    expect(long).toBeGreaterThan(short + 2);
  });

  test("the campaign never ends and keeps getting harder and longer", () => {
    expect(campaign.endless).toBe(true);
    let prev = 0;
    for (let n = 1; n <= 200; n++) {
      const d = campaignDifficulty(n);
      expect(d).toBeGreaterThan(prev);
      expect(d).toBeLessThan(0.9);
      prev = d;
    }
    expect(campaignDifficulty(1)).toBeCloseTo(0.15, 5);
    const a = ladderLevel("Rider", campaign, 1);
    const b = ladderLevel("Rider", campaign, 60);
    expect(b.params.length).toBeGreaterThan(a.params.length);
    expect(b.index).toBe(60);
    // the look changes every five levels
    expect(ladderLevel("Rider", campaign, 5).theme).toBe(a.theme);
    expect(ladderLevel("Rider", campaign, 6).theme).not.toBe(a.theme);
  });

  test("an impossible race fields ten riders, each the best of three", () => {
    expect(OPPONENTS.impossible.length).toBe(10);
    const l = ladderById("race-impossible")!;
    expect(ladderLevel("Rider", l, 1).params.difficulty).toBeGreaterThan(ladderLevel("Rider", ladderById("race-hard")!, 10).params.difficulty - 0.11);
  });

  test("finishing the last climb, the last descent, and deep campaign levels earns achievements", () => {
    const base: FinishInfo = { ladder: "impossible-climb", index: 10, difficulty: 1, length: 330, ticks: 9000, failsBefore: 0, previousBest: 1, place: null, marginTicks: null, headScraped: false, fenderBroken: false, standardDone: 0, streak: 0, planets: [] };
    expect(finishAchievements(base)).toEqual(["summit"]);
    expect(finishAchievements({ ...base, index: 9 })).toEqual([]);
    expect(finishAchievements({ ...base, ladder: "impossible-descent" })).toEqual(["freefall"]);
    expect(finishAchievements({ ...base, ladder: "impossible-campaign", index: 25 })).toEqual(["grinder", "relentless"]);
    expect(finishAchievements({ ...base, ladder: "race-impossible", place: 1, marginTicks: 400 })).toEqual(["ai-impossible"]);
  });
});
