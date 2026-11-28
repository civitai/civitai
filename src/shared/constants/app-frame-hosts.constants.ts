/**
 * The DNS label shapes of the per-session App Block frame hosts. Shared so the server
 * that mints them and the client that decides which frames may run at a real origin
 * (`isAppFrameHost`, `~/components/AppBlocks/sandbox`) read one definition.
 */

/** A dev tunnel host label, `dev-<16 hex>`, under `APPS_DOMAIN`. */
export const DEV_HOST_LABEL_REGEX = /^dev-[a-f0-9]{16}$/;

/**
 * An App Assistant direct-preview session label under `APP_ASSISTANT_PREVIEW_DOMAIN`:
 * "s" + 61 lowercase base32 characters (`preview-session-host.ts` owns the encoding).
 */
export const PREVIEW_LABEL_SHAPE = /^s[a-z2-7]{61}$/;

/** The frame roots `_app` hands the client (`~/server/utils/app-frame-domains`). */
export type AppFrameDomains = { appsDomain: string | null; previewDomain: string | null };
