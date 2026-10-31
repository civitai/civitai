import {
  attachCoverImage,
  coverErrorMessage,
  coverNotAttached,
  generateCover,
  readCoverListing,
  type CoverArtDeps,
  type CoverListingApi,
  type CoverOrchestration,
} from '@civitai/app-assistant';
import type { AssistantTokenProvider } from '~/components/Apps/AppAssistant/assistantToken';
import { appAssistantHoldsScopes } from '~/shared/constants/app-assistant.constants';

// `generate_app_cover` itself (its recipe, order and messages) lives in `@civitai/app-assistant`,
// which the server runner offers it from too; this module is only how the page reaches civitai.
export {
  APP_COVER_HEIGHT,
  APP_COVER_MODEL,
  APP_COVER_PROMPT_MAX,
  APP_COVER_WIDTH,
  COVER_LISTING_UNREADABLE,
  COVER_NO_APP,
  COVER_NO_LISTING,
  COVER_NO_PROMPT,
  COVER_NOT_GENERATED,
  COVER_ON_DRAFT,
  COVER_ON_LISTING_IN_REVIEW,
  COVER_SCAN_PENDING,
  GENERATE_APP_COVER,
  appCoverWorkflow,
  coverNotAttached,
  createCoverArt,
} from '@civitai/app-assistant';
export type {
  AppCoverStep,
  AppCoverWorkflow,
  CoverArtDeps,
  CoverListing,
  CoverListingApi,
  CoverOrchestration,
  CoverWorkflowResult,
  ListingForCover,
} from '@civitai/app-assistant';

/**
 * `generate_app_cover`'s deps on the page: the user's own chat token (which holds
 * `ai:write:budgeted`, so the run is on their Buzz, as the chat's own requests are), and the
 * listing editor's procedures, so the image is ingested and scanned like an author's upload and
 * attached by `setCover` with its checks on size, type and scan state.
 */
export function createBrowserCoverArtDeps({
  currentApp,
  api,
  orchestration,
  onAttached,
}: {
  currentApp: () => string | null;
  api: CoverListingApi;
  orchestration: () => Promise<CoverOrchestration>;
  /** Told only once `setCover` has succeeded. */
  onAttached?: () => void;
}): CoverArtDeps {
  return {
    currentApp,
    listing: (app) => readCoverListing(api, app),
    async generate(workflow, signal) {
      return generateCover(await orchestration(), workflow, signal);
    },
    async attach(listingId, url) {
      let result: { scanPending: boolean };
      try {
        result = await attachCoverImage(api, listingId, url);
      } catch (error) {
        throw new Error(coverNotAttached(coverErrorMessage(error), url));
      }
      onAttached?.();
      return result;
    },
  };
}

/** The page's orchestration client, on the user's chat token, made once. */
export function chatTokenOrchestration(
  tokens: AssistantTokenProvider
): () => Promise<CoverOrchestration> {
  let client: Promise<CoverOrchestration> | null = null;
  return () =>
    (client ??= import('@civitai/sdk')
      .then(({ initialize }) =>
        initialize({
          token: () => tokens.getToken(),
          refresh: () => tokens.getToken({ refresh: true }),
          requestGrants: (scopes) => appAssistantHoldsScopes(scopes),
        })
      )
      .then((app) => app.orchestration as unknown as CoverOrchestration)
      .catch((error) => {
        client = null;
        throw error;
      }));
}
