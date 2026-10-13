/**
 * Master kill-switch for the standalone-URL screenshot autogen. `false` because
 * the standalone `<slug>.<APPS_DOMAIN>` URL renders only a waiting-for-host
 * skeleton (blocks require the host `BLOCK_INIT` postMessage), so every capture
 * is a useless loading skeleton. Real screenshots come from creator/dev upload
 * (or a future in-host `/apps/run/<slug>` capture). Flip to `true` ONLY once a
 * capture target that actually renders the block exists. Every public entry
 * point in `autogenerate-screenshot.service` short-circuits to a no-op while
 * this is `false`.
 *
 * Its own module so callers that only read the switch don't load the service.
 */
export const BLOCK_SCREENSHOT_AUTOGEN_ENABLED: boolean = false;
