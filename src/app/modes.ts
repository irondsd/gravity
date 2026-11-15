// Game modes: which levels exist, and exactly what each one is.
// Levels are seeded from the player's name, so the same name always gets the same tracks.
import type { LevelParams } from "../level/generator";
import type { BikeConfig } from "../sim";
import { planetById, planetConfig, planetGapScale, PLANETS, type Planet } from "./planets";
import { hashText, type CustomSettings } from "./save";

export type RaceTier = "easy" | "medium" | "hard";

export interface Ladder {
  id: string;
  title: string;
  /** Number of levels. */
  count: number;
  planet: Planet;
  race: RaceTier | null;
  /** Difficulty (0..1) and length (m) of level `n` (1-based). */
  difficulty: (n: number) => number;
  length: (n: number) => number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const round50 = (m: number) => Math.round(m / 50) * 50;
const EARTH = planetById("earth");

/** How hard each world's ten levels are: [first, last]. Heavy worlds are hard enough at modest ratings. */
const PLANET_RANGE: Record<string, [number, number]> = {
  moon: [0.1, 0.8],
  mars: [0.1, 0.8],
  mercury: [0.3, 0.9],
  super2: [0.05, 0.65],
  super3: [0.05, 0.55],
  super5: [0.05, 0.45],
  super10: [0.03, 0.3],
};
export const PLANET_LEVELS = 10;
export const RACES_PER_TIER = 10;

const RACE_SETUP: Record<RaceTier, { title: string; difficulty: [number, number]; length: [number, number] }> = {
  easy: { title: "Race · easy", difficulty: [0.12, 0.32], length: [300, 400] },
  medium: { title: "Race · medium", difficulty: [0.22, 0.45], length: [350, 450] },
  hard: { title: "Race · hard", difficulty: [0.32, 0.6], length: [400, 500] },
};

export const LADDERS: Ladder[] = [
  {
    id: "standard",
    title: "Standard",
    count: 100,
    planet: EARTH,
    race: null,
    difficulty: (n) => n / 100,
    length: (n) => round50(lerp(200, 500, (n - 1) / 99)),
  },
  ...PLANETS.filter((p) => p.group !== "standard").map((p): Ladder => {
    const [lo, hi] = PLANET_RANGE[p.id]!;
    const t = (n: number) => (n - 1) / (PLANET_LEVELS - 1);
    return {
      id: p.id,
      title: p.name,
      count: PLANET_LEVELS,
      planet: p,
      race: null,
      difficulty: (n) => lerp(lo, hi, t(n)),
      length: (n) => round50(lerp(250, 450, t(n)) * p.lengthScale),
    };
  }),
  ...(["easy", "medium", "hard"] as const).map((tier): Ladder => {
    const s = RACE_SETUP[tier];
    const t = (n: number) => (n - 1) / (RACES_PER_TIER - 1);
    return {
      id: `race-${tier}`,
      title: s.title,
      count: RACES_PER_TIER,
      planet: EARTH,
      race: tier,
      difficulty: (n) => lerp(s.difficulty[0], s.difficulty[1], t(n)),
      length: (n) => round50(lerp(s.length[0], s.length[1], t(n))),
    };
  }),
];

export function ladderById(id: string): Ladder | undefined {
  return LADDERS.find((l) => l.id === id);
}

/** Everything needed to build and play one level. */
export interface LevelSpec {
  /** Unique per player name, mode and level: records are stored under it. */
  id: string;
  ladder: string;
  /** 1-based position in its ladder (1 for custom). */
  index: number;
  /** Levels in its ladder. */
  count: number;
  title: string;
  planet: Planet;
  params: LevelParams;
  cfg: BikeConfig;
  race: RaceTier | null;
}

const nameKey = (name: string) => hashText(name.trim().toLowerCase()).toString(36);

export function ladderLevel(name: string, ladder: Ladder, n: number, base?: BikeConfig): LevelSpec {
  const index = Math.max(1, Math.min(ladder.count, Math.floor(n)));
  const key = `${ladder.id}/${index}`;
  return {
    id: `${nameKey(name)}/${key}`,
    ladder: ladder.id,
    index,
    count: ladder.count,
    title: `${ladder.title} · ${ladder.race ? "race" : "level"} ${index}`,
    planet: ladder.planet,
    params: {
      seed: hashText(`${name.trim().toLowerCase()}/${key}`),
      difficulty: ladder.difficulty(index),
      length: ladder.length(index),
      gapScale: planetGapScale(ladder.planet.g),
    },
    cfg: planetConfig(ladder.planet.g, base),
    race: ladder.race,
  };
}

export const CUSTOM_LENGTH = { min: 150, max: 2000, step: 50 };

export function customLevel(name: string, c: CustomSettings, base?: BikeConfig): LevelSpec {
  const planet = planetById(c.planet);
  const key = `custom/${planet.id}/${c.difficulty}/${c.length}/${c.variant}`;
  return {
    id: `${nameKey(name)}/${key}`,
    ladder: "custom",
    index: 1,
    count: 1,
    title: `Custom · ${planet.name} · difficulty ${c.difficulty} · ${c.length} m`,
    planet,
    params: { seed: hashText(`${name.trim().toLowerCase()}/${key}`), difficulty: c.difficulty / 100, length: c.length, gapScale: planetGapScale(planet.g) },
    cfg: planetConfig(planet.g, base),
    race: null,
  };
}
