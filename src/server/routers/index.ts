import { auctionRouter } from '~/server/routers/auction.router';
import { blocklistRouter } from '~/server/routers/blocklist.router';
import { changelogRouter } from '~/server/routers/changelog.router';
import { clubRouter } from '~/server/routers/club.router';
import { clubMembershipRouter } from '~/server/routers/clubMembership.router';
import { clubPostRouter } from '~/server/routers/clubPost.router';
import { commonRouter } from '~/server/routers/common.router';
import { cosmeticShopRouter } from '~/server/routers/cosmetic-shop.router';
import { cosmeticRouter } from '~/server/routers/cosmetic.router';
import { creatorProgramRouter } from '~/server/routers/creator-program.router';
import { csamRouter } from '~/server/routers/csam.router';
import { dailyChallengeRouter } from '~/server/routers/daily-challenge.router';
import { donationGoalRouter } from '~/server/routers/donation-goal.router';
import { entityCollaboratorRouter } from '~/server/routers/entity-collaborator.router';
import { eventRouter } from '~/server/routers/event.router';
import { gamesRouter } from '~/server/routers/games.router';
import { modRouter } from '~/server/routers/moderator';
import { orchestratorRouter } from '~/server/routers/orchestrator.router';
import { paddleRouter } from '~/server/routers/paddle.router';
import { redeemableCodeRouter } from '~/server/routers/redeemableCode.router';
import { researchRouter } from '~/server/routers/research.router';
import { subscriptionsRouter } from '~/server/routers/subscriptions.router';
import { techniqueRouter } from '~/server/routers/technique.router';
import { toolRouter } from '~/server/routers/tool.router';
import { userRestrictionRouter } from '~/server/routers/user-restriction.router';
import { userProfileRouter } from '~/server/routers/user-profile.router';
import { userReferralCodeRouter } from '~/server/routers/user-referral-code.router';
import { vimeoRouter } from '~/server/routers/vimeo.router';
import { router } from '~/server/trpc';
import { accountRouter } from './account.router';
import { announcementRouter } from './announcement.router';
import { answerRouter } from './answer.router';
import { apiKeyRouter } from './apiKey.router';
import { articleRouter } from './article.router';
import { authRouter } from './auth.router';
import { bountyRouter } from './bounty.router';
import { bountyEntryRouter } from './bountyEntry.router';
import { buildGuideRouter } from './build-guide.router';
import { buzzWithdrawalRequestRouter } from './buzz-withdrawal-request.router';
import { buzzRouter } from './buzz.router';
import { chatRouter } from './chat.router';
import { clubAdminRouter } from './clubAdmin.router';
import { collectionRouter } from './collection.router';
import { commentRouter } from './comment.router';
import { commentv2Router } from './commentv2.router';
import { contentRouter } from './content.router';
import { downloadRouter } from './download.router';
import { generationRouter } from './generation.router';
import { hiddenPreferencesRouter } from './hidden-preferences.router';
import { homeBlockRouter } from './home-block.router';
import { imageRouter } from './image.router';
import { integrationRouter } from './integration.router';
import { leaderboardRouter } from './leaderboard.router';
import { modelFileRouter } from './model-file.router';
import { modelVersionRouter } from './model-version.router';
import { modelRouter } from './model.router';
import { newsletterRouter } from './newsletter.router';
import { notificationRouter } from './notification.router';
import { partnerRouter } from './partner.router';
import { paypalRouter } from './paypal.router';
import { postRouter } from './post.router';
import { purchasableRewardRouter } from './purchasable-reward.router';
import { questionRouter } from './question.router';
import { reactionRouter } from './reaction.router';
import { recommendersRouter } from './recommenders.router';
import { reportRouter } from './report.router';
import { resourceReviewRouter } from './resourceReview.router';
import { signalsRouter } from './signals.router';
import { stripeRouter } from './stripe.router';
import { systemRouter } from './system.router';
import { tagRouter } from './tag.router';
import { trackRouter } from './track.router';
import { trainingRouter } from './training.router';
import { userLinkRouter } from './user-link.router';
import { userPaymentConfigurationRouter } from './user-payment-configuration.router';
import { userRouter } from './user.router';
import { vaultRouter } from './vault.router';
import { nowPaymentsRouter } from './nowpayments.router';
import { coinbaseRouter } from './coinbase.router';
import { emerchantpayRouter } from './emerchantpay.router';
import { comicsRouter } from './comics.router';

export const appRouter = router({
  account: accountRouter,
  announcement: announcementRouter,
  answer: answerRouter,
  apiKey: apiKeyRouter,
  article: articleRouter,
  auth: authRouter,
  bounty: bountyRouter,
  bountyEntry: bountyEntryRouter,
  buzz: buzzRouter,
  chat: chatRouter,
  club: clubRouter,
  clubPost: clubPostRouter,
  clubMembership: clubMembershipRouter,
  clubAdmin: clubAdminRouter,
  collection: collectionRouter,
  comment: commentRouter,
  commentv2: commentv2Router,
  common: commonRouter,
  content: contentRouter,
  download: downloadRouter,
  homeBlock: homeBlockRouter,
  image: imageRouter,
  model: modelRouter,
  modelFile: modelFileRouter,
  modelVersion: modelVersionRouter,
  notification: notificationRouter,
  partner: partnerRouter,
  post: postRouter,
  question: questionRouter,
  reaction: reactionRouter,
  recommenders: recommendersRouter,
  report: reportRouter,
  resourceReview: resourceReviewRouter,
  signals: signalsRouter,
  stripe: stripeRouter,
  subscriptions: subscriptionsRouter,
  tag: tagRouter,
  track: trackRouter,
  training: trainingRouter,
  user: userRouter,
  userRestriction: userRestrictionRouter,
  userLink: userLinkRouter,
  leaderboard: leaderboardRouter,
  generation: generationRouter,
  newsletter: newsletterRouter,
  system: systemRouter,
  hiddenPreferences: hiddenPreferencesRouter,
  userReferralCode: userReferralCodeRouter,
  userProfile: userProfileRouter,
  cosmetic: cosmeticRouter,
  event: eventRouter,
  csam: csamRouter,
  userPaymentConfiguration: userPaymentConfigurationRouter,
  buzzWithdrawalRequest: buzzWithdrawalRequestRouter,
  integration: integrationRouter,
  paypal: paypalRouter,
  buildGuide: buildGuideRouter,
  purchasableReward: purchasableRewardRouter,
  vault: vaultRouter,
  research: researchRouter,
  redeemableCode: redeemableCodeRouter,
  tool: toolRouter,
  cosmeticShop: cosmeticShopRouter,
  technique: techniqueRouter,
  donationGoal: donationGoalRouter,
  orchestrator: orchestratorRouter,
  moderator: modRouter,
  entityCollaborator: entityCollaboratorRouter,
  games: gamesRouter,
  paddle: paddleRouter,
  blocklist: blocklistRouter,
  dailyChallenge: dailyChallengeRouter,
  vimeo: vimeoRouter,
  creatorProgram: creatorProgramRouter,
  auction: auctionRouter,
  changelog: changelogRouter,
  nowPayments: nowPaymentsRouter,
  coinbase: coinbaseRouter,
  emerchantpay: emerchantpayRouter,
  comics: comicsRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
