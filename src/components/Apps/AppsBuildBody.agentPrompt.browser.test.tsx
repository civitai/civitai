import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only namespace import (NOT `typeof import('...')`, which
// @typescript-eslint/consistent-type-imports rejects) so the spread below keeps the real
// module's type.
import type * as TrpcMod from '~/utils/trpc';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * The agent-onboarding card's PLACEMENT across `/apps/build`'s three states, and its funnel
 * event.
 *
 * The card itself is pinned by `AgentOnboardingCard.browser.test.tsx` (the prompt bytes, the
 * copy control, the motion/static split). This file is about the three mounts and the one
 * thing only `AppsBuildBody` can be asked: that the copy posts `agent_prompt_copy` with the
 * state the viewer was actually in, exactly once, and never from under the skeleton.
 *
 * 🔴 THE WORKBENCH CLAIM IS "INSIDE THE COLLAPSE", NOT "ABSENT". Mantine's `Collapse` keeps
 * its children MOUNTED at zero height, so a `toHaveLength(0)` assertion on the workbench
 * would be false and a `not.toBeVisible()` one alone would not say WHERE the card is. The
 * structural claim is containment — `closest('[data-testid="apps-build-resources"]')` — plus
 * the visibility transition across the toggle. That is what pins the deliberate DEMOTION
 * rather than merely the absence from the main flow.
 *
 * The mock shapes follow `AppsBuildBody.browser.test.tsx`, including its `enabled`-honouring
 * `getNavSummary` — see that file's header for why that is load-bearing rather than fidelity
 * for its own sake.
 */

/** A summary for an author who HAS apps — the workbench. */
const SUMMARY_WITH_APPS = {
  hasInstalls: false,
  hasActivity: false,
  hasSubmissions: false,
  hasApprovedApps: false,
  isReviewer: false,
  hasEditableApps: true,
  hasPendingInvites: false,
};
/** The all-false summary — an author with nothing yet (state B). */
const EMPTY_SUMMARY = { ...SUMMARY_WITH_APPS, hasEditableApps: false };

type TrackedAction = { type: string; details: { action: string; state: string } };

const mocks = vi.hoisted(() => ({
  isClient: true,
  isFetched: false,
  navSummary: undefined as undefined | Record<string, boolean>,
  flags: { appBlocks: true, appBlocksAuthor: true } as Record<string, boolean>,
  user: { id: 7, username: 'author', isModerator: false } as null | {
    id: number;
    username: string;
    isModerator?: boolean;
  },
  tracked: [] as TrackedAction[],
}));

vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => mocks.isClient }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => mocks.flags }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.user }));

vi.mock('~/components/TrackView/track.utils', () => ({
  useTrackEvent: () => ({
    trackAction: (payload: TrackedAction) => {
      mocks.tracked.push(payload);
      return Promise.resolve();
    },
  }),
}));

// Spread the REAL module and override only `trpc` (local-rules/no-wholesale-module-mock), and
// build that override as a PROXY rather than a hand-enumerated literal — `test/trpcProxyStub`
// records the four measured times the literal form cost this repo, and the only thing named
// here is what this suite measures. The inert defaults are never asserted through.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({
    // Honours `enabled`, which is load-bearing — see `AppsBuildBody.browser.test.tsx`'s header.
    'blocks.getNavSummary': {
      useQuery: (_input: unknown, opts?: { enabled?: boolean }) => {
        if (opts?.enabled === false) return { data: undefined, isFetched: false };
        return { data: mocks.navSummary, isFetched: mocks.isFetched };
      },
    },
    // `MyAppsBody` — mounted by the workbench state. Held in its loading branch; this suite
    // is about WHERE the card renders, not about the table's contents.
    'appListings.listMine': {
      useQuery: () => ({ data: undefined, isLoading: true, error: null }),
    },
    'appListings.listMyOrphanedSubmissions': {
      useQuery: () => ({ data: undefined, isLoading: true, error: null }),
    },
  }),
}));

const { AppsBuildBody } = await import('./AppsBuildBody');
const { AGENT_COPY_LABEL, AGENT_ONBOARDING_TESTID, AGENT_PROMPT_TESTID } = await import(
  './AgentOnboardingCard'
);
const { AGENT_BUILD_PROMPT } = await import('./cliCommands');

const PITCH = 'apps-build-pitch';
const FIRST_APP = 'apps-build-first-app';
const WORKBENCH_CTA = 'apps-build-new-app';
const RESOURCES = 'apps-build-resources';
const RESOURCES_TOGGLE = 'apps-build-resources-toggle';
const SKELETON = 'apps-build-skeleton';
const CREATE_FIRST = 'apps-build-create-first';
// Literal on purpose, like the handles above: importing them from `ManualSetupCollapse`
// would let a rename pass unnoticed.
const MANUAL_TOGGLE = 'apps-manual-setup-toggle';
const MANUAL_REGION = 'apps-manual-setup';
const NPM_INSTALL = 'npm install -g @civitai/cli';

/**
 * 🔴 RENDER BARRIER — required before every "renders nothing" assertion. `render()` commits
 * through a React 18 concurrent root on a LATER task, so a synchronous absence assertion
 * right after `renderWithProviders` reads an EMPTY container and passes whatever the
 * component does. Same reasoning as `AppsBuildBody.browser.test.tsx`.
 */
const RENDER_BARRIER = 'render-barrier';

async function renderBody() {
  // 🔴 AWAITED, NOT FIRE-AND-FORGET, AND THAT IS WHAT MAKES THE STATIC CLAIMS BELOW REAL.
  // `vitest-browser-react`'s `render` is `async` and wraps the root render in
  // `await act(async () => …)`, which drains the effect `useReducedMotion` uses to commit the
  // real media value. Without it, `motionOn` is false in the FIRST commit of an animated card
  // too, so `data-motion="off"` is the default state rather than evidence of anything — the
  // workbench-static test below would pass on a card that animates. The render barrier is a
  // different guard, for a different hazard (an absence assertion reading an empty container),
  // and both are needed.
  await renderWithProviders(
    <>
      <div data-testid={RENDER_BARRIER} />
      <AppsBuildBody />
    </>
  );
  await expect.element(page.getByTestId(RENDER_BARRIER)).toBeInTheDocument();
}

const seen = (testId: string) => page.getByTestId(testId).elements().length;

/**
 * The heading elements INSIDE one card, by tag name — the observable the card's `tone`
 * decides. Reads tag names rather than `role`, because the question is what lands in the
 * document outline and `<Title order={3}>` renders a literal `h3`.
 */
const headingsIn = (el: Element): string[] =>
  Array.from(el.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((h) => h.tagName);

const writeText = () => vi.mocked(navigator.clipboard.writeText);

/** True when `b` comes after `a` in document order. */
const follows = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeEach(() => {
  mocks.isClient = true;
  mocks.isFetched = false;
  mocks.navSummary = undefined;
  mocks.flags = { appBlocks: true, appBlocksAuthor: true };
  mocks.user = { id: 7, username: 'author', isModerator: false };
  mocks.tracked = [];
  writeText().mockClear();
});

describe('the agent card renders in ALL THREE states', () => {
  test('A · pitch — the card is present, inside the pitch body', async () => {
    mocks.flags = { appBlocks: true, appBlocksAuthor: false };
    await renderBody();

    await expect.element(page.getByTestId(PITCH)).toBeInTheDocument();
    const card = page.getByTestId(AGENT_ONBOARDING_TESTID);
    await expect.element(card).toBeInTheDocument();
    await expect.element(card).toBeVisible();
    // Mounted by `GetStartedBody`, which is the pitch body — so it must be INSIDE it, not a
    // sibling bolted on beside the invite-only alert.
    expect(card.element().closest(`[data-testid="${PITCH}"]`)).not.toBeNull();
  });

  test('🔴 B · first-app — the card leads, open, ahead of the manual commands', async () => {
    mocks.isFetched = true;
    mocks.navSummary = { ...EMPTY_SUMMARY };
    await renderBody();

    await expect.element(page.getByTestId(FIRST_APP)).toBeInTheDocument();
    const card = page.getByTestId(AGENT_ONBOARDING_TESTID);
    await expect.element(card).toBeVisible();
    expect(card.element().closest(`[data-testid="${FIRST_APP}"]`)).not.toBeNull();
    // The card itself is never behind a toggle in this state: not the workbench strip (which
    // state B does not have) and not the manual-setup collapse.
    expect(seen(RESOURCES)).toBe(0);
    expect(card.element().closest(`[data-testid="${MANUAL_REGION}"]`)).toBeNull();

    // Collapsed children stay mounted, so the command text is in the DOM while closed.
    const install = page.getByText(`$ ${NPM_INSTALL}`);
    await expect.element(install).toBeInTheDocument();
    expect(follows(card.element(), install.element()), 'the card must precede the commands').toBe(
      true
    );
  });

  test('🔴 B · the manual setup is CLOSED by default and the toggle opens it', async () => {
    mocks.isFetched = true;
    mocks.navSummary = { ...EMPTY_SUMMARY };
    await renderBody();

    const toggle = page.getByTestId(MANUAL_TOGGLE);
    const region = page.getByTestId(MANUAL_REGION);
    await expect.element(toggle).toHaveAttribute('aria-expanded', 'false');
    // On the collapse region, not the commands: see the workbench test below for why.
    await expect.element(region).not.toBeVisible();

    await toggle.click();
    await expect.element(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect.element(region).toBeVisible();
    await expect.element(page.getByText(`$ ${NPM_INSTALL}`)).toBeVisible();
  });

  test.for([
    { label: 'B · manual setup', toggle: MANUAL_TOGGLE, region: MANUAL_REGION, arrange: 'B' },
    { label: 'C · developer resources', toggle: RESOURCES_TOGGLE, region: RESOURCES, arrange: 'C' },
  ] as const)(
    '$label: the toggle names the region it controls',
    async ({ toggle, region, arrange }) => {
      mocks.isFetched = true;
      mocks.navSummary = arrange === 'B' ? { ...EMPTY_SUMMARY } : { ...SUMMARY_WITH_APPS };
      await renderBody();

      await expect.element(page.getByTestId(toggle)).toBeInTheDocument();
      const controls = page.getByTestId(toggle).element().getAttribute('aria-controls');
      expect(controls).toBeTruthy();
      expect(page.getByTestId(region).element().id).toBe(controls);
    }
  );

  test('B · "Create your first app" survives as a secondary action after the manual setup', async () => {
    mocks.isFetched = true;
    mocks.navSummary = { ...EMPTY_SUMMARY };
    await renderBody();

    const create = page.getByTestId(CREATE_FIRST);
    await expect.element(create).toBeVisible();
    expect(create.element().getAttribute('href')).toBe('/apps/submit');
    // "Secondary" is the `default` variant, which Mantine reflects onto the root as
    // `data-variant`. Without the prop the attribute is absent (null) and the button
    // falls back to the theme's default (primary-action) variant.
    expect(create.element().getAttribute('data-variant')).toBe('default');
    expect(follows(page.getByTestId(MANUAL_TOGGLE).element(), create.element())).toBe(true);

    mocks.tracked = [];
    // The click would navigate the test page away; the funnel event is what is asserted.
    create.element().addEventListener('click', (event) => event.preventDefault());
    await create.click();
    expect(mocks.tracked).toEqual([
      { type: 'AppsBuild_Action', details: { action: 'create_entry', state: 'first-app' } },
    ]);
  });

  test('🔴 C · workbench — the card is INSIDE the collapsed strip, not in the main flow', async () => {
    mocks.isFetched = true;
    mocks.navSummary = { ...SUMMARY_WITH_APPS };
    await renderBody();

    await expect.element(page.getByTestId(WORKBENCH_CTA)).toBeInTheDocument();
    const card = page.getByTestId(AGENT_ONBOARDING_TESTID);
    await expect.element(card).toBeInTheDocument();

    // The demotion, as a containment claim.
    expect(
      card.element().closest(`[data-testid="${RESOURCES}"]`),
      'the workbench card must be inside the Developer-resources collapse'
    ).not.toBeNull();
    // And it is not shown until the author asks for it.
    //
    // 🔴 THE VISIBILITY ASSERTION IS ON THE COLLAPSE REGION, NOT ON THE CARD, and that is
    // the documented behaviour of this matcher rather than a convenience. Mantine's closed
    // `Collapse` renders a `height: 0; opacity: 0` WRAPPER; the browser matcher ignores the
    // wrapper's opacity and a clipped child keeps its own bounding box, so
    // `expect(card).not.toBeVisible()` FAILS against a correctly-collapsed panel — measured
    // here, and already recorded in `GetStartedBody.browser.test.tsx` for the manual-setup
    // commands. The zero-height wrapper is the thing with an observable collapsed state.
    const region = page.getByTestId(RESOURCES);
    await expect.element(region).not.toBeVisible();

    await page.getByTestId(RESOURCES_TOGGLE).click();
    await expect.element(region).toBeVisible();
    await expect.element(page.getByTestId(AGENT_PROMPT_TESTID)).toBeVisible();
  });

  test('🔴 C · inside the strip the card comes BEFORE the commands, with no nested toggle', async () => {
    mocks.isFetched = true;
    mocks.navSummary = { ...SUMMARY_WITH_APPS };
    await renderBody();

    const region = page.getByTestId(RESOURCES);
    await expect.element(region).toBeInTheDocument();
    const card = page.getByTestId(AGENT_ONBOARDING_TESTID);
    const install = page.getByText(`$ ${NPM_INSTALL}`);
    await expect.element(install).toBeInTheDocument();
    expect(install.element().closest(`[data-testid="${RESOURCES}"]`)).not.toBeNull();
    expect(follows(card.element(), install.element()), 'the card must precede the commands').toBe(
      true
    );
    // One click reveals both routes: the strip does not nest the manual-setup collapse.
    expect(seen(MANUAL_TOGGLE)).toBe(0);

    await page.getByTestId(RESOURCES_TOGGLE).click();
    await expect.element(region).toBeVisible();
    await expect.element(install).toBeVisible();
  });

  test('🔴 C · the workbench card is STATIC — the collapsed strip stays cheap', async () => {
    // `Collapse` keeps children mounted at zero height, so an animated card here would run a
    // 4s infinite shimmer behind a panel nobody opened and would finish its entrance before
    // the panel ever revealed it.
    mocks.isFetched = true;
    mocks.navSummary = { ...SUMMARY_WITH_APPS };
    await renderBody();

    const card = page.getByTestId(AGENT_ONBOARDING_TESTID);
    await expect.element(card).toBeInTheDocument();
    expect(card.element().getAttribute('data-motion')).toBe('off');
  });

  /**
   * 🔴 THE OTHER HALF OF STATE C'S DEMOTION, AND IT WAS UNPINNED. `animated={false}` had a
   * guard (above); `tone="inline"` had none, and a mutation flipping the workbench call site
   * to `tone="prominent"` SURVIVED a 54-assertion sweep twice over. The two props are
   * independent — the strip would have gone back to leading with an `<h3>` and the hero
   * paragraph, inside a collapse, with every suite green.
   *
   * 🔴 THE CLAIM IS THE HEADING ELEMENT, NOT THE WORDING, and that is deliberate. `prominent`
   * renders `<Title order={3}>` and `inline` renders a plain `<Text fw={600}>`, so the tone
   * decides whether this card injects an `h3` into the document outline — which is the part
   * that MATTERS about being demoted inside a collapsed "Developer resources" strip, and the
   * part a copy edit cannot move. Asserting the two strings instead would tax every future
   * wording change for a weaker claim.
   */
  test('🔴 C · the workbench card is the INLINE tone — no heading in the document outline', async () => {
    mocks.isFetched = true;
    mocks.navSummary = { ...SUMMARY_WITH_APPS };
    await renderBody();

    const card = page.getByTestId(AGENT_ONBOARDING_TESTID);
    await expect.element(card).toBeInTheDocument();
    expect(
      headingsIn(card.element()),
      'the demoted card must not put a heading in the outline'
    ).toEqual([]);
  });

  /**
   * POSITIVE CONTROL FOR THE ASSERTION ABOVE. An empty heading list is indistinguishable
   * from a card that renders no headings in ANY tone — so the pitch card, the one placement
   * that passes `tone="prominent"`, has to report a non-empty one. This also pins state A's
   * own tone, which was equally unpinned: `GetStartedBody` flipping to `inline` would have
   * been invisible too.
   *
   * State B is asserted separately below: it leads with the card too.
   */
  test('POSITIVE CONTROL: the state-A pitch card IS the prominent tone — it has a heading', async () => {
    mocks.flags = { appBlocks: true, appBlocksAuthor: false };
    await renderBody();

    const card = page.getByTestId(AGENT_ONBOARDING_TESTID);
    await expect.element(card).toBeInTheDocument();
    expect(headingsIn(card.element())).toEqual(['H3']);
  });

  test('🔴 B · the first-app card is the PROMINENT tone', async () => {
    mocks.isFetched = true;
    mocks.navSummary = { ...EMPTY_SUMMARY };
    await renderBody();

    const card = page.getByTestId(AGENT_ONBOARDING_TESTID);
    await expect.element(card).toBeInTheDocument();
    expect(headingsIn(card.element())).toEqual(['H3']);
  });

  /**
   * 🔴 POSITIVE CONTROL FOR THE WORKBENCH'S `data-motion="off"`, AND THIS FILE HAD NONE. `data-motion` never
   * took the value `'on'` anywhere here, so the workbench's `'off'` was a reader nobody had
   * watched move — and `'off'` is also the component's first-render default, which is the
   * other half of why that assertion needed propping up (see `renderBody`). State B passes no
   * `animated` prop, so if it reported `'off'` too, the workbench result would be about the
   * clock rather than about the prop.
   */
  test('POSITIVE CONTROL: the state-B card reports `data-motion="on"`', async () => {
    mocks.isFetched = true;
    mocks.navSummary = { ...EMPTY_SUMMARY };
    await renderBody();

    const card = page.getByTestId(AGENT_ONBOARDING_TESTID);
    await expect.element(card).toBeInTheDocument();
    expect(card.element().getAttribute('data-motion')).toBe('on');
  });

  test('🔴 the card does NOT render under the skeleton', async () => {
    // The unsettled window commits to neither B nor C. A card painted there would also be a
    // `agent_prompt_copy` attributable to a state nobody was shown.
    mocks.isFetched = false;
    mocks.navSummary = undefined;
    await renderBody();

    await expect.element(page.getByTestId(SKELETON)).toBeInTheDocument();
    expect(seen(AGENT_ONBOARDING_TESTID)).toBe(0);
  });
});

describe('the `agent_prompt_copy` funnel step', () => {
  test('🔴 copying in state B posts exactly ONE `agent_prompt_copy`, for `first-app`', async () => {
    mocks.isFetched = true;
    mocks.navSummary = { ...EMPTY_SUMMARY };
    await renderBody();

    await expect.element(page.getByTestId(AGENT_PROMPT_TESTID)).toBeVisible();
    mocks.tracked = []; // drop the `view` event; this assertion is about the copy step
    await page.getByRole('button', { name: AGENT_COPY_LABEL }).click();

    expect(mocks.tracked).toEqual([
      { type: 'AppsBuild_Action', details: { action: 'agent_prompt_copy', state: 'first-app' } },
    ]);
    expect(writeText()).toHaveBeenCalledWith(AGENT_BUILD_PROMPT);
  });

  test('copying in state A posts it for `pitch`', async () => {
    mocks.flags = { appBlocks: true, appBlocksAuthor: false };
    await renderBody();

    await expect.element(page.getByTestId(AGENT_PROMPT_TESTID)).toBeVisible();
    mocks.tracked = [];
    await page.getByRole('button', { name: AGENT_COPY_LABEL }).click();

    expect(mocks.tracked).toEqual([
      { type: 'AppsBuild_Action', details: { action: 'agent_prompt_copy', state: 'pitch' } },
    ]);
  });

  test('copying in the workbench strip posts it for `workbench`', async () => {
    mocks.isFetched = true;
    mocks.navSummary = { ...SUMMARY_WITH_APPS };
    await renderBody();

    await page.getByTestId(RESOURCES_TOGGLE).click();
    await expect.element(page.getByTestId(AGENT_PROMPT_TESTID)).toBeVisible();
    mocks.tracked = [];
    await page.getByRole('button', { name: AGENT_COPY_LABEL }).click();

    expect(mocks.tracked).toEqual([
      { type: 'AppsBuild_Action', details: { action: 'agent_prompt_copy', state: 'workbench' } },
    ]);
  });

  /**
   * 🔴 ALSO THE POSITIVE CONTROL for every `agent_prompt_copy` assertion above. Without it they
   * could be satisfied by a component that posts that action for EVERY copy on the page, and
   * the two routes would be indistinguishable in the rollup.
   */
  test.for([
    {
      label: 'A · pitch',
      state: 'pitch',
      toggle: MANUAL_TOGGLE,
      arrange: () => {
        mocks.flags = { appBlocks: true, appBlocksAuthor: false };
      },
    },
    {
      label: 'B · first-app',
      state: 'first-app',
      toggle: MANUAL_TOGGLE,
      arrange: () => {
        mocks.isFetched = true;
        mocks.navSummary = { ...EMPTY_SUMMARY };
      },
    },
    {
      label: 'C · workbench',
      state: 'workbench',
      toggle: RESOURCES_TOGGLE,
      arrange: () => {
        mocks.isFetched = true;
        mocks.navSummary = { ...SUMMARY_WITH_APPS };
      },
    },
  ])(
    '🔴 $label: a CLI copy from the collapse posts ONE `cli_copy`, not the agent step',
    async ({ state, toggle, arrange }) => {
      arrange();
      await renderBody();

      await page.getByTestId(toggle).click();
      const copy = page.getByRole('button', { name: `Copy command: ${NPM_INSTALL}` });
      await expect.element(copy).toBeVisible();
      mocks.tracked = [];
      await copy.click();

      expect(mocks.tracked).toEqual([
        { type: 'AppsBuild_Action', details: { action: 'cli_copy', state } },
      ]);
      expect(writeText()).toHaveBeenCalledWith(NPM_INSTALL);
    }
  );
});
