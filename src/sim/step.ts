import {
  BODY_BARS,
  BODY_ENGINE,
  BODY_FENDER,
  BODY_TORSO,
  IN_BRAKE,
  IN_LEAN_BACK,
  IN_LEAN_FWD,
  IN_THROTTLE,
  SUB_DT,
  SUBSTEPS,
  type BikeConfig,
} from "./config";
import {
  CAUSE_CRUSHED,
  CAUSE_HEAD_IMPACT,
  CAUSE_NECK,
  CRASHED,
  FINISHED,
  RUNNING,
  type SimState,
  type WheelState,
} from "./state";
import { collideCircle, type Hit, type Track } from "./track";

export type SimEvent =
  | { type: "land"; wheel: 0 | 1; speed: number }
  | { type: "headScrape"; speed: number }
  | { type: "crash"; cause: number; speed: number }
  | { type: "fenderBreak" }
  | { type: "finish" };

/** Share of bump-stop force left while the shock extends again (the rest is absorbed). */
const STOP_RETURN = 0.25;
/** Share of tire and body spring force left while leaving the ground. */
const TIRE_RETURN = 0.45;
/** Largest upward kick a bad landing can give, m/s. */
const MAX_LANDING_KICK = 1.8;

// Scratch values reused across calls (no allocation in the hot loop).
const hit: Hit = { nx: 0, ny: 0, depth: 0 };
let cfx = 0; // force / torque accumulated on the chassis during a substep
let cfy = 0;
let ctq = 0;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Advance the simulation by one tick with the given input bitmask. */
export function tick(s: SimState, input: number, track: Track, cfg: BikeConfig, events?: SimEvent[]): void {
  // No control after a crash; brakes on after the finish.
  const controls = s.status === RUNNING ? input : s.status === FINISHED ? IN_BRAKE : 0;

  const fl = Math.sqrt(cfg.frontAxisX * cfg.frontAxisX + cfg.frontAxisY * cfg.frontAxisY);
  const fux = cfg.frontAxisX / fl;
  const fuy = cfg.frontAxisY / fl;

  for (let i = 0; i < SUBSTEPS; i++) substep(s, controls, track, cfg, fux, fuy, events);
  s.tick++;

  if (s.status === RUNNING && s.front.x >= track.finishX) {
    s.status = FINISHED;
    s.endTick = s.tick;
    events?.push({ type: "finish" });
  }
}

function substep(
  s: SimState,
  input: number,
  track: Track,
  cfg: BikeConfig,
  fux: number,
  fuy: number,
  events: SimEvent[] | undefined,
): void {
  const h = SUB_DT;
  const throttle = (input & IN_THROTTLE) !== 0;
  const brake = (input & IN_BRAKE) !== 0;
  const leanIn = (input & IN_LEAN_BACK ? 1 : 0) - (input & IN_LEAN_FWD ? 1 : 0);

  const M = cfg.chassisMass;
  const I = cfg.chassisInertia;
  const c = s.rx;
  const sn = s.ry;

  cfx = 0;
  cfy = -cfg.gravity * M;
  ctq = 0;

  const airborne = s.rear.grounded === 0 && s.front.grounded === 0;

  // Engine: flat torque up to half of max spin, then fading to zero.
  let drive = 0;
  if (throttle) {
    const f = clamp(2 * (1 - -s.rear.w / cfg.maxWheelSpin), 0, 1);
    drive = cfg.engineTorque * f;
  }

  stepWheel(s, s.rear, 0, track, cfg, cfg.rearAnchorX, cfg.rearAnchorY, 0, -1, drive, brake ? cfg.brakeRear : 0, events);
  stepWheel(s, s.front, 1, track, cfg, cfg.frontAnchorX, cfg.frontAnchorY, fux, fuy, 0, brake ? cfg.brakeFront : 0, events);

  // Lean: steer the rotation rate toward a target instead of applying raw torque.
  {
    let target = 0;
    let gain = cfg.leanGain;
    if (leanIn !== 0) target = leanIn * (airborne ? cfg.leanSpeedAir : cfg.leanSpeedGround);
    else if (airborne) gain *= cfg.airStability;
    else if (s.front.grounded === 0) gain *= cfg.wheelieStability;
    else gain *= cfg.groundStability;
    const max = airborne ? cfg.leanTorqueAir : cfg.leanTorque;
    ctq += clamp(gain * (target - s.w), -max, max);
    s.lean += clamp(-leanIn - s.lean, -cfg.leanRate * h, cfg.leanRate * h);
  }

  // Frame against the ground.
  bodyContact(s, track, cfg, BODY_ENGINE.x, BODY_ENGINE.y, BODY_ENGINE.r, cfg.bodyK, cfg.bodyDamp);
  bodyContact(s, track, cfg, BODY_BARS.x, BODY_BARS.y, BODY_BARS.r, cfg.bodyK, cfg.bodyDamp);

  // Rear fender: springy, takes light knocks, snaps off under real load.
  if (s.fenderBroken === 0) {
    const impulse = bodyContact(s, track, cfg, BODY_FENDER.x, BODY_FENDER.y, BODY_FENDER.r, cfg.fenderK, cfg.fenderDamp);
    if (impulse >= 0) {
      s.fenderDamage += impulse;
      if (lastApproach > cfg.fenderHitSpeed || s.fenderDamage > cfg.fenderBreak) {
        s.fenderBroken = 1;
        events?.push({ type: "fenderBreak" });
      }
    }
    s.fenderDamage -= cfg.fenderBreak * h; // fully recovers in a second
    if (s.fenderDamage < 0) s.fenderDamage = 0;
  }

  // Rider. After a crash the rider has left the bike, so nothing here collides.
  if (s.status !== CRASHED) {
    // Torso: sustained weight on the rider's back is fatal.
    const torso = bodyContact(s, track, cfg, BODY_TORSO.x, BODY_TORSO.y, BODY_TORSO.r, cfg.bodyK, cfg.bodyDamp);
    if (torso >= 0 && s.status === RUNNING) {
      s.headDamage += torso * 0.6;
      if (s.headDamage > cfg.headDamageMax) crash(s, CAUSE_CRUSHED, lastApproach, events);
    }

    // Head: a hard hit kills at once; scrapes add up.
    const hx = cfg.headX + s.lean * cfg.headLeanShift;
    const hy = cfg.headY - 0.1 * s.lean * s.lean;
    const impulse = bodyContact(s, track, cfg, hx, hy, cfg.headRadius, cfg.bodyK, cfg.bodyDamp);
    if (impulse >= 0) {
      if (s.status === RUNNING) {
        const approach = lastApproach;
        if (s.headContact === 0) {
          if (approach > cfg.headHitSpeed) crash(s, CAUSE_HEAD_IMPACT, approach, events);
          else events?.push({ type: "headScrape", speed: approach });
        }
        s.headDamage += impulse;
        if (s.status === RUNNING && s.headDamage > cfg.headDamageMax) crash(s, CAUSE_NECK, approach, events);
      }
      s.headContact = 1;
    } else {
      s.headContact = 0;
    }
    s.headDamage -= cfg.headRecover * h;
    if (s.headDamage < 0) s.headDamage = 0;
  }

  // A bad landing kicks back: release the stored bounce over the next moments.
  if (s.bounce > 0) {
    const out = s.bounce * 14 * h;
    s.bounce -= out;
    if (s.bounce < 0.01) s.bounce = 0;
    cfy += out / h;
  }

  // Integrate chassis (semi-implicit Euler).
  s.vx += (cfx / M) * h;
  s.vy += (cfy / M) * h;
  s.w += (ctq / I) * h;
  s.x += s.vx * h;
  s.y += s.vy * h;
  const nrx = c - s.w * h * sn;
  const nry = sn + s.w * h * c;
  const inv = 1 / Math.sqrt(nrx * nrx + nry * nry);
  s.rx = nrx * inv;
  s.ry = nry * inv;
}

function crash(s: SimState, cause: number, speed: number, events: SimEvent[] | undefined): void {
  s.status = CRASHED;
  s.crashCause = cause;
  s.endTick = s.tick;
  events?.push({ type: "crash", cause, speed });
}

function stepWheel(
  s: SimState,
  wh: WheelState,
  index: 0 | 1,
  track: Track,
  cfg: BikeConfig,
  ax: number,
  ay: number,
  ux: number,
  uy: number,
  drive: number,
  brakeMax: number,
  events: SimEvent[] | undefined,
): void {
  const h = SUB_DT;
  const R = cfg.wheelRadius;
  const m = cfg.wheelMass;
  const Iw = cfg.wheelInertia;
  const c = s.rx;
  const sn = s.ry;

  // Suspension anchor and axis in world space.
  const awx = s.x + c * ax - sn * ay;
  const awy = s.y + sn * ax + c * ay;
  const uwx = c * ux - sn * uy;
  const uwy = sn * ux + c * uy;

  const dx = wh.x - awx;
  const dy = wh.y - awy;
  const armX = wh.x - s.x;
  const armY = wh.y - s.y;
  // Wheel velocity relative to the chassis point it is attached to.
  const rvx = wh.vx - (s.vx - s.w * armY);
  const rvy = wh.vy - (s.vy + s.w * armX);

  const along = dx * uwx + dy * uwy;
  const across = -dx * uwy + dy * uwx;
  const vAlong = rvx * uwx + rvy * uwy;
  const vAcross = -rvx * uwy + rvy * uwx;

  // Damping is capped at what this mass and lever arm can take in one substep, so extreme
  // tuning combinations get softer instead of exploding.
  const dampCap = 0.6 / ((1 / m + 1 / cfg.chassisMass + (armX * armX + armY * armY) / cfg.chassisInertia) * h);
  // bump stops: stiff and heavily damped, so bottoming out is a thud, not a trampoline
  const bottomed = along > cfg.suspTravel || along < -cfg.suspTravel;
  // vAlong > 0 means the shock is extending (rebounding); real shocks damp that harder
  const rebound = vAlong > 0;
  let damp = cfg.suspDamp * (rebound ? cfg.reboundDamp : 1);
  if (bottomed) damp *= 3;
  const dampAlong = Math.min(damp, dampCap);
  let fAlong = -cfg.suspK * along - dampAlong * vAlong;
  // Bump stops absorb rather than spring back: on the way out they push with a fraction of their force.
  const stopK = rebound ? cfg.suspStopK * STOP_RETURN : cfg.suspStopK;
  if (along > cfg.suspTravel) fAlong -= stopK * (along - cfg.suspTravel);
  else if (along < -cfg.suspTravel) fAlong -= stopK * (along + cfg.suspTravel);
  const fAcross = -cfg.lateralK * across - Math.min(cfg.lateralDamp, dampCap) * vAcross;

  const sfx = fAlong * uwx - fAcross * uwy;
  const sfy = fAlong * uwy + fAcross * uwx;
  cfx -= sfx;
  cfy -= sfy;
  ctq -= armX * sfy - armY * sfx;

  let fx = sfx;
  let fy = sfy - cfg.gravity * m;
  // Forward drive spins the wheel clockwise (negative); part of it pitches the chassis back.
  let tq = -drive;
  ctq += drive * cfg.driveReaction;

  if (collideCircle(track, wh.x, wh.y, R, hit)) {
    const nx = hit.nx;
    const ny = hit.ny;
    const vn = wh.vx * nx + wh.vy * ny;
    // The tire carcass gives back little of what it soaks up (vn > 0: leaving the ground).
    let fn = (vn > 0 ? cfg.tireK * TIRE_RETURN : cfg.tireK) * hit.depth - cfg.tireDamp * vn;
    if (fn < 0) fn = 0;

    // Friction with a small tangential spring so the tire can truly hold still.
    const tx = ny;
    const ty = -nx;
    const slip = wh.vx * tx + wh.vy * ty + wh.w * R;
    wh.stick += slip * h;
    // (damping is capped at what a wheel this light can take without overshooting)
    const stickDamp = Math.min(cfg.tireStickDamp, 0.5 / ((1 / m + (R * R) / Iw) * h));
    let ft = -cfg.tireStickK * wh.stick - stickDamp * slip;
    const max = cfg.tireMu * fn;
    if (ft > max) {
      ft = max;
      wh.stick = -max / cfg.tireStickK;
    } else if (ft < -max) {
      ft = -max;
      wh.stick = max / cfg.tireStickK;
    }

    fx += fn * nx + ft * tx;
    fy += fn * ny + ft * ty;
    tq += ft * R;

    // Landing out of line with the ground scrubs speed: the harder the hit and the bigger
    // the angle between bike and ground, the more is lost. Ordinary riding loads are exempt.
    const excess = fn - 1.3 * cfg.gravity * (cfg.chassisMass + 2 * m);
    if (excess > 0) {
      let mis = c * nx + sn * ny; // sine of the angle between the bike and the ground
      if (mis < 0) mis = -mis;
      const vt = s.vx * tx + s.vy * ty;
      const limit = (0.25 * cfg.chassisMass * (vt < 0 ? -vt : vt)) / h;
      let scrub = cfg.landingScrub * excess * mis * 4;
      if (scrub > limit) scrub = limit;
      if (vt < 0) scrub = -scrub;
      cfx -= scrub * tx;
      cfy -= scrub * ty;
    }

    if (wh.grounded === 0 && -vn > 1.5) {
      // Touchdown out of line with the ground kicks the bike back up a little: once per landing,
      // sized by the impact and the angle, capped, and never stacked across the two wheels.
      let mis = c * nx + sn * ny;
      if (mis < 0) mis = -mis;
      let kick = cfg.landingBounce * mis * -vn * 0.45;
      if (kick > MAX_LANDING_KICK) kick = MAX_LANDING_KICK;
      if (kick * cfg.chassisMass > s.bounce) s.bounce = kick * cfg.chassisMass;
      events?.push({ type: "land", wheel: index, speed: -vn });
    }
    wh.grounded = 1;
  } else {
    wh.grounded = 0;
    wh.stick = 0;
  }

  if (brakeMax > 0) {
    // Exactly the torque that would stop the wheel this substep, limited by brake strength.
    const tb = clamp(-((wh.w * Iw) / h + tq), -brakeMax, brakeMax);
    tq += tb;
    ctq -= tb * cfg.driveReaction;
  }

  wh.vx += (fx / m) * h;
  wh.vy += (fy / m) * h;
  wh.w += (tq / Iw) * h;
  wh.x += wh.vx * h;
  wh.y += wh.vy * h;
  wh.angle += wh.w * h;
  if (wh.angle > 1024) wh.angle -= 1024;
  else if (wh.angle < -1024) wh.angle += 1024;
}

let lastApproach = 0; // speed into the ground at the most recent body contact

/**
 * Collide one chassis-attached circle with the ground and push on the chassis.
 * Returns the normal impulse applied this substep, or -1 if not touching.
 */
function bodyContact(
  s: SimState,
  track: Track,
  cfg: BikeConfig,
  lx: number,
  ly: number,
  r: number,
  k: number,
  damp: number,
): number {
  const c = s.rx;
  const sn = s.ry;
  const ox = c * lx - sn * ly;
  const oy = sn * lx + c * ly;
  if (!collideCircle(track, s.x + ox, s.y + oy, r, hit)) return -1;

  const nx = hit.nx;
  const ny = hit.ny;
  // Contact point relative to the center of mass.
  const px = ox - nx * r;
  const py = oy - ny * r;
  const pvx = s.vx - s.w * py;
  const pvy = s.vy + s.w * px;
  const vn = pvx * nx + pvy * ny;
  lastApproach = -vn;

  let fn = (vn > 0 ? k * TIRE_RETURN : k) * hit.depth - damp * vn;
  if (fn < 0) fn = 0;

  const tx = ny;
  const ty = -nx;
  const vt = pvx * tx + pvy * ty;
  const cross = px * ty - py * tx;
  const mEff = 1 / (1 / cfg.chassisMass + (cross * cross) / cfg.chassisInertia);
  const max = cfg.bodyMu * fn;
  const ft = clamp((-vt * mEff * 0.5) / SUB_DT, -max, max);

  const fx = fn * nx + ft * tx;
  const fy = fn * ny + ft * ty;
  cfx += fx;
  cfy += fy;
  ctq += px * fy - py * fx;
  return fn * SUB_DT;
}
