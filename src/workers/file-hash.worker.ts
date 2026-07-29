import { computeBlobSha256 } from '~/utils/file-hash';

export type FileHashRequest = { file: File };
export type FileHashResponse = { sha256: string } | { error: string };

self.onmessage = async (e: MessageEvent<FileHashRequest>) => {
  try {
    const sha256 = await computeBlobSha256(e.data.file);
    (self as unknown as Worker).postMessage({ sha256 } as FileHashResponse);
  } catch (err) {
    (self as unknown as Worker).postMessage({ error: (err as Error).message } as FileHashResponse);
  }
};
