import {
  attachCoverImage,
  coverErrorMessage,
  coverMaybeNotAttached,
  coverNotAttached,
  generateCover,
  priceCover,
  readCoverListing,
  type AppCoverWorkflow,
  type CoverArtDeps,
  type CoverEstimator,
  type CoverListingApi,
  type CoverOrchestration,
  type CoverPressDeps,
} from '@civitai/app-assistant';
import type { AssistantTokenProvider } from '~/components/Apps/AppAssistant/assistantToken';
import { appAssistantHoldsScopes } from '~/shared/constants/app-assistant.constants';

// `generate_app_cover` itself lives in `@civitai/app-assistant`; this module is only how the page
// reaches civitai and orchestration as the signed-in user.
export {
  APP_COVER_HEIGHT,
  APP_COVER_MODEL,
  APP_COVER_PROMPT_MAX,
  APP_COVER_WIDTH,
  COVER_LISTING_CHANGED,
  COVER_LISTING_UNREADABLE,
  COVER_NO_APP,
  COVER_NO_LISTING,
  COVER_NO_PROMPT,
  COVER_NOT_GENERATED,
  COVER_ON_DRAFT,
  COVER_ON_LISTING_IN_REVIEW,
  COVER_PRICE_UNCHECKED,
  COVER_PRICE_UNREADABLE,
  COVER_SCAN_PENDING,
  CoverPriceRoseError,
  GENERATE_APP_COVER,
  appCoverWorkflow,
  coverMaybeNotAttached,
  coverNotAttached,
  coverOfferOf,
  coverPriceRose,
  coverWorkflowFor,
  createCoverArt,
  makeOfferedCover,
} from '@civitai/app-assistant';
export type {
  AppCoverStep,
  AppCoverWorkflow,
  CoverArtDeps,
  CoverListing,
  CoverListingApi,
  CoverOffer,
  CoverOrchestration,
  CoverPressDeps,
  CoverWorkflowResult,
  ListingForCover,
} from '@civitai/app-assistant';

/** The page's orchestration client: the cover's what-if and its run. */
export type PageCoverOrchestration = CoverOrchestration & CoverEstimator;

/** A refusal civitai answered over tRPC (it has a code): the cover is surely not on the listing. */
function isRefusal(error: unknown): boolean {
  return typeof (error as { data?: { code?: unknown } } | null)?.data?.code === 'string';
}

/**
 * The cover's deps on the page, the offer's and the press's: the user's own chat token (with
 * `ai:write:budgeted`, so under the App Assistant's daily Buzz cap) and the listing editor's
 * procedures, so the image is ingested, scanned and checked by `setCover` like an author's upload.
 */
export function createBrowserCoverDeps({
  currentApp,
  api,
  orchestration,
  onAttached,
}: {
  currentApp: () => string | null;
  api: CoverListingApi;
  orchestration: () => Promise<PageCoverOrchestration>;
  /** Told only once `setCover` has succeeded. */
  onAttached?: () => void;
}): { offer: Omit<CoverArtDeps, 'nextId'>; press: CoverPressDeps } {
  const listing = (app: string) => readCoverListing(api, app);
  // One what-if for both: the press asks the same question the offer did, as the same user.
  const price = async (workflow: AppCoverWorkflow) => priceCover(await orchestration(), workflow);
  return {
    offer: { currentApp, listing, price },
    press: {
      listing,
      price,
      async generate(workflow, signal) {
        return generateCover(await orchestration(), workflow, signal);
      },
      async attach(listingId, url) {
        let result: { scanPending: boolean };
        try {
          result = await attachCoverImage(api, listingId, url);
        } catch (error) {
          // Only civitai's own refusal says for sure it is not on the listing; no answer may have.
          throw new Error(
            isRefusal(error)
              ? coverNotAttached(coverErrorMessage(error), url)
              : coverMaybeNotAttached(url)
          );
        }
        onAttached?.();
        return result;
      },
    },
  };
}

/** The page's orchestration client, on the user's chat token, made once. */
export function chatTokenOrchestration(
  tokens: AssistantTokenProvider
): () => Promise<PageCoverOrchestration> {
  let client: Promise<PageCoverOrchestration> | null = null;
  return () =>
    (client ??= import('@civitai/sdk')
      .then(({ initialize }) =>
        initialize({
          token: () => tokens.getToken(),
          refresh: () => tokens.getToken({ refresh: true }),
          requestGrants: (scopes) => appAssistantHoldsScopes(scopes),
        })
      )
      .then((app) => app.orchestration as unknown as PageCoverOrchestration)
      .catch((error) => {
        client = null;
        throw error;
      }));
}
