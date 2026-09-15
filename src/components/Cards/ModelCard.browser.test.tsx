import { describe, expect, test, vi, beforeEach } from 'vitest';
// Type-only, so they are erased before the hoisted `vi.mock` factories run.
import type * as ModelCardContext from '~/components/Cards/ModelCardContext';
import type * as ModelCardUtils from '~/components/Cards/model-card.utils';
import type * as TrpcModule from '~/utils/trpc';

// =============================================================================
// ModelCard — feed review-indicator now reads batched membership, not the
// unbounded `user.getEngagedModels` endpoint (PR3 of the engaged-feed arc).
// =============================================================================
//
// What this test pins (the point of the migration):
//   * `ModelCardStats` derives its "reviewed" indicator from
//     `useEngagedModelMembership(id).isEngaged('Recommended')` — TRUE lights the
//     success-colored thumb (`data-reviewed="true"`), FALSE the neutral one.
//   * the legacy `trpc.user.getEngagedModels.useQuery` is NEVER called by the
//     card — a regression guard against reverting to the unbounded read that
//     drives the dp-prod event-loop-freeze.
//
// The card is a heavy feed leaf (~10 context/child deps). We render the REAL
// `ModelCardContent` + `ModelCardStats` and BOUNDARY-STUB the heavy children so
// the seam under test (membership -> hasReview -> ThumbsUpIcon) stays faithful.
// SHADOWED (not under test here): the image card, live-metric subscription, the
// context menu / remix / civitai-link affordances, the tip button.

// Shared mock state must be created inside `vi.hoisted` so the hoisted
// `vi.mock` factories can safely close over it (browser-mode mocker).
const mocks = vi.hoisted(() => {
  const state = { engaged: false };
  const membershipMock = vi.fn((_id: number) => ({
    isEngaged: (type: string) => (type === 'Recommended' ? state.engaged : false),
    types: state.engaged ? (['Recommended'] as const) : ([] as const),
    isLoading: false,
    isKnown: true,
  }));
  const getEngagedModelsUseQuery = vi.fn(() => ({ data: undefined }));
  return { state, membershipMock, getEngagedModelsUseQuery };
});

// --- controllable membership hook -------------------------------------------
vi.mock('~/hooks/useEngagedModelMembership', () => ({
  useEngagedModelMembership: (id: number) => mocks.membershipMock(id),
}));

// --- legacy endpoint spy (must never fire) ----------------------------------
// The `trpc` export is still replaced wholesale — that object IS the spy, and
// keeping it bare is what makes "the card touched no other endpoint" observable
// rather than merely unasserted. What changed is that the MODULE is spread, so
// its other exports (`trpcVanilla`, `setTrpcBatchingEnabled`, …) survive. A
// factory that omitted them handed `undefined` to every importer in this file's
// module graph — the failure mode `local-rules/no-wholesale-module-mock` exists
// to stop, which has silently disabled ~36 tests here before.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: { user: { getEngagedModels: { useQuery: mocks.getEngagedModelsUseQuery } } },
}));

// --- boundary stubs for heavy children --------------------------------------
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, isModerator: false }),
}));
vi.mock('~/components/CardTemplates/AspectRatioImageCard', () => ({
  // Only the footer subtree carries ModelCardStats; render header+footer inline.
  AspectRatioImageCard: ({ header, footer }: any) => (
    <div>
      <div>{header}</div>
      <div>{footer}</div>
    </div>
  ),
}));
vi.mock('~/components/Metrics', () => ({
  // Render children with the `initial` metrics synchronously (no live sub).
  Metrics: ({ children, initial }: any) => children(initial),
  AnimatedCount: ({ value }: any) => <>{value}</>,
}));
// Spreads the real module rather than listing its exports, and that is the whole
// point rather than tidiness. The hand-listed version of this mock supplied only
// `useModelCardContext`; when #4112 gave `ModelCard.tsx` a second import from
// here — `useModelSaleBadge` — the module the card linked against no longer had
// it, and the file died at IMPORT with "does not provide an export named
// 'useModelSaleBadge'". That reports as `Tests no tests`, not as a failure count,
// so the whole component tier went red with nothing naming a broken assertion.
// A spread cannot go stale the same way: a new export arrives on its own.
//
// The two sale hooks are then stubbed back out deliberately. Both route through
// `trpc.model.getActiveSales.useQuery`, and the `~/utils/trpc` mock above is a
// deliberately minimal spy that carries only `user.getEngagedModels` — so
// running the real hooks would reach an undefined namespace. Stubbing them keeps
// the spread from ever touching it. `undefined` is "no sale", the default state,
// and the sale badge is shadowed here rather than under test — except where a test
// sets `saleState.sale`, which is the only way the merged-discount branch renders at
// all. Read inside the factory rather than captured, so each test's value is the
// one the card sees.
const saleState = vi.hoisted(
  () =>
    ({ sale: undefined } as {
      sale: { discountType: 'Fixed' | 'Percent'; discountAmount: number } | undefined;
    })
);
const salesForFixture = () => (saleState.sale ? { 123: saleState.sale } : undefined);
vi.mock('~/components/Cards/ModelCardContext', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelCardContext>()),
  useModelCardContext: () => ({
    useModelVersionRedirect: false,
    activeBaseModels: undefined,
    salesByModelId: salesForFixture(),
    hasSaleProvider: !!saleState.sale,
  }),
  useModelSaleBadge: () => undefined,
  useModelSaleBadges: () => undefined,
}));
vi.mock('~/components/Cards/ModelCardContextMenu', () => ({ ModelCardContextMenu: () => null }));
vi.mock('~/components/Cards/components/RemixButton', () => ({ RemixButton: () => null }));
vi.mock('~/components/CivitaiLink/CivitaiLinkManageButton', () => ({
  CivitaiLinkManageButton: () => null,
}));
vi.mock('~/components/UserAvatar/UserAvatarSimple', () => ({ UserAvatarSimple: () => null }));
vi.mock('~/components/Model/ModelTypeBadge/ModelTypeBadge', () => ({ ModelTypeBadge: () => null }));
vi.mock('~/components/Buzz/InteractiveTipBuzzButton', () => ({
  InteractiveTipBuzzButton: ({ children }: any) => <>{children}</>,
  useBuzzTippingStore: () => 0,
}));
vi.mock('~/components/IntersectionObserver/ElementInView', () => ({
  useElementInView: () => true,
}));
// Spread, not a hand-listed factory. `getCardBaseModels` is stubbed because the fixture carries no
// baseModels; `getModelRecency` must stay REAL, because the New badge is what several tests below
// assert on. A hand-listed factory here is also what would have hidden this whole file: the card
// gained a second import from this module, and an omitted export dies at import as `Tests no tests`.
vi.mock('~/components/Cards/model-card.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelCardUtils>()),
  getCardBaseModels: () => [],
}));

import { MantineProvider } from '@mantine/core';
import type { MantineColorsTuple } from '@mantine/core';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { ModelCard } from '~/components/Cards/ModelCard';
// Value import, deliberately — this resolves to the MOCKED module (vi.mock is hoisted), and
// the beforeEach below asserts the mock is wired the way the factory intends.
import { trpc } from '~/utils/trpc';

// Minimal fixture — only the fields ModelCardContent/ModelCardStats read.
// thumbsUpCount>0 + locked:false is the gate that renders the review badge.
function makeData(): any {
  return {
    id: 123,
    name: 'Test Model',
    poi: false,
    minor: false,
    nsfw: false,
    locked: false,
    availability: 'Public',
    mode: null,
    type: 'Checkpoint',
    publishedAt: null,
    lastVersionAt: null,
    earlyAccessDeadline: null,
    cosmetic: null,
    hashes: [],
    canGenerate: false,
    images: [{}],
    user: { id: 99, username: 'creator' },
    version: { id: 456, baseModel: 'SD 1.5', trainingStatus: null },
    rank: {
      downloadCount: 0,
      collectedCount: 0,
      commentCount: 0,
      tippedAmountCount: 0,
      thumbsUpCount: 5,
      thumbsDownCount: 1,
    },
  };
}

async function reviewedAttr(): Promise<string | null> {
  let el: Element | null = null;
  await vi.waitFor(() => {
    el = document.querySelector('[data-reviewed]');
    expect(el).toBeTruthy();
  });
  return (el as unknown as Element).getAttribute('data-reviewed');
}

describe('ModelCard review indicator (batched membership)', () => {
  beforeEach(() => {
    mocks.state.engaged = false;
    mocks.membershipMock.mockClear();
    mocks.getEngagedModelsUseQuery.mockClear();

    // 🔴 The `trpc:` override MUST come after the `importOriginal` spread in the factory
    // above, and nothing else enforces that. `local-rules/no-wholesale-module-mock` requires
    // that *a* top-level spread exists, not that it comes first — so a merge, a formatter or
    // a key-sort can silently reverse the two and hand every importer the REAL client.
    //
    // Measured: with the order reversed this file still reports 2 passed while the spy below
    // is dead. The `not.toHaveBeenCalled()` guard — the one assertion this spec exists for —
    // then never executes, and if production does regress it fails on an unrelated
    // "Unable to find tRPC Context" after two 10s waitFor timeouts, naming neither the spy
    // nor the endpoint. A vacuous guard that still reports success is worse than no guard,
    // so assert the wiring itself rather than trusting the key order to survive.
    // Cast, narrowly and deliberately: `user.getEngagedModels` is the LEGACY endpoint this
    // spec exists to prove is never called, and it no longer exists on the real router's
    // types (it is `getEngagedModelsByIds` now). The value import is typed against the REAL
    // module while the runtime value is the mock, so the property is absent at type level and
    // present at run time. Casting here is narrower than widening the mock's shape.
    const spiedUseQuery = (trpc.user as unknown as { getEngagedModels: { useQuery: unknown } })
      .getEngagedModels.useQuery;
    expect(spiedUseQuery).toBe(mocks.getEngagedModelsUseQuery);
  });

  test('renders the reviewed indicator when the model is Recommended by the user', async () => {
    mocks.state.engaged = true;
    renderWithProviders(<ModelCard data={makeData()} />);
    expect(await reviewedAttr()).toBe('true');
    // reads membership for THIS model id, never the unbounded endpoint
    expect(mocks.membershipMock).toHaveBeenCalledWith(123);
    expect(mocks.getEngagedModelsUseQuery).not.toHaveBeenCalled();
  });

  test('does NOT mark reviewed when the model is not Recommended', async () => {
    mocks.state.engaged = false;
    renderWithProviders(<ModelCard data={makeData()} />);
    expect(await reviewedAttr()).toBe('false');
    expect(mocks.getEngagedModelsUseQuery).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Paid-gate badge. `hasActivePaidAccess` is ANY live gate — permanent, or timed
// with an end date that was never materialized. Both reach the card as
// `deadline: null`, which is why the card cannot tell them apart and why the
// distinction is pinned in the SQL guard rather than here.
//
// The two WORDS are deliberately not interchangeable: an Early Access window
// ENDS and the model becomes free (`process-ending-early-access` does it), a
// gate with no end date never does. If you are here to collapse these into one
// label, that is why.
// =============================================================================

// Bare `MantineProvider` carries no `success` scale, and supplying it here keeps the fix local —
// widening the shared harness theme would change layout under every component test in the repo.
// Distinct hexes per family on purpose: the colour assertions below read green (access) and blue
// (recency), and a shared value would make a drift between them invisible.
const scale = (hex: string) =>
  Array.from({ length: 10 }, () => hex) as unknown as MantineColorsTuple;
function WithPalette({ children }: { children: React.ReactNode }) {
  return (
    <MantineProvider
      theme={{
        colors: {
          success: scale('#12b886'),
          teal: scale('#0ca678'),
          blue: scale('#228be6'),
          green: scale('#37b24d'),
        },
      }}
    >
      {children}
    </MantineProvider>
  );
}

// Two slots now, not one. They are queried separately on purpose: the bug this file failed to catch
// was a New badge that computed correctly and then lost a ternary to the money badge, which is
// invisible to any assertion that reads "the status badge" as a singular thing.
const recencyBadge = () => document.querySelector('[data-status-badge="recency"]');
const accessBadge = () => document.querySelector('[data-status-badge="access"]');

async function awaitBadge(which: 'recency' | 'access'): Promise<Element> {
  let el: Element | null = null;
  await vi.waitFor(() => {
    el = which === 'recency' ? recencyBadge() : accessBadge();
    expect(el, `no ${which} status badge rendered`).toBeTruthy();
  });
  return el as unknown as Element;
}

// The card renders nothing else asynchronously that these tests wait on, so a negative assertion
// needs something already-settled to hang off or it passes before the card has painted at all.
async function cardPainted() {
  await vi.waitFor(() => {
    expect(document.querySelector('[data-reviewed]')).toBeTruthy();
  });
}

// A publish time the shared fixture deliberately lacks. `makeData()` sets `publishedAt: null`, and
// that single line is what hid this bug for six days: isNew was false in every test in this file, so
// no assertion here could ever see New compete with the money badge.
const justPublished = () => new Date(Date.now() - 60 * 1000);

describe('ModelCard paid-gate badge', () => {
  test('renders a lock-dollar for a permanent gate, not the word "Paid"', async () => {
    renderWithProviders(
      <WithPalette>
        <ModelCard data={{ ...makeData(), hasActivePaidAccess: true, earlyAccessDeadline: null }} />
      </WithPalette>
    );
    const el = await awaitBadge('access');
    // The icon replaced the word so the badge is narrow enough to sit beside New. Asserting the
    // absence of the text as well as the presence of the icon is what makes a revert to the word
    // visible here rather than only in a screenshot.
    expect(el.textContent).toBe('');
    // Exactly one icon: `querySelector` takes the FIRST match, so every assertion below would stay
    // green if a second glyph were added beside it.
    expect(el.querySelectorAll('svg'), 'the access badge renders more than one icon').toHaveLength(
      1
    );
    const icon = el.querySelector('svg');
    expect(icon, 'no icon rendered in the access badge').toBeTruthy();

    // The FULL tabler name. A substring like `lock` matches IconLock, IconLockOff, IconLockOpen and
    // a dozen others — IconLockOff on a paid badge reads as "NOT paid", which is the mutation that
    // matters.
    expect(icon!.getAttribute('class') ?? '').toContain('tabler-icon-lock-dollar');

    // `IconLockDollar` is an OUTLINE icon, so tabler emits `stroke={color}` and `fill="none"`.
    // Reading stroke catches `color` being dropped; the chip's white comes from Mantine CSS the
    // harness never loads, so nothing else would.
    expect(icon!.getAttribute('stroke')).toBe('white');

    expect(el.innerHTML).not.toContain('bolt');
    expect(el.innerHTML).not.toContain('diamond');
  });

  test('the access badge carries an accessible name, not merely an aria-label attribute', async () => {
    renderWithProviders(
      <WithPalette>
        <ModelCard data={{ ...makeData(), hasActivePaidAccess: true, earlyAccessDeadline: null }} />
      </WithPalette>
    );
    await awaitBadge('access');
    // Resolved BY ROLE AND NAME rather than by reading two attributes: `getAttribute('aria-label')`
    // passes with no role at all, and ARIA drops an accessible name from a role-less generic, which
    // is exactly what Mantine's Badge root is on its own. This query is the tree's own answer.
    // Fast structural check FIRST, so a revert fails in milliseconds with a named cause. The role
    // query below is the one that actually proves the name resolves, but it is a polling locator:
    // on a missing role it can only fail by exhausting the 15s budget, which is a slow, mute way to
    // learn something this line says immediately.
    expect(
      document.querySelector('[data-status-badge="access"]')!.tagName,
      'the access badge is no longer a link, so it has neither a role nor a click'
    ).toBe('A');
    await expect.element(page.getByRole('link', { name: 'Paid' })).toBeInTheDocument();
  });

  test('the access badge is explained on hover — the only thing naming it for a sighted user', async () => {
    renderWithProviders(
      <WithPalette>
        <ModelCard data={{ ...makeData(), hasActivePaidAccess: true, earlyAccessDeadline: null }} />
      </WithPalette>
    );
    const el = await awaitBadge('access');
    await userEvent.hover(el);
    // Resolved through the badge's own `aria-describedby`, which Mantine sets only while the
    // tooltip is open. `getByText('Paid')` matches text that is on the page before any hover, so
    // it passed whether or not the tooltip ever opened.
    await expect
      .poll(
        () => {
          const id = el.getAttribute('aria-describedby');
          return id ? document.getElementById(id)?.textContent : undefined;
        },
        { message: 'hovering the badge opened no tooltip' }
      )
      .toBe('Paid');
  });

  test('a discount merged into the gate chip is spoken, not only drawn', async () => {
    saleState.sale = { discountType: 'Percent', discountAmount: 20 };
    try {
      renderWithProviders(
        <WithPalette>
          <ModelCard
            data={{ ...makeData(), hasActivePaidAccess: true, earlyAccessDeadline: null }}
          />
        </WithPalette>
      );
      const el = await awaitBadge('access');
      // `aria-label` overrides the subtree, so the drawn percentage reaches no screen reader — the
      // rendered text reaches no screen reader and the accessible name is the only carrier. The
      // standalone sale chip is suppressed on a gated card, so without this the percentage is
      // nowhere in the accessibility tree at all.
      expect(el.textContent).toContain('20% off');
      expect(el.getAttribute('aria-label')).toBe('Paid, 20% off');
    } finally {
      saleState.sale = undefined;
    }
  });

  test('a FIXED discount is spoken with its unit, not as a percentage', async () => {
    saleState.sale = { discountType: 'Fixed', discountAmount: 5000 };
    try {
      renderWithProviders(
        <WithPalette>
          <ModelCard
            data={{ ...makeData(), hasActivePaidAccess: true, earlyAccessDeadline: null }}
          />
        </WithPalette>
      );
      const el = await awaitBadge('access');
      // The `Percent` arm alone cannot test this: there the drawn and spoken forms are the same
      // string, so a name built by reusing the rendered text passes. Here they must differ — the
      // drawn form puts a Buzz icon beside the number, and a name that says "5000% off" on a
      // fixed-price sale is a false price on a money surface.
      expect(el.textContent).toContain('5,000 off');
      expect(el.getAttribute('aria-label')).toBe('Paid, 5,000 Buzz off');
    } finally {
      saleState.sale = undefined;
    }
  });

  test('the access badge explains itself to a keyboard, not only to a mouse', async () => {
    renderWithProviders(
      <WithPalette>
        <ModelCard data={{ ...makeData(), hasActivePaidAccess: true, earlyAccessDeadline: null }} />
      </WithPalette>
    );
    const el = (await awaitBadge('access')) as HTMLElement;
    // A glyph with no text has one explanation, and a pointer-only one leaves keyboard and touch
    // users with nothing. `Tooltip` takes `events`; `HoverCard` has no such option at all. `focus: true` also needs something focusable — the anchor supplies that
    // natively, where a `tabIndex` on a `div` would have bought a tab stop that does nothing.
    expect(
      el.tagName,
      'the access badge is not an anchor, so nothing focuses it and `focus: true` cannot fire'
    ).toBe('A');
    // The pointer is parked over this badge by the hover test above — same element, same position,
    // and the virtual mouse does not reset between tests. Left there, the tooltip is already open
    // via `hover`, and this test passes with `events` deleted.
    await userEvent.unhover(el);
    el.focus();
    // Resolved as the TOOLTIP ELEMENT, not as page text. `getByText('Paid')` and
    // `document.body.textContent` both match something else already on the page — measured: the
    // text is present before the badge is ever focused — so either would pass with `events`
    // deleted, which is the one mutation this test exists to catch.
    // Polled, not read synchronously: Mantine opens on focus a tick later, so a synchronous read
    // is a coin flip — it failed on a rerun of the unmutated code. `expect.poll`'s 1s budget keeps
    // the `events`-deleted failure fast rather than letting it run out a 15s matcher naming nothing.
    await expect
      .poll(
        () => {
          // Resolved THROUGH THE BADGE's own `aria-describedby`, which Mantine's `useRole` sets
          // only while the tooltip is open. A document-wide `[class*="Tooltip-tooltip"]` query
          // matched some other tooltip on the card and passed with `events` deleted; so did
          // `getByText('Paid')` and `document.body.textContent`, both of which match text that is
          // on the page before the badge is ever focused.
          const id = el.getAttribute('aria-describedby');
          return id ? document.getElementById(id)?.textContent : undefined;
        },
        { message: 'focusing the badge opened no tooltip — `events.focus` is off' }
      )
      .toBe('Paid');
  });

  test('the icon-only access chip is a circle, not a narrow oval', async () => {
    renderWithProviders(
      <WithPalette>
        <ModelCard data={{ ...makeData(), hasActivePaidAccess: true, earlyAccessDeadline: null }} />
      </WithPalette>
    );
    const el = (await awaitBadge('access')) as HTMLElement;
    // `.chip` fixes the height at 26px while Mantine's `circle` sizes the WIDTH from the badge
    // size, so the pair alone gives an oval. Both axes are pinned inline, which is why this is
    // readable in a harness that loads no stylesheet.
    expect(el.getAttribute('data-circle')).toBe('true');
    expect(el.style.width).toBe('26px');
    expect(el.style.height).toBe('26px');
    expect(el.style.padding).toBe('0px');
  });

  test('renders a clock-dollar for an active timed window, not the words', async () => {
    const deadline = new Date(Date.now() + 60 * 60 * 1000);
    renderWithProviders(
      <WithPalette>
        <ModelCard
          data={{ ...makeData(), earlyAccessDeadline: deadline, hasActivePaidAccess: false }}
        />
      </WithPalette>
    );
    const el = await awaitBadge('access');
    expect(el.textContent).toBe('');
    expect(el.querySelector('svg')!.getAttribute('class') ?? '').toContain(
      'tabler-icon-clock-dollar'
    );
    // Same accessible-name contract as the paid chip: an abstract glyph names itself or it names
    // nothing, and `getAttribute('aria-label')` alone would pass with no role at all.
    expect(el.tagName).toBe('A');
    await expect.element(page.getByRole('link', { name: 'Early Access' })).toBeInTheDocument();
  });

  test('a model carrying BOTH gates reads Early Access — the window is the fact with a clock on it', async () => {
    const deadline = new Date(Date.now() + 60 * 60 * 1000);
    renderWithProviders(
      <WithPalette>
        <ModelCard
          data={{ ...makeData(), earlyAccessDeadline: deadline, hasActivePaidAccess: true }}
        />
      </WithPalette>
    );
    expect((await awaitBadge('access')).getAttribute('aria-label')).toBe('Early Access');
  });

  test('an EXPIRED timed window renders no paid marker — the client re-checks the deadline against now', async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000);
    renderWithProviders(
      <WithPalette>
        <ModelCard
          data={{ ...makeData(), earlyAccessDeadline: past, hasActivePaidAccess: false }}
        />
      </WithPalette>
    );
    await cardPainted();
    expect(accessBadge()).toBeNull();
    // Nothing in the fixture sets New/Updated either, so neither slot is filled.
    expect(recencyBadge()).toBeNull();
  });

  test('the Paid badge is green, not the teal it shared with Updated', async () => {
    renderWithProviders(
      <WithPalette>
        <ModelCard data={{ ...makeData(), earlyAccessDeadline: null, hasActivePaidAccess: true }} />
      </WithPalette>
    );
    const el = (await awaitBadge('access')) as HTMLElement;
    expect(el.style.backgroundColor).toBe('rgb(55, 178, 77)');
  });

  test('an ungated model renders no status badge at all', async () => {
    renderWithProviders(
      <WithPalette>
        <ModelCard
          data={{ ...makeData(), earlyAccessDeadline: null, hasActivePaidAccess: false }}
        />
      </WithPalette>
    );
    await cardPainted();
    expect(accessBadge()).toBeNull();
    expect(recencyBadge()).toBeNull();
  });
});

// =============================================================================
// The reported bug: alexds9's models were both new AND paid-gated, and the New
// badge vanished. It was never wrong in the data — `isNew` was true — it lost a
// ternary to `isPaidAccess` in a single shared slot (#4678).
//
// These assertions are the ones that redden on a revert of that split. Verified
// by reverting it, not by adding them and watching them pass.
// =============================================================================
describe('ModelCard New badge coexists with the money badge', () => {
  test('a model that is BOTH new and paid-gated renders BOTH badges', async () => {
    renderWithProviders(
      <WithPalette>
        <ModelCard
          data={{
            ...makeData(),
            publishedAt: justPublished(),
            hasActivePaidAccess: true,
            earlyAccessDeadline: null,
          }}
        />
      </WithPalette>
    );
    const recency = await awaitBadge('recency');
    const access = await awaitBadge('access');
    expect(recency.textContent).toBe('New');
    expect(access.getAttribute('aria-label')).toBe('Paid');
    // Exactly one of each. `querySelector` takes the first match, so a merge that duplicated either
    // block would satisfy every other assertion in this file.
    expect(document.querySelectorAll('[data-status-badge="recency"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-status-badge="access"]')).toHaveLength(1);
  });

  test('a model that is BOTH new and in early access renders BOTH badges', async () => {
    renderWithProviders(
      <WithPalette>
        <ModelCard
          data={{
            ...makeData(),
            publishedAt: justPublished(),
            hasActivePaidAccess: false,
            earlyAccessDeadline: new Date(Date.now() + 60 * 60 * 1000),
          }}
        />
      </WithPalette>
    );
    expect((await awaitBadge('recency')).textContent).toBe('New');
    const access = await awaitBadge('access');
    expect(access.getAttribute('aria-label')).toBe('Early Access');
    // Both arms are icon-only, so both need the element that exposes the name AND restores the
    // click the header's `pointer-events: none` used to give them for free.
    expect(access.tagName).toBe('A');
  });

  test('a new UNGATED model renders the New badge and no money badge', async () => {
    // The populated control for the two tests above: it proves they are reading a real New badge
    // rather than a card that renders a recency chip no matter what.
    renderWithProviders(
      <WithPalette>
        <ModelCard
          data={{
            ...makeData(),
            publishedAt: justPublished(),
            hasActivePaidAccess: false,
            earlyAccessDeadline: null,
          }}
        />
      </WithPalette>
    );
    expect((await awaitBadge('recency')).textContent).toBe('New');
    expect(accessBadge()).toBeNull();
  });

  test('the New badge keeps the blue treatment, not the money badge green', async () => {
    renderWithProviders(
      <WithPalette>
        <ModelCard
          data={{
            ...makeData(),
            publishedAt: justPublished(),
            hasActivePaidAccess: true,
            earlyAccessDeadline: null,
          }}
        />
      </WithPalette>
    );
    const recency = (await awaitBadge('recency')) as HTMLElement;
    // Distinct from the access chip's green: sharing a colour would let a card that rendered the
    // money chip twice satisfy every assertion above.
    expect(recency.style.backgroundColor).toBe('rgb(34, 139, 230)');
  });

  test('an Updated model that is also paid-gated renders "Updated" beside the money badge', async () => {
    const publishedAt = new Date(Date.now() - 20 * 60 * 60 * 1000);
    renderWithProviders(
      <WithPalette>
        <ModelCard
          data={{
            ...makeData(),
            publishedAt,
            lastVersionAt: new Date(publishedAt.getTime() + 3 * 60 * 60 * 1000),
            hasActivePaidAccess: true,
            earlyAccessDeadline: null,
          }}
        />
      </WithPalette>
    );
    const recency = (await awaitBadge('recency')) as HTMLElement;
    expect(recency.textContent).toBe('Updated');
    // Updated wears the same blue as New — one colour for one kind of fact.
    expect(recency.style.backgroundColor).toBe('rgb(34, 139, 230)');
    expect((await awaitBadge('access')).getAttribute('aria-label')).toBe('Paid');
  });
});
