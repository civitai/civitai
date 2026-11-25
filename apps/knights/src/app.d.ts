import type { SessionUser } from '@civitai/auth';

declare global {
  namespace App {
    interface Locals {
      user: SessionUser;
      /** Set only on the welcome page (`/`) for a signed-out visitor: the hub sign-in URL, returning to their page. */
      signInUrl?: string;
      /** This request's ban and mute read (`requestStanding`), made once by the hooks. */
      standing?: Promise<import('$lib/server/standing').Standing>;
      /** This request's player status (`requestPlayerStatus`), shared by the layout and page loads. */
      playerStatus?: Promise<import('$lib/server/player-status').PlayerStatus | null>;
    }
  }
}

export {};
