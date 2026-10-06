import { describe, expect, it, vi } from 'vitest';
import { QUOTE_ABOVE } from '$lib/text-scan-lab/limits';
import { confirmedOrQuote, quoteStamp } from '../text-scan-lab/quote';

const form = (confirmed?: string) => {
  const data = new FormData();
  if (confirmed !== undefined) data.append('confirmed', confirmed);
  return data;
};
const batch = (count: number) => ({
  count,
  stamp: quoteStamp(count),
  quote: vi.fn(async () => ({ cost: 5 })),
});

describe('confirmedOrQuote', () => {
  it(`lets ${QUOTE_ABOVE} scans through without a quote`, async () => {
    const b = batch(QUOTE_ABOVE);
    expect(await confirmedOrQuote(form(), b)).toBeNull();
    expect(b.quote).not.toHaveBeenCalled();
  });

  it('quotes a larger batch that was not confirmed', async () => {
    expect(await confirmedOrQuote(form(), batch(11))).toEqual({
      cost: 5,
      needsConfirm: true,
      count: 11,
      stamp: '11:',
      changed: false,
    });
  });

  it('runs a batch confirmed with its own stamp', async () => {
    expect(await confirmedOrQuote(form('11:'), batch(11))).toBeNull();
  });

  it('re-quotes, flagged as changed, when the confirmed stamp no longer matches', async () => {
    expect(await confirmedOrQuote(form('11:'), batch(12))).toMatchObject({
      needsConfirm: true,
      count: 12,
      changed: true,
    });
    expect(await confirmedOrQuote(form('1'), batch(12))).toMatchObject({ changed: true });
  });

  it("stamps a draft's version", () => {
    expect(quoteStamp(3, new Date('2026-10-06T00:00:00Z'))).toBe('3:2026-10-06T00:00:00.000Z');
  });
});
