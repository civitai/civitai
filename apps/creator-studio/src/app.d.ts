import type { SessionUser } from '@civitai/auth';

// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      // The spoke guard (hooks.server.ts) redirects unauthenticated requests before any load runs, so every
      // route in the (app) group has a user — hence the non-optional type. The one exception is the public
      // landing (`/`), reachable logged-out; its loader treats `locals.user` as possibly-absent at runtime.
      user: SessionUser;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
