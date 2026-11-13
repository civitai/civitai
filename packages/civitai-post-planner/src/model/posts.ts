// Pure post helpers: the derived lists and counts the element renders from its loaded range.
import type { PlannerPost, PlannerPostDetail, PlannerScope } from '../host';
import { isMatureLevel } from '../parts/media';
import { validateBatchSchedule } from '@civitai/shared/post-scheduling';
import { localDayKey } from './calendar';

export type Filters = { scheduled: boolean; published: boolean; releases: boolean };

export type Override = { from: string; to: string };

export function isScheduled(post: PlannerPost, now: Date): boolean {
  return new Date(post.publishedAt) > now;
}

export function scopeOf(post: PlannerPost): PlannerScope {
  return post.release?.scope ?? 'post';
}

/** Server posts with the confirmed moves the next reload has not shown yet. */
export function applyOverrides(
  posts: PlannerPost[],
  overrides: ReadonlyMap<number, Override>
): PlannerPost[] {
  return posts.map((p) => {
    const moved = overrides.get(p.id);
    return moved ? { ...p, publishedAt: moved.to } : p;
  });
}

export function visiblePosts(
  posts: PlannerPost[],
  filters: Filters,
  now: Date,
  modelVersionId?: number
): PlannerPost[] {
  const { scheduled, published, releases } = filters;
  return posts.filter((p) => {
    if (modelVersionId && p.modelVersionId !== modelVersionId) return false;
    if (p.release && !releases) return false;
    return isScheduled(p, now) ? scheduled : published;
  });
}

export function countScheduled(posts: PlannerPost[], now: Date): number {
  return posts.filter((p) => isScheduled(p, now)).length;
}

export function countScheduledOn(posts: PlannerPost[], dayKey: string, now: Date): number {
  return posts.filter((p) => isScheduled(p, now) && localDayKey(new Date(p.publishedAt)) === dayKey)
    .length;
}

export function neighbours(
  posts: PlannerPost[],
  id: number
): { prev: PlannerPost | null; next: PlannerPost | null } {
  const sorted = [...posts].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  const index = sorted.findIndex((p) => p.id === id);
  return {
    prev: index > 0 ? sorted[index - 1] : null,
    next: index >= 0 && index < sorted.length - 1 ? sorted[index + 1] : null,
  };
}

export function modelFilterOptions(posts: PlannerPost[]): { value: string; label: string }[] {
  const versions = new Map<number, string>();
  for (const post of posts) {
    if (!post.modelVersionId || versions.has(post.modelVersionId)) continue;
    // A server that predates `model` sends neither name for a standalone post.
    const modelName = post.release?.modelName ?? post.model?.name;
    const versionName = post.release?.versionName ?? post.model?.versionName;
    versions.set(
      post.modelVersionId,
      modelName ? `${modelName} · ${versionName}` : `Version #${post.modelVersionId}`
    );
  }
  return [...versions].map(([id, label]) => ({ value: String(id), label }));
}

/** What select mode can act on: scheduled, standalone posts. */
export function isSelectable(post: PlannerPost, now: Date): boolean {
  return !post.release && isScheduled(post, now);
}

export function hasMature(posts: PlannerPost[]): boolean {
  return posts.some((p) => isMatureLevel(p.nsfwLevel));
}

/** A cap of `0` means no cap. */
export function capColor(scheduled: number, cap: number): 'error' | 'warning' | '' {
  return cap && scheduled > cap ? 'error' : cap && scheduled === cap ? 'warning' : '';
}

/**
 * The post the drawer shows: the detail when loaded, but always with the list's date and release
 * so an optimistic move or a reload is reflected before the detail refetches.
 */
export function drawerPost(
  list: PlannerPost | null,
  detail: PlannerPostDetail | null
): PlannerPost | null {
  return detail && list
    ? { ...detail, publishedAt: list.publishedAt, release: list.release }
    : detail ?? list;
}

export type PlannedMove = { post: PlannerPost; when: Date };

/** The spacing and daily-cap rules a set of moves must pass, checked against the loaded range so
 *  a bad drop is refused before the round trip. A release's own posts share its instant and are
 *  skipped. The server re-checks against everything; this only covers what is on screen. */
export function moveSetIssues(
  posts: PlannerPost[],
  moves: PlannedMove[],
  range: { dailyLimit: number; minGapMinutes: number } | null,
  now: Date
): string[] {
  const movingIds = new Set(moves.map(({ post }) => post.id));
  const releaseVersions = new Set(
    moves.filter(({ post }) => post.release).map(({ post }) => post.modelVersionId)
  );
  const neighbours = posts.filter(
    (post) =>
      !movingIds.has(post.id) &&
      isScheduled(post, now) &&
      !(post.modelVersionId != null && releaseVersions.has(post.modelVersionId))
  );
  const validation = validateBatchSchedule({
    now,
    publishedAts: moves.map(({ when }) => when),
    existingPublishedAts: neighbours.map((post) => new Date(post.publishedAt)),
    dailyLimit: range?.dailyLimit ?? Number.POSITIVE_INFINITY,
    minGapMinutes: range?.minGapMinutes,
  });
  return [...new Set(validation.issues.map((issue) => issue.message))];
}

export function moveIssues(
  posts: PlannerPost[],
  moving: PlannerPost,
  when: Date,
  range: { dailyLimit: number; minGapMinutes: number } | null,
  now: Date
): string[] {
  return moveSetIssues(posts, [{ post: moving, when }], range, now);
}
