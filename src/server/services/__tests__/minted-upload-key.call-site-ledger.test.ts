import { describe, expect, it } from 'vitest';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { scanSource } from '../../../../test/source-scan';

/**
 * Every upload key issued to a user is recorded in both issue stores, the Redis issue record and
 * the ClickHouse upload request log, so the ownership check can still read it while one is down.
 * The upload API routes record the Redis half with `recordUploadKeyOwner` and the log half with
 * `trackImageUpload`; a key the server mints itself goes through `recordMintedUploadKey`, which
 * does both. A new direct `recordUploadKeyOwner` caller would write only the Redis half.
 */

const scan = scanSource(process.cwd(), {
  recordUploadKeyOwner: 'src/server/services/image-url-ownership.ts',
  recordMintedUploadKey: 'src/server/services/image-upload-action.service.ts',
  trackImageUpload: 'src/server/services/image-upload-action.service.ts',
});

const UPLOAD_ROUTES = [
  'src/pages/api/v1/image-upload/index.ts',
  'src/pages/api/v1/image-upload/multipart/index.ts',
  'src/pages/api/v1/image-upload/relay-chunked.ts',
  'src/pages/api/v1/image-upload/relay.ts',
];

const calls = (file: string, name: string) =>
  (scan.code.get(file)!.match(new RegExp(`\\b${name}\\s*\\(`, 'g')) ?? []).length;

describe('upload key issue records', () => {
  it('are written only by the upload routes and the minted-key helper', () => {
    expect(scan.callersOf('recordUploadKeyOwner')).toEqual(
      [...UPLOAD_ROUTES, 'src/server/services/image-upload-action.service.ts'].sort()
    );
  });

  it('are logged by each upload route too', () => {
    for (const route of UPLOAD_ROUTES) expect(calls(route, 'trackImageUpload'), route).toBe(1);
  });

  it('cover each key the server mints: four in comics, one in generation polling', () => {
    expect(scan.callersOf('recordMintedUploadKey')).toEqual([
      'src/server/routers/comics.router.ts',
      'src/server/services/orchestrator/poll-iteration.ts',
    ]);
    expect(calls('src/server/routers/comics.router.ts', 'recordMintedUploadKey')).toBe(4);
  });
});
