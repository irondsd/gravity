import { TICK_RATE } from "../sim";

/** A time in sim ticks as m:ss.hh */
export function formatTime(ticks: number): string {
  const t = ticks / TICK_RATE;
  const min = Math.floor(t / 60);
  return `${min}:${(t - min * 60).toFixed(2).padStart(5, "0")}`;
}
