/**
 * `/apps/build` destinations, in one dependency-free module so pages, components and server-side
 * notification builders all link to the same URL.
 *
 * 🔴 "MY APPS" IS `/apps/build?view=apps`, NEVER BARE `/apps/build`. The page renders the App
 * Assistant for every viewer `canAccessAppAssistant` admits, and an AUTHOR can be one of them —
 * so bare `/apps/build` lands that author on the assistant, not on their app list. `?view=apps` is
 * the page's switch to the list for authors; for everyone else the page ignores it, so the same URL
 * is right for every viewer. (`next.config.mjs` cannot import TypeScript, so its `/apps/mine` and
 * `/apps/my-submissions` redirects spell the same URL literally; the redirects test pins it to
 * this constant.)
 */

/** `?view=` value that switches an author in the assistant view to their app list. */
export const APPS_BUILD_APPS_VIEW = 'apps';

/** Every "My apps" / "your submissions" link and redirect. */
export const MY_APPS_HREF = `/apps/build?view=${APPS_BUILD_APPS_VIEW}`;
