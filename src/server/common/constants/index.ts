/**
 * Central export point for all server constants.
 * This file aggregates constants from domain-specific files to maintain backward compatibility
 * while breaking circular dependencies.
 */

// Generation-related constants
export * from './generation.constants';

// Model-related constants
export * from './model.constants';

// Core/shared constants
export * from './core.constants';

// Re-export commonly used constant objects as a unified 'constants' object for backward compatibility
import * as generationConstants from './generation.constants';
import * as modelConstants from './model.constants';
import * as coreConstants from './core.constants';

export const constants = {
  modelFilterDefaults: modelConstants.modelFilterDefaults,
  questionFilterDefaults: coreConstants.questionFilterDefaults,
  galleryFilterDefaults: coreConstants.galleryFilterDefaults,
  postFilterDefaults: coreConstants.postFilterDefaults,
  articleFilterDefaults: coreConstants.articleFilterDefaults,
  collectionFilterDefaults: coreConstants.collectionFilterDefaults,
  modelFileTypes: modelConstants.modelFileTypes,
  trainingMediaTypes: modelConstants.trainingMediaTypes,
  trainingModelTypes: modelConstants.trainingModelTypes,
  baseModelTypes: modelConstants.baseModelTypes,
  modelFileFormats: modelConstants.modelFileFormats,
  modelFileSizes: modelConstants.modelFileSizes,
  modelFileFp: modelConstants.modelFileFp,
  imageFormats: modelConstants.imageFormats,
  tagFilterDefaults: coreConstants.tagFilterDefaults,
  reportingFilterDefaults: coreConstants.reportingFilterDefaults,
  modelFileOrder: modelConstants.modelFileOrder,
  cardSizes: coreConstants.cardSizes,
  modPublishOnlyStatuses: modelConstants.modPublishOnlyStatuses,
  cacheTime: coreConstants.cacheTime,
  timeCutOffs: coreConstants.timeCutOffs,
  samplers: generationConstants.samplers,
  availableReactions: generationConstants.availableReactions,
  richTextEditor: generationConstants.richTextEditor,
  imageGuard: generationConstants.imageGuard,
  imageGeneration: generationConstants.imageGeneration,
  tagVoting: coreConstants.tagVoting,
  mediaUpload: coreConstants.mediaUpload,
  bounties: coreConstants.bounties,
  referrals: coreConstants.referrals,
  leaderboard: coreConstants.leaderboard,
  buzz: coreConstants.buzz,
  profile: coreConstants.profile,
  clubs: coreConstants.clubs,
  article: coreConstants.article,
  profanity: coreConstants.profanity,
  comments: coreConstants.comments,
  system: coreConstants.system,
  creatorsProgram: coreConstants.creatorsProgram,
  purchasableRewards: coreConstants.purchasableRewards,
  vault: coreConstants.vault,
  memberships: coreConstants.memberships,
  cosmeticShop: coreConstants.cosmeticShop,
  cosmetics: coreConstants.cosmetics,
  chat: coreConstants.chat,
  entityCollaborators: coreConstants.entityCollaborators,
  autoLabel: coreConstants.autoLabel,
  modelGallery: modelConstants.modelGallery,
  altTruncateLength: coreConstants.altTruncateLength,
  supportedBaseModelAddendums: modelConstants.supportedBaseModelAddendums,
  defaultCurrency: coreConstants.defaultCurrency,
  supporterBadge: coreConstants.supporterBadge,
} as const;

// Also re-export standalone constants not in the `constants` object
export { altTruncateLength } from './core.constants';
export { defaultCurrency } from './core.constants';
export { supporterBadge } from './core.constants';
export { supportedBaseModelAddendums } from './model.constants';
