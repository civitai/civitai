/**
 * Shared assertion for the URL → download-route SEAM.
 *
 * A per-file `downloadUrl` is a claim that `/api/download/models/<versionId>`
 * plus `?fileId=<n>` will actually resolve. The download route resolves a
 * pinned URL with `dbRead.modelFile.findFirst({ where: { id: fileId,
 * modelVersionId } })` (src/server/services/file.service.ts) — so a pair whose
 * two halves disagree is a hard 404, and the URL string alone cannot show it.
 *
 * `assertDownloadUrlsResolve` replays that exact lookup against a universe of
 * files (local + spliced), and is deliberately NOT satisfied by "the URL looks
 * right": it fails on a pair that would 404, and it fails on an empty run.
 */

export type SeamFile = { id: number; modelVersionId: number };

export function assertDownloadUrlsResolve({
  urls,
  universe,
  expect,
}: {
  /** every per-file downloadUrl the response emitted */
  urls: string[];
  /** every file that exists, with the version it really belongs to */
  universe: SeamFile[];
  expect: (
    actual: unknown,
    message?: string
  ) => {
    toBe(expected: unknown): void;
    toBeGreaterThan(expected: number): void;
  };
}) {
  // Positive control: an empty list would pass every loop below vacuously.
  expect(urls.length, 'no downloadUrls to check').toBeGreaterThan(0);

  for (const raw of urls) {
    const url = new URL(raw);
    const versionId = Number(url.pathname.split('/').pop());
    const fileIdParam = url.searchParams.get('fileId');
    if (fileIdParam === null) continue; // unpinned — the route re-resolves it

    const fileId = Number(fileIdParam);
    // The download route's `fileId` branch, replayed literally.
    const resolved = universe.find((f) => f.id === fileId && f.modelVersionId === versionId);
    expect(
      resolved === undefined ? `404: no file ${fileId} on version ${versionId}` : 'resolved',
      `${raw} — the (versionId, fileId) pair this URL encodes does not exist`
    ).toBe('resolved');
  }
}
