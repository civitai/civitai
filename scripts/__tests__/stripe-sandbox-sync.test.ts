import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import {
  applyPlan,
  createSandboxWriter,
  LIVE_ID_KEY,
  planSync,
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
        if (p.lookup_key && p.transfer_lookup_key) {
          for (const other of cat.prices)
            if (other.lookup_key === p.lookup_key) other.lookup_key = null;
        }
        const { transfer_lookup_key: _t, metadata, ...rest } = p;
        Object.assign(target, rest);
        if (metadata) target.metadata = { ...target.metadata, ...(metadata as Stripe.Metadata) };
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
    // Stripe refuses to archive a product's default price, so the default moves first.
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

  it('matches by live_id, not by id, so a sandbox with unrelated objects gets its own copies', async () => {
    const sb = fakeSandbox();
    sb.cat.products.push(product({ id: 'prod_gold', name: 'Gold' }));
    await sync(liveCatalogue(), sb);
    expect(sb.cat.products.filter((p) => p.metadata[LIVE_ID_KEY] === 'prod_gold')).toHaveLength(1);
    expect(sb.cat.products).toHaveLength(3);
  });
});
