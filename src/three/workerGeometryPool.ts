import {
  buildAllChunkGeometriesRaw,
  type ChunkGeometryBuildInput,
  type ChunkGeometryBuildOutput,
} from '../shared/terrainGeometryBuilder.ts';
import type {
  WorkerGeometryRequest,
  WorkerGeometryResponse,
} from '../workers/terrainGeometry.worker.ts';

interface PendingJob {
  resolve: (res: ChunkGeometryBuildOutput) => void;
  reject: (err: unknown) => void;
}

/**
 * Bounded pool of Web Workers for off-main-thread building, vector road, and water mesh synthesis.
 * Gracefully falls back to synchronous local execution when Web Workers are unavailable.
 */
export class TerrainGeometryWorkerPool {
  private workers: Worker[] = [];
  private workerLoads: number[] = [];
  private pending = new Map<number, PendingJob>();
  private nextJobId = 1;
  private disposed = false;

  constructor(poolSize = 2) {
    if (typeof Worker === 'undefined') return;
    const count = Math.max(1, Math.min(3, poolSize));
    for (let i = 0; i < count; i++) {
      try {
        const w = new Worker(
          new URL('../workers/terrainGeometry.worker.ts', import.meta.url),
          { type: 'module' }
        );
        const slotIdx = this.workers.length;
        w.onmessage = (ev: MessageEvent<WorkerGeometryResponse>) => {
          this.workerLoads[slotIdx] = Math.max(0, (this.workerLoads[slotIdx] ?? 1) - 1);
          const job = this.pending.get(ev.data.jobId);
          if (job) {
            this.pending.delete(ev.data.jobId);
            job.resolve(ev.data.output);
          }
        };
        w.onerror = () => {
          this.workerLoads[slotIdx] = Math.max(0, (this.workerLoads[slotIdx] ?? 1) - 1);
        };
        this.workers.push(w);
        this.workerLoads.push(0);
      } catch {
        // Fallback cleanly to main-thread execution
      }
    }
  }

  public get isWorkerBacked(): boolean {
    return this.workers.length > 0;
  }

  public buildChunkGeometry(
    key: string,
    input: ChunkGeometryBuildInput
  ): Promise<ChunkGeometryBuildOutput> {
    if (this.disposed) {
      return Promise.resolve({
        stdGeo: null,
        towerGeo: null,
        roadsGeo: null,
        waterGeo: null,
        builtCount: 0,
      });
    }

    if (this.workers.length === 0) {
      return Promise.resolve(buildAllChunkGeometriesRaw(input));
    }

    let bestSlot = 0;
    let bestLoad = this.workerLoads[0] ?? 0;
    for (let i = 1; i < this.workers.length; i++) {
      const l = this.workerLoads[i] ?? 0;
      if (l < bestLoad) {
        bestLoad = l;
        bestSlot = i;
      }
    }

    const jobId = this.nextJobId++;
    this.workerLoads[bestSlot] = (this.workerLoads[bestSlot] ?? 0) + 1;

    return new Promise<ChunkGeometryBuildOutput>((resolve, reject) => {
      this.pending.set(jobId, { resolve, reject });
      const msg: WorkerGeometryRequest = { jobId, key, input };
      try {
        this.workers[bestSlot].postMessage(msg);
      } catch {
        this.pending.delete(jobId);
        this.workerLoads[bestSlot] = Math.max(0, (this.workerLoads[bestSlot] ?? 1) - 1);
        resolve(buildAllChunkGeometriesRaw(input));
      }
    });
  }

  public dispose() {
    this.disposed = true;
    for (const job of this.pending.values()) {
      job.resolve({
        stdGeo: null,
        towerGeo: null,
        roadsGeo: null,
        waterGeo: null,
        builtCount: 0,
      });
    }
    this.pending.clear();
    for (const w of this.workers) {
      w.terminate();
    }
    this.workers = [];
    this.workerLoads = [];
  }
}
