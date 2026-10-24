import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import {
  applyPlan,
  devDatabaseConfig,
  createSandboxWriter,
  LIVE_ID_KEY,
  planSync,
  upsertSandboxRows,
  writeDevDb,
  type Catalogue,
} from '../stripe-sandbox/sync.lib';

describe('createSandboxWriter', () => {
  it.each(['sk_live_abc123', 'rk_live_abc123', 'pk_test_abc123', '', undefined])(
    'refuses %s without constructing a client',
    (key) => {
      const ctor = vi.fn();
      expect(() => createSandboxWriter(key, ctor as unknown as typeof Stripe)).toThrow(/Refusing/);
      expect(ctor).not.toHaveBeenCalled();
    }
  );

  it('accepts a sandbox secret key', () => {
    const ctor = vi.fn();
    createSandboxWriter('sk_test_abc123', ctor as unknown as typeof Stripe);
    expect(ctor).toHaveBeenCalledWith('sk_test_abc123', expect.anything());
  });
});

const product = (o: Partial<Stripe.Product> & { id: string }) =>
  ({
    object: 'product',
    active: true,
    name: o.id,
    description: null,
    metadata: {},
    images: [],
    unit_label: null,
    default_price: null,
    ...o,
  } as Stripe.Product);

const price = (o: Partial<Stripe.Price> & { id: string; product: string }) =>
  ({
    object: 'price',
    active: true,
    currency: 'usd',
    unit_amount: 1000,
    unit_amount_decimal: '1000',
    type: 'recurring',
    billing_scheme: 'per_unit',
    tax_behavior: 'unspecified',
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    nickname: null,
    lookup_key: null,
    metadata: {},
    custom_unit_amount: null,
    ...o,
  } as Stripe.Price);

/** An in-memory sandbox with Stripe's create/update semantics for the fields the sync sets. */
function fakeSandbox() {
  const cat: Catalogue = { products: [], prices: [] };
  let n = 0;
  const writer = {
    products: {
      create: async (p: Stripe.ProductCreateParams) => {
        // Stripe treats '' as "unset", which a create refuses.
        if (p.description === '' || p.unit_label === '') throw new Error('empty string on create');
        const created = product({
          id: `prod_sb${++n}`,
          name: p.name,
          active: p.active ?? true,
          description: p.description ?? null,
          metadata: (p.metadata ?? {}) as Stripe.Metadata,
          images: p.images ?? [],
          unit_label: p.unit_label ?? null,
        });
        cat.products.push(created);
        return created;
      },
      update: async (id: string, p: Stripe.ProductUpdateParams) => {
        const target = cat.products.find((x) => x.id === id)!;
        const { metadata, ...rest } = p;
        Object.assign(target, rest);
        if ('description' in p) target.description = p.description || null;
        if ('unit_label' in p) target.unit_label = p.unit_label || null;
        if (metadata) {
          const merged = { ...target.metadata, ...(metadata as Stripe.Metadata) };
          target.metadata = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== ''));
        }
        return target;
      },
    },
    prices: {
      create: async (p: Stripe.PriceCreateParams) => {
        if (p.lookup_key && p.transfer_lookup_key) {
          for (const other of cat.prices)
            if (other.lookup_key === p.lookup_key) other.lookup_key = null;
        }
        const created = price({
          id: `price_sb${++n}`,
          product: p.product as string,
          active: p.active ?? true,
          currency: p.currency,
          unit_amount_decimal: p.unit_amount_decimal as string,
          unit_amount: Number(p.unit_amount_decimal),
          nickname: p.nickname ?? null,
          lookup_key: p.lookup_key ?? null,
          metadata: (p.metadata ?? {}) as Stripe.Metadata,
          type: p.recurring ? 'recurring' : 'one_time',
          recurring: p.recurring
            ? ({
                ...p.recurring,
                usage_type: p.recurring.usage_type ?? 'licensed',
              } as Stripe.Price.Recurring)
            : null,
        });
        cat.prices.push(created);
        return created;
      },
      update: async (id: string, p: Stripe.PriceUpdateParams) => {
        const target = cat.prices.find((x) => x.id === id)!;
        const owner = cat.products.find((x) => x.id === target.product);
        if (p.active === false && owner?.default_price === id)
          throw new Error('cannot archive the default price of a product');
        if (p.lookup_key && p.transfer_lookup_key) {
          for (const other of cat.prices)
            if (other.lookup_key === p.lookup_key) other.lookup_key = null;
        }
        const { transfer_lookup_key: _t, metadata, lookup_key, ...rest } = p;
        Object.assign(target, rest);
        if (lookup_key !== undefined) target.lookup_key = lookup_key || null;
        if (metadata) {
          const merged = { ...target.metadata, ...(metadata as Stripe.Metadata) };
          target.metadata = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== ''));
        }
        return target;
      },
    },
  };
  return { cat, writer: writer as unknown as Stripe };
}

const liveCatalogue = (): Catalogue => ({
  products: [
    product({
      id: 'prod_gold',
      name: 'Gold',
      description: 'Gold membership',
      metadata: { tier: 'gold', monthlyBuzz: '50000' },
      default_price: 'price_gold_m',
    }),
    product({ id: 'prod_old', name: 'Retired', active: false }),
    product({ id: 'prod_bare', name: 'No description' }),
  ],
  prices: [
    price({
      id: 'price_gold_m',
      product: 'prod_gold',
      unit_amount_decimal: '5000',
      lookup_key: 'gold_month',
    }),
    price({
      id: 'price_gold_y',
      product: 'prod_gold',
      unit_amount_decimal: '50000',
      recurring: {
        interval: 'year',
        interval_count: 1,
        usage_type: 'licensed',
      } as Stripe.Price.Recurring,
    }),
    price({ id: 'price_old', product: 'prod_old', active: false }),
  ],
});

const noLog = vi.fn();

async function sync(live: Catalogue, sb: ReturnType<typeof fakeSandbox>) {
  return applyPlan(sb.writer, planSync(live, sb.cat), sb.cat, noLog);
}

describe('planSync + applyPlan', () => {
  it('copies the active catalogue and a re-run plans nothing', async () => {
    const sb = fakeSandbox();
    const ids = await sync(liveCatalogue(), sb);

    expect(sb.cat.products.map((p) => p.name)).toEqual(['Gold', 'No description']);
    const gold = sb.cat.products[0];
    expect(gold.metadata).toEqual({
      tier: 'gold',
      monthlyBuzz: '50000',
      [LIVE_ID_KEY]: 'prod_gold',
    });
    expect(gold.default_price).toBe(ids.prices.price_gold_m);
    expect(sb.cat.prices.map((p) => [p.product, p.lookup_key, p.unit_amount_decimal])).toEqual([
      [gold.id, 'gold_month', '5000'],
      [gold.id, null, '50000'],
    ]);

    expect(planSync(liveCatalogue(), sb.cat)).toEqual([]);
  });

  it('replaces a sandbox price whose amount changed in live, moving its lookup key', async () => {
    const sb = fakeSandbox();
    await sync(liveCatalogue(), sb);
    const before = sb.cat.prices.find((p) => p.lookup_key === 'gold_month')!;

    const live = liveCatalogue();
    live.prices[0] = { ...live.prices[0], unit_amount_decimal: '6000' };
    const steps = planSync(live, sb.cat);
    expect(steps.map((s) => s.kind)).toEqual(['createPrice', 'setDefaultPrice', 'retirePrice']);

    await applyPlan(sb.writer, steps, sb.cat, noLog);
    const after = sb.cat.prices.find((p) => p.lookup_key === 'gold_month')!;
    expect(after.id).not.toBe(before.id);
    expect(after.unit_amount_decimal).toBe('6000');
    expect(before.active).toBe(false);
    expect(sb.cat.products[0].default_price).toBe(after.id);
    expect(planSync(live, sb.cat)).toEqual([]);
  });

  it('deactivates the sandbox copy when live deactivates a product', async () => {
    const sb = fakeSandbox();
    await sync(liveCatalogue(), sb);
    const live = liveCatalogue();
    live.products[0] = { ...live.products[0], active: false };

    await sync(live, sb);
    expect(sb.cat.products[0].active).toBe(false);
    expect(planSync(live, sb.cat)).toEqual([]);
  });

  it('follows a live repricing that moves the default and archives the old price', async () => {
    const sb = fakeSandbox();
    await sync(liveCatalogue(), sb);

    const live = liveCatalogue();
    live.prices[0] = { ...live.prices[0], active: false, lookup_key: null };
    live.prices.push(
      price({
        id: 'price_gold_m2',
        product: 'prod_gold',
        unit_amount_decimal: '6000',
        lookup_key: 'gold_month',
      })
    );
    live.products[0] = { ...live.products[0], default_price: 'price_gold_m2' };

    const ids = await sync(live, sb);
    const oldCopy = sb.cat.prices.find((p) => p.id === ids.prices.price_gold_m)!;
    expect(oldCopy.active).toBe(false);
    expect(sb.cat.products[0].default_price).toBe(ids.prices.price_gold_m2);
    expect(planSync(live, sb.cat)).toEqual([]);
  });

  it('clears a metadata key and a lookup key that live removed from a price', async () => {
    const sb = fakeSandbox();
    const start = liveCatalogue();
    start.prices[1] = { ...start.prices[1], metadata: { buzz: '1000' }, lookup_key: 'gold_year' };
    const ids = await sync(start, sb);

    const live = liveCatalogue();
    await sync(live, sb);
    const copy = sb.cat.prices.find((p) => p.id === ids.prices.price_gold_y)!;
    expect(copy.metadata).toEqual({ [LIVE_ID_KEY]: 'price_gold_y' });
    expect(copy.lookup_key).toBeNull();
    expect(planSync(live, sb.cat)).toEqual([]);
  });

  it('retires a second active copy of one live price, even when it is the default', async () => {
    const sb = fakeSandbox();
    await sync(liveCatalogue(), sb);
    const gold = sb.cat.products[0];
    const dupe = await sb.writer.prices.create({
      product: gold.id,
      currency: 'usd',
      unit_amount_decimal: '5000',
      recurring: { interval: 'month' },
      metadata: { [LIVE_ID_KEY]: 'price_gold_m' },
    });
    await sb.writer.products.update(gold.id, { default_price: dupe.id });

    await sync(liveCatalogue(), sb);
    const copies = sb.cat.prices.filter((p) => p.metadata[LIVE_ID_KEY] === 'price_gold_m');
    expect(copies.filter((p) => p.active)).toHaveLength(1);
    expect(gold.default_price).toBe(copies.find((p) => p.active)!.id);
    expect(planSync(liveCatalogue(), sb.cat)).toEqual([]);
  });

  it('skips archiving a sandbox default whose live replacement is not synced, instead of failing', async () => {
    const sb = fakeSandbox();
    const ids = await sync(liveCatalogue(), sb);

    const live = liveCatalogue();
    live.prices[0] = { ...live.prices[0], active: false };
    live.prices.push(
      price({ id: 'price_gold_tiered', product: 'prod_gold', billing_scheme: 'tiered' })
    );
    live.products[0] = { ...live.products[0], default_price: 'price_gold_tiered' };

    await sync(live, sb);
    expect(sb.cat.products[0].default_price).toBe(ids.prices.price_gold_m);
    expect(planSync(live, sb.cat).map((s) => s.kind)).toEqual(['skip', 'skip']);
  });

  it('matches by live_id, not by id, so a sandbox with unrelated objects gets its own copies', async () => {
    const sb = fakeSandbox();
    sb.cat.products.push(product({ id: 'prod_gold', name: 'Gold' }));
    await sync(liveCatalogue(), sb);
    expect(sb.cat.products.filter((p) => p.metadata[LIVE_ID_KEY] === 'prod_gold')).toHaveLength(1);
    expect(sb.cat.products).toHaveLength(3);
  });
});

describe('devDatabaseConfig', () => {
  const DEV = 'postgresql://u:p%40ss@devdb.local:5432/civitai?sslmode=no-verify&schema=public';
  const LIST = 'devdb.local:5432';

  it.each([
    ['no allowlist', DEV, undefined],
    ['an empty allowlist', DEV, ' , '],
    ['no database url', undefined, LIST],
    ['a host not listed', 'postgresql://u:p@proddb.internal:5432/civitai', LIST],
    ['the listed host on another port', 'postgresql://u:p@devdb.local:6543/civitai', LIST],
    ['a query-string host override', `${DEV}&host=proddb.internal`, LIST],
    ['a query-string port override', `${DEV}&port=6543`, LIST],
    ['a socket path', 'socket://u:p@devdb.local:5432/var/run/postgresql?db=civitai', LIST],
    ['a url with no database', 'postgresql://u:p@devdb.local:5432/', LIST],
    ['an ssl= param this does not map', 'postgresql://u:p@devdb.local:5432/civitai?ssl=true', LIST],
    ['an unparseable url', 'not a url', LIST],
  ])('refuses %s', (_, url, allowlist) => {
    expect(() => devDatabaseConfig(url, allowlist)).toThrow(/Refusing/);
  });

  it('returns explicit settings for the checked host, so nothing in the URL can redirect pg', () => {
    expect(devDatabaseConfig(DEV, `other:1, ${LIST}`)).toEqual({
      host: 'devdb.local',
      port: 5432,
      database: 'civitai',
      user: 'u',
      password: 'p@ss',
      ssl: { rejectUnauthorized: false },
    });
  });
});

describe('writeDevDb', () => {
  const DEV = 'postgresql://u:p@devdb.local:5432/civitai';

  it('never connects to a database that fails the check', async () => {
    const connect = vi.fn();
    await expect(
      writeDevDb({
        url: 'postgresql://u:p@proddb.internal:5432/civitai',
        allowlist: 'devdb.local:5432',
        catalogue: { products: [], prices: [] },
        connect,
      })
    ).rejects.toThrow(/Refusing/);
    expect(connect).not.toHaveBeenCalled();
  });

  it('connects with the checked settings and closes the client', async () => {
    const end = vi.fn(async () => undefined);
    const connect = vi.fn(async () => ({ query: async () => ({ rowCount: 1 }), end }));
    await writeDevDb({
      url: DEV,
      allowlist: 'devdb.local:5432',
      catalogue: { products: [], prices: [] },
      connect,
    });
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'devdb.local', port: 5432, database: 'civitai' })
    );
    expect(end).toHaveBeenCalled();
  });
});

describe('upsertSandboxRows', () => {
  async function synced() {
    const sb = fakeSandbox();
    const handmade = product({ id: 'prod_handmade', name: 'Made in the sandbox UI' });
    sb.cat.products.push(handmade);
    const ids = await sync(liveCatalogue(), sb);
    // A hand-made price, and a stamped price under the unstamped product: neither may be written.
    sb.cat.prices.push(
      price({ id: 'price_handmade', product: 'prod_handmade' }),
      price({ id: 'price_orphan', product: 'prod_handmade', metadata: { [LIVE_ID_KEY]: 'x' } })
    );
    return { sb, ids };
  }

  it('writes only stamped rows, products first, mapped column by column', async () => {
    const { sb, ids } = await synced();
    const calls: { sql: string; values: unknown[] }[] = [];
    const written = await upsertSandboxRows(async (sql, values) => {
      calls.push({ sql, values });
      return { rowCount: 1 };
    }, sb.cat);

    expect(calls.map((c) => c.values[0])).toEqual([
      ids.products.prod_gold,
      ids.products.prod_bare,
      ids.prices.price_gold_m,
      ids.prices.price_gold_y,
    ]);
    expect(written).toEqual({ products: 2, prices: 2, skipped: 0 });

    // Column order as written in the INSERT, so a swapped value or placeholder shows here.
    expect(calls[0].sql).toContain(
      '"Product" (id, active, name, description, metadata, "defaultPriceId", provider)'
    );
    expect(calls[0].values).toEqual([
      ids.products.prod_gold,
      true,
      'Gold',
      'Gold membership',
      JSON.stringify({ tier: 'gold', monthlyBuzz: '50000', [LIVE_ID_KEY]: 'prod_gold' }),
      ids.prices.price_gold_m,
    ]);
    expect(calls[2].values).toEqual([
      ids.prices.price_gold_m,
      ids.products.prod_gold,
      true,
      'usd',
      null,
      'recurring',
      5000,
      'month',
      1,
      JSON.stringify({ [LIVE_ID_KEY]: 'price_gold_m' }),
    ]);

    // Text pin: the update side of each upsert must be limited to stamped rows.
    for (const { sql } of calls)
      expect(sql.replace(/\s+/g, ' ')).toMatch(
        /DO UPDATE SET .* WHERE "(Product|Price)"\.metadata \? 'live_id'$/
      );
  });

  it('counts a conflict with an unstamped row as skipped, and writes no prices under it', async () => {
    const { sb, ids } = await synced();
    const seen: unknown[] = [];
    const written = await upsertSandboxRows(async (_sql, values) => {
      seen.push(values[0]);
      return { rowCount: values[0] === ids.products.prod_gold ? 0 : 1 };
    }, sb.cat);

    expect(written).toEqual({ products: 1, prices: 0, skipped: 1 });
    expect(seen).not.toContain(ids.prices.price_gold_m);
  });
});
