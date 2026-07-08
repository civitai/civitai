import type { SessionUser } from '@civitai/auth';

// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      // Non-optional: the spoke guard (hooks.server.ts) redirects unauthenticated requests before any load
      // runs, so every gated route has a user. Public endpoints (e.g. /favicon.svg) don't read it. Revisit
      // if we add routes for logged-out users.
      user: SessionUser;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
