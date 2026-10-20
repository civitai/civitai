import Stripe from 'stripe';
import { isTestKey, LIVE_ID_KEY } from '../../src/server/utils/stripe-key-mode';

export const STRIPE_API_VERSION = '2022-11-15' as const;
export { LIVE_ID_KEY };

export function assertSandboxKey(key: string | undefined): asserts key is string {
  if (!isTestKey(key)) {
    const prefix = key ? key.slice(0, 8) : '(empty)';
    throw new Error(
      `Refusing to write to Stripe with a ${prefix}... key: the sandbox writer only accepts sk_test_/rk_test_ keys.`
    );
  }
}

/** Every create/update in the sync goes through this client, so a live key can never write. */
export function createSandboxWriter(key: string | undefined, StripeCtor: typeof Stripe = Stripe) {
  assertSandboxKey(key);
  return new StripeCtor(key, { apiVersion: STRIPE_API_VERSION, typescript: true });
}

export type CatalogueReader = {
  listProducts(): Promise<Stripe.Product[]>;
  listPrices(): Promise<Stripe.Price[]>;
};

/** Exposes list calls only: the live source has no create/update method to call by mistake. */
export function createReader(key: string, StripeCtor: typeof Stripe = Stripe): CatalogueReader {
  const stripe = new StripeCtor(key, { apiVersion: STRIPE_API_VERSION, typescript: true });
  return {
    listProducts: () => stripe.products.list({ limit: 100 }).autoPagingToArray({ limit: 10_000 }),
    listPrices: () =>
      stripe.prices
        .list({ limit: 100, expand: ['data.currency_options', 'data.tiers'] })
        .autoPagingToArray({ limit: 10_000 }),
  };
}

type ProductFields = Pick<
  Stripe.ProductUpdateParams,
  'name' | 'description' | 'active' | 'metadata' | 'images' | 'unit_label'
>;

type WantedProduct = {
  name: string;
  description: string;
  active: boolean;
  metadata: Stripe.Metadata;
  images: string[];
  unit_label: string;
};

export type PlanStep =
  | { kind: 'createProduct'; liveId: string; params: Stripe.ProductCreateParams }
  | { kind: 'updateProduct'; liveId: string; sandboxId: string; params: ProductFields }
  | { kind: 'createPrice'; liveId: string; liveProductId: string; params: Stripe.PriceCreateParams }
  | { kind: 'updatePrice'; liveId: string; sandboxId: string; params: Stripe.PriceUpdateParams }
  | { kind: 'retirePrice'; liveId: string; sandboxId: string }
  | { kind: 'setDefaultPrice'; liveProductId: string; liveDefaultPriceId: string }
  | { kind: 'skip'; liveId: string; reason: string };

const idOf = (ref: string | { id: string }) => (typeof ref === 'string' ? ref : ref.id);

type Stamped = { id: string; active: boolean; metadata: Stripe.Metadata };

/** On a duplicate live_id (a retired copy beside its replacement), the active one wins. */
function indexByLiveId<T extends Stamped>(items: T[]) {
  const map = new Map<string, T>();
  for (const item of items) {
    const liveId = item.metadata?.[LIVE_ID_KEY];
    if (!liveId) continue;
    const existing = map.get(liveId);
    if (!existing || (!existing.active && item.active)) map.set(liveId, item);
  }
  return map;
}

/** Active sandbox copies of a live object other than the one `indexByLiveId` picked. */
function extraActiveCopies<T extends Stamped>(items: T[], picked: Map<string, T>) {
  return items.filter((item) => {
    const liveId = item.metadata?.[LIVE_ID_KEY];
    return liveId && item.active && picked.get(liveId)?.id !== item.id;
  });
}

function productFields(live: Stripe.Product): WantedProduct {
  return {
    name: live.name,
    description: live.description ?? '',
    active: live.active,
    metadata: { ...live.metadata, [LIVE_ID_KEY]: live.id },
    images: live.images ?? [],
    unit_label: live.unit_label ?? '',
  };
}

function sameMetadata(a: Stripe.Metadata, b: Stripe.Metadata) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) if ((a?.[k] ?? '') !== (b?.[k] ?? '')) return false;
  return true;
}

/** Stripe merges metadata on update, so a key removed in live is sent as '' to clear it. */
function metadataUpdate(current: Stripe.Metadata, want: Stripe.Metadata) {
  if (sameMetadata(current, want)) return null;
  const cleared = Object.fromEntries(
    Object.keys(current ?? {})
      .filter((k) => !(k in want))
      .map((k) => [k, ''])
  );
  return { ...cleared, ...want };
}

function productDiff(sandbox: Stripe.Product, want: WantedProduct): ProductFields | null {
  const diff: ProductFields = {};
  if (sandbox.name !== want.name) diff.name = want.name;
  if ((sandbox.description ?? '') !== want.description) diff.description = want.description;
  if (sandbox.active !== want.active) diff.active = want.active;
  if ((sandbox.unit_label ?? '') !== want.unit_label) diff.unit_label = want.unit_label;
  if (JSON.stringify(sandbox.images ?? []) !== JSON.stringify(want.images))
    diff.images = want.images;
  const metadata = metadataUpdate(sandbox.metadata, want.metadata);
  if (metadata) diff.metadata = metadata;
  return Object.keys(diff).length ? diff : null;
}

/** A difference here replaces the price instead of patching it (amounts and recurrence are immutable). */
function priceShape(p: Stripe.Price) {
  const currencyOptions = Object.entries(p.currency_options ?? {})
    .filter(([c]) => c !== p.currency)
    .map(([c, o]) => [c, o.unit_amount_decimal ?? null, o.tax_behavior ?? null])
    .sort();
  return JSON.stringify({
    currency: p.currency,
    unit_amount_decimal: p.unit_amount_decimal,
    type: p.type,
    billing_scheme: p.billing_scheme,
    tax_behavior: p.tax_behavior,
    interval: p.recurring?.interval ?? null,
    interval_count: p.recurring?.interval_count ?? null,
    usage_type: p.recurring?.usage_type ?? null,
    custom_unit_amount: p.custom_unit_amount ?? null,
    currencyOptions,
  });
}

function priceCreateParams(live: Stripe.Price, sandboxProductId: string): Stripe.PriceCreateParams {
  const currency_options = Object.fromEntries(
    Object.entries(live.currency_options ?? {})
      .filter(([c]) => c !== live.currency)
      .map(([c, o]) => [
        c,
        {
          unit_amount_decimal: o.unit_amount_decimal ?? undefined,
          tax_behavior: o.tax_behavior ?? undefined,
        },
      ])
  );
  return {
    product: sandboxProductId,
    currency: live.currency,
    active: live.active,
    nickname: live.nickname ?? undefined,
    metadata: { ...live.metadata, [LIVE_ID_KEY]: live.id },
    billing_scheme: live.billing_scheme,
    tax_behavior: live.tax_behavior ?? undefined,
    ...(live.custom_unit_amount
      ? {
          custom_unit_amount: {
            enabled: true,
            maximum: live.custom_unit_amount.maximum ?? undefined,
            minimum: live.custom_unit_amount.minimum ?? undefined,
            preset: live.custom_unit_amount.preset ?? undefined,
          },
        }
      : { unit_amount_decimal: live.unit_amount_decimal ?? undefined }),
    ...(live.recurring
      ? {
          recurring: {
            interval: live.recurring.interval,
            interval_count: live.recurring.interval_count,
            usage_type: live.recurring.usage_type,
          },
        }
      : {}),
    ...(Object.keys(currency_options).length ? { currency_options } : {}),
    ...(live.lookup_key ? { lookup_key: live.lookup_key, transfer_lookup_key: true } : {}),
  };
}

function priceDiff(sandbox: Stripe.Price, live: Stripe.Price): Stripe.PriceUpdateParams | null {
  const diff: Stripe.PriceUpdateParams = {};
  if (sandbox.active !== live.active) diff.active = live.active;
  if ((sandbox.nickname ?? '') !== (live.nickname ?? '')) diff.nickname = live.nickname ?? '';
  const metadata = metadataUpdate(sandbox.metadata, { ...live.metadata, [LIVE_ID_KEY]: live.id });
  if (metadata) diff.metadata = metadata;
  if ((sandbox.lookup_key ?? null) !== (live.lookup_key ?? null)) {
    diff.lookup_key = live.lookup_key ?? '';
    if (live.lookup_key) diff.transfer_lookup_key = true;
  }
  return Object.keys(diff).length ? diff : null;
}

function productCreateParams(want: WantedProduct): Stripe.ProductCreateParams {
  // Stripe rejects an empty string on create ("cannot be unset"), unlike on update.
  return {
    name: want.name,
    active: want.active,
    metadata: want.metadata,
    images: want.images,
    description: want.description || undefined,
    unit_label: want.unit_label || undefined,
  };
}

export type Catalogue = { products: Stripe.Product[]; prices: Stripe.Price[] };

/**
 * Matches sandbox objects to live ones by `metadata.live_id`, never by id (ids differ across
 * accounts). Inactive live objects are copied only with `includeInactive`; an existing sandbox
 * copy of one is still deactivated.
 */
export function planSync(
  live: Catalogue,
  sandbox: Catalogue,
  { includeInactive = false }: { includeInactive?: boolean } = {}
): PlanStep[] {
  const steps: PlanStep[] = [];
  // Stripe will not archive a product's default price, so every price deactivation runs after the
  // default prices move.
  const deactivations: PlanStep[] = [];
  const sandboxProducts = indexByLiveId(sandbox.products);
  const sandboxPrices = indexByLiveId(sandbox.prices);

  for (const lp of live.products) {
    const want = productFields(lp);
    const existing = sandboxProducts.get(lp.id);
    if (!existing) {
      if (lp.active || includeInactive)
        steps.push({ kind: 'createProduct', liveId: lp.id, params: productCreateParams(want) });
      continue;
    }
    const diff = productDiff(existing, want);
    if (diff)
      steps.push({ kind: 'updateProduct', liveId: lp.id, sandboxId: existing.id, params: diff });
  }

  const syncedProductIds = new Set(
    live.products
      .filter((p) => p.active || includeInactive || sandboxProducts.has(p.id))
      .map((p) => p.id)
  );
  for (const price of live.prices) {
    const liveProductId = idOf(price.product);
    const existing = sandboxPrices.get(price.id);
    if (!existing && !price.active && !includeInactive) continue;
    if (!syncedProductIds.has(liveProductId)) {
      steps.push({ kind: 'skip', liveId: price.id, reason: `product ${liveProductId} not synced` });
      continue;
    }
    if (price.billing_scheme === 'tiered') {
      steps.push({ kind: 'skip', liveId: price.id, reason: 'tiered prices are not synced' });
      continue;
    }
    // The sandbox product id is not known until the product exists, so it is filled in at apply.
    const create = priceCreateParams(price, '');
    if (!existing) {
      steps.push({ kind: 'createPrice', liveId: price.id, liveProductId, params: create });
      continue;
    }
    if (priceShape(existing) !== priceShape(price)) {
      steps.push({ kind: 'createPrice', liveId: price.id, liveProductId, params: create });
      deactivations.push({ kind: 'retirePrice', liveId: price.id, sandboxId: existing.id });
      continue;
    }
    const diff = priceDiff(existing, price);
    if (diff)
      (diff.active === false ? deactivations : steps).push({
        kind: 'updatePrice',
        liveId: price.id,
        sandboxId: existing.id,
        params: diff,
      });
  }
  for (const extra of extraActiveCopies(sandbox.prices, sandboxPrices)) {
    deactivations.push({
      kind: 'retirePrice',
      liveId: extra.metadata[LIVE_ID_KEY],
      sandboxId: extra.id,
    });
  }

  const syncedPriceIds = new Set([
    ...sandboxPrices.keys(),
    ...steps.flatMap((s) => (s.kind === 'createPrice' ? [s.liveId] : [])),
  ]);
  for (const lp of live.products) {
    if (!syncedProductIds.has(lp.id)) continue;
    const liveDefault = lp.default_price ? idOf(lp.default_price) : null;
    if (!liveDefault || !syncedPriceIds.has(liveDefault)) continue;
    const sandboxProduct = sandboxProducts.get(lp.id);
    const sandboxDefault = sandboxProduct?.default_price
      ? idOf(sandboxProduct.default_price)
      : null;
    const defaultReplaced = deactivations.some(
      (s) => s.kind === 'retirePrice' && s.liveId === liveDefault
    );
    if (defaultReplaced || sandboxDefault !== sandboxPrices.get(liveDefault)?.id) {
      steps.push({
        kind: 'setDefaultPrice',
        liveProductId: lp.id,
        liveDefaultPriceId: liveDefault,
      });
    }
  }

  // A default whose live replacement is not synced (tiered, or on an unsynced product) never
  // moves, and Stripe refuses to archive it, so it is skipped instead of failing every run.
  const movingDefaults = new Set(
    steps.flatMap((st) => (st.kind === 'setDefaultPrice' ? [st.liveProductId] : []))
  );
  const stuckDefaults = new Map(
    sandbox.products
      .filter((p) => p.default_price && !movingDefaults.has(p.metadata?.[LIVE_ID_KEY]))
      .map((p) => [idOf(p.default_price as string | Stripe.Price), p.id])
  );
  const runnable = deactivations.map((st): PlanStep => {
    const sandboxId = 'sandboxId' in st ? st.sandboxId : undefined;
    const product = sandboxId && stuckDefaults.get(sandboxId);
    return product && 'liveId' in st
      ? { kind: 'skip', liveId: st.liveId, reason: `still the default of sandbox ${product}` }
      : st;
  });

  return [...steps, ...runnable];
}

export type IdMap = { products: Record<string, string>; prices: Record<string, string> };

export async function applyPlan(
  writer: Stripe,
  steps: PlanStep[],
  sandbox: Catalogue,
  log: (line: string) => void = console.log
): Promise<IdMap> {
  const products: Record<string, string> = {};
  const prices: Record<string, string> = {};
  for (const [liveId, p] of indexByLiveId(sandbox.products)) products[liveId] = p.id;
  for (const [liveId, p] of indexByLiveId(sandbox.prices)) prices[liveId] = p.id;

  for (const step of steps) {
    switch (step.kind) {
      case 'createProduct': {
        const created = await writer.products.create(step.params);
        products[step.liveId] = created.id;
        log(`created product ${step.liveId} -> ${created.id}`);
        break;
      }
      case 'updateProduct':
        await writer.products.update(step.sandboxId, step.params);
        log(`updated product ${step.liveId} (${step.sandboxId})`);
        break;
      case 'createPrice': {
        const product = products[step.liveProductId];
        if (!product) throw new Error(`no sandbox product for ${step.liveProductId}`);
        const created = await writer.prices.create({ ...step.params, product });
        prices[step.liveId] = created.id;
        log(`created price ${step.liveId} -> ${created.id}`);
        break;
      }
      case 'updatePrice':
        await writer.prices.update(step.sandboxId, step.params);
        log(`updated price ${step.liveId} (${step.sandboxId})`);
        break;
      case 'retirePrice':
        await writer.prices.update(step.sandboxId, { active: false });
        log(`retired price ${step.sandboxId} (superseded copy of ${step.liveId})`);
        break;
      case 'setDefaultPrice': {
        const product = products[step.liveProductId];
        const price = prices[step.liveDefaultPriceId];
        if (!product || !price) {
          log(`skipped default price for ${step.liveProductId}: not synced`);
          break;
        }
        await writer.products.update(product, { default_price: price });
        log(`set default price of ${product} -> ${price}`);
        break;
      }
      case 'skip':
        log(`skipped ${step.liveId}: ${step.reason}`);
        break;
    }
  }
  return { products, prices };
}

export function describePlan(steps: PlanStep[]) {
  const counts: Record<string, number> = {};
  for (const s of steps) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
  return counts;
}

export type DbQuery = (
  sql: string,
  values: unknown[]
) => Promise<{ rowCount?: number | null } | void>;

export type DevDbConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean | { rejectUnauthorized: false };
};

const REDIRECTING_PARAMS = ['host', 'hostaddr', 'port', 'socket'];

/**
 * The only source of --dev-db's connection settings. Refuses any database whose host:port is not
 * in `allowlist` (from the local STRIPE_SANDBOX_DB_HOSTS), so a sandbox key paired with a
 * production URL never writes. The settings are built here from the checked URL, because pg's own
 * parser lets `?host=` / `?port=` or a socket path override the host:port that was checked.
 */
export function devDatabaseConfig(
  url: string | undefined,
  allowlist: string | undefined
): DevDbConfig {
  const allowed = (allowlist ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  let parsed: URL | undefined;
  try {
    parsed = url ? new URL(url) : undefined;
  } catch {
    parsed = undefined;
  }
  const port = parsed?.port || '5432';
  const target = parsed ? `${parsed.hostname}:${port}` : '(no DATABASE_URL)';
  const refuse = (why: string) => new Error(`Refusing to write sandbox rows to ${target}: ${why}.`);

  if (!parsed || !['postgres:', 'postgresql:'].includes(parsed.protocol))
    throw refuse('not a postgres:// URL');
  if (REDIRECTING_PARAMS.some((p) => parsed!.searchParams.has(p)))
    throw refuse('the URL overrides its host or port in the query string');
  if (!allowed.includes(target)) throw refuse('not in STRIPE_SANDBOX_DB_HOSTS');
  // Only sslmode is mapped below; pg's own `ssl=` would otherwise be dropped to plaintext.
  if (parsed.searchParams.has('ssl')) throw refuse('use sslmode, not ssl, in the URL');
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!database) throw refuse('the URL names no database');

  const sslmode = parsed.searchParams.get('sslmode');
  return {
    host: parsed.hostname,
    port: Number(port),
    database,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    ssl:
      !sslmode || sslmode === 'disable'
        ? false
        : sslmode === 'no-verify'
        ? { rejectUnauthorized: false }
        : true,
  };
}

/**
 * Mirrors `upsertProductRecord` / `upsertPriceRecord` in src/server/services/stripe.service.ts,
 * which the app's webhook runs. Inserts or updates sandbox rows only: a row without `live_id` is
 * never touched, and the plan reads tell the two catalogues apart by that key. A price is written
 * only under a product row this run wrote.
 */
export async function upsertSandboxRows(query: DbQuery, sandbox: Catalogue) {
  const written = { products: 0, prices: 0, skipped: 0 };
  const writtenProducts = new Set<string>();
  for (const p of sandbox.products.filter((p) => p.metadata?.[LIVE_ID_KEY])) {
    const result = await query(
      `INSERT INTO "Product" (id, active, name, description, metadata, "defaultPriceId", provider)
       VALUES ($1, $2, $3, $4, $5, $6, 'Stripe')
       ON CONFLICT (id) DO UPDATE SET active = $2, name = $3, description = $4, metadata = $5,
         "defaultPriceId" = $6
       WHERE "Product".metadata ? '${LIVE_ID_KEY}'`,
      [
        p.id,
        p.active,
        p.name,
        p.description ?? null,
        JSON.stringify(p.metadata),
        p.default_price ? idOf(p.default_price) : null,
      ]
    );
    // A conflict with a row lacking live_id updates nothing; a dry run's query returns no count.
    if (result?.rowCount === 0) {
      written.skipped++;
      continue;
    }
    written.products++;
    writtenProducts.add(p.id);
  }
  const prices = sandbox.prices.filter(
    (p) => p.metadata?.[LIVE_ID_KEY] && writtenProducts.has(idOf(p.product))
  );
  for (const p of prices) {
    const result = await query(
      `INSERT INTO "Price" (id, "productId", active, currency, description, type, "unitAmount",
         interval, "intervalCount", metadata, provider)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'Stripe')
       ON CONFLICT (id) DO UPDATE SET "productId" = $2, active = $3, currency = $4,
         description = $5, type = $6, "unitAmount" = $7, interval = $8, "intervalCount" = $9,
         metadata = $10
       WHERE "Price".metadata ? '${LIVE_ID_KEY}'`,
      [
        p.id,
        idOf(p.product),
        p.active,
        p.currency,
        p.nickname ?? null,
        p.type,
        p.unit_amount,
        p.recurring?.interval ?? null,
        p.recurring?.interval_count ?? null,
        JSON.stringify(p.metadata),
      ]
    );
    if (result?.rowCount === 0) written.skipped++;
    else written.prices++;
  }
  return written;
}

export type DevDbClient = { query: DbQuery; end(): Promise<void> };

/** Validates the target first, so nothing connects to a database that failed the check. */
export async function writeDevDb({
  url,
  allowlist,
  catalogue,
  connect,
}: {
  url: string | undefined;
  allowlist: string | undefined;
  catalogue: Catalogue;
  connect: (config: DevDbConfig) => Promise<DevDbClient>;
}) {
  const client = await connect(devDatabaseConfig(url, allowlist));
  try {
    return await upsertSandboxRows(client.query, catalogue);
  } finally {
    await client.end();
  }
}
