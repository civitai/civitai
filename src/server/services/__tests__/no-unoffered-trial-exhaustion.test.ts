import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * A spent generation trial used to render as inert red text naming the model and offering nothing — no
 * purchase, no link (868maecz9). The remedy is a priority chain in the generation footer, and there are
 * no footer tests to catch a regression in it (the component needs a dozen contexts) — the form generates
 * fine either way, so the loss is invisible until a non-buyer hits the wall.
 *
 * Textual, so it checks what text can: that the footer routes the error to the offer, that the offer is
 * reachable in the priority chain, and that the proactive warning yields to it. It says nothing about
 * either alert rendering correctly — `GenerationPaidAccessAlerts.browser.test.tsx` owns that.
 */

const repoRoot = path.resolve(__dirname, '../../../..');

const FOOTER = 'src/components/form-graph/generation/FormFooter.tsx';
const source = readFileSync(path.join(repoRoot, FOOTER), 'utf8');

describe('the generation footer offers purchase on a spent trial', () => {
  it('POSITIVE CONTROL — the footer still has the priority chain this guard reads', () => {
    expect(
      source,
      `${FOOTER} no longer contains \`let priorityAlert\`. The alert chain was restructured, so ` +
        `every assertion below is matching against a shape that no longer exists — fix this guard first.`
    ).toContain('let priorityAlert');
  });

  it('the footer routes a trial-exhausted message to the purchase offer', () => {
    expect(
      source,
      `${FOOTER} does not classify the trial-exhausted message. Without it the text falls through ` +
        `to a generic notification, which is the dead end this exists to close.`
    ).toContain('const blockingTrialMessage = [');
    expect(source).toContain('<TrialBlockedAlert');
  });

  /**
   * The same sentence arrives on three channels and only two of them BLOCK. Reading `submitError` alone
   * is what shipped an alert nobody saw — the whatIf rejects the estimate before a submit ever happens,
   * so the offer never rendered and a generic red banner drew instead.
   */
  it('the footer treats both blocking channels as blocking', () => {
    const block = /const blockingTrialMessage = \[([\s\S]*?)\]\.find\(/.exec(source);

    expect(
      block,
      `${FOOTER} no longer builds the candidate list this guard reads — fix this guard first.`
    ).not.toBeNull();
    for (const channel of ['submitError', 'whatIfError?.message']) {
      expect(
        block![1],
        `${FOOTER} does not consider \`${channel}\`. A trial block arriving on that channel ` +
          `renders as plain text with no way to buy.`
      ).toContain(channel);
    }
  });

  /**
   * And the advisory one must stay advisory. A step warning says how many trials are left without
   * refusing anything; promoting it to the blocking alert would tell a user with generations in hand
   * that they are stuck.
   */
  it('the footer does not treat the advisory warning as blocking', () => {
    const block = /const blockingTrialMessage = \[([\s\S]*?)\]\.find\(/.exec(source);

    expect(
      block![1],
      `${FOOTER} folds the step warning into the blocking list, so an advisory count renders as ` +
        `a refusal over a form that can still generate.`
    ).not.toContain('trialWarning');
  });

  it('the footer tests for it BEFORE the generic branches', () => {
    const trial = source.indexOf('} else if (blockingTrialMessage) {');
    const whatIf = source.indexOf('} else if (hasWhatIfError && whatIfError) {');
    const generic = source.indexOf('} else if (submitError) {');

    expect(generic, `No generic submitError branch found in ${FOOTER}.`).toBeGreaterThan(-1);
    expect(
      trial,
      `In ${FOOTER} a generic branch comes first. The chain is exclusive, so the offer is present ` +
        `in the source and unreachable at runtime — exactly the shape that shipped broken.`
    ).toBeLessThan(Math.min(whatIf, generic));
  });

  /** The trial warning must not ALSO render in the generic warnings banner beside the offer. */
  it('the footer excludes the trial warning from the warnings banner', () => {
    expect(
      source,
      `${FOOTER} feeds every whatIf warning to StepWarningsNotification, so the trial sentence ` +
        `renders twice — once as a banner and once as the offer.`
    ).toContain('<StepWarningsNotification warnings={otherWarnings} />');
    expect(source).toContain('const otherWarnings =');
  });

  it('the footer shows ONE alert, not the warning stacked on the error', () => {
    expect(
      source,
      `${FOOTER} renders <TrialAccessWarning /> unguarded. Once the trial is spent that warning ` +
        `("you get a limited number of free generations") is both stale and a second alert for one state.`
    ).toMatch(/\{whatIfSettled && !showingTrialAlert && \(?\s*<TrialAccessWarning\b/);
    expect(
      source,
      `${FOOTER} never sets \`showingTrialAlert\`, so the warning is suppressed unconditionally ` +
        `and the proactive half of the fix is dead.`
    ).toContain('showingTrialAlert = true');
    expect(
      source,
      `${FOOTER} does not pass the remaining count to the warning, so it falls back to vague copy ` +
        `while the orchestrator is telling us the exact number.`
    ).toContain('remaining={trialRemaining}');
  });

  /**
   * Entity access resolves well before the cost estimate, so an ungated advisory alert draws yellow and is
   * then replaced by the blocking one the moment the whatIf answers — a visible flash on every load of a
   * gated resource.
   */
  it('the footer waits for the estimate before advising', () => {
    expect(
      source,
      `${FOOTER} does not derive \`whatIfSettled\`, so the advisory alert renders before the whatIf ` +
        `has answered and flashes yellow-to-red.`
    ).toContain('const whatIfSettled = whatIfSucceeded || hasWhatIfError;');
  });

  /**
   * The trigger is a match on orchestrator PROSE, which is the weakest part of this fix. One copy with one
   * test can be repointed when upstream rewords; a copy inlined in a footer cannot be found.
   */
  it('the footer does not inline its own trial-error matcher', () => {
    const inlined = /\/[^/\n]*\btrial\b[^/\n]*\/[gimsuy]*\.test\(/i.exec(source);
    expect(
      inlined?.[0],
      `${FOOTER} matches the trial error with its own regex. Use parseTrialMessage from ` +
        `~/components/Generate/paid-access-gate so upstream rewording is one edit.`
    ).toBeUndefined();
  });
});
