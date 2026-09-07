/**
 * Canonical Civitai App-Blocks CLI commands + ecosystem links — the SINGLE
 * source within civitai-web for the get-started page (`GetStartedBody`) and the
 * submit CTA (`CliSubmitCta`), so the two surfaces can't drift.
 *
 * SOURCE OF TRUTH is the `civitai/cli` repo (its README "## Quickstart" +
 * `internal/cmd/app_init.go` printed next-steps). The CLI exposes no
 * machine-readable manifest today, so these are kept in sync MANUALLY — update
 * here when the CLI's canonical quickstart changes; the `*.browser.test.tsx`
 * suites pin the exact strings so any change is a deliberate, reviewed edit.
 */

// --- Ecosystem links ---
/**
 * Where the `/apps/build` pitch's "Request access" CTA points.
 *
 * 🔴 THIS IS THE COMMUNITY DISCORD, NOT A REQUEST-ACCESS ENDPOINT, AND THE DIFFERENCE
 * IS DELIBERATELY NOT PAPERED OVER. `appBlocksAuthor` is a Flipt flag with no self-serve
 * path: there is no DB row, no invite mechanism, no form, and no queue. The flag's own
 * comment in `feature-flags.service.ts` says the get-started widen is blocked on "the
 * real Request-access link" — a destination that has never existed. So rather than
 * fabricate a URL nothing serves, this points at the one channel the repo ALREADY treats
 * as the place a person asks a human for something: `/discord`.
 *
 * `/discord` rather than a raw `discord.gg` URL because it is a real, permanent redirect
 * defined in `next.config.mjs` and asserted to exist by
 * `src/__tests__/pages/apps-build-redirects.test.ts` (which absorbed the retired
 * `apps-my-submissions-redirect.test.ts` this note used to cite), and it is already the
 * community-help CTA in `~/components/Support/SupportContent`. That makes it the
 * canonical in-repo spelling, and it survives the invite link being rotated.
 *
 * 🔴 REPOINT THIS when a real access flow lands — that is the whole reason it is a named
 * constant with this note rather than an inline `href`. The CTA's copy is deliberately
 * "Ask about access" rather than "Request access", so the button does not promise a
 * mechanism that is not behind it.
 */
export const APPS_REQUEST_ACCESS_HREF = '/discord';
export const CIVITAI_CLI_GITHUB_URL = 'https://github.com/civitai/cli';
export const BLOCKS_REACT_NPM_URL = 'https://www.npmjs.com/package/@civitai/blocks-react';
export const APP_SDK_NPM_URL = 'https://www.npmjs.com/package/@civitai/app-sdk';

// --- Install ---
/**
 * 🔴 EVERY ROUTE BELOW WAS VERIFIED AGAINST THE CLI's OWN RELEASE ARTEFACTS, not
 * assumed — the previous submit CTA advertised ONLY `brew`, which stops a Windows
 * developer at step 1 of 3.
 *
 * Verified 2026-08-21 against `civitai/cli` (README "## Install", plus the `v0.1.99`
 * release assets and the npm registry):
 *  - npm      — `@civitai/cli` is published (60 versions, `latest` = 0.1.99); the
 *               package is a thin wrapper that downloads the matching prebuilt binary
 *               and verifies its sha256 against the release `checksums.txt`. It is the
 *               only ONE-LINER that covers Windows, so it leads.
 *  - brew     — macOS / Linux only, by construction.
 *  - releases — the release carries `windows_amd64` / `windows_arm64` (.exe + .zip)
 *               alongside linux/darwin × amd64/arm64, so a no-toolchain download is a
 *               real Windows route and is named as one.
 *  - go       — from source, Go 1.25+ (already used by the get-started page).
 *
 * The CLI publishes no machine-readable manifest, so these stay MANUALLY in sync;
 * the `*.browser.test.tsx` suites pin the exact strings so a change is deliberate.
 */
export const CLI_INSTALL_NPM = 'npm install -g @civitai/cli';
export const CLI_INSTALL_BREW = 'brew install civitai/tap/civitai';
export const CLI_INSTALL_GO = 'go install github.com/civitai/cli/cmd/civitai@latest';
/** Prebuilt binaries — linux, macOS and **windows** × amd64/arm64. */
export const CIVITAI_CLI_RELEASES_URL = 'https://github.com/civitai/cli/releases';

// --- Author / run / submit ---
/** Bare `civitai app create` (the submit CTA's form). */
export const CLI_CREATE_COMMAND = 'civitai app create';
/** With-sample-name form the quickstart uses. */
export const CLI_CREATE_SAMPLE_COMMAND = 'civitai app create my-app';
// The CLI does NOT install deps on `create`; its own next-step prompt is
// `cd <dir> && npm install && npm run dev:harness`. `dev:harness` serves a MOCK
// host at localhost:5186 (plain `npm run dev` shows a blank screen — no host).
export const CLI_RUN_COMMAND = 'cd my-app && npm install && npm run dev:harness';
export const CLI_SUBMIT_COMMAND = 'civitai app submit';
