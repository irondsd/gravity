import type { BikeConfig } from "../sim";

// Joint order in a pose: x,y pairs in chassis-local space.
export const J_HEAD = 0;
export const J_SHOULDER = 1;
export const J_HIP = 2;
export const J_KNEE = 3;
export const J_FOOT = 4;
export const J_ELBOW = 5;
export const J_HAND = 6;
export const JOINTS = 7;

/** Seated rider pose for a given lean (-1 back .. +1 forward). The head matches the sim's head circle. */
export function riderPose(cfg: BikeConfig, lean: number, out: Float64Array): Float64Array {
  const hx = cfg.headX + lean * cfg.headLeanShift;
  const hy = cfg.headY - 0.1 * lean * lean;
  const hipX = -0.3 + lean * 0.08;
  const hipY = 0.26;
  const shX = hx * 0.8 + hipX * 0.2 - 0.02;
  const shY = hy - 0.2;
  const handX = 0.46;
  const handY = 0.41;
  out[0] = hx;
  out[1] = hy;
  out[2] = shX;
  out[3] = shY;
  out[4] = hipX;
  out[5] = hipY;
  out[6] = 0.1 + lean * 0.04;
  out[7] = 0.14;
  out[8] = -0.02;
  out[9] = -0.2;
  out[10] = (shX + handX) / 2 - 0.02;
  out[11] = (shY + handY) / 2 - 0.12;
  out[12] = handX;
  out[13] = handY;
  return out;
}
