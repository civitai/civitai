import { useCallback } from 'react';
import { OFFICIAL_MATCH_HASH_MAX_BYTES } from '~/utils/file-hash';
import type { FileHashRequest, FileHashResponse } from '~/workers/file-hash.worker';

/**
 * The worker script is rebuilt on every deploy at the same path, and the CDN keeps a copy for
 * minutes (`~/shared/constants/static-asset-cache-rules.mjs`), so the URL carries the build id: a
 * page always asks for the script of its own build.
 */
export function fileHashWorkerUrl() {
  const buildId = (globalThis as { __NEXT_DATA__?: { buildId?: string } }).__NEXT_DATA__?.buildId;
  const path = '/workers/file-hash.worker.js';
  return buildId ? `${path}?v=${encodeURIComponent(buildId)}` : path;
}

// Returns null when the file is over the cap (defer to the server-side dedup) or
// the worker errors — callers treat null as "no client match, upload normally".
export function useFileHash() {
  const hashFile = useCallback((file: File): Promise<string | null> => {
    if (file.size > OFFICIAL_MATCH_HASH_MAX_BYTES) return Promise.resolve(null);
    return new Promise((resolve) => {
      // Static path (not new URL(import.meta.url)) — Turbopack can't compile
      // .ts worker entries; build:workers bundles it to /public. See build-workers.mjs.
      const worker = new Worker(fileHashWorkerUrl());
      worker.onmessage = (e: MessageEvent<FileHashResponse>) => {
        worker.terminate();
        resolve('sha256' in e.data ? e.data.sha256 : null);
      };
      worker.onerror = () => {
        worker.terminate();
        resolve(null);
      };
      worker.postMessage({ file } as FileHashRequest);
    });
  }, []);

  return { hashFile };
}
