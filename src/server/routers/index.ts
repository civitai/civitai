import { clubRouter } from '~/server/routers/club.router';
import { clubMembershipRouter } from '~/server/routers/clubMembership.router';
import { clubPostRouter } from '~/server/routers/clubPost.router';
import { commonRouter } from '~/server/routers/common.router';
import { cosmeticRouter } from '~/server/routers/cosmetic.router';
import { csamRouter } from '~/server/routers/csam.router';
import { eventRouter } from '~/server/routers/event.router';
import { userProfileRouter } from '~/server/routers/user-profile.router';
import { userReferralCodeRouter } from '~/server/routers/user-referral-code.router';
import { router } from '~/server/trpc';

import { accountRouter } from './account.router';
import { announcementRouter } from './announcement.router';
import { answerRouter } from './answer.router';
import { apiKeyRouter } from './apiKey.router';
import { articleRouter } from './article.router';
import { authRouter } from './auth.router';
import { bountyRouter } from './bounty.router';
import { bountyEntryRouter } from './bountyEntry.router';
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
import { leaderboardRouter } from './leaderboard.router';
import { modelFileRouter } from './model-file.router';
import { modelVersionRouter } from './model-version.router';
import { modelRouter } from './model.router';
import { newsletterRouter } from './newsletter.router';
import { notificationRouter } from './notification.router';
import { partnerRouter } from './partner.router';
import { postRouter } from './post.router';
import { questionRouter } from './question.router';
import { reactionRouter } from './reaction.router';
import { reportRouter } from './report.router';
import { resourceReviewRouter } from './resourceReview.router';
import { signalsRouter } from './signals.router';
import { stripeRouter } from './stripe.router';
import { systemRouter } from './system.router';
import { tagRouter } from './tag.router';
import { trackRouter } from './track.router';
import { trainingRouter } from './training.router';
import { userLinkRouter } from './user-link.router';
import { userRouter } from './user.router';
import { userStripeConnectRouter } from './user-stripe-connect.router';
import { buzzWithdrawalRequestRouter } from './buzz-withdrawal-request.router';
import { integrationRouter } from './integration.router';
import { paypalRouter } from './paypal.router';
import { buildGuideRouter } from './build-guide.router';
import { purchasableRewardRouter } from './purchasable-reward.router';
import { vaultRouter } from './vault.router';
import { researchRouter } from '~/server/routers/research.router';
import { redeemableCodeRouter } from '~/server/routers/redeemableCode.router';
import { toolRouter } from '~/server/routers/tool.router';
import { cosmeticShopRouter } from '~/server/routers/cosmetic-shop.router';

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
  report: reportRouter,
  resourceReview: resourceReviewRouter,
  signals: signalsRouter,
  stripe: stripeRouter,
  tag: tagRouter,
  track: trackRouter,
  training: trainingRouter,
  user: userRouter,
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
  userStripeConnect: userStripeConnectRouter,
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
});

// export type definition of API
export type AppRouter = typeof appRouter;
