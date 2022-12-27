import { router } from '~/server/trpc';

import { accountRouter } from './account.router';
import { apiKeyRouter } from './apiKey.router';
import { authRouter } from './auth.router';
import { bountyRouter } from './bounty.router';
import { commentRouter } from './comment.router';
import { downloadRouter } from './download.router';
import { imageRouter } from './image.router';
import { hunterRouter } from './hunter.router';
import { modelRouter } from './model.router';
import { modelVersionRouter } from './model-version.router';
import { notificationRouter } from './notification.router';
import { partnerRouter } from './partner.router';
import { reportRouter } from './report.router';
import { reviewRouter } from './review.router';
import { tagRouter } from './tag.router';
import { userRouter } from './user.router';
import { userLinkRouter } from './user-link.router';

export const appRouter = router({
  account: accountRouter,
  apiKey: apiKeyRouter,
  auth: authRouter,
  bounty: bountyRouter,
  comment: commentRouter,
  download: downloadRouter,
  image: imageRouter,
  hunter: hunterRouter,
  model: modelRouter,
  modelVersion: modelVersionRouter,
  notification: notificationRouter,
  partner: partnerRouter,
  report: reportRouter,
  review: reviewRouter,
  tag: tagRouter,
  user: userRouter,
  userLink: userLinkRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
