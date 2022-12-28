import { router } from '~/server/trpc';

import { accountRouter } from './account.router';
import { answerRouter } from './answer.router';
import { apiKeyRouter } from './apiKey.router';
import { authRouter } from './auth.router';
import { bountyRouter } from './bounty.router';
import { commentRouter } from './comment.router';
import { commentv2Router } from './commentv2.router';
import { downloadRouter } from './download.router';
import { imageRouter } from './image.router';
import { hunterRouter } from './hunter.router';
import { modelRouter } from './model.router';
import { modelVersionRouter } from './model-version.router';
import { notificationRouter } from './notification.router';
import { partnerRouter } from './partner.router';
import { questionRouter } from './question.router';
import { reactionRouter } from './reaction.router';
import { reportRouter } from './report.router';
import { reviewRouter } from './review.router';
import { tagRouter } from './tag.router';
import { userRouter } from './user.router';
import { userLinkRouter } from './user-link.router';

export const appRouter = router({
  account: accountRouter,
  answer: answerRouter,
  apiKey: apiKeyRouter,
  auth: authRouter,
  bounty: bountyRouter,
  comment: commentRouter,
  commentv2: commentv2Router,
  download: downloadRouter,
  image: imageRouter,
  hunter: hunterRouter,
  model: modelRouter,
  modelVersion: modelVersionRouter,
  notification: notificationRouter,
  partner: partnerRouter,
  question: questionRouter,
  reaction: reactionRouter,
  report: reportRouter,
  review: reviewRouter,
  tag: tagRouter,
  user: userRouter,
  userLink: userLinkRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
