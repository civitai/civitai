import { expect } from 'vitest';
import { checkReplyKeys, type InventoryType } from '~/components/AppBlocks/hostHandlerParity';

/**
 * Pin a reply a REAL host sent against INVENTORY's declared `replyKeys` / `errorKeys`.
 *
 * Pass a reply payload the test captured from the host, never a literal the test wrote.
 * `outcome` says which list the payload must match. Use `'error'` for a reply with a top-level
 * `error` key and `'success'` for any other. `keys` is the EXACT top-level key set of this
 * payload, `requestId` left out.
 *
 * `hostHandlerParity.test.ts` reads these calls from the test sources, so keep `type`,
 * `outcome` and `keys` as literals. It requires:
 *   - a pin from each host that must handle the type;
 *   - the pinned `keys`, taken together, to cover every key the type declares, `?` keys
 *     included.
 */
export function expectReplyKeys(
  type: InventoryType,
  outcome: 'success' | 'error',
  keys: readonly string[],
  payload: unknown
): void {
  expect(checkReplyKeys(type, payload), `${type} reply ${JSON.stringify(payload)}`).toEqual({
    outcome,
    problems: [],
  });
  const actual = Object.keys(payload as object)
    .filter((k) => k !== 'requestId')
    .sort();
  expect(actual, `${type} reply keys`).toEqual([...keys].sort());
}
