import { describe, expect, it } from 'vitest';

import { createMultiAccountBuzzTransactionResponse } from '~/server/schema/buzz.schema';

/**
 * 🔴 A FIELD THE SCHEMA OMITS IS A FIELD NO CONSUMER CAN BRANCH ON.
 *
 * `CreateMultiTransactionResponse` (`packages/civitai-buzz/src/responses.ts`)
 * declares a per-leg `duplicate` flag — how the multi-account endpoint reports
 * an external id that was already occupied, where its single-transaction
 * sibling has no conflict field at all. Zod strips unknown keys, so leaving it
 * out of this schema deleted that signal on the way in: a leg the ledger
 * refused as a duplicate reached the caller looking exactly like one that moved
 * money, behind a plausible `transactionCount` and `totalAmount`.
 *
 * `block-goods.service.ts` is the caller that branches on it. This pins the
 * half that lives in the schema, which no mocked-`buzz.service` test can see —
 * those replace the function that does the parsing.
 */
describe('createMultiAccountBuzzTransactionResponse — the duplicate flag survives parsing', () => {
  const leg = { transactionId: 'tx-1', accountType: 'User', amount: 1000 };

  it('KEEPS a leg marked duplicate', () => {
    const parsed = createMultiAccountBuzzTransactionResponse.parse({
      transactionIds: [{ ...leg, duplicate: true }],
      totalAmount: 1000,
      transactionCount: 1,
    });
    expect(parsed.transactionIds[0].duplicate).toBe(true);
  });

  it('keeps an explicit FALSE rather than folding it into absent', () => {
    // The negative control: if the field were being dropped, both this and the
    // case above would read `undefined` and only one of the two assertions
    // would notice.
    const parsed = createMultiAccountBuzzTransactionResponse.parse({
      transactionIds: [{ ...leg, duplicate: false }],
      totalAmount: 1000,
      transactionCount: 1,
    });
    expect(parsed.transactionIds[0].duplicate).toBe(false);
  });

  it('ACCEPTS a response that omits it — undefined means "not reported", never false', () => {
    // Whether the service sends the field on every response is unverified from
    // here, so the schema must not make the parse fail when it does not. A
    // required field would break every caller of this endpoint, not just the
    // goods rail.
    const parsed = createMultiAccountBuzzTransactionResponse.parse({
      transactionIds: [leg],
      totalAmount: 1000,
      transactionCount: 1,
    });
    expect(parsed.transactionIds[0].duplicate).toBeUndefined();
  });
});
