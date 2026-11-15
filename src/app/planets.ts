// Worlds to ride on: each has its own gravity, a bike set up for it, and a look.
import { defaultConfig, type BikeConfig } from "../sim";

export interface Planet {
  id: string;
  name: string;
  /** Gravity as a multiple of the standard game's. */
  g: number;
  group: "standard" | "light" | "heavy";
  blurb: string;
  theme: string;
  /** Tracks here are this many times longer than standard ones. */
  lengthScale: number;
}

export const PLANETS: Planet[] = [
  { id: "earth", name: "Earth", g: 1, group: "standard", blurb: "Home gravity", theme: "earth", lengthScale: 1 },
  { id: "moon", name: "Moon", g: 0.165, group: "light", blurb: "One sixth gravity. Huge, slow jumps.", theme: "moon", lengthScale: 2 },
  { id: "mars", name: "Mars", g: 0.38, group: "light", blurb: "A bit over a third gravity. Red dust and long air.", theme: "mars", lengthScale: 2 },
  { id: "mercury", name: "Mercury", g: 0.38, group: "light", blurb: "Mars gravity, rougher ground, a huge sun.", theme: "mercury", lengthScale: 2 },
  { id: "super2", name: "Super-Earth 2×", g: 2, group: "heavy", blurb: "Twice the gravity. Jumps are short and landings hurt.", theme: "super2", lengthScale: 1 },
  { id: "super3", name: "Super-Earth 3×", g: 3, group: "heavy", blurb: "Three times the gravity. The bike is glued down.", theme: "super3", lengthScale: 1 },
  { id: "super5", name: "Super-Earth 5×", g: 5, group: "heavy", blurb: "Five times the gravity. Every bump is a wall.", theme: "super5", lengthScale: 1 },
  { id: "super10", name: "Super-Earth 10×", g: 10, group: "heavy", blurb: "Ten times the gravity. Barely rideable. You were warned.", theme: "super10", lengthScale: 1 },
];

export function planetById(id: string): Planet {
  return PLANETS.find((p) => p.id === id) ?? PLANETS[0]!;
}

/**
 * The bike for a world with `g` times standard gravity. On heavy worlds the springs, tires and
 * engine are beefed up so the bike can still carry itself and climb; on light ones the engine is
 * tamed so it does not loop out the moment the throttle opens.
 */
export function planetConfig(g: number, base: BikeConfig = defaultConfig): BikeConfig {
  if (g === 1) return { ...base };
  const c = { ...base, gravity: base.gravity * g };
  if (g > 1) {
    const drive = Math.pow(g, 0.8);
    c.suspK = base.suspK * g;
    c.suspStopK = base.suspStopK * g;
    c.suspDamp = base.suspDamp * Math.sqrt(g);
    c.tireK = base.tireK * g;
    c.tireDamp = base.tireDamp * Math.sqrt(g);
    c.bodyK = base.bodyK * g;
    c.fenderK = base.fenderK * g;
    c.engineTorque = base.engineTorque * drive;
    c.brakeRear = base.brakeRear * drive;
    c.brakeFront = base.brakeFront * drive;
    c.leanTorque = base.leanTorque * drive;
    c.headDamageMax = base.headDamageMax * Math.sqrt(g);
    c.fenderBreak = base.fenderBreak * Math.sqrt(g);
  } else {
    // Low gravity: full power would flip the bike over backwards at once, and stiff springs would
    // keep bouncing the tires off the ground. Settings found by trying them on flat and bumpy ground.
    c.engineTorque = base.engineTorque * Math.pow(g, 0.75);
    c.driveReaction = base.driveReaction * g;
    c.leanTorque = base.leanTorque * Math.sqrt(g);
    c.tireMu = base.tireMu * 1.5;
    c.suspK = base.suspK * Math.sqrt(g);
    c.suspDamp = base.suspDamp * Math.pow(g, 0.25);
  }
  return c;
}

/** How wide jumps should be on a world, relative to standard. */
export function planetGapScale(g: number): number {
  return g >= 1 ? 1 / g : Math.min(2.5, Math.pow(1 / g, 0.6));
}
