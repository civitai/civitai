import { lazy, type AnyTRPCRouter, type TRPCBuiltRouter } from '@trpc/server';
import { router } from '~/server/trpc';

// Each entry is a dynamic import, wrapped in `lazy()` by `lazyRouters`, so editing a service
// only rebuilds its own chunk in dev instead of recompiling the entire /api/trpc/[trpc] route.
// See docs/trpc-router-dev-recompile-and-v11-notes.md.
const routers = {
  blocks: () => import('~/server/routers/blocks.router').then((m) => m.blocksRouter),
  apps: () => import('~/server/routers/apps.router').then((m) => m.appsRouter),
  appListings: () =>
    import('~/server/routers/app-listings.router').then((m) => m.appListingsRouter),
  appAccessRequest: () =>
    import('~/server/routers/app-access-request.router').then((m) => m.appAccessRequestRouter),
  appFeedback: () =>
    import('~/server/routers/app-feedback.router').then((m) => m.appFeedbackRouter),
  appCollaborators: () =>
    import('~/server/routers/app-collaborators.router').then((m) => m.appCollaboratorsRouter),
  blockImageUpload: () =>
    import('~/server/routers/block-image-upload.router').then((m) => m.blockImageUploadRouter),
  blockImagePicker: () =>
    import('~/server/routers/block-image-picker.router').then((m) => m.blockImagePickerRouter),
  platformFeedback: () =>
    import('~/server/routers/platform-feedback.router').then((m) => m.platformFeedbackRouter),
  account: () => import('./account.router').then((m) => m.accountRouter),
  announcement: () => import('./announcement.router').then((m) => m.announcementRouter),
  answer: () => import('./answer.router').then((m) => m.answerRouter),
  apiKey: () => import('./apiKey.router').then((m) => m.apiKeyRouter),
  article: () => import('./article.router').then((m) => m.articleRouter),
  auth: () => import('./auth.router').then((m) => m.authRouter),
  blurb: () => import('./blurb.router').then((m) => m.blurbRouter),
  bounty: () => import('./bounty.router').then((m) => m.bountyRouter),
  bountyEntry: () => import('./bountyEntry.router').then((m) => m.bountyEntryRouter),
  buzz: () => import('./buzz.router').then((m) => m.buzzRouter),
  chat: () => import('./chat.router').then((m) => m.chatRouter),
  collection: () => import('./collection.router').then((m) => m.collectionRouter),
  comment: () => import('./comment.router').then((m) => m.commentRouter),
  contestScore: () => import('./contest-score.router').then((m) => m.contestScoreRouter),
  commentv2: () => import('./commentv2.router').then((m) => m.commentv2Router),
  commentv3: () => import('./commentv3.router').then((m) => m.commentv3Router),
  common: () => import('~/server/routers/common.router').then((m) => m.commonRouter),
  content: () => import('./content.router').then((m) => m.contentRouter),
  download: () => import('./download.router').then((m) => m.downloadRouter),
  feedback: () => import('./feedback.router').then((m) => m.feedbackRouter),
  homeBlock: () => import('./home-block.router').then((m) => m.homeBlockRouter),
  huggingFaceImport: () =>
    import('./huggingface-import.router').then((m) => m.huggingFaceImportRouter),
  creatorServiceDeal: () =>
    import('./creator-service-deal.router').then((m) => m.creatorServiceDealRouter),
  creatorServiceDealFile: () =>
    import('./creator-service-deal-file.router').then((m) => m.creatorServiceDealFileRouter),
  image: () => import('./image.router').then((m) => m.imageRouter),
  merch: () => import('./merch.router').then((m) => m.merchRouter),
  model: () => import('./model.router').then((m) => m.modelRouter),
  model3d: () => import('./model3d.router').then((m) => m.model3dRouter),
  modelFile: () => import('./model-file.router').then((m) => m.modelFileRouter),
  modelVersion: () => import('./model-version.router').then((m) => m.modelVersionRouter),
  notification: () => import('./notification.router').then((m) => m.notificationRouter),
  partner: () => import('./partner.router').then((m) => m.partnerRouter),
  placement: () => import('./placement.router').then((m) => m.placementRouter),
  storyline: () => import('./storyline.router').then((m) => m.storylineRouter),
  post: () => import('./post.router').then((m) => m.postRouter),
  postPreset: () => import('./post-preset.router').then((m) => m.postPresetRouter),
  postIntent: () => import('./post-intent.router').then((m) => m.postIntentRouter),
  promotion: () => import('./promotion.router').then((m) => m.promotionRouter),
  question: () => import('./question.router').then((m) => m.questionRouter),
  ratingReview: () => import('./rating-review.router').then((m) => m.ratingReviewRouter),
  reaction: () => import('./reaction.router').then((m) => m.reactionRouter),
  report: () => import('./report.router').then((m) => m.reportRouter),
  resourceReview: () => import('./resourceReview.router').then((m) => m.resourceReviewRouter),
  semanticImageSearch: () =>
    import('./semantic-image-search.router').then((m) => m.semanticImageSearchRouter),
  signals: () => import('./signals.router').then((m) => m.signalsRouter),
  stickerBook: () => import('./sticker-book.router').then((m) => m.stickerBookRouter),
  stripe: () => import('./stripe.router').then((m) => m.stripeRouter),
  subscriptions: () =>
    import('~/server/routers/subscriptions.router').then((m) => m.subscriptionsRouter),
  tag: () => import('./tag.router').then((m) => m.tagRouter),
  track: () => import('./track.router').then((m) => m.trackRouter),
  training: () => import('./training.router').then((m) => m.trainingRouter),
  user: () => import('./user.router').then((m) => m.userRouter),
  userHub: () => import('./user-hub.router').then((m) => m.userHubRouter),
  userRestriction: () =>
    import('~/server/routers/user-restriction.router').then((m) => m.userRestrictionRouter),
  userLink: () => import('./user-link.router').then((m) => m.userLinkRouter),
  leaderboard: () => import('./leaderboard.router').then((m) => m.leaderboardRouter),
  generation: () => import('./generation.router').then((m) => m.generationRouter),
  generationPreset: () =>
    import('./generation-preset.router').then((m) => m.generationPresetRouter),
  generationSizePreset: () =>
    import('./generation-size-preset.router').then((m) => m.generationSizePresetRouter),
  wildcardSet: () => import('./wildcard-set.router').then((m) => m.wildcardSetRouter),
  newsletter: () => import('./newsletter.router').then((m) => m.newsletterRouter),
  system: () => import('./system.router').then((m) => m.systemRouter),
  hiddenPreferences: () =>
    import('./hidden-preferences.router').then((m) => m.hiddenPreferencesRouter),
  userReferralCode: () =>
    import('~/server/routers/user-referral-code.router').then((m) => m.userReferralCodeRouter),
  referral: () => import('~/server/routers/referral.router').then((m) => m.referralRouter),
  userProfile: () =>
    import('~/server/routers/user-profile.router').then((m) => m.userProfileRouter),
  cosmetic: () => import('~/server/routers/cosmetic.router').then((m) => m.cosmeticRouter),
  event: () => import('~/server/routers/event.router').then((m) => m.eventRouter),
  csam: () => import('~/server/routers/csam.router').then((m) => m.csamRouter),
  userPaymentConfiguration: () =>
    import('./user-payment-configuration.router').then((m) => m.userPaymentConfigurationRouter),
  buzzWithdrawalRequest: () =>
    import('./buzz-withdrawal-request.router').then((m) => m.buzzWithdrawalRequestRouter),
  integration: () => import('./integration.router').then((m) => m.integrationRouter),
  paypal: () => import('./paypal.router').then((m) => m.paypalRouter),
  buildGuide: () => import('./build-guide.router').then((m) => m.buildGuideRouter),
  purchasableReward: () =>
    import('./purchasable-reward.router').then((m) => m.purchasableRewardRouter),
  vault: () => import('./vault.router').then((m) => m.vaultRouter),
  siteAlerts: () => import('./site-alert.router').then((m) => m.siteAlertRouter),
  research: () => import('~/server/routers/research.router').then((m) => m.researchRouter),
  redeemableCode: () =>
    import('~/server/routers/redeemableCode.router').then((m) => m.redeemableCodeRouter),
  membershipGift: () =>
    import('~/server/routers/membership-gift.router').then((m) => m.membershipGiftRouter),
  tool: () => import('~/server/routers/tool.router').then((m) => m.toolRouter),
  cosmeticShop: () =>
    import('~/server/routers/cosmetic-shop.router').then((m) => m.cosmeticShopRouter),
  creatorShop: () =>
    import('~/server/routers/creator-shop.router').then((m) => m.creatorShopRouter),
  mysteryBox: () => import('~/server/routers/mystery-box.router').then((m) => m.mysteryBoxRouter),
  creatorService: () =>
    import('~/server/routers/creator-service.router').then((m) => m.creatorServiceRouter),
  productBadge: () =>
    import('~/server/routers/product-badge.router').then((m) => m.productBadgeRouter),
  technique: () => import('~/server/routers/technique.router').then((m) => m.techniqueRouter),
  donationGoal: () =>
    import('~/server/routers/donation-goal.router').then((m) => m.donationGoalRouter),
  orchestrator: () =>
    import('~/server/routers/orchestrator.router').then((m) => m.orchestratorRouter),
  moderator: () => import('~/server/routers/moderator').then((m) => m.modRouter),
  entityCollaborator: () =>
    import('~/server/routers/entity-collaborator.router').then((m) => m.entityCollaboratorRouter),
  games: () => import('~/server/routers/games.router').then((m) => m.gamesRouter),
  paddle: () => import('~/server/routers/paddle.router').then((m) => m.paddleRouter),
  challenge: () => import('~/server/routers/challenge.router').then((m) => m.challengeRouter),
  dailyChallenge: () =>
    import('~/server/routers/daily-challenge.router').then((m) => m.dailyChallengeRouter),
  vimeo: () => import('~/server/routers/vimeo.router').then((m) => m.vimeoRouter),
  creatorProgram: () =>
    import('~/server/routers/creator-program.router').then((m) => m.creatorProgramRouter),
  creatorJourney: () =>
    import('~/server/routers/creator-journey.router').then((m) => m.creatorJourneyRouter),
  auction: () => import('~/server/routers/auction.router').then((m) => m.auctionRouter),
  resourceLoad: () =>
    import('~/server/routers/resource-load.router').then((m) => m.resourceLoadRouter),
  changelog: () => import('~/server/routers/changelog.router').then((m) => m.changelogRouter),
  bug: () => import('~/server/routers/bug.router').then((m) => m.bugRouter),
  nowPayments: () => import('./nowpayments.router').then((m) => m.nowPaymentsRouter),
  coinbase: () => import('./coinbase.router').then((m) => m.coinbaseRouter),
  emerchantpay: () => import('./emerchantpay.router').then((m) => m.emerchantpayRouter),
  comics: () => import('./comics.router').then((m) => m.comicsRouter),
  strike: () => import('~/server/routers/strike.router').then((m) => m.strikeRouter),
  rewardsBonusEvent: () =>
    import('./rewards-bonus-event.router').then((m) => m.rewardsBonusEventRouter),
  rewardConfig: () => import('./reward-config.router').then((m) => m.rewardConfigRouter),
  oauthClient: () =>
    import('~/server/routers/oauth-client.router').then((m) => m.oauthClientRouter),
  oauthConsent: () =>
    import('~/server/routers/oauth-consent.router').then((m) => m.oauthConsentRouter),
  scannerPolicies: () =>
    import('~/server/routers/scanner-policies.router').then((m) => m.scannerPoliciesRouter),
  crucible: () => import('./crucible.router').then((m) => m.crucibleRouter),
  prize: () => import('./prize.router').then((m) => m.prizeRouter),
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
