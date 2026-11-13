import { CREDENTIAL_NAME_RE } from '../column-policy';
import { jsonLinesFile, type ExportWriter, type ManifestFile } from '../output';

/** List calls only. Nothing here creates, updates or deletes anything in Stripe. */
export type StripeReader = {
  customers: { retrieve(id: string): Promise<unknown> };
  charges: { list(p: { customer: string; limit: number }): AsyncIterable<unknown> };
  invoices: { list(p: { customer: string; limit: number }): AsyncIterable<unknown> };
  subscriptions: {
    list(p: { customer: string; limit: number; status: 'all' }): AsyncIterable<unknown>;
  };
};

/** Card fingerprints identify a card across merchants; they are not information about the user. */
const STRIPE_DROP_RE = /^(fingerprint|client_secret|fraud_details|radar_options)$/;

/** A charge's `outcome` is the payment risk system's verdict; only these plain fields are kept. */
const OUTCOME_KEEP = new Set(['network_status', 'seller_message']);

export function reduceStripe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reduceStripe);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (STRIPE_DROP_RE.test(k) || CREDENTIAL_NAME_RE.test(k)) continue;
    if (k === 'outcome' && v && typeof v === 'object') {
      out[k] = Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter(([ok]) => OUTCOME_KEEP.has(ok))
      );
      continue;
    }
    out[k] = reduceStripe(v);
  }
  return out;
}

export async function exportStripe({
  customerId,
  writer,
  stripe,
  onError,
}: {
  customerId: string | null;
  writer: ExportWriter;
  stripe: StripeReader | undefined;
  onError: (what: string, e: unknown) => void;
}): Promise<ManifestFile[]> {
  if (!customerId) return [];
  const parts: {
    name: string;
    description: string;
    read: (s: StripeReader) => AsyncIterable<unknown>;
  }[] = [
    {
      name: 'customer',
      description: 'Your payment-provider customer record.',
      read: (s) =>
        (async function* () {
          yield await s.customers.retrieve(customerId);
        })(),
    },
    {
      name: 'charges',
      description: 'Your card charges.',
      read: (s) => s.charges.list({ customer: customerId, limit: 100 }),
    },
    {
      name: 'invoices',
      description: 'Your invoices.',
      read: (s) => s.invoices.list({ customer: customerId, limit: 100 }),
    },
    {
      name: 'subscriptions',
      description: 'Your subscriptions, current and past.',
      read: (s) => s.subscriptions.list({ customer: customerId, limit: 100, status: 'all' }),
    },
  ];

  const files: ManifestFile[] = [];
  for (const part of parts) {
    const entry: ManifestFile = {
      file: `data/stripe/${part.name}.jsonl`,
      source: 'stripe',
      rows: 0,
      description: part.description,
      status: 'complete',
    };
    files.push(entry);
    if (!stripe) {
      entry.status = 'unavailable';
      continue;
    }
    // Read before the file starts, so a Stripe failure costs this part only, not the archive.
    const records: unknown[] = [];
    try {
      for await (const r of part.read(stripe)) records.push(reduceStripe(r));
    } catch (e) {
      entry.status = 'unavailable';
      onError(`stripe:${part.name}`, e);
      continue;
    }
    if (!records.length) continue;
    await writer.addFile(
      entry.file,
      jsonLinesFile(
        (async function* () {
          yield* records;
        })(),
        () => entry.rows++
      )
    );
  }
  return files;
}
