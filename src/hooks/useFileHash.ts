import { useCallback } from 'react';
import { OFFICIAL_MATCH_HASH_MAX_BYTES } from '~/utils/file-hash';
import type { FileHashRequest, FileHashResponse } from '~/workers/file-hash.worker';

// Returns null when the file is over the cap (defer to server B.1b) or the
// worker errors — callers treat null as "no client match, upload normally".
export function useFileHash() {
  const hashFile = useCallback((file: File): Promise<string | null> => {
    if (file.size > OFFICIAL_MATCH_HASH_MAX_BYTES) return Promise.resolve(null);
    return new Promise((resolve) => {
      // Static path (not new URL(import.meta.url)) — Turbopack can't compile
      // .ts worker entries; build:workers bundles it to /public. See build-workers.mjs.
      const worker = new Worker('/workers/file-hash.worker.js');
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
