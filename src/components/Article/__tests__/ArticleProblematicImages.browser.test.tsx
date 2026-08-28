import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { UNRENDERABLE_ARTICLE_IMAGE_NOTE } from '~/components/Article/articleImageActions';
import type * as TrpcModule from '~/utils/trpc';

/**
 * 🔴 THE ONLY TEST THAT ACTUALLY LOOKS AT WHAT A READER SEES.
 *
 * The entire user-facing effect of the unrenderable-media work on this surface is "a button is
 * gone and a sentence takes its place", and until this file existed NOTHING rendered it. The two
 * guards that covered it are both blind to what a render would show:
 *
 *   - `articleImageActions.test.ts` pins the DECISION (`offerOverride`/`offerRetry`/`blockingNote`)
 *     as a pure function, which says nothing about whether the component consults it.
 *   - `article-unrenderable-image-seam.test.ts` is a SOURCE-TEXT SCAN whose `enclosingGate` returns
 *     the nearest preceding line containing `&& (` — the nearest, not the syntactic parent. It can
 *     therefore certify that a string appears above a JSX tag and nothing about reachability.
 *
 * So this file asserts the three things neither can: the note appears, the dead-end controls do
 * NOT, and the card is not left visually empty. Every arm has a CONTROL with an ordinary url —
 * without it "render nothing at all" satisfies the positive arms and ships a surface where nobody
 * can override or retry anything.
 */

const state = vi.hoisted(() => ({
  /** Every `resolveImageScan.mutate` / `rescanImage.mutate` / `article.rescan` call. */
  overrideCalls: [] as unknown[],
  retryCalls: [] as unknown[],
  articleRescanCalls: [] as unknown[],
}));

vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

/**
 * `EdgeMedia` reaches `useBrowsingSettings` (a provider this scaffold deliberately does not mount)
 * and a CDN url resolver. Neither is this suite's subject — it is about which CONTROLS survive —
 * and a real `<img>` pointed at an http url would race its own error event (see
 * `LOADABLE_IMAGE_DATA_URI`'s note in the setup file). Stubbed to a plain element that carries the
 * `alt`, so the card's non-emptiness is still measured against real DOM.
 */
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ alt }: { alt?: string }) => <span data-testid="stub-edge-media">{alt}</span>,
}));

// Spread the REAL module and override only `trpc` (per `local-rules/no-wholesale-module-mock`): a
// hand-written replacement silently drops any export a transitive importer needs, and the file
// then fails to load as "0 tests collected" — green for the worst possible reason.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  const mutation = (record: (args: unknown) => void) => ({
    useMutation: () => ({
      mutate: (args: unknown) => record(args),
      mutateAsync: async (args: unknown) => record(args),
      isPending: false,
    }),
  });
  return {
    ...actual,
    trpc: {
      useUtils: () => ({
        article: {
          getScanStatus: { invalidate: vi.fn().mockResolvedValue(undefined) },
          getById: { invalidate: vi.fn().mockResolvedValue(undefined) },
        },
      }),
      article: {
        resolveImageScan: mutation((a) => state.overrideCalls.push(a)),
        rescanImage: mutation((a) => state.retryCalls.push(a)),
        rescan: mutation((a) => state.articleRescanCalls.push(a)),
      },
    },
  };
});

const { ArticleProblematicImages } = await import('~/components/Article/ArticleProblematicImages');

const UNRENDERABLE_URL = 'blob:https://civitai.com/9f8e-1234';
const ORDINARY_URL = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

type ErrorImageOverrides = {
  id?: number;
  url?: string;
  nsfwLevelLocked?: boolean;
  failureClass?: string | null;
  reason?: string | null;
};

function errorImage(over: ErrorImageOverrides = {}) {
  return {
    id: 4242,
    url: ORDINARY_URL,
    // `Error` — the state this whole queue is about. Typed loosely because the enum's runtime value
    // is the string, and importing the prisma enum barrel here buys nothing.
    ingestion: 'Error' as never,
    nsfwLevelLocked: false,
    failureClass: 'transient' as string | null,
    reason: 'scan timed out' as string | null,
    ...over,
  };
}

function renderErrors(images: ReturnType<typeof errorImage>[], over?: Record<string, boolean>) {
  return renderWithProviders(
    <ArticleProblematicImages
      articleId={7}
      blockedImages={[]}
      errorImages={images}
      canOverride
      canRetry
      canRescan
      {...over}
    />
  );
}

beforeEach(() => {
  state.overrideCalls.length = 0;
  state.retryCalls.length = 0;
  state.articleRescanCalls.length = 0;
});

describe('ArticleProblematicImages — what a reader actually sees for an unrenderable image', () => {
  test('CONTROL: an ordinary failed image still offers both actions and shows no note', async () => {
    /**
     * 🔴 THE ARM THAT MAKES THE OTHERS MEAN ANYTHING. "Render no controls at all" satisfies every
     * positive assertion below while shipping a surface on which no moderator can override and no
     * author can retry. Asserted FIRST, deliberately.
     */
    renderErrors([errorImage()]);

    await expect.element(page.getByRole('button', { name: 'Retry scan' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Override' })).toBeInTheDocument();
    // The scan-failure cause is what the card says when nothing is withdrawn.
    await expect.element(page.getByText('Scanning failed, retrying automatically.')).toBeVisible();
    expect(page.getByText(UNRENDERABLE_ARTICLE_IMAGE_NOTE).elements()).toHaveLength(0);
  });

  test('withdraws BOTH dead-end controls for a blob: url', async () => {
    // Override calls the mutation that refuses this url; Retry re-fetches a browser-session handle
    // nothing outside the originating document can read. Both can only fail.
    renderErrors([errorImage({ url: UNRENDERABLE_URL })]);

    // Awaited on the note so the assertion runs against a settled tree — a bare synchronous
    // `elements()` on an absence can pass before the component has rendered anything at all.
    await expect.element(page.getByText(UNRENDERABLE_ARTICLE_IMAGE_NOTE)).toBeVisible();
    expect(page.getByRole('button', { name: 'Retry scan' }).elements()).toHaveLength(0);
    expect(page.getByRole('button', { name: 'Override' }).elements()).toHaveLength(0);
    // Not merely un-clickable: nothing in the tree can reach either mutation.
    expect(state.overrideCalls).toEqual([]);
    expect(state.retryCalls).toEqual([]);
  });

  test('puts the remedy in the card it emptied, not somewhere else on the page', async () => {
    /**
     * Withdrawing the buttons without saying why replaces a dead-end click with a blank card, which
     * is a worse dead end. The note has to land INSIDE the same `Paper` as the image it is about —
     * a page-level banner would be true and useless once there are several images.
     */
    renderErrors([errorImage({ url: UNRENDERABLE_URL })]);

    const note = page.getByText(UNRENDERABLE_ARTICLE_IMAGE_NOTE);
    await expect.element(note).toBeVisible();
    const card = note.element().closest('.mantine-Paper-root');
    expect(card, 'the note must sit inside a card').not.toBeNull();
    expect(card?.querySelector('[data-testid="stub-edge-media"]')).not.toBeNull();
  });

  test('names the rescan the article needs, because the delete alone will not unblock it', async () => {
    /**
     * 🔴 The spoke's delete removes the row and cascades `ImageConnection`/`Article.coverId` but
     * cannot call `recomputeArticleIngestion` (main-app only), and `article-ingestion-reconcile`
     * selects only `ingestion IN (Pending, Rescan)` or `(Processing, Scanned)` — an article blocked
     * by one of these sits at `Error` and is never a candidate. So the note has to say so, and the
     * button that does it has to be on screen next to it.
     */
    renderErrors([errorImage({ url: UNRENDERABLE_URL })]);

    await expect.element(page.getByText(UNRENDERABLE_ARTICLE_IMAGE_NOTE)).toBeVisible();
    expect(UNRENDERABLE_ARTICLE_IMAGE_NOTE).toContain('rescan the article');
    await expect.element(page.getByRole('button', { name: 'Rescan Article' })).toBeInTheDocument();
  });

  test('keeps the Overridden STATUS while withdrawing the override ACTION', async () => {
    /**
     * 🔴 THE FINDING THIS CLOSES, AT THE ONLY LEVEL THAT CAN SEE IT. The badge and the control used
     * to be one component, so gating it on `remedy.offerOverride` hid the badge too. That state is
     * reachable for exactly these images — `updateImageNsfwLevel` sets `nsfwLevelLocked` without
     * touching `ingestion` — so a moderator saw a card whose override had already been applied with
     * nothing on it saying so.
     */
    renderErrors([errorImage({ url: UNRENDERABLE_URL, nsfwLevelLocked: true })]);

    await expect.element(page.getByText('Overridden')).toBeVisible();
    // ...and the ACTION is still gone. Both halves, or this passes on a component that simply
    // reverted the withdrawal.
    expect(page.getByRole('button', { name: 'Override' }).elements()).toHaveLength(0);
    expect(page.getByRole('button', { name: 'Retry scan' }).elements()).toHaveLength(0);
    await expect.element(page.getByText(UNRENDERABLE_ARTICLE_IMAGE_NOTE)).toBeVisible();
  });

  test('CONTROL: the badge is a moderator affordance and stays behind canOverride', async () => {
    // The mirror of the case above: making the badge unconditional would leak an internal
    // moderation state to every reader of the article.
    renderErrors([errorImage({ url: UNRENDERABLE_URL, nsfwLevelLocked: true })], {
      canOverride: false,
    });

    await expect.element(page.getByText(UNRENDERABLE_ARTICLE_IMAGE_NOTE)).toBeVisible();
    expect(page.getByText('Overridden').elements()).toHaveLength(0);
  });

  test('withdraws per IMAGE, not per section', async () => {
    /**
     * The list is rendered from one `.map`, so a gate accidentally hoisted out of it would withdraw
     * the controls for every image the moment ONE is unrenderable — or, in the other direction,
     * offer them for the unrenderable one because a sibling is fine. Two images, one of each.
     */
    renderErrors([
      errorImage({ id: 1, url: UNRENDERABLE_URL }),
      errorImage({ id: 2, url: ORDINARY_URL }),
    ]);

    await expect.element(page.getByText(UNRENDERABLE_ARTICLE_IMAGE_NOTE)).toBeVisible();
    // Exactly one of each control survives — the ordinary image's.
    expect(page.getByRole('button', { name: 'Override' }).elements()).toHaveLength(1);
    expect(page.getByRole('button', { name: 'Retry scan' }).elements()).toHaveLength(1);
    expect(page.getByText(UNRENDERABLE_ARTICLE_IMAGE_NOTE).elements()).toHaveLength(1);
  });

  test('withdraws the same way in the BLOCKED section', async () => {
    // The other list on this component renders the note beside the block reason rather than in
    // place of a cause line, and only Override is on offer there. Same rule, different layout.
    renderWithProviders(
      <ArticleProblematicImages
        articleId={7}
        blockedImages={[
          {
            id: 9,
            url: UNRENDERABLE_URL,
            ingestion: 'Blocked' as never,
            blockedFor: 'Policy violation',
            nsfwLevelLocked: false,
          },
        ]}
        errorImages={[]}
        canOverride
        canRetry
        canRescan
      />
    );

    await expect.element(page.getByText(UNRENDERABLE_ARTICLE_IMAGE_NOTE)).toBeVisible();
    // The block reason is still shown — the note replaces the CONTROL, not the explanation.
    await expect.element(page.getByText('Blocked: Policy violation')).toBeVisible();
    expect(page.getByRole('button', { name: 'Override' }).elements()).toHaveLength(0);
  });
});
