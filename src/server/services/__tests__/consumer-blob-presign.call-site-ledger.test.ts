import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { scanSource } from '../../../../test/source-scan';
import { stripCommentsAndStrings } from '../../../../test/strip-comments';

/**
 * WHO MINTS A CONSUMER-BLOB UPLOAD URL, AND WITH WHICH ORCHESTRATOR CLIENT.
 *
 * An upload URL is minted for an identity: the client handed to `getConsumerBlobUploadUrl` decides
 * whose upload the file is, and nothing in the type system distinguishes a viewer's client from the
 * system one. The App Blocks batch path must mint as the VIEWER.
 *
 * Two ledgers, each compared as a SET in both directions over the main app's `src/`:
 *   - every file importing the orchestration client's `getConsumerBlobUploadUrl`, with the client
 *     expression it passes. A new caller fails here until someone records which client it uses.
 *   - every caller of `getConsumerBlobUploadUrlService` — the user-token presign — so the App
 *     Blocks batch path is pinned to it, and to a token it obtained for the viewer.
 *
 * Scope: `src/` only (`scanSource`). `apps/training-studio` mints with a client its caller builds
 * and is not covered here.
 */

const ROOT = join(__dirname, '../../../..');
const SERVICE = 'src/server/services/orchestrator/consumerBlobUpload.ts';
const scan = scanSource(ROOT, { getConsumerBlobUploadUrlService: SERVICE });

const IMPORT_RE =
  /import\s*\{[^}]*\bgetConsumerBlobUploadUrl\b[^}]*\}\s*from\s*['"]@civitai\/orchestration-client['"]/;
const CALL_CLIENT_RE =
  /\bgetConsumerBlobUploadUrl\s*\(\s*\{\s*client\s*(?::\s*([A-Za-z_$][\w$]*))?/g;

/** `{ file → the client expression each call passes }`, for every importer of the client's presign. */
function presignClients(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const file of scan.files) {
    if (!IMPORT_RE.test(scan.raw(file))) continue;
    const code = scan.code.get(file)!;
    out[file] = [...code.matchAll(CALL_CLIENT_RE)].map((m) => m[1] ?? 'client');
  }
  return out;
}

describe('consumer-blob upload URLs: who mints them, with which client', () => {
  it('every importer of the orchestration client presign, and the client it passes', () => {
    expect(presignClients()).toEqual({
      // The user-token presign: `client` is `createOrchestratorClient(token)`, pinned below.
      [SERVICE]: ['client'],
      // Pre-existing, on the system client; recorded so a second system-client caller cannot be
      // added unnoticed.
      'src/server/services/training.service.ts': ['internalOrchestratorClient'],
    });
  });

  it('the user-token presign builds its client from the token it is handed', () => {
    const code = scan.code.get(SERVICE)!;
    expect(code).toMatch(/const client = createOrchestratorClient\(token\)/);
    expect(code).not.toMatch(/internalOrchestratorClient/);
  });

  it('the user-token presign is called by the presign route and the App Blocks batch path only', () => {
    expect(scan.callersOf('getConsumerBlobUploadUrlService')).toEqual([
      'src/pages/api/orchestrator/getConsumerBlobUploadUrl.ts',
      'src/server/services/blocks/media-upload-batch.service.ts',
    ]);
  });

  it('the batch path hands it the token it was given, and never names the system client', () => {
    const code = scan.code.get('src/server/services/blocks/media-upload-batch.service.ts')!;
    expect(code).toMatch(/getConsumerBlobUploadUrlService\(\{\s*token\s*\}\)/);
    expect(code).not.toMatch(/internalOrchestratorClient|createOrchestratorClient/);
  });

  it('the batch presign procedure gets that token for the token subject, from getOrchestratorToken', () => {
    const router = stripCommentsAndStrings(
      readFileSync(join(ROOT, 'src/server/routers/blocks.router.ts'), 'utf8')
    );
    const start = router.indexOf('presignMediaUploadBatchItem: protectedProcedure');
    expect(
      start,
      'the batch presign procedure is not declared the way this test expects'
    ).toBeGreaterThan(-1);
    const end = router.indexOf('\n  recordMediaUploadBatchItem:', start);
    const proc = router.slice(start, end === -1 ? undefined : end);
    expect(proc).toMatch(/const token = await getOrchestratorToken\(userId, ctx\)/);
    expect(proc).toMatch(/presignMediaUploadBatchItem\(\{[^}]*\btoken\b/);
    expect(proc).not.toMatch(/internalOrchestratorClient/);
  });

  it('POSITIVE CONTROL — the client scan sees a system-client call it was not told about', () => {
    const mutated = 'getConsumerBlobUploadUrl({ client: internalOrchestratorClient })';
    expect([...mutated.matchAll(CALL_CLIENT_RE)].map((m) => m[1])).toEqual([
      'internalOrchestratorClient',
    ]);
  });
});
