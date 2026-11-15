// A small pool of worker threads that run jobs in parallel.
import type { Job } from "./worker";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type JobInput = DistributiveOmit<Job, "id">;

export class WorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: { job: Job; resolve: (v: unknown) => void }[] = [];
  private pending = new Map<number, { resolve: (v: unknown) => void; worker: Worker }>();
  private nextId = 1;

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL("./worker.ts", import.meta.url).href);
      w.onmessage = (e: MessageEvent<{ id: number }>) => {
        const p = this.pending.get(e.data.id)!;
        this.pending.delete(e.data.id);
        this.idle.push(w);
        p.resolve(e.data);
        this.pump();
      };
      w.onerror = (e) => {
        console.error("worker error:", e.message);
        process.exit(1);
      };
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  run<T>(job: JobInput): Promise<T> {
    return new Promise<T>((resolve) => {
      this.queue.push({ job: { ...job, id: this.nextId++ } as Job, resolve: resolve as (v: unknown) => void });
      this.pump();
    });
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const w = this.idle.pop()!;
      const { job, resolve } = this.queue.shift()!;
      this.pending.set(job.id, { resolve, worker: w });
      w.postMessage(job);
    }
  }

  close(): void {
    for (const w of this.workers) w.terminate();
  }
}
