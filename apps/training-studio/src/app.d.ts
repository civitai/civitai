import type { SessionUser } from '@civitai/auth';

// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      // Non-optional: the hooks.server.ts guard redirects login/forbidden before any handler runs, so
      // route code always has a signed-in user. (Public paths skip the guard and must not read this.)
      user: SessionUser;
      // Set only on the dev-login bypass, where `user` is a stub with no real orchestrator token —
      // loaders serve sample data instead of querying the orchestrator.
      devPreview?: boolean;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
