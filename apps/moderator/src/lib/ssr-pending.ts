/**
 * What a derived fetch should be on the server: `browser ? fetch(…) : SSR_PENDING`, never `: null`.
 *
 * A promise that never settles, so SSR renders the `{#await}`'s pending branch — the branch the browser
 * starts in. With `null` the server renders `{:then}` (null is not a promise) and the browser hydrates
 * `pending`, and Svelte does not reconcile that: the content the browser renders lands outside the
 * enclosing block, so when a parent `{#key}` or `{#if}` later swaps the component out, that content
 * stays on the page and the replacement renders below it. Mods saw exactly this on the model reports
 * page — the report the page loaded on stuck at the top of the preview column, every other report
 * appended under it, and itself twice on return (`ssr-pending.test.ts` reproduces it).
 *
 * `{#if x}{#await x}` with `: null` is also correct — Svelte repairs a mismatched `{#if}`, just not an
 * `{#await}` — and is what a panel that should render nothing at all without JS uses.
 *
 * 🔴 Safe only while `svelte.config.js` leaves `compilerOptions.experimental.async` off. With async SSR
 * the server AWAITS an `{#await}` before rendering it, and this would hang the request instead.
 */
export const SSR_PENDING: Promise<never> = new Promise(() => {});
