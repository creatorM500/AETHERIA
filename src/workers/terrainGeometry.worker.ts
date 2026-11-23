import {
  buildAllChunkGeometriesRaw,
  type ChunkGeometryBuildInput,
  type ChunkGeometryBuildOutput,
  type RawIndexedBuffers,
} from '../shared/terrainGeometryBuilder.ts';

export interface WorkerGeometryRequest {
  jobId: number;
  key: string;
  input: ChunkGeometryBuildInput;
}

export interface WorkerGeometryResponse {
  jobId: number;
  key: string;
  output: ChunkGeometryBuildOutput;
}

function collectTransferables(bufs: RawIndexedBuffers | null, list: Transferable[]) {
  if (!bufs) return;
  list.push(bufs.pos.buffer, bufs.norm.buffer, bufs.col.buffer, bufs.index.buffer);
  if (bufs.uv) list.push(bufs.uv.buffer);
}

self.onmessage = (e: MessageEvent<WorkerGeometryRequest>) => {
  const { jobId, key, input } = e.data;
  const output = buildAllChunkGeometriesRaw(input);
  const transferables: Transferable[] = [];
  collectTransferables(output.stdGeo, transferables);
  collectTransferables(output.towerGeo, transferables);
  collectTransferables(output.roadsGeo, transferables);
  collectTransferables(output.waterGeo, transferables);

  const response: WorkerGeometryResponse = { jobId, key, output };
  (self as unknown as { postMessage: (msg: unknown, transfer: Transferable[]) => void }).postMessage(
    response,
    transferables
  );
};
