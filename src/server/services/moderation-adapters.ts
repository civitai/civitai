import { articleModerationAdapter } from '~/server/services/article-moderation.adapter';
import { challengeModerationAdapter } from '~/server/services/challenge-moderation.adapter';
import type { ModerationAdapter } from '~/server/services/entity-moderation.service';
import { wildcardCategoryModerationAdapter } from '~/server/services/wildcard-category-audit.service';

// Central registry of `ModerationAdapter`s keyed by entityType. Adding a new
// moderated entity type is a single registration here — the webhook, the
// retry cron, and any future moderation consumer all read from this map.
//
// Lives in its own module (rather than alongside `entity-moderation.service`)
// because it imports the per-entity service files, which themselves import
// from `entity-moderation.service`. Keeping the wiring one-directional
// avoids the import cycle.
const moderationAdapters: Record<string, ModerationAdapter> = {
  Article: articleModerationAdapter,
  Challenge: challengeModerationAdapter,
  WildcardSetCategory: wildcardCategoryModerationAdapter,
};

export function getModerationAdapter(entityType: string): ModerationAdapter | undefined {
  return moderationAdapters[entityType];
}

export function getSupportedModerationEntityTypes(): string[] {
  return Object.keys(moderationAdapters);
}
