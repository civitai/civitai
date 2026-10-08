// Pure post helpers: the derived lists and counts the element renders from its loaded range.
import type { PlannerPost, PlannerPostDetail, PlannerScope } from '../host.js';
import { PG_LEVEL } from '../parts/media.js';
import { localDayKey } from './calendar.js';

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
    if (!post.modelVersionId) continue;
    if (post.release)
      versions.set(post.modelVersionId, `${post.release.modelName} · ${post.release.versionName}`);
    else if (!versions.has(post.modelVersionId))
      versions.set(post.modelVersionId, `Version #${post.modelVersionId}`);
  }
  return [...versions].map(([id, label]) => ({ value: String(id), label }));
}

export function hasMature(posts: PlannerPost[]): boolean {
  return posts.some((p) => p.nsfwLevel > PG_LEVEL);
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
