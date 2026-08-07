import type { SessionUser } from '@civitai/auth';

// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      // Non-optional: the hooks.server.ts guard redirects login/forbidden before any handler runs, so
      // route code always has a moderator. (Public paths skip the guard but don't read this.) The
      // API-key path holds the same invariant by answering 401 in the hook rather than continuing
      // without a user.
      user: SessionUser;
      /** True when the user was resolved from an API key rather than a session cookie. Only ever set on `/api/*`. */
      viaApiKey?: boolean;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
