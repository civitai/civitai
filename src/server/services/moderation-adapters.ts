import { setTextScanVerdictApplier } from '~/server/services/text-scan/verdict-applier';
import '~/server/services/text-scan/profiles/index';
import { articleModerationAdapter } from '~/server/services/article-moderation.adapter';
import { bountyModerationAdapter } from '~/server/services/bounty-moderation.adapter';
import { challengeModerationAdapter } from '~/server/services/challenge-moderation.adapter';
import { crucibleModerationAdapter } from '~/server/services/crucible-moderation.adapter';
import type { ModerationAdapter } from '~/server/services/entity-moderation.service';
import { modelModerationAdapter } from '~/server/services/model-moderation.adapter';
import {
  serviceDealReviewModerationAdapter,
  serviceDealReviewReplyModerationAdapter,
} from '~/server/services/service-deal-review-moderation.adapter';
import { serviceOfferingModerationAdapter } from '~/server/services/service-offering-moderation.adapter';
import {
  textScanShadowAdapters,
  textScanWebSearchAdapters,
} from '~/server/services/text-scan/adapter';
import {
  appDocTextScanAdapter,
  bountyEntryTextScanAdapter,
  collectionTextScanAdapter,
  imageCaptionTextScanAdapter,
  postTextTextScanAdapter,
  postTextScanAdapter,
  retiredModelRulesAdapter,
  storylineTextScanAdapter,
} from '~/server/services/text-scan/adapters';
import { scamModerationAdapters } from '~/server/services/text-scan/scam.adapter';
import { trackLyricsLanguageModerationAdapter } from '~/server/services/track-lyrics-language-moderation.adapter';
import { trackLyricsModerationAdapter } from '~/server/services/track-lyrics-moderation.adapter';
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
  Crucible: crucibleModerationAdapter,
  Model: modelModerationAdapter,
  WildcardSetCategory: wildcardCategoryModerationAdapter,
  Bounty: bountyModerationAdapter,
  BountyEntry: bountyEntryTextScanAdapter,
  Collection: collectionTextScanAdapter,
  Post: postTextScanAdapter,
  Storyline: storylineTextScanAdapter,
  ImageCaption: imageCaptionTextScanAdapter,
  TrackLyrics: trackLyricsModerationAdapter,
  TrackLyricsLanguage: trackLyricsLanguageModerationAdapter,
  ServiceOffering: serviceOfferingModerationAdapter,
  ServiceDealReview: serviceDealReviewModerationAdapter,
  ServiceDealReviewReply: serviceDealReviewReplyModerationAdapter,
  PostText: postTextTextScanAdapter,
  AppDoc: appDocTextScanAdapter,
  ...textScanShadowAdapters(),
  ...textScanWebSearchAdapters(),
  ...scamModerationAdapters,
  ModelRules: retiredModelRulesAdapter,
  'ModelRules:shadow': retiredModelRulesAdapter,
};

export function getModerationAdapter(entityType: string): ModerationAdapter | undefined {
  return moderationAdapters[entityType];
}

export function getSupportedModerationEntityTypes(): string[] {
  return Object.keys(moderationAdapters);
}

// Text scan applies verdicts through this without importing the registry (verdict-applier.ts).
setTextScanVerdictApplier(async (entityType, args) => {
  await getModerationAdapter(entityType)?.applyTextScan?.(args);
});
