import { describe, expect, it } from 'vitest';
import { AGENT_BUILD_PROMPT, AGENT_ONBOARDING_URL } from '~/components/Apps/cliCommands';

/**
 * 🔴 THE PROMPT'S BYTES, IN THE TIER A HUMAN ACTUALLY READS.
 *
 * These two assertions need no DOM, and they were originally written in
 * `AgentOnboardingCard.browser.test.tsx` — the `component` project, which
 * `.github/workflows/lint.yml` does not run at all ("🔴 GEOMETRY ONLY; `component` IS STILL
 * UNGATED … its only CI home is the preview pipeline's report-only
 * `preview / component-tests`"). So the single strongest claim in the whole change — that we
 * have not quietly altered the instruction we hand people's coding agents — was reported
 * nowhere. Moved here, beside `appsBuildState.test.ts`, which the `unit` project picks up.
 *
 * The browser suite keeps the assertion that genuinely needs a DOM: that these bytes are what
 * reaches the clipboard. This file is about the constant; that one is about the affordance.
 *
 * 🔴 A COSMETIC REWORD FAILS THIS FILE, ON PURPOSE. The string is an instruction an
 * autonomous agent executes, and the repo that owns the URL cannot see this copy — its
 * anti-rot checker is repo-local by design. A guard on a few keywords would be walkable by
 * any reword that kept them. See `~/components/Apps/cliCommands`'s note on
 * {@link AGENT_ONBOARDING_URL} for what is and is not guarded on either side.
 */

/**
 * Written from the specification, not copied from the implementation, and concatenated with
 * an explicit `'\n' + '\n'` so the blank line between the two paragraphs is unambiguous in
 * the source — it is part of the bytes the clipboard receives, and
 * `AgentOnboardingCard.module.scss`'s `white-space: pre-line` exists to render it. The em
 * dash (U+2014) and that blank line are both inside this literal, so both are pinned by the
 * one `toBe` below; neither needs its own assertion.
 */
const EXPECTED_PROMPT =
  'Read https://civitai.com/agent-onboarding and complete the setup, then tell me if I need to run `civitai login`.\n' +
  '\n' +
  'Then ask me clarifying questions about my app idea and build it — with a custom theme built on @civitai/theme tokens, and complete test coverage.';

describe('🔴 the agent onboarding prompt is these exact bytes', () => {
  it('matches the specified string, blank line and em dash included', () => {
    expect(AGENT_BUILD_PROMPT).toBe(EXPECTED_PROMPT);
  });

  it('pins the onboarding URL independently of the prompt', () => {
    // The one claim the assertion above does not already make: `AGENT_ONBOARDING_URL` is
    // exported and read elsewhere, so it is pinned on its own rather than only through the
    // prompt that interpolates it.
    expect(AGENT_ONBOARDING_URL).toBe('https://civitai.com/agent-onboarding');
  });
});
