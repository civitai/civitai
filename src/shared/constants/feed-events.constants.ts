// What a feed event may carry. Shared by the browser (what to send) and the server (what to keep), so
// a key added on one side and not the other is dropped, never stored. Only filter controls are listed;
// inputs that hold free text or identities (query, username, user, tag and post ids) never are.
export const FEED_EVENT_TYPES = ['load', 'seen', 'click'] as const;
export type FeedEventType = (typeof FEED_EVENT_TYPES)[number];

export const FEED_EVENT_FEEDS = ['models', 'images', 'posts', 'articles', 'search'] as const;
export type FeedEventFeed = (typeof FEED_EVENT_FEEDS)[number];

export const FEED_EVENT_FILTER_KEYS: Record<FeedEventFeed, readonly string[]> = {
  models: [
    'period',
    'periodMode',
    'browsingLevel',
    'types',
    'checkpointType',
    'baseModels',
    'fileFormats',
    'availability',
    'supportsGeneration',
    'earlyAccess',
    'paidAccess',
    'hidePaid',
    'fromPlatform',
    'isFeatured',
    'followed',
    'hidden',
  ],
  images: [
    'period',
    'periodMode',
    'browsingLevel',
    'types',
    'baseModels',
    'techniques',
    'tools',
    'followed',
    'fromPlatform',
    'hidden',
    'withMeta',
    'requiringMeta',
    'hideAutoResources',
    'hideManualResources',
  ],
  posts: ['period', 'periodMode', 'browsingLevel', 'followed'],
  articles: ['period', 'periodMode', 'browsingLevel', 'followed'],
  search: ['index', 'baseModels', 'types', 'category', 'checkpointType', 'fileFormats', 'hidePaid'],
};

export const FEED_EVENT_FILTER_VALUE_MAX = 200;
// The deepest position or page index a row may carry.
export const FEED_EVENT_INDEX_MAX = 10_000;
// What a filter control sends: option labels and numbers, comma-joined (`SDXL 1.0,Pony`, `true`).
export const FEED_EVENT_FILTER_VALUE_PATTERN = /^[\w .,:+-]+$/;
export const FEED_EVENT_SORT_PATTERN = /^[\w ]{1,40}$/;
