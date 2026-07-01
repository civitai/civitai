import type { SessionUser } from '@civitai/auth';

// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      // Non-optional: the hooks.server.ts guard redirects login/forbidden before any handler runs, so
      // route code always has a moderator. (Public paths skip the guard but don't read this.)
      user: SessionUser;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
