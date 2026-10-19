/**
 * App reactions — the shared vocabulary for `social:react:self`.
 *
 * A block may set the VIEWER'S reaction on an image it was served, through the host bridge
 * (`SET_ENTITY_REACTION` / `GET_ENTITY_REACTIONS`) and the two wrapper procedures
 * `blocks.setReactionFromApp` / `blocks.getReactionsForApp`. The wrappers call the SAME
 * handler the site's own reaction button calls, so rewards, metrics and notifications are
 * identical to the site; what the wrappers add is attribution (an audit row per change),
 * provenance (a server-issued ticket per entity) and a fail-closed kill switch.
 *
 * Client-safe and import-free: both hosts, the shared gate (`reactionGate.ts`) and the server
 * read these, so the strings the server throws and the strings the host maps cannot drift.
 */

/** The block scope. Consent-gated, sensitive, never anonymous — see `block-scope.constants.ts`. */
export const APP_REACTION_SCOPE = 'social:react:self';

/**
 * The reactions an app may set on an IMAGE. Enforced server-side in
 * `blocks.setReactionFromApp`, not only in the host gate.
 *
 * 🔴 `Dislike` IS DELIBERATELY ABSENT. Image stats hardcode the dislike count to 0, so a
 * Dislike is invisible on the site, yet it is stored and still pays the reactor's encouragement
 * reward. An app could therefore farm rewards with a reaction nobody can see.
 */
export const APP_IMAGE_REACTIONS = ['Like', 'Heart', 'Laugh', 'Cry'] as const;
export type AppImageReaction = (typeof APP_IMAGE_REACTIONS)[number];

export function isAppImageReaction(value: unknown): value is AppImageReaction {
  return typeof value === 'string' && (APP_IMAGE_REACTIONS as readonly string[]).includes(value);
}

/** Entity types v1 accepts. Image only: no block endpoint serves any other type with a ticket. */
export const APP_REACTION_ENTITY_TYPES = ['image'] as const;
export type AppReactionEntityType = (typeof APP_REACTION_ENTITY_TYPES)[number];

/** Same cap as `reaction.getMyImageReactions`, so both reads chunk at one size. */
export const APP_REACTION_READ_MAX_IDS = 100;

/** Upper bound on a ticket's wire length. A real one is ~60 characters. */
export const REACT_TICKET_MAX_LENGTH = 256;

/** How long a provenance ticket stays valid after the block endpoint served the entity. */
export const REACT_TICKET_TTL_SECONDS = 24 * 60 * 60;

/**
 * The tRPC path key the site's `reaction.toggle` rate limit is stored under. That procedure
 * uses `rateLimit(reactionRateLimits)` with no `sharedKey`, so the middleware keys it on
 * `path.replace('.', ':')` — `reaction:toggle`. `blocks.setReactionFromApp` passes this as its
 * `sharedKey`, so an app's reactions and the viewer's own clicks draw on ONE per-user quota.
 * Pinned against the middleware's derivation by `block-reaction.rate-limit-key.test.ts`.
 */
export const SITE_REACTION_RATE_LIMIT_KEY = 'reaction:toggle';

/**
 * Messages the wrapper procedures throw for their OWN refusals. Stable strings: the host
 * maps them onto the closed bridge error set, so a reword here is a protocol change.
 */
export const APP_REACTION_SERVER_ERRORS = {
  /** The token does not carry `social:react:self` — the viewer has not granted it. */
  missingScope: 'block lacks social:react:self scope',
  /** The provenance guard: no valid ticket for this (entity, app, viewer). */
  ticket: 'reaction ticket is missing, expired or not issued to this app and viewer',
  /** The kill switch is off for this viewer. */
  disabled: 'reactions from apps are not enabled',
  /** A reaction outside `APP_IMAGE_REACTIONS`. */
  reactionNotAllowed: 'this reaction is not available to apps',
} as const;

/**
 * The CLOSED set of errors `ENTITY_REACTION_RESULT` / `ENTITY_REACTIONS_RESULT` carry. Every
 * failure — a host refusal or a server error — is reported as one of these, so a block can
 * branch on them. `reactionGate.ts` owns the mapping.
 */
export const ENTITY_REACTION_ERRORS = [
  'invalid-request',
  'sign-in-required',
  'review-mode',
  'not-ready',
  'needs-consent',
  'entity-unavailable',
  'rate-limited',
] as const;
export type EntityReactionError = (typeof ENTITY_REACTION_ERRORS)[number];
