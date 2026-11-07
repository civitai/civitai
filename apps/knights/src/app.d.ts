import type { SessionUser } from '@civitai/auth';

declare global {
  namespace App {
    interface Locals {
      user: SessionUser;
      /** Set only on the welcome page (`/`) for a signed-out visitor: the hub sign-in URL, returning to their page. */
      signInUrl?: string;
    }
  }
}

export {};
