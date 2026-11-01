import { isAppBlockId } from './app-key';
import type { AssistantTool, ToolResult } from './tool';

/**
 * `generate_app_cover`, the store cover for the open app's listing: one implementation for the page
 * (`src/components/Apps/AppAssistant/coverArt.ts`, `assistantCover.ts`) and the server runner
 * (`apps/assistant-runner/src/app-assistant/cover.ts`).
 *
 * THE RULE: a cover costs the user Buzz, so the assistant never makes one. The tool spends nothing:
 * it reads the user's listing for the open app, prices the fixed recipe with orchestration's
 * what-if, and returns an OFFER. The page shows the offer as a card with the price and a button,
 * whichever side (page or runner) ran the reply, and only the user's press makes the cover
 * (`makeOfferedCover`), as them, on their Buzz. Code elsewhere points here rather than restating it.
 */
export const GENERATE_APP_COVER = 'generate_app_cover';

/**
 * The one recipe a cover runs. Landscape inside the listing cover's aspect band and above its minimum
 * width (civitai's `validateListingImage`, pinned against these in its tests), and JPEG so the file
 * stays under the cover's byte cap.
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
  /** One per offer, so a repeated submit of the same offer cannot start a second run. */
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

/** What a `generate_app_cover` call that passed returns: the page shows the card for it. */
export interface CoverOffer {
  awaitsUser: true;
  /** This offer's id: the page shows a button only for an offer it heard of live. */
  coverOffer: string;
  app: string;
  listingId: string;
  /** The listing's status when offered: where the cover lands (its draft, or once approved). */
  listingStatus: string;
  /** What is generated on the press: exactly what was priced. */
  prompt: string;
  seed: number;
  /** What orchestration quoted for it, in Buzz. */
  buzz: number;
  note: string;
}

/** The workflow a press runs for `offer`: the fixed recipe, its prompt and seed, one id per offer. */
export function coverWorkflowFor(offer: Pick<CoverOffer, 'coverOffer' | 'prompt' | 'seed'>) {
  return {
    ...appCoverWorkflow(offer.prompt, offer.seed),
    externalId: `app-cover-${offer.coverOffer}`,
  };
}

/** The offer a finished call made, or null: refused, failed, a subagent's, or another tool. */
export function coverOfferOf({
  name,
  output,
  isError,
  refused,
  stopped,
  subagent,
}: ToolResult): CoverOffer | null {
  if (name !== GENERATE_APP_COVER || isError || refused !== undefined || stopped) return null;
  if (subagent !== undefined) return null;
  const offer = output as Partial<CoverOffer> | null | undefined;
  if (offer?.awaitsUser !== true || typeof offer.coverOffer !== 'string' || !offer.coverOffer)
    return null;
  if (typeof offer.app !== 'string' || !isAppBlockId(offer.app)) return null;
  if (typeof offer.listingId !== 'string' || !offer.listingId) return null;
  if (typeof offer.listingStatus !== 'string') return null;
  if (typeof offer.prompt !== 'string' || !offer.prompt.trim()) return null;
  if (offer.prompt.length > APP_COVER_PROMPT_MAX) return null;
  if (!Number.isSafeInteger(offer.seed) || (offer.seed as number) < 0) return null;
  if (typeof offer.buzz !== 'number' || !Number.isFinite(offer.buzz) || offer.buzz < 0) return null;
  return offer as CoverOffer;
}

/** What the tool reads before it offers anything. */
export interface CoverArtDeps {
  /** The open app's key (its blockId, which an on-site listing's slug is), or null. */
  currentApp(): string | null;
  /** The user's own listing for `app`; null when they have none. */
  listing(app: string, signal?: AbortSignal): Promise<CoverListing | null>;
  /** What `workflow` would cost, in Buzz (orchestration's what-if); spends nothing. */
  price(workflow: AppCoverWorkflow, signal?: AbortSignal): Promise<number>;
  /** Ids the offers are named by; per page or run, so an offer from elsewhere never matches. */
  nextId(): string;
  seed?(): number;
}

// The chat shows the user every thrown error, so these are written for them: no tool names or ids.
export const COVER_NO_APP = 'There is no app open to make a cover for.';
export const COVER_NO_LISTING =
  'This app has no store listing yet. Publish it first, then a cover can be made for its listing.';
export const COVER_NO_PROMPT = 'Describe what the cover should show.';
export const COVER_LISTING_UNREADABLE = 'Your app’s store listing could not be read right now.';
export const COVER_PRICE_UNREADABLE =
  'The cover’s price could not be checked right now, so nothing was offered. Try again in a moment.';
export const COVER_PRICE_UNCHECKED =
  'The cover’s price could not be checked just now, so nothing was generated. Try again in a moment.';
export const coverPriceRose = (buzz: number) =>
  `The cover now costs about ${buzz} Buzz, more than when it was offered, so nothing was generated. Press again to make it at the new price.`;

/** The press found a higher price than the user last saw: nothing was generated. */
export class CoverPriceRoseError extends Error {
  override name = 'CoverPriceRoseError';
  constructor(readonly buzz: number) {
    super(coverPriceRose(buzz));
  }
}
export const COVER_NOT_SET_UP = 'Covers cannot be made here.';
export const COVER_NOT_GENERATED = 'The cover could not be generated, so nothing was attached.';
export const COVER_LISTING_CHANGED =
  'Your app’s store listing changed since this cover was offered, so nothing was generated. Ask App Assistant for a cover again.';
// Carries the image's URL: it is already paid for, so the user need not generate it again.
export const coverNotAttached = (reason: string, url: string) =>
  `The cover was generated but could not be put on your listing: ${reason.replace(/\.?$/, '.')} ` +
  `The image is at ${url} — upload it as the cover from the listing editor rather than making a new one.`;
/** The attach's outcome is unknown (no answer): it may be on the listing, so the user checks first. */
export const coverMaybeNotAttached = (url: string) =>
  `The cover was generated but may not have been put on your listing: Civitai did not confirm it. ` +
  `Check your listing's Media tab before trying again. The image is at ${url}.`;
// `setCover` writes an approved listing's cover to its draft revision and a draft's in place, so
// neither shows in the store until it is submitted; a listing under review shows it once approved.
export const COVER_ON_DRAFT =
  'The cover was added to your listing draft. Submit the listing for review to publish it in the store.';
export const COVER_ON_LISTING_IN_REVIEW =
  'The cover is on your listing, which is under review: it shows in the store once the listing is approved.';
export const COVER_SCAN_PENDING = 'The image is still being checked.';

/** `generate_app_cover`'s offer. No listing (or a locked one) or no price: no offer. */
export function createCoverArt(deps: CoverArtDeps): Record<string, AssistantTool> {
  const seed = deps.seed ?? (() => Math.floor(Math.random() * 2 ** 31));

  const offer = async (app: string, rawPrompt: unknown, signal?: AbortSignal) => {
    const prompt = typeof rawPrompt === 'string' ? rawPrompt.trim() : '';
    if (!prompt) throw new Error(COVER_NO_PROMPT);
    const listing = await deps.listing(app, signal);
    if (!listing) throw new Error(COVER_NO_LISTING);
    if (listing.blockedReason) throw new Error(listing.blockedReason);
    const capped = prompt.slice(0, APP_COVER_PROMPT_MAX);
    const chosenSeed = seed();
    let buzz: number;
    try {
      buzz = await deps.price(appCoverWorkflow(capped, chosenSeed), signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(COVER_PRICE_UNREADABLE);
    }
    if (!Number.isFinite(buzz) || buzz < 0) throw new Error(COVER_PRICE_UNREADABLE);
    const result: CoverOffer = {
      awaitsUser: true,
      coverOffer: deps.nextId(),
      app,
      listingId: listing.listingId,
      listingStatus: listing.status,
      prompt: capped,
      seed: chosenSeed,
      buzz,
      note: `The user now sees a card offering this cover for about ${buzz} Buzz, with a button. Nothing is generated or spent until they press it. Tell them that in one short sentence; your reply ends here.`,
    };
    return result;
  };

  const tool: AssistantTool = {
    description:
      "Offer the user a store cover image for the open app's published listing. It spends nothing itself: it checks the listing and the price, and the user sees a card with the price and a button; only their press generates the cover (on their Buzz) and sets it as the listing's cover. Use it only when the user asks for a cover.",
    activity: 'Pricing your cover…',
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
      if (!app || !isAppBlockId(app)) return Promise.reject(new Error(COVER_NO_APP));
      return offer(app, input.prompt, context?.signal);
    },
  };

  return { [GENERATE_APP_COVER]: tool };
}

/** What a press on an offer's card does, as the user. */
export interface CoverPressDeps {
  /** The user's own listing for `app`; null when they have none. */
  listing(app: string, signal?: AbortSignal): Promise<CoverListing | null>;
  /** What `workflow` would cost now, in Buzz: the offer's own what-if, asked again. */
  price(workflow: AppCoverWorkflow, signal?: AbortSignal): Promise<number>;
  /** Runs `workflow` on the user's Buzz and returns its image's URL; throws a message for the user. */
  generate(workflow: AppCoverWorkflow, signal?: AbortSignal): Promise<string>;
  /**
   * Makes the image at `url` the cover of listing `listingId` (the user's own listing for `app`)
   * through civitai's listing-asset checks. Throws a message for the user, naming the image.
   */
  attach(listingId: string, url: string, app: string): Promise<{ scanPending: boolean }>;
}

/**
 * The press. The listing is read again and must still be the offered one and editable, and the
 * price is checked again and must be no more than offered, or nothing is spent; then exactly the
 * offered recipe is generated and attached. Resolves with what the user
 * is told; throws a message for them.
 */
export async function makeOfferedCover(
  deps: CoverPressDeps,
  offer: CoverOffer,
  signal?: AbortSignal
): Promise<string> {
  const listing = await deps.listing(offer.app, signal);
  if (!listing || listing.listingId !== offer.listingId) throw new Error(COVER_LISTING_CHANGED);
  if (listing.blockedReason) throw new Error(listing.blockedReason);
  // Never more than the user last saw: a higher price is shown to them, and only a press at it
  // makes the cover (the card offers it again at `CoverPriceRoseError.buzz`).
  let now: number;
  try {
    now = await deps.price(appCoverWorkflow(offer.prompt, offer.seed), signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(COVER_PRICE_UNCHECKED);
  }
  if (!Number.isFinite(now) || now < 0) throw new Error(COVER_PRICE_UNCHECKED);
  if (now > offer.buzz) throw new CoverPriceRoseError(now);
  const url = await deps.generate(coverWorkflowFor(offer), signal);
  const attached = await deps.attach(listing.listingId, url, offer.app);
  const where = listing.status === 'pending' ? COVER_ON_LISTING_IN_REVIEW : COVER_ON_DRAFT;
  return attached.scanPending ? `${where} ${COVER_SCAN_PENDING}` : where;
}

/** What `appListings.getMyListingForApp` answers that the cover reads. */
export interface ListingForCover {
  appListingId: string;
  status: string;
  editBlockedReason: string | null;
}

/** The listing editor's procedures the cover goes through; the runner reaches only the read. */
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
  api: Pick<CoverListingApi, 'getMyListingForApp'>,
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

/** Orchestration's what-if for a workflow: what it would cost, submitting nothing. */
export interface CoverEstimator {
  estimateWorkflow(
    template: AppCoverWorkflow
  ): Promise<{ cost?: { total?: number | null } | null }>;
}

export interface CoverWorkflowResult {
  id?: string | null;
  status: string;
  steps?: { output?: { images?: { url?: string | null; available?: boolean }[] } | null }[];
}

/** What `workflow` would cost in Buzz, from orchestration's what-if; throws when it gives no price. */
export async function priceCover(
  client: CoverEstimator,
  workflow: AppCoverWorkflow
): Promise<number> {
  const quote = await client.estimateWorkflow(workflow);
  const total = quote?.cost?.total;
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0)
    throw new Error(COVER_PRICE_UNREADABLE);
  return Math.ceil(total);
}

/**
 * Runs `workflow` on `client` (on the user's token, so on their Buzz) and returns its image's URL.
 * Once it is submitted it is paid for as it runs: every way the wait can fail cancels it,
 * best-effort. A Stop is passed on as it is; any other failure says the cover was not made.
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
    void client.cancelWorkflow(id).catch(() => undefined);
    if (signal?.aborted) throw error;
    throw new Error(COVER_NOT_GENERATED);
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
