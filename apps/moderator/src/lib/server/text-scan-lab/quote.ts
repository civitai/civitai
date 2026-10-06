import { QUOTE_ABOVE } from '../../text-scan-lab/limits';

/** A billed batch, planned: how many scans it is, what a confirmation must match, and both outcomes. */
export type Billable<Q, R> = {
  count: number;
  stamp: string;
  quote: () => Promise<Q>;
  execute: (userId: number) => Promise<R>;
};

/** Binds a confirmation to what was quoted: the scan count and, where one runs, the draft's version. */
export const quoteStamp = (count: number, version?: Date | null) =>
  `${count}:${version ? version.toISOString() : ''}`;

export type QuoteRequest<Q> = Q & {
  needsConfirm: true;
  count: number;
  stamp: string;
  /** The form confirmed an earlier quote that no longer matches what would run. */
  changed: boolean;
};

/**
 * Null when the batch may run: small enough to need no quote, or confirmed with this exact stamp
 * (the confirm button posts the stamp as `confirmed`). Otherwise the quote to confirm.
 */
export async function confirmedOrQuote<Q extends object>(
  form: FormData,
  batch: Pick<Billable<Q, unknown>, 'count' | 'stamp' | 'quote'>
): Promise<QuoteRequest<Q> | null> {
  if (batch.count <= QUOTE_ABOVE) return null;
  const confirmed = form.get('confirmed');
  if (confirmed === batch.stamp) return null;
  return {
    ...(await batch.quote()),
    needsConfirm: true,
    count: batch.count,
    stamp: batch.stamp,
    changed: typeof confirmed === 'string' && confirmed !== '',
  };
}
