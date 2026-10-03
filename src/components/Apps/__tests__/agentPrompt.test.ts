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
 * `AgentOnboardingCard.module.scss`'s `white-space: pre-line` exists to render it.
 */
const EXPECTED_PROMPT =
  'Read https://civitai.com/agent-onboarding and complete the setup, then tell me if I need to run `civitai login`.\n' +
  '\n' +
  'Then ask me clarifying questions about my app idea and build it — with a custom theme built on @civitai/theme tokens, and complete test coverage.';

describe('🔴 the agent onboarding prompt is these exact bytes', () => {
  it('matches the specified string, blank line and em dash included', () => {
    expect(AGENT_BUILD_PROMPT).toBe(EXPECTED_PROMPT);
  });

  it('carries the onboarding URL, so the two constants cannot drift apart', () => {
    // `AGENT_BUILD_PROMPT` interpolates `AGENT_ONBOARDING_URL`, so this holds structurally —
    // asserted anyway, because the interpolation is the kind of thing a later edit inlines.
    expect(AGENT_BUILD_PROMPT).toContain(AGENT_ONBOARDING_URL);
    expect(AGENT_ONBOARDING_URL).toBe('https://civitai.com/agent-onboarding');
  });

  it('uses an EM DASH, not a hyphen, and a real blank line between the paragraphs', () => {
    // Spelled out separately because both are invisible in a diff and neither would survive
    // a well-meant "tidy the punctuation" pass unnoticed. The em dash is U+2014.
    expect(AGENT_BUILD_PROMPT).toContain('—');
    expect(AGENT_BUILD_PROMPT.split('\n\n')).toHaveLength(2);
  });
});
