import type { SessionUser } from '@civitai/auth';

// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      // Non-optional: the hooks.server.ts guard redirects login/forbidden before any handler runs, so
      // route code always has a moderator. (Public and secret-authed paths skip the guard, and must not
      // read this — they have no user.)
      user: SessionUser;
      /**
       * Set INSTEAD of `user` on token-authenticated ingress, where there is nobody behind the request.
       * `user` is typed non-optional for the session paths that are the overwhelming majority, so a
       * helper reached from a token route must not assume it — check this first.
       */
      tokenClient?: 'webhook';
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
