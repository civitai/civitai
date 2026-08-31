import { describe, expect, it } from 'vitest';
import { parseModelTensorMetadata } from '~/utils/model-tensor-metadata';

/**
 * CU 868khnkuc: the delivery hosts intermittently answer a `Range` request with 200 + the whole
 * file instead of 206. That was a hard failure ("Model host does not support byte-range requests",
 * 207K hits / 14d) even though a 200 body still contains the header we want at offset 0. We now
 * slice the wanted window off the stream and abort — without ever buffering the 24 GB body.
 */

const CHUNK_SIZE = 64 * 1024;
const CHUNK_COUNT = 16;

function buildSafetensorsFile() {
  const header = JSON.stringify({
    weight: { dtype: 'F16', shape: [2, 2], data_offsets: [0, 8] },
    bias: { dtype: 'F16', shape: [2], data_offsets: [8, 12] },
  });
  const headerBytes = new TextEncoder().encode(header);
  const file = new Uint8Array(CHUNK_SIZE * CHUNK_COUNT);
  new DataView(file.buffer).setUint32(0, headerBytes.length, true);
  file.set(headerBytes, 8);
  return file;
}

/** Emits the file in fixed-size chunks and records how many were actually pulled. */
function chunkedBody(file: Uint8Array, pulled: { count: number }) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= file.length) return controller.close();
      controller.enqueue(file.slice(offset, offset + CHUNK_SIZE));
      offset += CHUNK_SIZE;
      pulled.count += 1;
    },
  });
}

describe('parseModelTensorMetadata with a host that ignores Range', () => {
  it('parses the SafeTensor header from a 200 full-body response', async () => {
    const file = buildSafetensorsFile();
    const pulled = { count: 0 };
    const fetchImpl = (async () =>
      new Response(chunkedBody(file, pulled), { status: 200 })) as unknown as typeof fetch;

    const analysis = await parseModelTensorMetadata({
      url: 'https://delivery.example/file.safetensors',
      format: 'SafeTensor',
      fileSizeBytes: file.length,
      estimateVram: false,
      fetchImpl,
    });

    expect(analysis.tensors.map((tensor) => tensor.name)).toEqual(['weight', 'bias']);
  });

  it('aborts the body instead of buffering the whole file', async () => {
    const file = buildSafetensorsFile();
    const pulled = { count: 0 };
    const fetchImpl = (async () =>
      new Response(chunkedBody(file, pulled), { status: 200 })) as unknown as typeof fetch;

    await parseModelTensorMetadata({
      url: 'https://delivery.example/file.safetensors',
      format: 'SafeTensor',
      fileSizeBytes: file.length,
      estimateVram: false,
      fetchImpl,
    });

    // Two range reads (8-byte prefix, then the header) — both satisfied by the first chunk.
    expect(pulled.count).toBeLessThanOrEqual(4);
  });

  it('still fails on a non-ok response', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 404 })) as unknown as typeof fetch;

    await expect(
      parseModelTensorMetadata({
        url: 'https://delivery.example/file.safetensors',
        format: 'SafeTensor',
        estimateVram: false,
        fetchImpl,
      })
    ).rejects.toThrow('Failed to fetch model metadata range: 404');
  });

  it('still honours a real 206 partial response', async () => {
    const file = buildSafetensorsFile();
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string>).Range;
      const [start, end] = range.replace('bytes=', '').split('-').map(Number);
      return new Response(file.slice(start, end + 1), { status: 206 });
    }) as unknown as typeof fetch;

    const analysis = await parseModelTensorMetadata({
      url: 'https://delivery.example/file.safetensors',
      format: 'SafeTensor',
      estimateVram: false,
      fetchImpl,
    });

    expect(analysis.tensors.map((tensor) => tensor.name)).toEqual(['weight', 'bias']);
  });
});
