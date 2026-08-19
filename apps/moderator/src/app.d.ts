import type { SessionUser } from '@civitai/auth';
import type { PermissionSet } from '$lib/permissions';

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
      /**
       * The permissions this user holds, resolved once per request in `hooks.server.ts`.
       *
       * Page access is NOT here: it is enforced in the hook before any handler runs, so nothing
       * downstream re-asks it. Always set — empty on token ingress — so no call site null-checks and
       * the degenerate case fails closed.
       */
      grants: PermissionSet;
      tokenClient?: 'webhook';
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
