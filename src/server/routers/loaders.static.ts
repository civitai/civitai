import type { routers as lazyLoaders } from './loaders';
import { blocksRouter } from '~/server/routers/blocks.router';
import { appsRouter } from '~/server/routers/apps.router';
import { appListingsRouter } from '~/server/routers/app-listings.router';
import { appAccessRequestRouter } from '~/server/routers/app-access-request.router';
import { appFeedbackRouter } from '~/server/routers/app-feedback.router';
import { appCollaboratorsRouter } from '~/server/routers/app-collaborators.router';
import { appStorageRouter } from '~/server/routers/app-storage.router';
import { appHibernationRouter } from '~/server/routers/app-hibernation.router';
import { blockImageUploadRouter } from '~/server/routers/block-image-upload.router';
import { blockImagePickerRouter } from '~/server/routers/block-image-picker.router';
import { platformFeedbackRouter } from '~/server/routers/platform-feedback.router';
import { accountRouter } from './account.router';
import { announcementRouter } from './announcement.router';
import { apiKeyRouter } from './apiKey.router';
import { articleRouter } from './article.router';
import { authRouter } from './auth.router';
import { blurbRouter } from './blurb.router';
import { bountyRouter } from './bounty.router';
import { bountyEntryRouter } from './bountyEntry.router';
import { buzzRouter } from './buzz.router';
import { chatRouter } from './chat.router';
import { collectionRouter } from './collection.router';
import { contestScoreRouter } from './contest-score.router';
import { commentv3Router } from './commentv3.router';
import { commonRouter } from '~/server/routers/common.router';
import { contentRouter } from './content.router';
import { downloadRouter } from './download.router';
import { feedbackRouter } from './feedback.router';
import { homeBlockRouter } from './home-block.router';
import { huggingFaceImportRouter } from './huggingface-import.router';
import { creatorServiceDealRouter } from './creator-service-deal.router';
import { creatorServiceDealFileRouter } from './creator-service-deal-file.router';
import { imageRouter } from './image.router';
import { merchRouter } from './merch.router';
import { modelRouter } from './model.router';
import { model3dRouter } from './model3d.router';
import { modelFileRouter } from './model-file.router';
import { modelVersionRouter } from './model-version.router';
import { modelVersionGiftRouter } from './model-version-gift.router';
import { versionShowcaseRouter } from './version-showcase.router';
import { notificationRouter } from './notification.router';
import { partnerRouter } from './partner.router';
import { placementRouter } from './placement.router';
import { storylineRouter } from './storyline.router';
import { postRouter } from './post.router';
import { postPresetRouter } from './post-preset.router';
import { postIntentRouter } from './post-intent.router';
import { promotionRouter } from './promotion.router';
import { ratingReviewRouter } from './rating-review.router';
import { reactionRouter } from './reaction.router';
import { reportRouter } from './report.router';
import { resourceReviewRouter } from './resourceReview.router';
import { semanticImageSearchRouter } from './semantic-image-search.router';
import { imageSearchUploadRouter } from './image-search-upload.router';
import { semanticArticleSearchRouter } from './semantic-article-search.router';
import { semanticComicSearchRouter } from './semantic-comic-search.router';
import { semanticChallengeSearchRouter } from './semantic-challenge-search.router';
import { semanticModelSearchRouter } from './semantic-model-search.router';
import { semanticModel3DSearchRouter } from './semantic-model3d-search.router';
import { semanticStorylineSearchRouter } from './semantic-storyline-search.router';
import { semanticCollectionSearchRouter } from './semantic-collection-search.router';
import { semanticBountySearchRouter } from './semantic-bounty-search.router';
import { semanticCrucibleSearchRouter } from './semantic-crucible-search.router';
import { signalsRouter } from './signals.router';
import { stickerBookRouter } from './sticker-book.router';
import { stripeRouter } from './stripe.router';
import { subscriptionsRouter } from '~/server/routers/subscriptions.router';
import { tagRouter } from './tag.router';
import { takedownRequestRouter } from './takedown-request.router';
import { trackRouter } from './track.router';
import { trainingRouter } from './training.router';
import { userRouter } from './user.router';
import { userHubRouter } from './user-hub.router';
import { userRestrictionRouter } from '~/server/routers/user-restriction.router';
import { userLinkRouter } from './user-link.router';
import { leaderboardRouter } from './leaderboard.router';
import { generationRouter } from './generation.router';
import { generationPresetRouter } from './generation-preset.router';
import { generationSizePresetRouter } from './generation-size-preset.router';
import { wildcardSetRouter } from './wildcard-set.router';
import { newsletterRouter } from './newsletter.router';
import { systemRouter } from './system.router';
import { experimentsRouter } from '~/server/routers/experiments.router';
import { hiddenPreferencesRouter } from './hidden-preferences.router';
import { userReferralCodeRouter } from '~/server/routers/user-referral-code.router';
import { referralRouter } from '~/server/routers/referral.router';
import { userProfileRouter } from '~/server/routers/user-profile.router';
import { cosmeticRouter } from '~/server/routers/cosmetic.router';
import { eventRouter } from '~/server/routers/event.router';
import { hatTurfRouter } from '~/server/routers/hat-turf.router';
import { csamRouter } from '~/server/routers/csam.router';
import { userPaymentConfigurationRouter } from './user-payment-configuration.router';
import { buzzWithdrawalRequestRouter } from './buzz-withdrawal-request.router';
import { integrationRouter } from './integration.router';
import { paypalRouter } from './paypal.router';
import { buildGuideRouter } from './build-guide.router';
import { purchasableRewardRouter } from './purchasable-reward.router';
import { vaultRouter } from './vault.router';
import { siteAlertRouter } from './site-alert.router';
import { researchRouter } from '~/server/routers/research.router';
import { redeemableCodeRouter } from '~/server/routers/redeemableCode.router';
import { membershipGiftRouter } from '~/server/routers/membership-gift.router';
import { toolRouter } from '~/server/routers/tool.router';
import { cosmeticShopRouter } from '~/server/routers/cosmetic-shop.router';
import { creatorShopRouter } from '~/server/routers/creator-shop.router';
import { mysteryBoxRouter } from '~/server/routers/mystery-box.router';
import { creatorServiceRouter } from '~/server/routers/creator-service.router';
import { productBadgeRouter } from '~/server/routers/product-badge.router';
import { techniqueRouter } from '~/server/routers/technique.router';
import { donationGoalRouter } from '~/server/routers/donation-goal.router';
import { orchestratorRouter } from '~/server/routers/orchestrator.router';
import { remixAppRouter } from '~/server/routers/remix-app.router';
import { modRouter } from '~/server/routers/moderator';
import { entityCollaboratorRouter } from '~/server/routers/entity-collaborator.router';
import { gamesRouter } from '~/server/routers/games.router';
import { paddleRouter } from '~/server/routers/paddle.router';
import { challengeRouter } from '~/server/routers/challenge.router';
import { dailyChallengeRouter } from '~/server/routers/daily-challenge.router';
import { vimeoRouter } from '~/server/routers/vimeo.router';
import { creatorProgramRouter } from '~/server/routers/creator-program.router';
import { creatorJourneyRouter } from '~/server/routers/creator-journey.router';
import { auctionRouter } from '~/server/routers/auction.router';
import { resourceLoadRouter } from '~/server/routers/resource-load.router';
import { changelogRouter } from '~/server/routers/changelog.router';
import { bugRouter } from '~/server/routers/bug.router';
import { nowPaymentsRouter } from './nowpayments.router';
import { coinbaseRouter } from './coinbase.router';
import { emerchantpayRouter } from './emerchantpay.router';
import { comicsRouter } from './comics.router';
import { strikeRouter } from '~/server/routers/strike.router';
import { rewardsBonusEventRouter } from './rewards-bonus-event.router';
import { rewardConfigRouter } from './reward-config.router';
import { oauthClientRouter } from '~/server/routers/oauth-client.router';
import { oauthConsentRouter } from '~/server/routers/oauth-consent.router';
import { scannerPoliciesRouter } from '~/server/routers/scanner-policies.router';
import { crucibleRouter } from './crucible.router';
import { prizeRouter } from './prize.router';

// Production builds resolve ./loaders to this file (next.config.mjs, turbopack.resolveAlias).
export const routers = {
  blocks: () => Promise.resolve(blocksRouter),
  apps: () => Promise.resolve(appsRouter),
  appListings: () => Promise.resolve(appListingsRouter),
  appAccessRequest: () => Promise.resolve(appAccessRequestRouter),
  appFeedback: () => Promise.resolve(appFeedbackRouter),
  appCollaborators: () => Promise.resolve(appCollaboratorsRouter),
  appStorage: () => Promise.resolve(appStorageRouter),
  appHibernation: () => Promise.resolve(appHibernationRouter),
  blockImageUpload: () => Promise.resolve(blockImageUploadRouter),
  blockImagePicker: () => Promise.resolve(blockImagePickerRouter),
  platformFeedback: () => Promise.resolve(platformFeedbackRouter),
  account: () => Promise.resolve(accountRouter),
  announcement: () => Promise.resolve(announcementRouter),
  apiKey: () => Promise.resolve(apiKeyRouter),
  article: () => Promise.resolve(articleRouter),
  auth: () => Promise.resolve(authRouter),
  blurb: () => Promise.resolve(blurbRouter),
  bounty: () => Promise.resolve(bountyRouter),
  bountyEntry: () => Promise.resolve(bountyEntryRouter),
  buzz: () => Promise.resolve(buzzRouter),
  chat: () => Promise.resolve(chatRouter),
  collection: () => Promise.resolve(collectionRouter),
  contestScore: () => Promise.resolve(contestScoreRouter),
  commentv3: () => Promise.resolve(commentv3Router),
  common: () => Promise.resolve(commonRouter),
  content: () => Promise.resolve(contentRouter),
  download: () => Promise.resolve(downloadRouter),
  feedback: () => Promise.resolve(feedbackRouter),
  homeBlock: () => Promise.resolve(homeBlockRouter),
  huggingFaceImport: () => Promise.resolve(huggingFaceImportRouter),
  creatorServiceDeal: () => Promise.resolve(creatorServiceDealRouter),
  creatorServiceDealFile: () => Promise.resolve(creatorServiceDealFileRouter),
  image: () => Promise.resolve(imageRouter),
  merch: () => Promise.resolve(merchRouter),
  model: () => Promise.resolve(modelRouter),
  model3d: () => Promise.resolve(model3dRouter),
  modelFile: () => Promise.resolve(modelFileRouter),
  modelVersion: () => Promise.resolve(modelVersionRouter),
  versionShowcase: () => Promise.resolve(versionShowcaseRouter),
  modelVersionGift: () => Promise.resolve(modelVersionGiftRouter),
  notification: () => Promise.resolve(notificationRouter),
  partner: () => Promise.resolve(partnerRouter),
  placement: () => Promise.resolve(placementRouter),
  storyline: () => Promise.resolve(storylineRouter),
  post: () => Promise.resolve(postRouter),
  postPreset: () => Promise.resolve(postPresetRouter),
  postIntent: () => Promise.resolve(postIntentRouter),
  promotion: () => Promise.resolve(promotionRouter),
  ratingReview: () => Promise.resolve(ratingReviewRouter),
  reaction: () => Promise.resolve(reactionRouter),
  report: () => Promise.resolve(reportRouter),
  resourceReview: () => Promise.resolve(resourceReviewRouter),
  semanticImageSearch: () => Promise.resolve(semanticImageSearchRouter),
  imageSearchUpload: () => Promise.resolve(imageSearchUploadRouter),
  semanticArticleSearch: () => Promise.resolve(semanticArticleSearchRouter),
  semanticComicSearch: () => Promise.resolve(semanticComicSearchRouter),
  semanticChallengeSearch: () => Promise.resolve(semanticChallengeSearchRouter),
  semanticModelSearch: () => Promise.resolve(semanticModelSearchRouter),
  semanticModel3DSearch: () => Promise.resolve(semanticModel3DSearchRouter),
  semanticStorylineSearch: () => Promise.resolve(semanticStorylineSearchRouter),
  semanticCollectionSearch: () => Promise.resolve(semanticCollectionSearchRouter),
  semanticBountySearch: () => Promise.resolve(semanticBountySearchRouter),
  semanticCrucibleSearch: () => Promise.resolve(semanticCrucibleSearchRouter),
  signals: () => Promise.resolve(signalsRouter),
  stickerBook: () => Promise.resolve(stickerBookRouter),
  stripe: () => Promise.resolve(stripeRouter),
  subscriptions: () => Promise.resolve(subscriptionsRouter),
  tag: () => Promise.resolve(tagRouter),
  takedownRequest: () => Promise.resolve(takedownRequestRouter),
  track: () => Promise.resolve(trackRouter),
  training: () => Promise.resolve(trainingRouter),
  user: () => Promise.resolve(userRouter),
  userHub: () => Promise.resolve(userHubRouter),
  userRestriction: () => Promise.resolve(userRestrictionRouter),
  userLink: () => Promise.resolve(userLinkRouter),
  leaderboard: () => Promise.resolve(leaderboardRouter),
  generation: () => Promise.resolve(generationRouter),
  generationPreset: () => Promise.resolve(generationPresetRouter),
  generationSizePreset: () => Promise.resolve(generationSizePresetRouter),
  wildcardSet: () => Promise.resolve(wildcardSetRouter),
  newsletter: () => Promise.resolve(newsletterRouter),
  system: () => Promise.resolve(systemRouter),
  experiments: () => Promise.resolve(experimentsRouter),
  hiddenPreferences: () => Promise.resolve(hiddenPreferencesRouter),
  userReferralCode: () => Promise.resolve(userReferralCodeRouter),
  referral: () => Promise.resolve(referralRouter),
  userProfile: () => Promise.resolve(userProfileRouter),
  cosmetic: () => Promise.resolve(cosmeticRouter),
  event: () => Promise.resolve(eventRouter),
  hatTurf: () => Promise.resolve(hatTurfRouter),
  csam: () => Promise.resolve(csamRouter),
  userPaymentConfiguration: () => Promise.resolve(userPaymentConfigurationRouter),
  buzzWithdrawalRequest: () => Promise.resolve(buzzWithdrawalRequestRouter),
  integration: () => Promise.resolve(integrationRouter),
  paypal: () => Promise.resolve(paypalRouter),
  buildGuide: () => Promise.resolve(buildGuideRouter),
  purchasableReward: () => Promise.resolve(purchasableRewardRouter),
  vault: () => Promise.resolve(vaultRouter),
  siteAlerts: () => Promise.resolve(siteAlertRouter),
  research: () => Promise.resolve(researchRouter),
  redeemableCode: () => Promise.resolve(redeemableCodeRouter),
  membershipGift: () => Promise.resolve(membershipGiftRouter),
  tool: () => Promise.resolve(toolRouter),
  cosmeticShop: () => Promise.resolve(cosmeticShopRouter),
  creatorShop: () => Promise.resolve(creatorShopRouter),
  mysteryBox: () => Promise.resolve(mysteryBoxRouter),
  creatorService: () => Promise.resolve(creatorServiceRouter),
  productBadge: () => Promise.resolve(productBadgeRouter),
  technique: () => Promise.resolve(techniqueRouter),
  donationGoal: () => Promise.resolve(donationGoalRouter),
  orchestrator: () => Promise.resolve(orchestratorRouter),
  remixApp: () => Promise.resolve(remixAppRouter),
  moderator: () => Promise.resolve(modRouter),
  entityCollaborator: () => Promise.resolve(entityCollaboratorRouter),
  games: () => Promise.resolve(gamesRouter),
  paddle: () => Promise.resolve(paddleRouter),
  challenge: () => Promise.resolve(challengeRouter),
  dailyChallenge: () => Promise.resolve(dailyChallengeRouter),
  vimeo: () => Promise.resolve(vimeoRouter),
  creatorProgram: () => Promise.resolve(creatorProgramRouter),
  creatorJourney: () => Promise.resolve(creatorJourneyRouter),
  auction: () => Promise.resolve(auctionRouter),
  resourceLoad: () => Promise.resolve(resourceLoadRouter),
  changelog: () => Promise.resolve(changelogRouter),
  bug: () => Promise.resolve(bugRouter),
  nowPayments: () => Promise.resolve(nowPaymentsRouter),
  coinbase: () => Promise.resolve(coinbaseRouter),
  emerchantpay: () => Promise.resolve(emerchantpayRouter),
  comics: () => Promise.resolve(comicsRouter),
  strike: () => Promise.resolve(strikeRouter),
  rewardsBonusEvent: () => Promise.resolve(rewardsBonusEventRouter),
  rewardConfig: () => Promise.resolve(rewardConfigRouter),
  oauthClient: () => Promise.resolve(oauthClientRouter),
  oauthConsent: () => Promise.resolve(oauthConsentRouter),
  scannerPolicies: () => Promise.resolve(scannerPoliciesRouter),
  crucible: () => Promise.resolve(crucibleRouter),
  prize: () => Promise.resolve(prizeRouter),
} satisfies typeof lazyLoaders;
