// The seam between <civitai-post-planner> and whatever hosts it (docs/batch-scheduling-planner-element.md
// §3). The element owns no routes, credentials or URLs: every read and write goes through `backend`,
// every destination through the URL callbacks, and the host owns the URL space.

export type PlannerView = 'day' | 'week' | 'month' | 'agenda';

export type PlannerScope = 'post' | 'version' | 'model';

export interface PlannerLocation {
  view: PlannerView;
  /** YYYY-MM-DD anchor day: the day itself, or the week/month containing it. */
  anchor: string;
  modelVersionId?: number;
}

export interface PlannerRelease {
  scope: Exclude<PlannerScope, 'post'>;
  modelName: string;
  versionName: string;
}

export interface PlannerPost {
  id: number;
  title: string | null;
  /** ISO instant. The element buckets it into the viewer's local day. */
  publishedAt: string;
  modelVersionId: number | null;
  nsfwLevel: number;
  imageCount: number;
  cover: { url: string; type: 'image' | 'video' | 'audio' } | null;
  /** Set when the post goes live with a scheduled release and so moves with it. */
  release: PlannerRelease | null;
}

export interface PlannerMedia {
  id: number;
  url: string;
  type: 'image' | 'video' | 'audio';
  nsfwLevel: number;
  width: number | null;
  height: number | null;
}

export interface PlannerPostDetail extends PlannerPost {
  /** Plain text: the server strips the stored rich-text markup. */
  description: string | null;
  media: PlannerMedia[];
  model: { id: number; name: string; versionName: string } | null;
  resources: { id: number; name: string; type: string; modelId: number; versionId: number }[];
  tools: string[];
  techniques: string[];
  tags: string[];
  /** Only once the post is live. Posts carry no stored view count, so this is engagement only. */
  stats: { reactions: number; comments: number } | null;
}

export interface ScheduledRange {
  posts: PlannerPost[];
  dailyLimit: number;
  minGapMinutes: number;
  /** The range held more than the server returned. */
  truncated: boolean;
}

export interface MoveResult {
  publishedAt: string;
  scope: PlannerScope;
  /** Other posts the move carried along (a release fans out to its version's posts). */
  movedPostIds: number[];
}

/** Release posts are never unscheduled or shifted in bulk; they come back in `skippedReleaseIds`. */
export interface UnscheduleResult {
  unscheduledIds: number[];
  skippedReleaseIds: number[];
}

export interface ShiftResult {
  moved: { id: number; publishedAt: string }[];
  skippedReleaseIds: number[];
}

export interface PlannerBackend {
  getScheduled(range: {
    from: string;
    to: string;
    modelVersionId?: number;
  }): Promise<ScheduledRange>;
  getPostDetail(id: number): Promise<PlannerPostDetail>;
  /** `expectedScope` is what the UI showed; the server refuses when its own computation differs. */
  reschedule(req: {
    id: number;
    publishedAt: string;
    expectedScope: PlannerScope;
  }): Promise<MoveResult>;
  publishNow(req: { id: number; expectedScope: PlannerScope }): Promise<MoveResult>;
  unschedule(ids: number[]): Promise<UnscheduleResult>;
  shift(req: { ids: number[]; deltaMinutes: number }): Promise<ShiftResult>;
}

export interface PlannerHost {
  backend: PlannerBackend;
  config: {
    /** Scopes the remembered Show-mature choice to this account on a shared device. */
    userId?: number;
    /** Cloudflare Images delivery base for covers and media. */
    imageLocation: string;
    /** The viewer's browsing level; media above it renders blurred until unblurred. */
    browsingLevel: number;
    /** Seed for the Show-mature toggle on a device that has not chosen yet. A choice made in the
     *  planner is remembered per device and wins over this; it never writes the account's browsing
     *  settings. The element fires `show-mature-change` on each change. */
    showMature?: boolean;
    /** Hides quick-add and "Schedule a batch" until the composer exists. */
    composerAvailable: boolean;
  };
  hrefFor(loc: PlannerLocation): string;
  navigate(loc: PlannerLocation): Promise<void>;
  /** A host-relative URL is an in-host same-tab navigation; anything else opens in a new tab. The
   *  post's `nsfwLevel` rides along so a host that splits domains by maturity can pick the right one. */
  editPostUrl(post: { id: number; nsfwLevel: number }): string;
  viewPostUrl(post: { id: number; nsfwLevel: number }): string;
  modelPageUrl(req: { modelId: number; modelVersionId: number; nsfwLevel: number }): string;
  composerUrl?(req: { startAt?: string; modelVersionId?: number }): string;
}

/** Anchor attrs for a host URL: relative = same tab; http(s) = new tab; any other scheme is dropped. */
export function hostLink(href: string): {
  href: string;
  target?: '_blank';
  rel?: 'noreferrer';
} {
  if (href.startsWith('/') && !href.startsWith('//')) return { href };
  let protocol: string;
  try {
    protocol = new URL(href).protocol;
  } catch {
    return { href: '#' };
  }
  return protocol === 'http:' || protocol === 'https:'
    ? { href, target: '_blank', rel: 'noreferrer' }
    : { href: '#' };
}

/** The events the element dispatches (all bubble and are composed). */
export interface PlannerEventMap {
  navigate: CustomEvent<PlannerLocation>;
  rescheduled: CustomEvent<{ id: number } & MoveResult>;
  published: CustomEvent<{ id: number } & MoveResult>;
  unscheduled: CustomEvent<{ ids: number[] }>;
  shifted: CustomEvent<{ moved: { id: number; publishedAt: string }[] }>;
  'show-mature-change': CustomEvent<{ showMature: boolean }>;
  error: CustomEvent<{ message: string }>;
}
