import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcModule from '~/utils/trpc';

/**
 * The panel must never present buckets that were never measured as earnings.
 * `getMyRevenue` returns all-zero buckets both for a publisher who has genuinely
 * earned nothing yet and for a caller the dark `appBlocks` flag never let it
 * query — only `unavailable` separates them, so rendering the former shape for
 * the latter fabricates a clean $0.00 revenue report.
 *
 * Both /apps/revenue and /apps/[appBlockId]/revenue render this component, so
 * these cases cover the guard for both pages.
 */

const mocks = vi.hoisted(() => ({ revenue: { current: undefined as unknown } }));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'blocks.getMyRevenue': {
        useQuery: () => ({ data: mocks.revenue.current, isLoading: false, error: null }),
      },
    }),
  };
});

const { RevenuePanel } = await import('./RevenuePanel');

const ZERO_FEES = {
  accrued: { count: 0, feeBuzz: 0, byBuzzType: {} },
  settled: { count: 0, feeBuzz: 0, byBuzzType: {} },
  byApp: [],
  recent: [],
};
const ZERO_GOODS = {
  sales: {
    count: 0,
    grossBuzz: 0,
    shareBuzz: 0,
    shareUsdCents: 0,
    grossUsdCents: 0,
    blueGrossBuzz: 0,
  },
  refunded: { count: 0, grossBuzz: 0 },
};
const ZEROED = {
  authorFees: ZERO_FEES,
  goods: ZERO_GOODS,
};

/** The card-purchase share's labels. That share is recorded but never paid out. */
const CARD_SHARE_LABELS = [
  'Pending',
  'Confirmed (unpaid)',
  'Paid out',
  'Voided',
  'Top earning apps',
  'Recent attributions',
];
const cardShareOnScreen = () =>
  CARD_SHARE_LABELS.filter((l) => page.getByText(l, { exact: true }).elements().length > 0);

describe('RevenuePanel — unavailable vs genuine zero', () => {
  test('dark flag (notEntitled): shows an honest unavailable state, NOT a $0.00 dashboard', async () => {
    mocks.revenue.current = { ...ZEROED, unavailable: 'notEntitled' };
    renderWithProviders(<RevenuePanel />);

    await expect.element(page.getByText('Revenue unavailable')).toBeInTheDocument();
    await expect.element(page.getByText(/not a report of zero earnings/i)).toBeInTheDocument();
    // The fabricated dashboard must be gone entirely — both money cards.
    expect(page.getByRole('heading', { name: 'Author fees' }).elements()).toHaveLength(0);
    expect(page.getByTestId('author-fees-pending-buzz').elements()).toHaveLength(0);
    expect(page.getByRole('heading', { name: 'Digital goods sales' }).elements()).toHaveLength(0);
  });

  test('dark flag, scoped to one app: same guard on the per-app revenue page', async () => {
    mocks.revenue.current = { ...ZEROED, unavailable: 'notEntitled' };
    renderWithProviders(<RevenuePanel appBlockId="apb_1" />);

    await expect.element(page.getByText('Revenue unavailable')).toBeInTheDocument();
    expect(page.getByRole('heading', { name: 'Author fees' }).elements()).toHaveLength(0);
  });

  test('DISCRIMINATOR: a genuine earned-nothing result still renders the real dashboard', async () => {
    // Byte-identical buckets to the two cases above — only `unavailable` is
    // absent. If a later change flags this path too, a publisher loses a report
    // they are entitled to; if it stops flagging the others, the fabricated zero
    // comes back.
    mocks.revenue.current = { ...ZEROED };
    renderWithProviders(<RevenuePanel />);

    await expect.element(page.getByRole('heading', { name: 'Author fees' })).toBeInTheDocument();
    await expect
      .element(page.getByTestId('author-fees-empty'))
      .toHaveTextContent(/^No author fees attributed to you on your apps\.$/);
    expect(page.getByText('Revenue unavailable').elements()).toHaveLength(0);
    // Rendered even at zero: "sold nothing" and "sales are not reported here" must
    // not look the same, which is this file's whole thesis one rail over.
    await expect
      .element(page.getByRole('heading', { name: 'Digital goods sales' }))
      .toBeInTheDocument();
    // 🔴 The UNSCOPED wording specifically. `/No digital goods sold/` matches BOTH
    // copies, so with the loose pattern a `scoped ? A : B` collapsed to the scoped
    // branch survived — and the portfolio page then told an owner "through this app".
    await expect
      .element(page.getByText(/No digital goods sales attributed to you on your apps yet/i))
      .toBeInTheDocument();
  });
});

/**
 * The digital-goods rail.
 *
 * THE DEFECT: a settled sale — 10 Buzz, 7 to the owner, `status='paid'`, entitlement
 * granted — rendered as $0.00 on both revenue pages, because every figure on them
 * summed `block_buzz_attribution` and this rail writes no row there.
 *
 * 🔴 WHY THE BUZZ FIGURE IS THE ASSERTION AND THE DOLLARS ARE NOT. 1,000 Buzz =
 * $1, so a 7-Buzz owner share is 0.7c and floors to ZERO cents. A fix that
 * reported this rail in dollars alone would show `$0.00` for the very sale that
 * motivated it — the same bug, one layer down. So Buzz is pinned, and the sub-cent
 * aside is pinned as `<$0.01` rather than `$0.00`.
 *
 * 🔴 EVERY NUMERIC ASSERTION HERE IS AN ANCHORED REGEX, NOT A STRING.
 * `toHaveTextContent` is a SUBSTRING match (measured in
 * `@vitest/browser`'s `expect-element`: `textContent.includes(String(expected))`),
 * so `toHaveTextContent('0')` is satisfied by `"10"`, `"100"` and `"1,000"`. With
 * plain strings, a `shareBuzz + refunded.grossBuzz` mutation — a plausible "show
 * total transacted" edit that inflates an owner's share with reversed money —
 * rendered `"10"`, matched `'0'`, and survived the whole suite. The helper branches
 * to `regex.test(text)`, so `/^0$/` closes it.
 */
describe('RevenuePanel — digital goods sales', () => {
  test('a paid sale is VISIBLE: Buzz figures render, sub-cent USD reads <$0.01', async () => {
    mocks.revenue.current = {
      ...ZEROED,
      goods: {
        sales: {
          count: 1,
          grossBuzz: 10,
          shareBuzz: 7,
          shareUsdCents: 0,
          grossUsdCents: 1,
          blueGrossBuzz: 0,
        },
        refunded: { count: 0, grossBuzz: 0 },
      },
    };
    renderWithProviders(<RevenuePanel />);

    await expect
      .element(page.getByRole('heading', { name: 'Digital goods sales' }))
      .toBeInTheDocument();
    // Addressed by testid, not by text: every figure is a small integer, so
    // `getByText('7')` matches the wrapping element too and cannot say which field
    // it found. Anchored, so a field carrying a wider number fails.
    await expect.element(page.getByTestId('goods-sales-count')).toHaveTextContent(/^1$/);
    await expect.element(page.getByTestId('goods-gross-buzz')).toHaveTextContent(/^10$/);
    await expect.element(page.getByTestId('goods-share-buzz')).toHaveTextContent(/^7$/);
    // 🔴 A real amount must never read as nothing. 0 cents against 7 Buzz is
    // `<$0.01` — rendering `$0.00` here is the bug this whole change exists to fix,
    // reproduced one unit down. No `≈`: the value is an exact upper bound.
    await expect.element(page.getByTestId('goods-share-usd')).toHaveTextContent(/^<\$0\.01$/);
    // ...while a figure that reaches a cent prints normally, so `<$0.01` is not
    // simply always used.
    await expect.element(page.getByTestId('goods-gross-usd')).toHaveTextContent(/^≈ \$0\.01$/);

    // 🔴 LABEL↔FIGURE BINDING. The testids pin number→testid and nothing else, so
    // swapping the two visible labels while leaving the testids in place showed an
    // owner the gross figure as their share with no test going red. Asserting the
    // enclosing tile carries both its label and its number is what catches it.
    // Pinned as the tile's WHOLE normalised text. A "contains the label" plus
    // "contains the number" pair cannot do this job: the rendered text has no
    // separator between them (`Your share7<$0.01`), so a word-boundary pattern on
    // the number never matches, and a loose `/7/` would also match the gross tile's
    // "10"... no it would not, but it WOULD match a tile showing 17 or 70. The whole
    // string costs a cosmetic-reword failure and buys a machine-readable claim.
    await expect
      .element(page.getByTestId('goods-share-tile'))
      .toHaveTextContent(/^Your share7<\$0\.01$/);
    await expect
      .element(page.getByTestId('goods-gross-tile'))
      .toHaveTextContent(/^Gross10≈ \$0\.01$/);

    // No sale was paid with blue, so the non-bankable caveat must be absent —
    // otherwise it would be decoration rather than a signal.
    expect(page.getByTestId('goods-blue-caveat').elements()).toHaveLength(0);
    // The empty state must be gone — a sale exists.
    expect(page.getByText(/No digital goods sales attributed to you/i).elements()).toHaveLength(0);
  });

  test('BLUE BUZZ: a blue-funded sale carries the non-bankable caveat', async () => {
    // Blue Buzz is Generation Buzz and cannot be withdrawn, and the owner's share
    // is paid proportionally in blue — so a dollar figure beside it is an upper
    // bound, not a value. Without this the page attaches a cash number to money
    // that can never be cashed.
    mocks.revenue.current = {
      ...ZEROED,
      goods: {
        sales: {
          count: 1,
          grossBuzz: 10,
          shareBuzz: 7,
          shareUsdCents: 0,
          grossUsdCents: 1,
          blueGrossBuzz: 10,
        },
        refunded: { count: 0, grossBuzz: 0 },
      },
    };
    renderWithProviders(<RevenuePanel />);

    await expect.element(page.getByTestId('goods-blue-caveat')).toBeInTheDocument();
    await expect
      .element(page.getByTestId('goods-blue-caveat'))
      .toHaveTextContent(/cannot be withdrawn/i);
    // The figures still render — the caveat qualifies them, it does not replace them.
    await expect.element(page.getByTestId('goods-share-buzz')).toHaveTextContent(/^7$/);
  });

  test('a reversed purchase is excluded from earnings AND disclosed as excluded', async () => {
    mocks.revenue.current = {
      ...ZEROED,
      goods: {
        // The only purchase was reversed: nothing earned, and the owner should be
        // able to see WHY their total is zero rather than being shown a bare zero.
        sales: {
          count: 0,
          grossBuzz: 0,
          shareBuzz: 0,
          shareUsdCents: 0,
          grossUsdCents: 0,
          blueGrossBuzz: 0,
        },
        refunded: { count: 1, grossBuzz: 10 },
      },
    };
    renderWithProviders(<RevenuePanel />);

    await expect
      .element(page.getByRole('heading', { name: 'Digital goods sales' }))
      .toBeInTheDocument();
    // 🔴 "reversed or refunded", never "refunded sale". `status='refunded'` also
    // covers a charge reversed before any entitlement existed, where no sale ever
    // happened, and the aggregate does not join the entitlement that would tell
    // them apart. Pinned so the wording cannot drift back.
    await expect
      .element(page.getByTestId('goods-reversed-line'))
      .toHaveTextContent(/^1 reversed or refunded charge \(10 Buzz\) — not counted above\.$/);

    // 🔴 It must NOT be counted as a sale. ANCHORED: `toHaveTextContent('0')` is a
    // substring match satisfied by "10", so the unanchored form let a reversed
    // amount leak into the gross or the share and still pass.
    await expect.element(page.getByTestId('goods-sales-count')).toHaveTextContent(/^0$/);
    await expect.element(page.getByTestId('goods-gross-buzz')).toHaveTextContent(/^0$/);
    await expect.element(page.getByTestId('goods-share-buzz')).toHaveTextContent(/^0$/);

    // 🔴 NEGATIVE CONTROL FOR `<$0.01`. A TRUE zero must render `$0.00`, not the
    // sub-cent form — otherwise `approxDollars` could drop its `buzzAmount > 0`
    // term and claim a real sub-cent earning where there is none, and the paid case
    // above would not notice. This is the assertion that makes `<$0.01` evidence
    // rather than a value that is always used.
    await expect.element(page.getByTestId('goods-share-usd')).toHaveTextContent(/^≈ \$0\.00$/);
    await expect.element(page.getByTestId('goods-gross-usd')).toHaveTextContent(/^≈ \$0\.00$/);

    // 🔴 ...and the "nothing sold" copy must NOT appear. Something WAS bought and
    // then reversed, so that sentence would be false — which is why the empty state
    // keys on `sales.count === 0 && refunded.count === 0`, not on the paid count.
    expect(page.getByText(/No digital goods sales attributed to you/i).elements()).toHaveLength(0);
  });

  test('PLURAL: more than one reversed charge pluralises, and the caveat co-renders', async () => {
    // Two surviving mutations in one case. (1) The plural ternary had no multi-count
    // fixture, so collapsing it to always-singular was green. (2) The blue caveat and
    // the reversed line had never rendered TOGETHER, so nothing proved the card can
    // show a sale, a colour caveat and an exclusion at once rather than one of them.
    mocks.revenue.current = {
      ...ZEROED,
      goods: {
        sales: {
          count: 2,
          grossBuzz: 430,
          shareBuzz: 301,
          shareUsdCents: 30,
          grossUsdCents: 43,
          blueGrossBuzz: 115,
        },
        refunded: { count: 4, grossBuzz: 60 },
      },
    };
    renderWithProviders(<RevenuePanel />);

    await expect
      .element(page.getByTestId('goods-reversed-line'))
      .toHaveTextContent(/^4 reversed or refunded charges \(60 Buzz\) — not counted above\.$/);
    await expect.element(page.getByTestId('goods-blue-caveat')).toBeInTheDocument();
    // The earnings figures are the PAID bucket's, untouched by the 60 reversed Buzz.
    await expect.element(page.getByTestId('goods-share-buzz')).toHaveTextContent(/^301$/);
    await expect.element(page.getByTestId('goods-gross-buzz')).toHaveTextContent(/^430$/);
    // ...and at this size the dollars are real, so the sub-cent form must NOT appear —
    // the other half of the `approxDollars` condition, pinned on a third shape.
    await expect.element(page.getByTestId('goods-share-usd')).toHaveTextContent(/^≈ \$0\.30$/);
    await expect.element(page.getByTestId('goods-gross-usd')).toHaveTextContent(/^≈ \$0\.43$/);
  });

  test('scoped to one app: the empty state claims only what was MEASURED', async () => {
    // 🔴 "attributed to you", not "sold through this app". The aggregate is scoped
    // by `app_owner_user_id`, and an accepted COLLABORATOR can reach this page —
    // it admits anything in `getMyApps`, which includes seated apps — so none of
    // the owner's rows are theirs. The unhedged sentence told such a viewer the app
    // had no sales when it may have many.
    mocks.revenue.current = { ...ZEROED };
    renderWithProviders(<RevenuePanel appBlockId="apb_1" />);

    await expect
      .element(page.getByRole('heading', { name: 'Digital goods sales' }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(/No digital goods sales attributed to you for this app yet/i))
      .toBeInTheDocument();
  });

  test('UNREADABLE: a bucket that could not be read says so, and does NOT read as zero sales', async () => {
    // 🔴 `block_good_purchase` is applied by hand per environment, so this code can
    // run against a database without it. Before the discriminator existed that
    // threw and took BOTH revenue pages down, including the other figures
    // that were fine. The fix must not swing to the other error either: zeroing the
    // bucket would report "no sales" for a rail nobody read — the fabricated zero
    // the payload-level guard in the describe above exists to prevent.
    // 🔴 NON-ZERO blue and reversed figures, deliberately. The card guards those two
    // lines with `!unavailable &&`, and with an all-zero fixture both guards are
    // unreachable — deleting them was a green mutation. A flagged bucket should not
    // normally carry figures at all, but the guards exist precisely for the case
    // where a future `unavailable` reason does, so the fixture has to create it.
    mocks.revenue.current = {
      ...ZEROED,
      goods: {
        sales: { ...ZERO_GOODS.sales, blueGrossBuzz: 40 },
        refunded: { count: 3, grossBuzz: 90 },
        unavailable: 'unreadable',
      },
    };
    renderWithProviders(<RevenuePanel />);

    await expect.element(page.getByTestId('goods-unavailable')).toBeInTheDocument();
    await expect
      .element(page.getByTestId('goods-unavailable'))
      .toHaveTextContent(/not a report of zero sales/i);

    // The zeroed stat grid must NOT render — zeros nobody measured are exactly what
    // is being withheld.
    expect(page.getByTestId('goods-share-buzz').elements()).toHaveLength(0);
    expect(page.getByTestId('goods-gross-buzz').elements()).toHaveLength(0);
    // ...nor the "no sales" copy, which would be the same lie in words.
    expect(page.getByText(/No digital goods sales attributed to you/i).elements()).toHaveLength(0);

    // 🔴 NEITHER SUBORDINATE LINE MAY RENDER BESIDE THE FLAG. Both carry figures the
    // bucket did not measure, so showing either would reinstate the fabricated-zero
    // problem one line down. These are the assertions that make the `!unavailable &&`
    // guards reachable rather than decoration.
    expect(page.getByTestId('goods-blue-caveat').elements()).toHaveLength(0);
    expect(page.getByTestId('goods-reversed-line').elements()).toHaveLength(0);

    // 🔴 DISCRIMINATOR, and the whole point: the REST of the dashboard still
    // renders. One unreadable rail must degrade to a labelled gap, not an outage.
    await expect.element(page.getByTestId('author-fees-empty')).toBeInTheDocument();
    expect(page.getByText('Revenue unavailable').elements()).toHaveLength(0);
  });

  test('ABSENT goods key: an older API process omitting it degrades, it does not crash', async () => {
    // 🔴 THIS IS THE TEST FOR `data.goods ?? GOODS_ABSENT`, AND WITHOUT IT THAT
    // GUARD HAD NO COVERAGE AT ALL. `mocks.revenue.current` is this component's only
    // data-injection point; the `ZEROED` base fixture always carries `goods`, and
    // every other case in this file OVERRIDES that key rather than omitting it. So
    // deleting `?? GOODS_ABSENT` was green across the whole suite: `tsc` cannot
    // object because `goods` is declared non-optional on the payload type, and
    // `@typescript-eslint/no-unnecessary-condition` is not enabled in this repo.
    //
    // 🔴 THE SCENARIO IS REAL, WHICH IS WHY THE GUARD IS NOT DECORATION. `data` is
    // an `as`-cast of a wire payload, and SSR and the API are separate deployments
    // here — so during a rollout an API process older than this bundle can answer
    // the revenue bundle without the key at all. `GoodsSalesCard` destructures its
    // prop (`const { sales, refunded, unavailable } = goods`), so an unchecked
    // `data.goods` threw and took the whole page down, other figures included.
    //
    // 🔴 AND IT DEGRADES TO THE UNREADABLE SHAPE, NOT TO ZEROS. "Absent from the
    // payload" is not a measurement of zero sales; rendering a clean $0.00 goods
    // card here is the fabricated zero the discriminator in the describe header
    // exists to prevent.
    //
    // The key is DELETED rather than set to `undefined`: that is the shape the wire
    // actually produces, and the assertion below pins that the fixture really omits
    // it — a fixture that merely set `goods: undefined` would be testing a different
    // payload than the one this guard is for.
    const payload: Record<string, unknown> = { ...ZEROED };
    delete payload.goods;
    expect('goods' in payload).toBe(false);
    mocks.revenue.current = payload;

    renderWithProviders(<RevenuePanel />);

    // The flagged state renders, with the same copy the server-side unreadable
    // bucket produces — the reader cannot tell the two apart, and should not.
    await expect.element(page.getByTestId('goods-unavailable')).toBeInTheDocument();
    await expect
      .element(page.getByTestId('goods-unavailable'))
      .toHaveTextContent(/not a report of zero sales/i);

    // 🔴 NOT ZEROS, AND NOT THE "no sales" SENTENCE. Both would report a figure for
    // a rail that was never in the payload.
    expect(page.getByTestId('goods-share-buzz').elements()).toHaveLength(0);
    expect(page.getByTestId('goods-gross-buzz').elements()).toHaveLength(0);
    expect(page.getByText(/No digital goods sales attributed to you/i).elements()).toHaveLength(0);

    // 🔴 AND THE REST OF THE DASHBOARD SURVIVES — the property the guard exists for.
    // A page-wide crash is what the missing key used to cause, so these are the
    // assertions that separate "degraded one rail" from "took the page down".
    await expect.element(page.getByTestId('author-fees-empty')).toBeInTheDocument();
    expect(page.getByText('Revenue unavailable').elements()).toHaveLength(0);
  });
});

const FEES = {
  paidWindowDays: 90,
  accrued: { count: 3, feeBuzz: 41, byBuzzType: { yellow: 41 } },
  settled: { count: 5, feeBuzz: 97, byBuzzType: { yellow: 90, blue: 7 } },
  byApp: [
    {
      appBlockId: 'apb_big',
      accrued: { count: 2, feeBuzz: 33, byBuzzType: { yellow: 33 } },
      settled: { count: 4, feeBuzz: 88, byBuzzType: { yellow: 81, blue: 7 } },
    },
    {
      appBlockId: 'apb_small',
      accrued: { count: 1, feeBuzz: 8, byBuzzType: { yellow: 8 } },
      settled: { count: 1, feeBuzz: 9, byBuzzType: { yellow: 9 } },
    },
  ],
  recent: [
    {
      id: 'bafa_2',
      appBlockId: 'apb_small',
      feeBuzz: 8,
      buzzType: 'yellow',
      status: 'accrued',
      accruedAt: '2026-11-11T10:00:00Z',
      settledAt: null,
    },
    {
      id: 'bafa_1',
      appBlockId: 'apb_big',
      feeBuzz: 7,
      buzzType: 'blue',
      status: 'settled',
      accruedAt: '2026-11-09T10:00:00Z',
      settledAt: '2026-11-10T02:30:00Z',
    },
  ],
};

describe('RevenuePanel — author fees', () => {
  test('pending and paid totals render against their labels, with the buzz-type split', async () => {
    mocks.revenue.current = { ...ZEROED, authorFees: FEES };
    renderWithProviders(<RevenuePanel />);

    await expect.element(page.getByRole('heading', { name: 'Author fees' })).toBeInTheDocument();
    // Each figure is anchored inside the tile that labels it, so swapping the two buckets
    // (or their labels) fails.
    const pending = page.getByTestId('author-fees-pending-tile');
    const paid = page.getByTestId('author-fees-paid-tile');
    await expect.element(pending).toHaveTextContent(/^Pending payout/);
    await expect.element(pending.getByTestId('author-fees-pending-buzz')).toHaveTextContent(/^41$/);
    await expect
      .element(pending.getByTestId('author-fees-pending-count'))
      .toHaveTextContent(/^3 generations · Yellow 41$/);
    await expect.element(paid).toHaveTextContent(/^Paid to you/);
    await expect.element(paid.getByTestId('author-fees-paid-buzz')).toHaveTextContent(/^97$/);
    await expect
      .element(paid.getByTestId('author-fees-paid-count'))
      .toHaveTextContent(/^5 generations · Blue 7 · Yellow 90$/);
    await expect
      .element(page.getByTestId('author-fees-payout-copy'))
      .toHaveTextContent(/paid into your Buzz account once a day/);
    // A no-range read says plainly which period the paid figures cover.
    await expect
      .element(page.getByTestId('author-fees-window'))
      .toHaveTextContent(/^Last 90 days: paid fees and recent fees cover only that period\./);
    // Blue was paid, so the non-withdrawable caveat shows.
    await expect.element(page.getByTestId('author-fees-blue-caveat')).toBeInTheDocument();
  });

  test('the portfolio page lists each app and the recent fees with their status', async () => {
    mocks.revenue.current = { ...ZEROED, authorFees: FEES };
    renderWithProviders(<RevenuePanel />);

    await expect
      .element(page.getByTestId('author-fees-app-apb_big'))
      .toHaveTextContent(/^apb_big88 paid · 33 pending$/);
    await expect
      .element(page.getByTestId('author-fees-app-apb_small'))
      .toHaveTextContent(/^apb_small9 paid · 8 pending$/);

    const rows = page.getByTestId('author-fees-recent').getByRole('row').elements();
    expect(rows.map((r) => r.textContent)).toEqual([
      'DateAppFeeBuzz typeStatus',
      `${new Date('2026-11-11T10:00:00Z').toLocaleDateString()}apb_small8YellowPending payout`,
      `${new Date('2026-11-09T10:00:00Z').toLocaleDateString()}apb_big7BluePaid`,
    ]);
  });

  test('scoped to one app: no per-app list and no App column', async () => {
    mocks.revenue.current = { ...ZEROED, authorFees: FEES };
    renderWithProviders(<RevenuePanel appBlockId="apb_big" />);

    await expect.element(page.getByTestId('author-fees-recent')).toBeInTheDocument();
    expect(page.getByTestId('author-fees-by-app').elements()).toHaveLength(0);
    const header = page.getByTestId('author-fees-recent').getByRole('row').elements()[0];
    expect(header.textContent).toBe('DateFeeBuzz typeStatus');
  });

  test('no blue paid: no blue caveat', async () => {
    mocks.revenue.current = {
      ...ZEROED,
      authorFees: {
        ...FEES,
        settled: { count: 5, feeBuzz: 97, byBuzzType: { yellow: 97 } },
      },
    };
    renderWithProviders(<RevenuePanel />);

    await expect.element(page.getByTestId('author-fees-paid-buzz')).toHaveTextContent(/^97$/);
    expect(page.getByTestId('author-fees-blue-caveat').elements()).toHaveLength(0);
  });

  test('ABSENT authorFees key (older API process): says it could not load, not zero', async () => {
    const payload: Record<string, unknown> = { ...ZEROED };
    delete payload.authorFees;
    mocks.revenue.current = payload;
    renderWithProviders(<RevenuePanel />);

    await expect
      .element(page.getByTestId('author-fees-unavailable'))
      .toHaveTextContent(/not a report of zero earnings/);
    expect(page.getByTestId('author-fees-empty').elements()).toHaveLength(0);
    expect(page.getByTestId('author-fees-pending-buzz').elements()).toHaveLength(0);
    // The goods card still renders.
    await expect
      .element(page.getByRole('heading', { name: 'Digital goods sales' }))
      .toBeInTheDocument();
  });
});

describe('RevenuePanel — the card-purchase share is not shown', () => {
  test('even when the payload carries it (an older API process), none of it renders', async () => {
    // The share is recorded but never paid out, so author pages do not show it.
    mocks.revenue.current = {
      ...ZEROED,
      authorFees: FEES,
      summary: {
        pending: { count: 2, grossCents: 1234, shareCents: 864 },
        confirmed: { count: 3, grossCents: 4321, shareCents: 3025 },
        paidOut: { count: 1, grossCents: 999, shareCents: 699 },
        voided: { count: 1, grossCents: 555 },
      },
      topApps: [{ appBlockId: 'apb_top', shareCents: 3025, count: 3 }],
      recentAttributions: [
        {
          id: 'bba_1',
          attributedAt: '2026-11-01T00:00:00Z',
          scope: 'per_model_install',
          buzzAmount: 5000,
          usdAmountCents: 1000,
          appOwnerShareCents: 700,
          status: 'confirmed',
          voidedReason: null,
          appBlockId: 'apb_top',
        },
      ],
    };
    renderWithProviders(<RevenuePanel />);

    await expect.element(page.getByRole('heading', { name: 'Author fees' })).toBeInTheDocument();
    expect(cardShareOnScreen()).toEqual([]);
    for (const dollars of ['$8.64', '$30.25', '$6.99', '$7.00', '$10.00'])
      expect(page.getByText(dollars).elements(), dollars).toHaveLength(0);
  });
});
