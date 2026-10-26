import type { AssistantTool } from '@civitai/app-assistant';
import type { AssistantTokenProvider } from '~/components/Apps/AppAssistant/assistantToken';
import { appAssistantHoldsScopes } from '~/shared/constants/app-assistant.constants';

export const GENERATE_APP_COVER = 'generate_app_cover';

/**
 * The one recipe `generate_app_cover` runs. Landscape inside the listing cover's aspect band and above
 * its minimum width (civitai's `validateListingImage`, pinned against these in its tests), and JPEG so
 * the file stays under the cover's byte cap.
 */
export const APP_COVER_WIDTH = 1344;
export const APP_COVER_HEIGHT = 768;
export const APP_COVER_MODEL = 'urn:air:sdxl:checkpoint:civitai:101055@128078';
export const APP_COVER_PROMPT_MAX = 600;
const APP_COVER_NEGATIVE_PROMPT =
  'text, words, letters, watermark, logo, signature, blurry, lowres';

export interface AppCoverStep {
  $type: 'textToImage';
  input: {
    model: string;
    prompt: string;
    negativePrompt: string;
    width: number;
    height: number;
    steps: number;
    cfgScale: number;
    seed: number;
    quantity: 1;
    outputFormat: 'jpeg';
  };
}

export interface AppCoverWorkflow {
  steps: [AppCoverStep];
  /** One per call, so a repeated submit of the same call cannot start a second run. */
  externalId?: string;
}

/** The cover recipe for `prompt`; nothing about it but the prompt and seed comes from the caller. */
export function appCoverWorkflow(prompt: string, seed: number): AppCoverWorkflow {
  return {
    steps: [
      {
        $type: 'textToImage',
        input: {
          model: APP_COVER_MODEL,
          prompt,
          negativePrompt: APP_COVER_NEGATIVE_PROMPT,
          width: APP_COVER_WIDTH,
          height: APP_COVER_HEIGHT,
          steps: 25,
          cfgScale: 7,
          seed,
          quantity: 1,
          outputFormat: 'jpeg',
        },
      },
    ],
  };
}

export interface CoverListing {
  listingId: string;
  /** Why the listing's media cannot be edited now, in the user's words; null when it can. */
  blockedReason: string | null;
}

export interface CoverArtDeps {
  /** The open app's key (its blockId, which an on-site listing's slug is), or null. */
  currentApp(): string | null;
  /** The user's own listing for `app`; null when they have none. */
  listing(app: string): Promise<CoverListing | null>;
  /** Runs `workflow` on the user's Buzz and returns its image's URL; throws a message for the user. */
  generate(workflow: AppCoverWorkflow, signal?: AbortSignal): Promise<string>;
  /** Makes the image at `url` the listing's cover through civitai's listing-asset checks. */
  attach(listingId: string, url: string): Promise<{ scanPending: boolean }>;
  newId?(): string;
  seed?(): number;
}

// The chat shows the user every thrown error, so these are written for them: no tool names or ids.
export const COVER_NO_APP = 'There is no app open to make a cover for.';
export const COVER_NO_LISTING =
  'This app has no store listing yet. Publish it first, then a cover can be made for its listing.';
export const COVER_NO_PROMPT = 'Describe what the cover should show.';
export const COVER_LISTING_UNREADABLE = 'Your app’s store listing could not be read right now.';
export const COVER_NOT_GENERATED = 'The cover could not be generated, so nothing was attached.';
export const coverNotAttached = (reason: string) =>
  `The cover was generated but could not be put on your listing: ${reason}`;

/**
 * `generate_app_cover`: a store cover for the open app's listing, from the one fixed recipe above,
 * on the user's Buzz under the App Assistant's daily cap. One call checks the listing, generates the
 * cover and attaches it.
 */
export function createCoverArt(deps: CoverArtDeps): Record<string, AssistantTool> {
  const newId = deps.newId ?? (() => Math.random().toString(36).slice(2, 12));
  const seed = deps.seed ?? (() => Math.floor(Math.random() * 2 ** 31));

  const run = async (app: string, rawPrompt: unknown, signal?: AbortSignal) => {
    const prompt = typeof rawPrompt === 'string' ? rawPrompt.trim() : '';
    if (!prompt) throw new Error(COVER_NO_PROMPT);
    const listing = await deps.listing(app);
    if (!listing) throw new Error(COVER_NO_LISTING);
    if (listing.blockedReason) throw new Error(listing.blockedReason);
    const workflow = {
      ...appCoverWorkflow(prompt.slice(0, APP_COVER_PROMPT_MAX), seed()),
      externalId: `app-cover-${newId()}`,
    };
    const url = await deps.generate(workflow, signal);
    const attached = await deps.attach(listing.listingId, url);
    return {
      attached: true,
      note: attached.scanPending
        ? 'The cover is on the listing. It is still being checked, and shows in the store once that passes.'
        : 'The cover is on the listing.',
    };
  };

  const tool: AssistantTool = {
    description:
      "Make a store cover image for the open app's published listing and set it as the listing's cover. It spends the user's Buzz: use it only when the user asks for a cover.",
    activity: 'Making your cover…',
    inputSchema: {
      properties: {
        prompt: {
          type: 'string',
          description: `What the cover shows, in plain words: the app's subject and mood, with no text or logos (at most ${APP_COVER_PROMPT_MAX} characters).`,
        },
      },
      required: ['prompt'],
    },
    // The chat passes its call context second (`ChatTool`); only its abort signal is read.
    execute(input, context?: { signal?: AbortSignal }) {
      const app = deps.currentApp();
      if (!app) return Promise.reject(new Error(COVER_NO_APP));
      return run(app, input.prompt, context?.signal);
    },
  };

  return { [GENERATE_APP_COVER]: tool };
}

/** What `appListings.getMyListingForApp` answers that the cover reads. */
export interface ListingForCover {
  appListingId: string;
  editBlockedReason: string | null;
}

/** The civitai procedures the cover goes through: the same ones the listing editor uses. */
export interface CoverListingApi {
  getMyListingForApp(input: { slug: string }): Promise<ListingForCover>;
  ingestAssetFromUrl(input: { url: string; kind: 'cover' }): Promise<{ imageId: number }>;
  setCover(input: {
    listingId: string;
    imageId: number;
  }): Promise<{ status: 'pending' } | { status: 'attached'; scanPending?: boolean }>;
}

/** The part of `@civitai/sdk`'s orchestration client the cover runs on. */
export interface CoverOrchestration {
  submitWorkflow(template: AppCoverWorkflow): Promise<CoverWorkflowResult>;
  waitForWorkflow(id: string, opts?: { signal?: AbortSignal }): Promise<CoverWorkflowResult>;
}

export interface CoverWorkflowResult {
  id?: string | null;
  status: string;
  steps?: { output?: { images?: { url?: string | null; available?: boolean }[] } | null }[];
}

/** No listing of the user's for this app: none exists, or the slug is someone else's. */
function isNoListing(error: unknown): boolean {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
  return code === 'NOT_FOUND' || code === 'FORBIDDEN';
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'try again in a moment.';
}

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
    async listing(app) {
      let listing: ListingForCover;
      try {
        listing = await api.getMyListingForApp({ slug: app });
      } catch (error) {
        if (isNoListing(error)) return null;
        throw new Error(COVER_LISTING_UNREADABLE);
      }
      return { listingId: listing.appListingId, blockedReason: listing.editBlockedReason };
    },
    async generate(workflow, signal) {
      const client = await orchestration();
      const submitted = await client.submitWorkflow(workflow);
      if (!submitted.id) throw new Error(COVER_NOT_GENERATED);
      const done = await client.waitForWorkflow(submitted.id, { signal });
      const image = done.steps?.[0]?.output?.images?.[0];
      if (done.status !== 'succeeded' || !image?.url || image.available === false)
        throw new Error(COVER_NOT_GENERATED);
      return image.url;
    },
    async attach(listingId, url) {
      let result: Awaited<ReturnType<CoverListingApi['setCover']>>;
      try {
        const { imageId } = await api.ingestAssetFromUrl({ url, kind: 'cover' });
        result = await api.setCover({ listingId, imageId });
      } catch (error) {
        throw new Error(coverNotAttached(messageOf(error)));
      }
      onAttached?.();
      return { scanPending: result.status === 'pending' || !!result.scanPending };
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
