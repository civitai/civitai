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
  collection: collectionRouter,
  comment: commentRouter,
  commentv2: commentv2Router,
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
});

// export type definition of API
export type AppRouter = typeof appRouter;
