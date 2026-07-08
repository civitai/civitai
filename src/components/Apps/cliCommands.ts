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
export const CIVITAI_CLI_GITHUB_URL = 'https://github.com/civitai/cli';
export const BLOCKS_REACT_NPM_URL = 'https://www.npmjs.com/package/@civitai/blocks-react';
export const APP_SDK_NPM_URL = 'https://www.npmjs.com/package/@civitai/app-sdk';

// --- Install ---
export const CLI_INSTALL_BREW = 'brew install civitai/tap/civitai';
export const CLI_INSTALL_GO = 'go install github.com/civitai/cli/cmd/civitai@latest';

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
