// Simulation constants and tunable bike parameters.
// Units: meters, kilograms, seconds. World is y-up; +x is forward.
// Rotation is counter-clockwise positive, so "lean back" (front wheel up) is positive.

/** Changes whenever the simulation's behavior changes, so stored runs from older physics can be told apart. */
export const PHYSICS_VERSION = 2;

export const TICK_RATE = 120;
export const SUBSTEPS = 8;
export const TICK_DT = 1 / TICK_RATE;
export const SUB_DT = TICK_DT / SUBSTEPS;

export const defaultConfig = {
  gravity: 15,

  // Chassis (frame + rider as one rigid body, origin at its center of mass)
  chassisMass: 150,
  chassisInertia: 40,

  // Wheels
  wheelRadius: 0.35,
  wheelMass: 15,
  wheelInertia: 1.5,
  rearAnchorX: -0.72,
  rearAnchorY: -0.38,
  frontAnchorX: 0.78,
  frontAnchorY: -0.38,
  // Front fork direction in chassis space (normalized at use). Rear is straight down.
  frontAxisX: 0.42,
  frontAxisY: -0.9,

  // Suspension: soft along the axis, stiff across it
  suspK: 26000,
  suspDamp: 2300,
  reboundDamp: 2.5, // rebound damping as a multiple of compression damping, like a real shock
  suspTravel: 0.14,
  suspStopK: 150000,
  lateralK: 1000000,
  lateralDamp: 5000,

  // Tires
  tireK: 200000,
  tireDamp: 3000,
  tireMu: 1.1,
  tireStickK: 150000,
  tireStickDamp: 2000,

  // Engine and brakes
  engineTorque: 680,
  maxWheelSpin: 80, // rad/s at which engine torque reaches zero
  driveReaction: 0.8, // 0..1 share of engine/brake torque that pitches the chassis
  brakeRear: 560,
  brakeFront: 360,

  // Lean control: lean input drives chassis rotation toward a target rate
  leanSpeedAir: 2.75,
  leanSpeedGround: 2.6,
  leanTorque: 950, // on the ground
  leanTorqueAir: 325,
  leanGain: 400,
  airStability: 0.12, // 0..1 how strongly rotation is damped in the air with no lean input
  groundStability: 0,
  wheelieStability: 0.3, // same, while balancing on the rear wheel
  leanRate: 7, // how fast the rider's body moves (visual + head position)

  // Landing: speed scrubbed off when the bike hits the ground out of line with it (0 = off)
  landingScrub: 0.35,
  // ...and how hard such a landing kicks the bike back up, once, at touchdown (0 = off)
  landingBounce: 0.5,

  // Rider head
  headX: -0.12,
  headY: 0.92,
  headRadius: 0.13,
  headLeanShift: 0.25,

  // Body contact with ground
  bodyK: 300000,
  bodyDamp: 6000,
  bodyMu: 0.5,

  // Rear fender: springy, but snaps off under load
  fenderK: 70000,
  fenderDamp: 900,
  fenderBreak: 110, // accumulated impulse (N*s) that snaps it
  fenderHitSpeed: 5, // first-contact speed that snaps it instantly

  // Head damage model
  headHitSpeed: 3.5, // first-contact speed into the ground that kills instantly
  headDamageMax: 220, // accumulated impulse (N*s) that breaks the neck
  headRecover: 150, // damage decay per second
};

export type BikeConfig = typeof defaultConfig;

/**
 * Allowed range for every parameter. Values outside these can make the physics blow up
 * or the drawing fail, so anything loaded or tuned is clamped to them.
 */
export const CONFIG_LIMITS: Record<keyof BikeConfig, readonly [number, number]> = {
  gravity: [4, 30],
  chassisMass: [80, 300],
  chassisInertia: [15, 120],
  wheelRadius: [0.25, 0.5],
  wheelMass: [10, 30],
  wheelInertia: [0.6, 5],
  rearAnchorX: [-1.1, -0.4],
  rearAnchorY: [-0.6, -0.2],
  frontAnchorX: [0.4, 1.2],
  frontAnchorY: [-0.6, -0.2],
  frontAxisX: [0, 0.8],
  frontAxisY: [-1, -0.5],
  suspK: [8000, 60000],
  suspDamp: [300, 4500],
  reboundDamp: [1, 5],
  suspTravel: [0.05, 0.3],
  suspStopK: [50000, 300000],
  lateralK: [300000, 1500000],
  lateralDamp: [2000, 6000],
  tireK: [80000, 400000],
  tireDamp: [800, 5000],
  tireMu: [0.3, 2.5],
  tireStickK: [50000, 300000],
  tireStickDamp: [500, 4000],
  engineTorque: [150, 1500],
  maxWheelSpin: [30, 200],
  driveReaction: [0, 1],
  brakeRear: [0, 1200],
  brakeFront: [0, 1200],
  leanSpeedAir: [0.5, 10],
  leanSpeedGround: [0.5, 8],
  leanTorque: [100, 2500],
  leanTorqueAir: [50, 1500],
  leanGain: [50, 1500],
  airStability: [0, 1],
  groundStability: [0, 1],
  wheelieStability: [0, 1],
  leanRate: [1, 20],
  landingScrub: [0, 1],
  landingBounce: [0, 1],
  headX: [-0.4, 0.2],
  headY: [0.7, 1.2],
  headRadius: [0.08, 0.2],
  headLeanShift: [0, 0.4],
  bodyK: [100000, 500000],
  bodyDamp: [2000, 10000],
  bodyMu: [0, 1.5],
  fenderK: [20000, 200000],
  fenderDamp: [200, 3000],
  fenderBreak: [20, 600],
  fenderHitSpeed: [1, 15],
  headHitSpeed: [1, 12],
  headDamageMax: [50, 800],
  headRecover: [0, 600],
};

/** Returns a complete, in-range config from anything config-shaped (saved data, a replay, sliders). */
export function sanitizeConfig(input: unknown): BikeConfig {
  const src = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const out = { ...defaultConfig };
  for (const k of Object.keys(defaultConfig) as (keyof BikeConfig)[]) {
    const v = src[k];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const [lo, hi] = CONFIG_LIMITS[k];
    out[k] = v < lo ? lo : v > hi ? hi : v;
  }
  return out;
}

// Fixed collision circles on the chassis (local space).
export const BODY_ENGINE = { x: 0.02, y: -0.12, r: 0.2 };
export const BODY_BARS = { x: 0.5, y: 0.38, r: 0.1 };
export const BODY_FENDER = { x: -0.66, y: 0.22, r: 0.1 };
export const BODY_TORSO = { x: -0.22, y: 0.52, r: 0.17 };

// Input is a bitmask so a run is just an array of small integers.
export const IN_THROTTLE = 1;
export const IN_BRAKE = 2;
export const IN_LEAN_BACK = 4;
export const IN_LEAN_FWD = 8;
