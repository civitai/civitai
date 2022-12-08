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

export const appRouter = router({
  account: accountRouter,
  apiKey: apiKeyRouter,
  auth: authRouter,
  comment: commentRouter,
  model: modelRouter,
  notification: notificationRouter,
  review: reviewRouter,
  tag: tagRouter,
  user: userRouter,
  userLink: userLinkRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
