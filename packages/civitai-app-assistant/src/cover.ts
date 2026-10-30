import type { AssistantTool } from './tool';

/**
 * `generate_app_cover`, the store cover for the open app's listing: one implementation for the page
 * (`src/components/Apps/AppAssistant/coverArt.ts`) and the server runner
 * (`apps/assistant-runner/src/app-assistant/cover.ts`). Each supplies only how it reaches civitai and
 * orchestration as the user (`CoverArtDeps`); the recipe, the order (listing first, then the spend,
 * then the attach) and every message the user reads are here.
 */
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
  /** The listing's lifecycle status (`draft|pending|approved|…`): where an attached cover lands. */
  status: string;
}

export interface CoverArtDeps {
  /** The open app's key (its blockId, which an on-site listing's slug is), or null. */
  currentApp(): string | null;
  /** The user's own listing for `app`; null when they have none. */
  listing(app: string): Promise<CoverListing | null>;
  /** Runs `workflow` on the user's Buzz and returns its image's URL; throws a message for the user. */
  generate(workflow: AppCoverWorkflow, signal?: AbortSignal): Promise<string>;
  /**
   * Makes the image at `url` the cover of listing `listingId` (the user's own listing for `app`)
   * through civitai's listing-asset checks.
   */
  attach(listingId: string, url: string, app: string): Promise<{ scanPending: boolean }>;
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
// Carries the image's URL: it is already paid for, so the user need not generate it again.
export const coverNotAttached = (reason: string, url: string) =>
  `The cover was generated but could not be put on your listing: ${reason.replace(/\.?$/, '.')} ` +
  `The image is at ${url} — upload it as the cover from the listing editor rather than making a new one.`;
// `setCover` writes an approved listing's cover to its draft revision and a draft's in place, so
// neither shows in the store until it is submitted; a listing under review shows it once approved.
export const COVER_ON_DRAFT =
  'The cover was added to your listing draft. Submit the listing for review to publish it in the store.';
export const COVER_ON_LISTING_IN_REVIEW =
  'The cover is on your listing, which is under review: it shows in the store once the listing is approved.';
export const COVER_SCAN_PENDING = 'The image is still being checked.';

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
    const attached = await deps.attach(listing.listingId, url, app);
    const where = listing.status === 'pending' ? COVER_ON_LISTING_IN_REVIEW : COVER_ON_DRAFT;
    return {
      attached: true,
      note: attached.scanPending ? `${where} ${COVER_SCAN_PENDING}` : where,
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
  status: string;
  editBlockedReason: string | null;
}

/**
 * The civitai procedures the cover goes through: the same ones the listing editor uses. The page
 * calls them over tRPC; civitai's runner endpoints call them as the run's user (`/api/internal/
 * app-assistant/cover/*`).
 */
export interface CoverListingApi {
  getMyListingForApp(input: { slug: string }): Promise<ListingForCover>;
  ingestAssetFromUrl(input: { url: string; kind: 'cover' }): Promise<{ imageId: number }>;
  /** Never answers `pending`: `setListingCover` loads with `allowPending`, so it attaches or throws. */
  setCover(input: {
    listingId: string;
    imageId: number;
  }): Promise<{ status: string; scanPending?: boolean }>;
}

/** No listing of the user's for this app: none exists, or the slug is someone else's. */
export function isNoListingError(error: unknown): boolean {
  // A tRPC client error carries its code in `data`; a server-side TRPCError on itself.
  const err = error as { data?: { code?: unknown }; code?: unknown } | null;
  const code = err?.data?.code ?? err?.code;
  return code === 'NOT_FOUND' || code === 'FORBIDDEN';
}

/** The user's own listing for `app` through `api`; null when they have none. */
export async function readCoverListing(
  api: CoverListingApi,
  app: string
): Promise<CoverListing | null> {
  let listing: ListingForCover;
  try {
    listing = await api.getMyListingForApp({ slug: app });
  } catch (error) {
    if (isNoListingError(error)) return null;
    throw new Error(COVER_LISTING_UNREADABLE);
  }
  return {
    listingId: listing.appListingId,
    blockedReason: listing.editBlockedReason,
    status: listing.status,
  };
}

/**
 * Ingests the image at `url` as a cover upload (scanned like an author's) and makes it the listing's
 * cover with `setCover`'s checks on size, type and scan state. Throws whatever they refuse with.
 */
export async function attachCoverImage(
  api: CoverListingApi,
  listingId: string,
  url: string
): Promise<{ scanPending: boolean }> {
  const { imageId } = await api.ingestAssetFromUrl({ url, kind: 'cover' });
  const result = await api.setCover({ listingId, imageId });
  return { scanPending: !!result.scanPending };
}

/** The part of an orchestration client (`@civitai/sdk`'s, or the runner's own) the cover runs on. */
export interface CoverOrchestration {
  submitWorkflow(template: AppCoverWorkflow): Promise<CoverWorkflowResult>;
  waitForWorkflow(id: string, opts?: { signal?: AbortSignal }): Promise<CoverWorkflowResult>;
  cancelWorkflow(id: string): Promise<unknown>;
}

export interface CoverWorkflowResult {
  id?: string | null;
  status: string;
  steps?: { output?: { images?: { url?: string | null; available?: boolean }[] } | null }[];
}

/**
 * Runs `workflow` on `client` (on the user's token, so on their Buzz) and returns its image's URL.
 * A Stop while it runs cancels the run, as the chat's own jobs do, so it is not billed on.
 */
export async function generateCover(
  client: CoverOrchestration,
  workflow: AppCoverWorkflow,
  signal?: AbortSignal
): Promise<string> {
  const submitted = await client.submitWorkflow(workflow);
  if (!submitted.id) throw new Error(COVER_NOT_GENERATED);
  const id = submitted.id;
  let done: CoverWorkflowResult;
  try {
    done = await client.waitForWorkflow(id, { signal });
  } catch (error) {
    if (signal?.aborted) void client.cancelWorkflow(id).catch(() => undefined);
    throw error;
  }
  const image = done.steps?.[0]?.output?.images?.[0];
  if (done.status !== 'succeeded' || !image?.url || image.available === false)
    throw new Error(COVER_NOT_GENERATED);
  return image.url;
}

/** The text of an error for the user, or a generic retry hint. */
export function coverErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'try again in a moment.';
}
