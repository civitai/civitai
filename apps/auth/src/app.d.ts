import type { CookieSlot, SessionClaims, SessionUser } from '@civitai/auth';

// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      user?: SessionUser;
      /** The verified claims of the session this request acts as. */
      session?: SessionClaims;
      /** The current session's token id (jti) — used by /logout to invalidate it. */
      tokenId?: string;
      /** Moderator impersonation (F): the moderator's id when this is an impersonation session. */
      impersonatedBy?: number;
      /** This browser's device id: the device cookie, or the `deviceId` an `internal`-shape caller sent. */
      deviceId?: string;
      /** Which cookie slot the hub's own session was read from, when it came from a cookie. */
      sessionSlot?: CookieSlot;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
