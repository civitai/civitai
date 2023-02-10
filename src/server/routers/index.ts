import { modelVersionRouter } from './model-version.router';
import { partnerRouter } from './partner.router';
import { userLinkRouter } from './user-link.router';
import { router } from '~/server/trpc';
import { accountRouter } from './account.router';
import { apiKeyRouter } from './apiKey.router';
import { authRouter } from './auth.router';
import { commentRouter } from './comment.router';
import { modelRouter } from './model.router';
import { notificationRouter } from './notification.router';
import { reviewRouter } from './review.router';
import { tagRouter } from './tag.router';
import { userRouter } from './user.router';
import { imageRouter } from './image.router';
import { reportRouter } from './report.router';
import { questionRouter } from './question.router';
import { answerRouter } from './answer.router';
import { commentv2Router } from './commentv2.router';
import { reactionRouter } from './reaction.router';
import { downloadRouter } from './download.router';
import { stripeRouter } from './stripe.router';
import { announcementRouter } from '~/server/routers/announcement.router';

export const appRouter = router({
  account: accountRouter,
  announcement: announcementRouter,
  apiKey: apiKeyRouter,
  auth: authRouter,
  comment: commentRouter,
  model: modelRouter,
  notification: notificationRouter,
  download: downloadRouter,
  review: reviewRouter,
  tag: tagRouter,
  user: userRouter,
  userLink: userLinkRouter,
  partner: partnerRouter,
  modelVersion: modelVersionRouter,
  image: imageRouter,
  report: reportRouter,
  question: questionRouter,
  answer: answerRouter,
  commentv2: commentv2Router,
  reaction: reactionRouter,
  stripe: stripeRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
