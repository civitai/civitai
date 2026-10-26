import type { AssistantTool } from './tool';

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
  /** Set on the submit only: orchestration also matches it against an estimate's workflow. */
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

/** `placeholder`: the cover is an image civitai made by machine, not one the author chose. */
export type ListingCoverState = 'none' | 'placeholder' | 'custom';

export interface CoverListing {
  listingId: string;
  cover: ListingCoverState;
  /** Why the listing's media cannot be edited now, in the user's words; null when it can. */
  blockedReason: string | null;
}

export interface CoverArtDeps {
  /** The open app's key (its blockId, which an on-site listing's slug is), or null. */
  currentApp(): string | null;
  /** The user's own listing for `app`; null when they have none. */
  listing(app: string): Promise<CoverListing | null>;
  /** The Buzz `workflow` would cost the user; null when it cannot be priced. */
  estimate(workflow: AppCoverWorkflow): Promise<number | null>;
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
export const COVER_UNPRICED = 'The cover could not be priced right now, so nothing was generated.';
export const COVER_UNKNOWN_QUOTE =
  'That price is no longer on offer. Get a new price and ask the user again before generating.';
export const COVER_NOT_CONFIRMED =
  'The user has not answered the price yet. Tell them what it costs and wait for their reply; do not generate the cover in this reply.';
export const COVER_OTHER_APP = 'That price was for a different app. Get a new price for this one.';

type Quote = {
  app: string;
  listingId: string;
  prompt: string;
  seed: number;
  cost: number;
  /** How many user messages had been sent when it was quoted. */
  messagesAtQuote: number;
};

export interface CoverArt {
  tools: Record<string, AssistantTool>;
  /** The user sent a message: a price quoted before it may now be confirmed. */
  userMessage(): void;
  /** Another app or chat opened: no earlier price may be confirmed. */
  reset(): void;
}

/**
 * `generate_app_cover`: a store cover for the open app's listing, from the one fixed recipe above.
 * It spends Buzz, so it runs in two calls: the first prices the cover and keeps that price as a
 * quote, and only a later call naming the quote, after the user has sent a message since, generates
 * it. A quote is used once.
 */
export function createCoverArt(deps: CoverArtDeps): CoverArt {
  const quotes = new Map<string, Quote>();
  let messages = 0;
  const newId = deps.newId ?? (() => Math.random().toString(36).slice(2, 12));
  const seed = deps.seed ?? (() => Math.floor(Math.random() * 2 ** 31));

  const editableListing = async (app: string) => {
    const listing = await deps.listing(app);
    if (!listing) throw new Error(COVER_NO_LISTING);
    if (listing.blockedReason) throw new Error(listing.blockedReason);
    return listing;
  };

  const price = async (app: string, rawPrompt: unknown) => {
    const prompt = typeof rawPrompt === 'string' ? rawPrompt.trim() : '';
    if (!prompt) throw new Error(COVER_NO_PROMPT);
    const clipped = prompt.slice(0, APP_COVER_PROMPT_MAX);
    const listing = await editableListing(app);
    const quote: Quote = {
      app,
      listingId: listing.listingId,
      prompt: clipped,
      seed: seed(),
      cost: 0,
      messagesAtQuote: messages,
    };
    const cost = await deps.estimate(appCoverWorkflow(quote.prompt, quote.seed));
    if (cost === null) throw new Error(COVER_UNPRICED);
    quote.cost = cost;
    const id = newId();
    quotes.set(id, quote);
    return {
      quote: id,
      cost,
      currentCover: listing.cover,
      note: `Generating this cover costs ${cost} Buzz from the user's balance. Tell them the price and ask whether to go ahead, then end your reply. Only when their next message agrees, call ${GENERATE_APP_COVER} again with quote "${id}".`,
    };
  };

  const generate = async (app: string, id: string, signal?: AbortSignal) => {
    const quote = quotes.get(id);
    if (!quote) throw new Error(COVER_UNKNOWN_QUOTE);
    if (quote.app !== app) throw new Error(COVER_OTHER_APP);
    if (messages <= quote.messagesAtQuote) throw new Error(COVER_NOT_CONFIRMED);
    // Before any await, so a second call naming it in the same step cannot spend twice.
    quotes.delete(id);
    const listing = await editableListing(app);
    const workflow = {
      ...appCoverWorkflow(quote.prompt, quote.seed),
      externalId: `app-cover-${id}`,
    };
    const url = await deps.generate(workflow, signal);
    const attached = await deps.attach(listing.listingId, url);
    return {
      attached: true,
      cost: quote.cost,
      note: attached.scanPending
        ? 'The cover is on the listing. It is still being checked, and shows in the store once that passes.'
        : 'The cover is on the listing.',
    };
  };

  const tool: AssistantTool = {
    description:
      "Make a store cover image for the open app's published listing and set it as the listing's cover. It spends the user's Buzz, so call it first with prompt alone: that only returns the price and a quote. Tell the user the price and end your reply. Only after the user agrees in a new message, call it again with that quote alone to generate and attach the cover.",
    activity: 'Making your cover…',
    inputSchema: {
      properties: {
        prompt: {
          type: 'string',
          description: `What the cover shows, in plain words: the app's subject and mood, with no text or logos (at most ${APP_COVER_PROMPT_MAX} characters). Only on the first call.`,
        },
        quote: {
          type: 'string',
          description:
            'The quote the first call returned, once the user has agreed to the price. Generates the cover.',
        },
      },
    },
    // The chat passes its call context second (`ChatTool`); only its abort signal is read.
    execute(input, context?: { signal?: AbortSignal }) {
      const app = deps.currentApp();
      if (!app) return Promise.reject(new Error(COVER_NO_APP));
      if (typeof input.quote === 'string' && input.quote)
        return generate(app, input.quote, context?.signal);
      return price(app, input.prompt);
    },
  };

  return {
    tools: { [GENERATE_APP_COVER]: tool },
    userMessage: () => {
      messages += 1;
    },
    reset: () => quotes.clear(),
  };
}
