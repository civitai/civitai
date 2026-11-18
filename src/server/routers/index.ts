import { lazy, type AnyTRPCRouter, type TRPCBuiltRouter } from '@trpc/server';
import { router } from '~/server/trpc';
import { blocksRouter as r_blocks } from '~/server/routers/blocks.router';
import { appsRouter as r_apps } from '~/server/routers/apps.router';
import { appListingsRouter as r_appListings } from '~/server/routers/app-listings.router';
import { appAccessRequestRouter as r_appAccessRequest } from '~/server/routers/app-access-request.router';
import { appFeedbackRouter as r_appFeedback } from '~/server/routers/app-feedback.router';
import { appCollaboratorsRouter as r_appCollaborators } from '~/server/routers/app-collaborators.router';
import { appStorageRouter as r_appStorage } from '~/server/routers/app-storage.router';
import { appHibernationRouter as r_appHibernation } from '~/server/routers/app-hibernation.router';
import { blockImageUploadRouter as r_blockImageUpload } from '~/server/routers/block-image-upload.router';
import { blockImagePickerRouter as r_blockImagePicker } from '~/server/routers/block-image-picker.router';
import { platformFeedbackRouter as r_platformFeedback } from '~/server/routers/platform-feedback.router';
import { accountRouter as r_account } from './account.router';
import { announcementRouter as r_announcement } from './announcement.router';
import { apiKeyRouter as r_apiKey } from './apiKey.router';
import { articleRouter as r_article } from './article.router';
import { authRouter as r_auth } from './auth.router';
import { blurbRouter as r_blurb } from './blurb.router';
import { bountyRouter as r_bounty } from './bounty.router';
import { bountyEntryRouter as r_bountyEntry } from './bountyEntry.router';
import { buzzRouter as r_buzz } from './buzz.router';
import { chatRouter as r_chat } from './chat.router';
import { collectionRouter as r_collection } from './collection.router';
import { contestScoreRouter as r_contestScore } from './contest-score.router';
import { commentv3Router as r_commentv3 } from './commentv3.router';
import { commonRouter as r_common } from '~/server/routers/common.router';
import { contentRouter as r_content } from './content.router';
import { downloadRouter as r_download } from './download.router';
import { feedbackRouter as r_feedback } from './feedback.router';
import { homeBlockRouter as r_homeBlock } from './home-block.router';
import { huggingFaceImportRouter as r_huggingFaceImport } from './huggingface-import.router';
import { creatorServiceDealRouter as r_creatorServiceDeal } from './creator-service-deal.router';
import { creatorServiceDealFileRouter as r_creatorServiceDealFile } from './creator-service-deal-file.router';
import { imageRouter as r_image } from './image.router';
import { merchRouter as r_merch } from './merch.router';
import { modelRouter as r_model } from './model.router';
import { model3dRouter as r_model3d } from './model3d.router';
import { modelFileRouter as r_modelFile } from './model-file.router';
import { modelVersionRouter as r_modelVersion } from './model-version.router';
import { modelVersionGiftRouter as r_modelVersionGift } from './model-version-gift.router';
import { notificationRouter as r_notification } from './notification.router';
import { partnerRouter as r_partner } from './partner.router';
import { placementRouter as r_placement } from './placement.router';
import { storylineRouter as r_storyline } from './storyline.router';
import { postRouter as r_post } from './post.router';
import { postPresetRouter as r_postPreset } from './post-preset.router';
import { postIntentRouter as r_postIntent } from './post-intent.router';
import { promotionRouter as r_promotion } from './promotion.router';
import { ratingReviewRouter as r_ratingReview } from './rating-review.router';
import { reactionRouter as r_reaction } from './reaction.router';
import { reportRouter as r_report } from './report.router';
import { resourceReviewRouter as r_resourceReview } from './resourceReview.router';
import { semanticImageSearchRouter as r_semanticImageSearch } from './semantic-image-search.router';
import { imageSearchUploadRouter as r_imageSearchUpload } from './image-search-upload.router';
import { semanticArticleSearchRouter as r_semanticArticleSearch } from './semantic-article-search.router';
import { semanticComicSearchRouter as r_semanticComicSearch } from './semantic-comic-search.router';
import { semanticChallengeSearchRouter as r_semanticChallengeSearch } from './semantic-challenge-search.router';
import { semanticModelSearchRouter as r_semanticModelSearch } from './semantic-model-search.router';
import { semanticModel3DSearchRouter as r_semanticModel3DSearch } from './semantic-model3d-search.router';
import { semanticStorylineSearchRouter as r_semanticStorylineSearch } from './semantic-storyline-search.router';
import { semanticCollectionSearchRouter as r_semanticCollectionSearch } from './semantic-collection-search.router';
import { semanticBountySearchRouter as r_semanticBountySearch } from './semantic-bounty-search.router';
import { semanticCrucibleSearchRouter as r_semanticCrucibleSearch } from './semantic-crucible-search.router';
import { signalsRouter as r_signals } from './signals.router';
import { stickerBookRouter as r_stickerBook } from './sticker-book.router';
import { stripeRouter as r_stripe } from './stripe.router';
import { subscriptionsRouter as r_subscriptions } from '~/server/routers/subscriptions.router';
import { tagRouter as r_tag } from './tag.router';
import { trackRouter as r_track } from './track.router';
import { trainingRouter as r_training } from './training.router';
import { userRouter as r_user } from './user.router';
import { userHubRouter as r_userHub } from './user-hub.router';
import { userRestrictionRouter as r_userRestriction } from '~/server/routers/user-restriction.router';
import { userLinkRouter as r_userLink } from './user-link.router';
import { leaderboardRouter as r_leaderboard } from './leaderboard.router';
import { generationRouter as r_generation } from './generation.router';
import { generationPresetRouter as r_generationPreset } from './generation-preset.router';
import { generationSizePresetRouter as r_generationSizePreset } from './generation-size-preset.router';
import { wildcardSetRouter as r_wildcardSet } from './wildcard-set.router';
import { newsletterRouter as r_newsletter } from './newsletter.router';
import { systemRouter as r_system } from './system.router';
import { experimentsRouter as r_experiments } from '~/server/routers/experiments.router';
import { hiddenPreferencesRouter as r_hiddenPreferences } from './hidden-preferences.router';
import { userReferralCodeRouter as r_userReferralCode } from '~/server/routers/user-referral-code.router';
import { referralRouter as r_referral } from '~/server/routers/referral.router';
import { userProfileRouter as r_userProfile } from '~/server/routers/user-profile.router';
import { cosmeticRouter as r_cosmetic } from '~/server/routers/cosmetic.router';
import { eventRouter as r_event } from '~/server/routers/event.router';
import { hatTurfRouter as r_hatTurf } from '~/server/routers/hat-turf.router';
import { csamRouter as r_csam } from '~/server/routers/csam.router';
import { userPaymentConfigurationRouter as r_userPaymentConfiguration } from './user-payment-configuration.router';
import { buzzWithdrawalRequestRouter as r_buzzWithdrawalRequest } from './buzz-withdrawal-request.router';
import { integrationRouter as r_integration } from './integration.router';
import { paypalRouter as r_paypal } from './paypal.router';
import { buildGuideRouter as r_buildGuide } from './build-guide.router';
import { purchasableRewardRouter as r_purchasableReward } from './purchasable-reward.router';
import { vaultRouter as r_vault } from './vault.router';
import { siteAlertRouter as r_siteAlerts } from './site-alert.router';
import { researchRouter as r_research } from '~/server/routers/research.router';
import { redeemableCodeRouter as r_redeemableCode } from '~/server/routers/redeemableCode.router';
import { membershipGiftRouter as r_membershipGift } from '~/server/routers/membership-gift.router';
import { toolRouter as r_tool } from '~/server/routers/tool.router';
import { cosmeticShopRouter as r_cosmeticShop } from '~/server/routers/cosmetic-shop.router';
import { creatorShopRouter as r_creatorShop } from '~/server/routers/creator-shop.router';
import { mysteryBoxRouter as r_mysteryBox } from '~/server/routers/mystery-box.router';
import { creatorServiceRouter as r_creatorService } from '~/server/routers/creator-service.router';
import { productBadgeRouter as r_productBadge } from '~/server/routers/product-badge.router';
import { techniqueRouter as r_technique } from '~/server/routers/technique.router';
import { donationGoalRouter as r_donationGoal } from '~/server/routers/donation-goal.router';
import { orchestratorRouter as r_orchestrator } from '~/server/routers/orchestrator.router';
import { remixAppRouter as r_remixApp } from '~/server/routers/remix-app.router';
import { modRouter as r_moderator } from '~/server/routers/moderator';
import { entityCollaboratorRouter as r_entityCollaborator } from '~/server/routers/entity-collaborator.router';
import { gamesRouter as r_games } from '~/server/routers/games.router';
import { paddleRouter as r_paddle } from '~/server/routers/paddle.router';
import { challengeRouter as r_challenge } from '~/server/routers/challenge.router';
import { dailyChallengeRouter as r_dailyChallenge } from '~/server/routers/daily-challenge.router';
import { vimeoRouter as r_vimeo } from '~/server/routers/vimeo.router';
import { creatorProgramRouter as r_creatorProgram } from '~/server/routers/creator-program.router';
import { creatorJourneyRouter as r_creatorJourney } from '~/server/routers/creator-journey.router';
import { auctionRouter as r_auction } from '~/server/routers/auction.router';
import { resourceLoadRouter as r_resourceLoad } from '~/server/routers/resource-load.router';
import { changelogRouter as r_changelog } from '~/server/routers/changelog.router';
import { bugRouter as r_bug } from '~/server/routers/bug.router';
import { nowPaymentsRouter as r_nowPayments } from './nowpayments.router';
import { coinbaseRouter as r_coinbase } from './coinbase.router';
import { emerchantpayRouter as r_emerchantpay } from './emerchantpay.router';
import { comicsRouter as r_comics } from './comics.router';
import { strikeRouter as r_strike } from '~/server/routers/strike.router';
import { rewardsBonusEventRouter as r_rewardsBonusEvent } from './rewards-bonus-event.router';
import { rewardConfigRouter as r_rewardConfig } from './reward-config.router';
import { oauthClientRouter as r_oauthClient } from '~/server/routers/oauth-client.router';
import { oauthConsentRouter as r_oauthConsent } from '~/server/routers/oauth-consent.router';
import { scannerPoliciesRouter as r_scannerPolicies } from '~/server/routers/scanner-policies.router';
import { crucibleRouter as r_crucible } from './crucible.router';
import { prizeRouter as r_prize } from './prize.router';

// Each entry is a dynamic import, wrapped in `lazy()` by `lazyRouters`, so editing a service
// only rebuilds its own chunk in dev instead of recompiling the entire /api/trpc/[trpc] route.
// See docs/trpc-router-dev-recompile-and-v11-notes.md.
const routers = {
  blocks: () => Promise.resolve(r_blocks),
  apps: () => Promise.resolve(r_apps),
  appListings: () => Promise.resolve(r_appListings),
  appAccessRequest: () => Promise.resolve(r_appAccessRequest),
  appFeedback: () => Promise.resolve(r_appFeedback),
  appCollaborators: () => Promise.resolve(r_appCollaborators),
  appStorage: () => Promise.resolve(r_appStorage),
  appHibernation: () => Promise.resolve(r_appHibernation),
  blockImageUpload: () => Promise.resolve(r_blockImageUpload),
  blockImagePicker: () => Promise.resolve(r_blockImagePicker),
  platformFeedback: () => Promise.resolve(r_platformFeedback),
  account: () => Promise.resolve(r_account),
  announcement: () => Promise.resolve(r_announcement),
  apiKey: () => Promise.resolve(r_apiKey),
  article: () => Promise.resolve(r_article),
  auth: () => Promise.resolve(r_auth),
  blurb: () => Promise.resolve(r_blurb),
  bounty: () => Promise.resolve(r_bounty),
  bountyEntry: () => Promise.resolve(r_bountyEntry),
  buzz: () => Promise.resolve(r_buzz),
  chat: () => Promise.resolve(r_chat),
  collection: () => Promise.resolve(r_collection),
  contestScore: () => Promise.resolve(r_contestScore),
  commentv3: () => Promise.resolve(r_commentv3),
  common: () => Promise.resolve(r_common),
  content: () => Promise.resolve(r_content),
  download: () => Promise.resolve(r_download),
  feedback: () => Promise.resolve(r_feedback),
  homeBlock: () => Promise.resolve(r_homeBlock),
  huggingFaceImport: () => Promise.resolve(r_huggingFaceImport),
  creatorServiceDeal: () => Promise.resolve(r_creatorServiceDeal),
  creatorServiceDealFile: () => Promise.resolve(r_creatorServiceDealFile),
  image: () => Promise.resolve(r_image),
  merch: () => Promise.resolve(r_merch),
  model: () => Promise.resolve(r_model),
  model3d: () => Promise.resolve(r_model3d),
  modelFile: () => Promise.resolve(r_modelFile),
  modelVersion: () => Promise.resolve(r_modelVersion),
  modelVersionGift: () => Promise.resolve(r_modelVersionGift),
  notification: () => Promise.resolve(r_notification),
  partner: () => Promise.resolve(r_partner),
  placement: () => Promise.resolve(r_placement),
  storyline: () => Promise.resolve(r_storyline),
  post: () => Promise.resolve(r_post),
  postPreset: () => Promise.resolve(r_postPreset),
  postIntent: () => Promise.resolve(r_postIntent),
  promotion: () => Promise.resolve(r_promotion),
  ratingReview: () => Promise.resolve(r_ratingReview),
  reaction: () => Promise.resolve(r_reaction),
  report: () => Promise.resolve(r_report),
  resourceReview: () => Promise.resolve(r_resourceReview),
  semanticImageSearch: () => Promise.resolve(r_semanticImageSearch),
  imageSearchUpload: () => Promise.resolve(r_imageSearchUpload),
  semanticArticleSearch: () => Promise.resolve(r_semanticArticleSearch),
  semanticComicSearch: () => Promise.resolve(r_semanticComicSearch),
  semanticChallengeSearch: () => Promise.resolve(r_semanticChallengeSearch),
  semanticModelSearch: () => Promise.resolve(r_semanticModelSearch),
  semanticModel3DSearch: () => Promise.resolve(r_semanticModel3DSearch),
  semanticStorylineSearch: () => Promise.resolve(r_semanticStorylineSearch),
  semanticCollectionSearch: () => Promise.resolve(r_semanticCollectionSearch),
  semanticBountySearch: () => Promise.resolve(r_semanticBountySearch),
  semanticCrucibleSearch: () => Promise.resolve(r_semanticCrucibleSearch),
  signals: () => Promise.resolve(r_signals),
  stickerBook: () => Promise.resolve(r_stickerBook),
  stripe: () => Promise.resolve(r_stripe),
  subscriptions: () => Promise.resolve(r_subscriptions),
  tag: () => Promise.resolve(r_tag),
  track: () => Promise.resolve(r_track),
  training: () => Promise.resolve(r_training),
  user: () => Promise.resolve(r_user),
  userHub: () => Promise.resolve(r_userHub),
  userRestriction: () => Promise.resolve(r_userRestriction),
  userLink: () => Promise.resolve(r_userLink),
  leaderboard: () => Promise.resolve(r_leaderboard),
  generation: () => Promise.resolve(r_generation),
  generationPreset: () => Promise.resolve(r_generationPreset),
  generationSizePreset: () => Promise.resolve(r_generationSizePreset),
  wildcardSet: () => Promise.resolve(r_wildcardSet),
  newsletter: () => Promise.resolve(r_newsletter),
  system: () => Promise.resolve(r_system),
  experiments: () => Promise.resolve(r_experiments),
  hiddenPreferences: () => Promise.resolve(r_hiddenPreferences),
  userReferralCode: () => Promise.resolve(r_userReferralCode),
  referral: () => Promise.resolve(r_referral),
  userProfile: () => Promise.resolve(r_userProfile),
  cosmetic: () => Promise.resolve(r_cosmetic),
  event: () => Promise.resolve(r_event),
  hatTurf: () => Promise.resolve(r_hatTurf),
  csam: () => Promise.resolve(r_csam),
  userPaymentConfiguration: () => Promise.resolve(r_userPaymentConfiguration),
  buzzWithdrawalRequest: () => Promise.resolve(r_buzzWithdrawalRequest),
  integration: () => Promise.resolve(r_integration),
  paypal: () => Promise.resolve(r_paypal),
  buildGuide: () => Promise.resolve(r_buildGuide),
  purchasableReward: () => Promise.resolve(r_purchasableReward),
  vault: () => Promise.resolve(r_vault),
  siteAlerts: () => Promise.resolve(r_siteAlerts),
  research: () => Promise.resolve(r_research),
  redeemableCode: () => Promise.resolve(r_redeemableCode),
  membershipGift: () => Promise.resolve(r_membershipGift),
  tool: () => Promise.resolve(r_tool),
  cosmeticShop: () => Promise.resolve(r_cosmeticShop),
  creatorShop: () => Promise.resolve(r_creatorShop),
  mysteryBox: () => Promise.resolve(r_mysteryBox),
  creatorService: () => Promise.resolve(r_creatorService),
  productBadge: () => Promise.resolve(r_productBadge),
  technique: () => Promise.resolve(r_technique),
  donationGoal: () => Promise.resolve(r_donationGoal),
  orchestrator: () => Promise.resolve(r_orchestrator),
  remixApp: () => Promise.resolve(r_remixApp),
  moderator: () => Promise.resolve(r_moderator),
  entityCollaborator: () => Promise.resolve(r_entityCollaborator),
  games: () => Promise.resolve(r_games),
  paddle: () => Promise.resolve(r_paddle),
  challenge: () => Promise.resolve(r_challenge),
  dailyChallenge: () => Promise.resolve(r_dailyChallenge),
  vimeo: () => Promise.resolve(r_vimeo),
  creatorProgram: () => Promise.resolve(r_creatorProgram),
  creatorJourney: () => Promise.resolve(r_creatorJourney),
  auction: () => Promise.resolve(r_auction),
  resourceLoad: () => Promise.resolve(r_resourceLoad),
  changelog: () => Promise.resolve(r_changelog),
  bug: () => Promise.resolve(r_bug),
  nowPayments: () => Promise.resolve(r_nowPayments),
  coinbase: () => Promise.resolve(r_coinbase),
  emerchantpay: () => Promise.resolve(r_emerchantpay),
  comics: () => Promise.resolve(r_comics),
  strike: () => Promise.resolve(r_strike),
  rewardsBonusEvent: () => Promise.resolve(r_rewardsBonusEvent),
  rewardConfig: () => Promise.resolve(r_rewardConfig),
  oauthClient: () => Promise.resolve(r_oauthClient),
  oauthConsent: () => Promise.resolve(r_oauthConsent),
  scannerPolicies: () => Promise.resolve(r_scannerPolicies),
  crucible: () => Promise.resolve(r_crucible),
  prize: () => Promise.resolve(r_prize),
};

type Routers = { [K in keyof typeof routers]: Awaited<ReturnType<(typeof routers)[K]>> };
type RootTypes = ReturnType<typeof router<Record<never, never>>>['_def']['_config']['$types'];

// Don't simplify to `typeof appRouter`: inferring through `router(...)` resolves every
// router's types at once (the memory cost this avoids). This resolves a router only when
// a caller reads it.
export type AppRouter = TRPCBuiltRouter<
  RootTypes,
  { [K in keyof Routers]: Routers[K]['_def']['record'] }
>;

const lazyRouters = (input: typeof routers) =>
  Object.fromEntries(
    Object.entries(input).map(([key, load]) => [key, lazy(load as () => Promise<AnyTRPCRouter>)])
  ) as {
    [K in keyof Routers]: ReturnType<typeof lazy<Routers[K]>>;
  };

export const appRouter: AppRouter = router(lazyRouters(routers));
