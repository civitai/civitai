import type { SessionUser } from '@civitai/auth';

// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      /** The authenticated moderator, populated by the spoke guard in hooks.server.ts. */
      user?: SessionUser;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
