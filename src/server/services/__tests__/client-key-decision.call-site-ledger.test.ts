import { describe, expect, it } from 'vitest';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { scanSource } from '../../../../test/source-scan';

/**
 * A client save and the batch draft check decide an upload key from one function,
 * `issuerRefusals`, so a draft is never told a key is fine that its save would refuse.
 */

const OWNERSHIP = 'src/server/services/image-url-ownership.ts';
const scan = scanSource(process.cwd(), { issuerRefusals: OWNERSHIP });

/** The body of `export async function <name>(`, up to the next top-level declaration. */
const body = (file: string, name: string) => {
  const code = scan.code.get(file)!;
  const start = code.indexOf(`export async function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const end = code.slice(start + 1).search(/\n(export |async function |function |const )/);
  return code.slice(start, end < 0 ? undefined : start + 1 + end);
};

describe('the client upload key decision', () => {
  it('is made only in the ownership service', () => {
    // `callersOf` leaves out the file that defines it.
    expect(scan.callersOf('issuerRefusals')).toEqual([]);
  });

  it('is what both the save check and the draft check use', () => {
    expect(body(OWNERSHIP, 'assertClientKeysIssuedToCaller')).toMatch(/\bissuerRefusals\(/);
    expect(body(OWNERSHIP, 'clientKeysToReupload')).toMatch(/\bissuerRefusals\(/);
  });
});

describe('post.checkBatchDraftKeys', () => {
  const ROUTER = 'src/server/routers/post.router.ts';
  const router = scanSource(process.cwd(), { clientKeysToReupload: OWNERSHIP });

  it('is the only caller of the draft check, signed in and with no API key', () => {
    expect(router.callersOf('clientKeysToReupload')).toEqual([ROUTER]);
    const code = router.code.get(ROUTER)!;
    const at = code.indexOf('checkBatchDraftKeys:');
    const procedure = code.slice(at, code.indexOf('.mutation(', at));
    expect(procedure).toMatch(
      /^checkBatchDraftKeys: protectedProcedure\s*\n\s*\.meta\(\{ blockApiKeys: true \}\)/
    );
    expect(procedure).toMatch(/\.use\(rateLimit\(/);
  });
});
