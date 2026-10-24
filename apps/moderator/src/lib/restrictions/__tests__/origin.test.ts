import { describe, expect, it } from 'vitest';
import { originSummary, planRemixSources, sourceState, triggerOrigin } from '../origin';

const remix = (promptMatch: 'identical' | 'edited' | 'unrelated' | 'unknown', verified = true) => ({
  prompt: 'p',
  origin: { remix: { imageId: 9, verified, promptMatch } },
});

const typed = { prompt: 'typed', origin: {} };

describe('triggerOrigin', () => {
  it.each([
    ['identical', 'Remix of #9 · unchanged'],
    ['edited', 'Remix of #9 · edited'],
    ['unrelated', 'Remix of #9 · unrelated'],
    ['unknown', 'Remix of #9 · not compared'],
  ] as const)('labels a %s remix', (match, label) => {
    expect(triggerOrigin(remix(match))).toMatchObject({
      kind: 'remix',
      label,
      imageId: 9,
      verified: true,
      match,
    });
  });

  it('carries an unverified remix claim through', () => {
    expect(triggerOrigin(remix('identical', false))).toMatchObject({
      kind: 'remix',
      verified: false,
    });
  });

  it('labels an enhancer output', () => {
    const view = triggerOrigin({
      prompt: 'p',
      origin: { enhancer: { workflowId: 'w', verified: false, promptMatch: 'edited' } },
    });
    expect(view).toMatchObject({
      kind: 'enhancer',
      label: 'Prompt enhancer output · edited',
      match: 'edited',
      verified: false,
    });
  });

  it('carries a verified enhancer through', () => {
    const view = triggerOrigin({
      prompt: 'p',
      origin: { enhancer: { workflowId: 'w', verified: true, promptMatch: 'identical' } },
    });
    expect(view.verified).toBe(true);
  });

  it('treats an enhancer record with no verified flag as unverified', () => {
    const view = triggerOrigin({
      prompt: 'p',
      origin: { enhancer: { workflowId: 'w', promptMatch: 'identical' } } as never,
    });
    expect(view.verified).toBe(false);
  });

  it('puts a remix first and notes an enhancer beside it', () => {
    const view = triggerOrigin({
      prompt: 'p',
      origin: {
        remix: { imageId: 3, verified: true, promptMatch: 'identical' },
        enhancer: { workflowId: 'w', verified: false, promptMatch: 'identical' },
      },
    });
    expect(view.kind).toBe('remix');
    expect(view.alsoEnhancer).toBe(true);
    expect(view.enhancerVerified).toBe(false);
  });

  it('carries the enhancer evidence verification beside a remix', () => {
    const view = triggerOrigin({
      prompt: 'p',
      origin: {
        remix: { imageId: 3, verified: true, promptMatch: 'identical' },
        enhancer: { workflowId: 'w', verified: true, promptMatch: 'identical' },
      },
    });
    expect(view.enhancerVerified).toBe(true);
  });

  it('reads the legacy remixOfId as an unverified, uncompared remix', () => {
    expect(triggerOrigin({ prompt: 'p', remixOfId: 12 })).toMatchObject({
      kind: 'legacy-remix',
      label: 'Remix of #12 · not compared',
      imageId: 12,
      verified: false,
      match: 'unknown',
    });
  });

  it('prefers origin over the legacy field', () => {
    expect(triggerOrigin({ ...remix('edited'), remixOfId: 12 }).imageId).toBe(9);
  });

  it('calls a prompt whose recorded origin is empty typed by the user', () => {
    expect(triggerOrigin({ prompt: 'a prompt', origin: {} })).toMatchObject({
      kind: 'typed',
      label: 'Typed by user',
    });
  });

  it('does not claim a prompt with no recorded origin was typed', () => {
    expect(triggerOrigin({ prompt: 'a prompt' })).toMatchObject({
      kind: 'unrecorded',
      label: 'Origin not recorded',
      verified: false,
      match: 'unknown',
    });
  });

  it('says nothing for a trigger that is not a generation prompt', () => {
    expect(triggerOrigin({ text: 'scanned text', category: 'scam' }).kind).toBe('none');
    expect(triggerOrigin({}).kind).toBe('none');
  });

  it('calls a prompt whose origin lookup failed with no evidence incomplete, never typed', () => {
    expect(triggerOrigin({ prompt: 'a prompt', origin: { incomplete: true } })).toMatchObject({
      kind: 'incomplete',
      label: 'Origin lookup incomplete',
      incomplete: true,
    });
  });

  it('flags partial evidence as incomplete without losing the evidence', () => {
    const view = triggerOrigin({
      prompt: 'p',
      origin: { incomplete: true, remix: { imageId: 9, verified: true, promptMatch: 'edited' } },
    });
    expect(view).toMatchObject({ kind: 'remix', incomplete: true, imageId: 9 });
    expect(triggerOrigin(remix('edited')).incomplete).toBe(false);
  });

  it('ignores a legacy id that is null or zero', () => {
    expect(triggerOrigin({ prompt: 'p', remixOfId: null }).kind).toBe('unrecorded');
    expect(triggerOrigin({ prompt: 'p', remixOfId: 0 }).kind).toBe('unrecorded');
    expect(triggerOrigin({ prompt: 'p', origin: {}, remixOfId: 0 }).kind).toBe('typed');
  });
});

describe('originSummary', () => {
  it('is empty for no prompt triggers', () => {
    expect(originSummary([])).toEqual({ verdict: null, chip: '' });
    expect(originSummary([{ text: 'x' }])).toEqual({ verdict: null, chip: '' });
  });

  it('leads with verified remixes left unchanged', () => {
    const { verdict, chip } = originSummary([
      remix('identical'),
      remix('identical'),
      remix('identical'),
      typed,
    ]);
    expect(verdict).toBe(
      '3 of 4 blocked prompts came from remixes and were left unchanged (1 typed)'
    );
    expect(chip).toBe('3 remix · 1 typed');
  });

  it('does not call an unverified identical remix unchanged', () => {
    expect(originSummary([remix('identical', false)]).verdict).toBe(
      '1 of 1 blocked prompt came from a remix that could not be confirmed'
    );
  });

  it('does not count an unrelated remix as edited', () => {
    expect(originSummary([remix('edited'), remix('unrelated'), typed]).verdict).toBe(
      '1 of 3 blocked prompts came from remixes and were edited (1 with a remix source but an unrelated prompt, 1 typed)'
    );
  });

  it('gives an unrelated remix its own wording', () => {
    expect(originSummary([remix('unrelated')])).toEqual({
      verdict: '1 of 1 blocked prompt had a remix source but an unrelated prompt',
      chip: '1 remix',
    });
  });

  it('does not assert an unverified edited or unrelated remix as fact', () => {
    expect(originSummary([remix('edited', false), remix('unrelated', false)]).verdict).toBe(
      '2 of 2 blocked prompts came from remixes that could not be confirmed'
    );
  });

  it('counts a legacy remix as unconfirmed', () => {
    const summary = originSummary([{ prompt: 'p', remixOfId: 4 }]);
    expect(summary.verdict).toBe(
      '1 of 1 blocked prompt came from a remix that could not be confirmed'
    );
    expect(summary.chip).toBe('1 remix (unconfirmed)');
  });

  it('shows unconfirmed remix claims apart from confirmed ones in the chip', () => {
    expect(
      originSummary([remix('identical'), remix('edited', false), remix('identical', false)]).chip
    ).toBe('1 remix · 2 remix (unconfirmed)');
  });

  it('mentions the enhancer', () => {
    const enhancer = {
      prompt: 'p',
      origin: { enhancer: { workflowId: 'w', verified: true, promptMatch: 'identical' as const } },
    };
    expect(originSummary([enhancer, typed])).toEqual({
      verdict: '1 of 2 blocked prompts came from the prompt enhancer (1 typed)',
      chip: '1 enhancer · 1 typed',
    });
  });

  it('does not state an unverified enhancer match as fact', () => {
    const enhancer = {
      prompt: 'p',
      origin: { enhancer: { workflowId: 'w', verified: false, promptMatch: 'identical' as const } },
    };
    expect(originSummary([enhancer, typed])).toEqual({
      verdict:
        '1 of 2 blocked prompts matched a prompt enhancer output that could not be confirmed (1 typed)',
      chip: '1 enhancer (unconfirmed) · 1 typed',
    });
  });

  it('counts a failed lookup with no evidence as incomplete, not typed', () => {
    const incomplete = { prompt: 'p', origin: { incomplete: true as const } };
    expect(originSummary([incomplete])).toEqual({
      verdict: 'Origin lookup incomplete for the blocked prompt',
      chip: '1 incomplete',
    });
    expect(originSummary([incomplete, typed])).toEqual({
      verdict: '1 of 2 blocked prompts were typed by the user (1 origin lookup incomplete)',
      chip: '1 typed · 1 incomplete',
    });
  });

  it('notes partial evidence from an incomplete lookup', () => {
    const partial = {
      prompt: 'p',
      origin: {
        incomplete: true as const,
        remix: { imageId: 9, verified: true, promptMatch: 'identical' as const },
      },
    };
    expect(originSummary([partial]).verdict).toBe(
      '1 of 1 blocked prompt came from a remix and was left unchanged (1 origin lookup incomplete)'
    );
  });

  it('says plainly when every prompt was typed', () => {
    expect(originSummary([{ ...typed }, { ...typed }]).verdict).toBe(
      'All 2 blocked prompts were typed by the user'
    );
    expect(originSummary([typed]).verdict).toBe('The blocked prompt was typed by the user');
  });

  it('says an unrecorded origin is not recorded, never typed', () => {
    expect(originSummary([{ prompt: 'a' }, { prompt: 'b' }])).toEqual({
      verdict: 'Origin not recorded for 2 blocked prompts (recorded before origin tracking)',
      chip: '2 not recorded',
    });
    expect(originSummary([{ prompt: 'a' }]).verdict).toBe(
      'Origin not recorded for the blocked prompt (recorded before origin tracking)'
    );
  });

  it('counts unrecorded prompts apart from typed and remix ones', () => {
    expect(originSummary([remix('identical'), typed, { prompt: 'a' }, { prompt: 'b' }])).toEqual({
      verdict:
        '1 of 4 blocked prompts came from remixes and were left unchanged (1 typed, 2 not recorded)',
      chip: '1 remix · 1 typed · 2 not recorded',
    });
  });

  it('leads with typed when nothing else has evidence', () => {
    expect(originSummary([typed, { prompt: 'a' }]).verdict).toBe(
      '1 of 2 blocked prompts were typed by the user (1 not recorded)'
    );
  });

  it('lists the other origins after the lead', () => {
    expect(originSummary([remix('identical'), remix('edited'), remix('unknown')]).verdict).toBe(
      '1 of 3 blocked prompts came from remixes and were left unchanged (1 edited remix, 1 unconfirmed remix)'
    );
  });
});

describe('planRemixSources', () => {
  it('collects distinct ids from origin and the legacy field', () => {
    expect(
      planRemixSources([
        { triggers: [remix('edited'), { prompt: 'p', remixOfId: 12 }, { prompt: 'typed' }] },
        { triggers: [remix('identical'), { text: 'x', remixOfId: null }] },
      ])
    ).toEqual({ lookup: [9, 12], notLoaded: [] });
  });

  it('bounds the lookup and reports the ids it left out', () => {
    const triggers = Array.from({ length: 400 }, (_, i) => ({ prompt: 'p', remixOfId: i + 1 }));
    const { lookup, notLoaded } = planRemixSources([{ triggers }]);
    expect(lookup).toHaveLength(300);
    expect(notLoaded).toHaveLength(100);
    expect(notLoaded[0]).toBe(301);
  });
});

describe('sourceState', () => {
  const sources = { 9: { id: 9 } };
  it('is loaded when the source came back', () => {
    expect(sourceState(9, { sources, failed: false, notLoaded: [] })).toBe('loaded');
  });
  it('is missing only when it was looked up and not returned', () => {
    expect(sourceState(10, { sources, failed: false, notLoaded: [] })).toBe('missing');
  });
  it('is not-loaded for an id outside the lookup, never missing', () => {
    expect(sourceState(301, { sources, failed: false, notLoaded: [301] })).toBe('not-loaded');
    expect(sourceState(301, { sources, failed: true, notLoaded: [301] })).toBe('not-loaded');
  });
  it('is failed when the lookup failed', () => {
    expect(sourceState(10, { sources: {}, failed: true, notLoaded: [] })).toBe('failed');
  });
});
