import type { SessionUser } from '@civitai/auth';

// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      user?: SessionUser;
      /** The current session's token id (jti) — used by /logout to invalidate it. */
      tokenId?: string;
      /** Moderator impersonation (F): the moderator's id when this is an impersonation session. */
      impersonatedBy?: number;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
