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
// and the sale badge is shadowed here rather than under test.
vi.mock('~/components/Cards/ModelCardContext', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelCardContext>()),
  useModelCardContext: () => ({ useModelVersionRedirect: false, activeBaseModels: undefined }),
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

// The harness mounts a bare `MantineProvider`, whose default palette has no `success` scale — and
// `statusBadgeStyle` indexes `theme.colors.success[5]`. No existing test in this file renders the
// status badge, so the card threw "Cannot read properties of undefined (reading '5')" the first time
// one did. Supplying the scale here keeps the fix local to the tests that need it; widening the
// shared harness theme would change layout under every component test in the repo.
// Distinct hexes on purpose: success and teal sharing one value would make a success->teal
// regression in statusBadgeStyle invisible to the colour assertion below.
const scale = (hex: string) =>
  Array.from({ length: 10 }, () => hex) as unknown as MantineColorsTuple;
function WithPalette({ children }: { children: React.ReactNode }) {
  return (
    <MantineProvider
      theme={{
        colors: { success: scale('#12b886'), teal: scale('#0ca678'), blue: scale('#228be6') },
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
  test('renders a Buzz bolt for a permanent gate, not the word "Paid"', async () => {
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
    // `querySelector('svg')` alone is satisfied by ANY icon, under a title that names the bolt.
    // Tabler stamps its own class, so this reddens on a swap to a different glyph.
    const icon = el.querySelector('svg');
    expect(icon, 'no icon rendered in the access badge').toBeTruthy();
    expect(icon!.getAttribute('class') ?? '').toContain('bolt');
  });

  test('the bolt carries an accessible name, not merely an aria-label attribute', async () => {
    renderWithProviders(
      <WithPalette>
        <ModelCard data={{ ...makeData(), hasActivePaidAccess: true, earlyAccessDeadline: null }} />
      </WithPalette>
    );
    await awaitBadge('access');
    // Resolved BY ROLE AND NAME rather than by reading two attributes: `getAttribute('aria-label')`
    // passes with no role at all, and ARIA drops an accessible name from a role-less generic, which
    // is exactly what Mantine's Badge root is. This query is the accessibility tree's own answer.
    // Fast structural check FIRST, so a revert fails in milliseconds with a named cause. The role
    // query below is the one that actually proves the name resolves, but it is a polling locator:
    // on a missing role it can only fail by exhausting the 15s budget, which is a slow, mute way to
    // learn something this line says immediately.
    expect(
      document.querySelector('[data-status-badge="access"]')!.getAttribute('role'),
      'the access badge lost its role, so its aria-label reaches no screen reader'
    ).toBe('img');
    await expect.element(page.getByRole('img', { name: 'Paid' })).toBeInTheDocument();
  });

  test('the bolt is explained on hover — it is the only thing that names it for a sighted user', async () => {
    renderWithProviders(
      <WithPalette>
        <ModelCard data={{ ...makeData(), hasActivePaidAccess: true, earlyAccessDeadline: null }} />
      </WithPalette>
    );
    const el = await awaitBadge('access');
    // Deleting the Tooltip wrapper leaves every other assertion in this file green, which is why
    // this exists. It has to hover: Mantine wires `aria-describedby` only once the tooltip opens.
    // Awaiting an ARRIVING state, never a leaving one — the tooltip stays open while the pointer
    // rests on the badge, so the matcher cannot lose a race against it.
    await userEvent.hover(el);
    let described: Element | null = null;
    await vi.waitFor(() => {
      const id = el.getAttribute('aria-describedby');
      expect(id, 'no tooltip opened on the icon-only badge').toBeTruthy();
      described = document.getElementById(id!);
      expect(described, 'aria-describedby points at no element').toBeTruthy();
    });
    // Reading the element the badge actually points at, rather than scanning the document for the
    // word: a match anywhere in `body` would also be satisfied by the word appearing in some other
    // chip entirely.
    expect((described as unknown as Element).textContent).toBe('Paid');
  });

  test('renders "Early Access" as text for an active timed window', async () => {
    const deadline = new Date(Date.now() + 60 * 60 * 1000);
    renderWithProviders(
      <WithPalette>
        <ModelCard
          data={{ ...makeData(), earlyAccessDeadline: deadline, hasActivePaidAccess: false }}
        />
      </WithPalette>
    );
    expect((await awaitBadge('access')).textContent).toBe('Early Access');
  });

  test('a model carrying BOTH gates reads "Early Access" — the window is the fact with a clock on it', async () => {
    const deadline = new Date(Date.now() + 60 * 60 * 1000);
    renderWithProviders(
      <WithPalette>
        <ModelCard
          data={{ ...makeData(), earlyAccessDeadline: deadline, hasActivePaidAccess: true }}
        />
      </WithPalette>
    );
    expect((await awaitBadge('access')).textContent).toBe('Early Access');
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

  test('the Paid badge uses the Early Access colour, not the New/Updated one', async () => {
    renderWithProviders(
      <WithPalette>
        <ModelCard data={{ ...makeData(), earlyAccessDeadline: null, hasActivePaidAccess: true }} />
      </WithPalette>
    );
    const el = (await awaitBadge('access')) as HTMLElement;
    // Reusing the Early Access treatment is the community ask #4678 answered, and it lives in an
    // inline style rather than a class, so it survives the harness having no stylesheet.
    expect(el.style.backgroundColor).toBe('rgb(18, 184, 134)');
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
    expect(access.textContent).toBe('Early Access');
    // The text arm carries its own name, so it neither needs nor gets the icon arm's role.
    expect(access.getAttribute('role')).toBeNull();
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
    // Distinct from success (#12b886) in the harness palette on purpose: if the two badges shared a
    // colour, a card that rendered the money chip twice would satisfy every assertion above.
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
    expect((await awaitBadge('recency')).textContent).toBe('Updated');
    expect((await awaitBadge('access')).getAttribute('aria-label')).toBe('Paid');
  });
});
