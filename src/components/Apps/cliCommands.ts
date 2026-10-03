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
 * path: there is no DB row, no invite mechanism, no form, and no queue. A "Request-access
 * link" has never existed. This note used to cite the `appBlocksGetStarted` comment in
 * `feature-flags.service.ts` as saying the get-started widen was blocked on one; `f5ad1d6deb`
 * rewrote that comment for a different reason and the sentence is gone, so the claim now has
 * NO citation anywhere in the repo — do not read one back in. So rather than fabricate a URL
 * nothing serves, this points at the one channel the repo ALREADY treats as the place a
 * person asks a human for something: `/discord`.
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

// --- Agent onboarding (the "let your agent build it" prompt) ---
/**
 * The short alias a developer's coding agent is told to read.
 *
 * 🔴 OWNED BY `civitai/civitai-developer-docs`, NOT BY THIS REPO.
 * `.vitepress/agent-setup.mjs` there declares `SHORT_PROMPT_URL` with this exact value and
 * builds its own `SETUP_PROMPT` from it, and `scripts/check-agent-setup.mjs` runs six
 * anti-rot checks over that surface — including a SINGLE SOURCE check that the page's
 * copy-paste string is byte-identical to the constant. That checker BLOCKS a PR there.
 *
 * 🔴 IT CANNOT SEE THIS FILE, AND THAT IS BY DESIGN RATHER THAN AN OVERSIGHT. Its own
 * header states every check is repo-local — "they read committed files only, make no network
 * request, and cannot false-fail on someone else's publish, which is the property this repo
 * requires of anything that blocks a PR". So the copy below is unguarded upstream: changing
 * `SHORT_PROMPT_URL` there leaves this constant behind with every check on both sides green.
 *
 * 🔴 AND THE URL ITSELF IS TRACKED IN NEITHER REPO. It is a Cloudflare 302 to
 * `https://developer.civitai.com/agent-setup/prompt.md` — a dashboard redirect rule, not a
 * Next.js route and not a rewrite. Measured 2026-10-03: `302` with that `location:`, then
 * `200` and 7,433 bytes. `git grep agent-onboarding` over this repo returns NOTHING but this
 * block (verified with a positive control on a neighbouring constant, so that zero is a real
 * absence and not a broken search), and `next.config.mjs` defines no such redirect — unlike
 * `APPS_REQUEST_ACCESS_HREF` above, whose `/discord` target IS a committed redirect with a
 * test asserting it exists. If the Cloudflare rule is moved or deleted, this constant
 * silently points at a 404 and nothing in either repo reports it.
 *
 * What DOES pin the pair is `__tests__/agentPrompt.test.ts` (the exact bytes, in the unit
 * tier) plus `AgentOnboardingCard.browser.test.tsx` (that those bytes are what reaches the
 * clipboard). That is a pin against an accidental edit HERE, not a check that upstream still
 * agrees — nothing in this repo can make that second claim.
 *
 * ⚠️ THE ALTERNATIVE THAT WAS CONSIDERED AND NOT TAKEN, recorded so it is a decision rather
 * than an oversight: the prompt could name `https://developer.civitai.com/agent-setup/prompt.md`
 * directly — the 302's own target, which IS covered by that PR-blocking checker — and drop
 * the alias hop entirely. It was kept because the alias is what upstream's own `SETUP_PROMPT`
 * advertises (`SHORT_PROMPT_URL` exists precisely to be the short human copy-paste form), so
 * using the canonical URL here would make the two surfaces disagree about what a developer is
 * told to paste — trading an ungated hop for a guaranteed divergence. Note the gain is also
 * smaller than it looks: both hostnames are civitai DNS, so the same CDN control plane
 * decides both; the alias removes one separately-editable rule, not the class. Revisit
 * together with upstream, not unilaterally.
 */
export const AGENT_ONBOARDING_URL = 'https://civitai.com/agent-onboarding';

/**
 * The prompt `/apps/build` offers for pasting into a coding agent.
 *
 * NOT the upstream `SETUP_PROMPT`, and the difference is the point. Upstream's is
 * setup-only ("Fetch and execute the appropriate instructions to set me up for Civitai
 * from <url>") and its own page says the flow stops before authentication — the last thing
 * it tells you is to run `civitai login` yourself. An agent handed the setup-only prompt
 * therefore reaches an auth wall with no instruction to surface it, so this one asks for
 * the login state back, then turns the session toward actually building something.
 *
 * The URL is interpolated rather than retyped, so the two constants cannot disagree.
 *
 * Wording notes, because each clause was a decision rather than prose:
 *  - "build it", not "dispatch to implement it" — the upstream page targets Claude Code,
 *    Cursor, Codex, opencode, Copilot, Windsurf and Zed; "dispatch" is Claude-Code subagent
 *    jargon that reads as a no-op in the others.
 *  - `@civitai/theme` is named so "a custom theme" is actionable against a real token
 *    system (see the `manage-design-system` surface) rather than an invitation to invent one.
 */
export const AGENT_BUILD_PROMPT = `Read ${AGENT_ONBOARDING_URL} and complete the setup, then tell me if I need to run \`civitai login\`.

Then ask me clarifying questions about my app idea and build it — with a custom theme built on @civitai/theme tokens, and complete test coverage.`;
