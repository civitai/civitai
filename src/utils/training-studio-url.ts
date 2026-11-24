import { env } from '~/env/client';

/** The Training Studio's origin: the page loads the embedded element from it, and the server
 *  forwards the embed's training calls to it. */
export const trainingStudioUrl = (): string =>
  process.env.NODE_ENV === 'development'
    ? 'http://localhost:5174'
    : env.NEXT_PUBLIC_TRAINING_STUDIO_URL;
