// The AI rider's brain: a small neural network from what it sees to which buttons to hold.
// Plain arithmetic only (no Math.tanh or exp), so the same weights give the same ride on any JS engine.
import { IN_BRAKE, IN_LEAN_BACK, IN_LEAN_FWD, IN_THROTTLE } from "../sim";
import { makeRng } from "../level/generator";
import { OBS_SIZE } from "./observe";

export const LAYERS = [OBS_SIZE, 32, 16, 6];
/** The rider decides this often, in sim ticks (12 ticks = 10 decisions a second, about human pace). */
export const DECISION_TICKS = 12;

export const PARAM_COUNT = (() => {
  let n = 0;
  for (let l = 1; l < LAYERS.length; l++) n += (LAYERS[l - 1]! + 1) * LAYERS[l]!;
  return n;
})();

const bufA = new Float64Array(64);
const bufB = new Float64Array(64);

/** Run the network on an observation and return the input bitmask to hold until the next decision. */
export function decide(theta: Float64Array, obs: Float64Array): number {
  let input: Float64Array = obs;
  let out = bufA;
  let p = 0;
  for (let l = 1; l < LAYERS.length; l++) {
    const nIn = LAYERS[l - 1]!;
    const nOut = LAYERS[l]!;
    const last = l === LAYERS.length - 1;
    for (let j = 0; j < nOut; j++) {
      let sum = theta[p++]!; // bias
      for (let k = 0; k < nIn; k++) sum += theta[p++]! * input[k]!;
      // soft squash for hidden layers: x / (1 + |x|)
      out[j] = last ? sum : sum / (1 + (sum < 0 ? -sum : sum));
    }
    input = out;
    out = out === bufA ? bufB : bufA;
  }
  // outputs: [coast, throttle, brake] and [no lean, lean back, lean forward]; take the strongest of each
  const o = input;
  let mask = 0;
  if (o[1]! >= o[0]! && o[1]! >= o[2]!) mask |= IN_THROTTLE;
  else if (o[2]! > o[0]!) mask |= IN_BRAKE;
  if (o[4]! > o[3]! && o[4]! >= o[5]!) mask |= IN_LEAN_BACK;
  else if (o[5]! > o[3]!) mask |= IN_LEAN_FWD;
  return mask;
}

export interface RiderFile {
  layers: number[];
  decisionTicks: number;
  /** Network weights, layer by layer. */
  theta: number[];
  note?: string;
}

/** Load saved weights; null if they were made for a different network shape. */
export function loadRider(file: RiderFile): Float64Array | null {
  if (file.theta.length !== PARAM_COUNT || file.layers.join() !== LAYERS.join()) return null;
  return Float64Array.from(file.theta);
}

/** A slightly different rider: the same weights with seeded random noise of size `sigma` added. */
export function variantRider(theta: Float64Array, seed: number, sigma: number): Float64Array {
  const rng = makeRng(seed);
  const out = new Float64Array(theta.length);
  for (let i = 0; i < out.length; i++) {
    const g = Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
    out[i] = theta[i]! + sigma * g;
  }
  return out;
}
