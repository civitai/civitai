import { describe, it, expect } from 'vitest';
import type { DerivedLabelInput } from '../scanner-derived-labels.service';
import {
  applyDerivedLabels,
  diffDerivedLabels,
} from '../scanner-derived-labels.service';

function row(
  label: string,
  triggered: 0 | 1,
  score = 0.6,
  extra: Partial<DerivedLabelInput> = {}
): DerivedLabelInput {
  return {
    label,
    score,
    threshold: 0.5,
    triggered,
    version: 'v1',
    matchedText: [],
    matchedPositivePrompt: [],
    matchedNegativePrompt: [],
    ...extra,
  };
}

describe('applyDerivedLabels', () => {
  describe('passthrough', () => {
    it('returns empty for empty input', () => {
      expect(applyDerivedLabels([], 'prompt')).toEqual([]);
    });

    it('passes through a single non-matching row unchanged', () => {
      const out = applyDerivedLabels([row('bestiality', 0)], 'prompt');
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        label: 'bestiality',
        synthetic: false,
        derivedFrom: [],
      });
    });

    it('keeps suggestive when explicit did NOT trigger', () => {
      const out = applyDerivedLabels(
        [row('suggestive', 1), row('explicit', 0)],
        'prompt'
      );
      const labels = out.map((r) => r.label).sort();
      expect(labels).toEqual(['explicit', 'suggestive']);
    });

    it('keeps explicit alone when suggestive did NOT trigger', () => {
      // explicit-without-suggestive shouldn't happen under the hierarchy but
      // the suppression rule doesn't apply (no suggestive to suppress).
      const out = applyDerivedLabels([row('explicit', 1), row('suggestive', 0)], 'prompt');
      expect(out.map((r) => r.label).sort()).toEqual(['explicit', 'suggestive']);
    });
  });

  describe('suppression (suggestive when explicit)', () => {
    it('suppresses suggestive when explicit also triggered', () => {
      const out = applyDerivedLabels(
        [row('suggestive', 1), row('explicit', 1)],
        'prompt'
      );
      const labels = out.map((r) => r.label);
      expect(labels).toContain('explicit');
      expect(labels).not.toContain('suggestive');
    });

    it('does not suppress when only suggestive triggered', () => {
      const out = applyDerivedLabels(
        [row('suggestive', 1), row('explicit', 0)],
        'prompt'
      );
      expect(out.map((r) => r.label)).toContain('suggestive');
    });

    it('applies in text mode the same as prompt mode', () => {
      const out = applyDerivedLabels(
        [row('suggestive', 1), row('explicit', 1)],
        'text'
      );
      expect(out.map((r) => r.label)).not.toContain('suggestive');
    });
  });

  describe('derivation (csam = young AND any sexual signal)', () => {
    it('does not synthesize csam without young', () => {
      const out = applyDerivedLabels(
        [row('explicit', 1), row('suggestive', 1)],
        'prompt'
      );
      expect(out.map((r) => r.label)).not.toContain('csam');
    });

    it('does not synthesize csam without any sexual signal', () => {
      const out = applyDerivedLabels([row('young', 1)], 'prompt');
      expect(out.map((r) => r.label)).not.toContain('csam');
    });

    it('synthesizes csam when young + explicit triggered', () => {
      const out = applyDerivedLabels(
        [row('young', 1, 0.6), row('explicit', 1, 0.9)],
        'prompt'
      );
      const csam = out.find((r) => r.label === 'csam');
      expect(csam).toBeDefined();
      expect(csam!.synthetic).toBe(true);
      expect(csam!.triggered).toBe(1);
      expect(csam!.threshold).toBeNull();
      expect(csam!.derivedFrom).toEqual(['young', 'explicit']);
      // score = min of contributing labels
      expect(csam!.score).toBe(0.6);
    });

    it('synthesizes csam when young + suggestive triggered (no explicit)', () => {
      const out = applyDerivedLabels(
        [row('young', 1), row('suggestive', 1)],
        'prompt'
      );
      const csam = out.find((r) => r.label === 'csam');
      expect(csam).toBeDefined();
      expect(csam!.derivedFrom).toEqual(['young', 'suggestive']);
    });

    it('prefers the first matching any-of input', () => {
      // both suggestive and explicit triggered — derivation picks the first
      // listed match (suggestive) per the requiresAnyOf array order. (Note:
      // when both fire, suggestive is normally suppressed by the
      // explicit-dominates-suggestive rule, but derivation reads the
      // PRE-suppression set, so suggestive is still visible here.)
      const out = applyDerivedLabels(
        [row('young', 1), row('suggestive', 1), row('explicit', 1)],
        'prompt'
      );
      const csam = out.find((r) => r.label === 'csam');
      expect(csam!.derivedFrom).toEqual(['young', 'suggestive']);
    });

    it('text mode also accepts nsfw as the sexual signal', () => {
      const out = applyDerivedLabels(
        [row('young', 1), row('nsfw', 1)],
        'text'
      );
      expect(out.find((r) => r.label === 'csam')).toBeDefined();
    });

    it('synthesizes csam in text mode the same way', () => {
      const out = applyDerivedLabels(
        [row('young', 1), row('explicit', 1)],
        'text'
      );
      const csam = out.find((r) => r.label === 'csam');
      expect(csam).toBeDefined();
      expect(csam!.derivedFrom).toEqual(['young', 'explicit']);
    });

    it('does not fire when one of the requires labels did not trigger', () => {
      const out = applyDerivedLabels(
        [row('young', 0), row('explicit', 1)],
        'prompt'
      );
      expect(out.find((r) => r.label === 'csam')).toBeUndefined();
    });
  });

  describe('derivation (incest = familial AND any sexual signal)', () => {
    it('does not synthesize incest without familial', () => {
      const out = applyDerivedLabels([row('explicit', 1), row('suggestive', 1)], 'prompt');
      expect(out.map((r) => r.label)).not.toContain('incest');
    });

    it('does not synthesize incest without any sexual signal', () => {
      const out = applyDerivedLabels([row('familial', 1)], 'prompt');
      expect(out.map((r) => r.label)).not.toContain('incest');
    });

    it('synthesizes incest when familial + explicit triggered', () => {
      const out = applyDerivedLabels(
        [row('familial', 1, 0.7), row('explicit', 1, 0.9)],
        'prompt'
      );
      const incest = out.find((r) => r.label === 'incest');
      expect(incest).toBeDefined();
      expect(incest!.synthetic).toBe(true);
      expect(incest!.triggered).toBe(1);
      expect(incest!.derivedFrom).toEqual(['familial', 'explicit']);
      expect(incest!.score).toBe(0.7); // min of contributing scores
    });

    it('synthesizes incest when familial + suggestive triggered (no explicit)', () => {
      const out = applyDerivedLabels(
        [row('familial', 1), row('suggestive', 1)],
        'prompt'
      );
      const incest = out.find((r) => r.label === 'incest');
      expect(incest).toBeDefined();
      expect(incest!.derivedFrom).toEqual(['familial', 'suggestive']);
    });

    it('strips an input incest row when the rule does not fire', () => {
      // Incest is now a derivation-owned name. A raw `incest` row in the
      // input (e.g. from a stale XGuard scan before Familial was added)
      // should be stripped if the rule doesn't fire.
      const out = applyDerivedLabels([row('incest', 1)], 'prompt');
      expect(out.find((r) => r.label === 'incest')).toBeUndefined();
    });

    it('replaces an input incest row with a freshly-derived one', () => {
      const out = applyDerivedLabels(
        [row('incest', 1), row('familial', 1), row('explicit', 1)],
        'prompt'
      );
      const incests = out.filter((r) => r.label === 'incest');
      expect(incests).toHaveLength(1);
      expect(incests[0].synthetic).toBe(true);
      expect(incests[0].derivedFrom).toEqual(['familial', 'explicit']);
    });
  });

  describe('derivation rules own their label name', () => {
    it('strips an input csam row when the rule does not fire', () => {
      // Synthetic-label names are owned by derivation rules. If a `csam`
      // row arrives in the input but the rule (young + sexual-signal)
      // doesn't fire, the output should NOT contain csam.
      const out = applyDerivedLabels(
        [row('csam', 1), row('bestiality', 0)],
        'prompt'
      );
      expect(out.find((r) => r.label === 'csam')).toBeUndefined();
    });

    it('replaces an input csam row with a freshly-derived one', () => {
      // Input has csam (perhaps from a prior derivation), and the rule
      // fires too. The output should contain exactly one csam, with the
      // synthetic flag — the input csam is stripped and re-derived.
      const out = applyDerivedLabels(
        [row('csam', 1), row('young', 1), row('explicit', 1)],
        'prompt'
      );
      const csams = out.filter((r) => r.label === 'csam');
      expect(csams).toHaveLength(1);
      expect(csams[0].synthetic).toBe(true);
      expect(csams[0].derivedFrom).toEqual(['young', 'explicit']);
    });
  });

  describe('derivation reads pre-suppression set', () => {
    it('fires csam when its only sexual signal is being suppressed', () => {
      // suggestive will be suppressed (because explicit fires), but csam
      // derivation should still see suggestive in its any-of check.
      const out = applyDerivedLabels(
        [row('young', 1), row('suggestive', 1), row('explicit', 1)],
        'prompt'
      );
      // suggestive suppressed
      expect(out.find((r) => r.label === 'suggestive')).toBeUndefined();
      // explicit kept
      expect(out.find((r) => r.label === 'explicit')).toBeDefined();
      // csam derived — requiresAnyOf is [suggestive, explicit], suggestive is
      // first matching, so derivedFrom should be [young, suggestive]
      const csam = out.find((r) => r.label === 'csam');
      expect(csam).toBeDefined();
      expect(csam!.derivedFrom).toEqual(['young', 'suggestive']);
    });
  });

  describe('matched-term aggregation on synthetic rows', () => {
    it('unions and dedupes matched terms across contributing labels', () => {
      const out = applyDerivedLabels(
        [
          row('young', 1, 0.6, {
            matchedPositivePrompt: ['loli', 'child'],
            matchedNegativePrompt: ['adult'],
            matchedText: ['kid'],
          }),
          row('explicit', 1, 0.8, {
            matchedPositivePrompt: ['nude', 'child'], // 'child' duplicated, should dedupe
            matchedNegativePrompt: [],
            matchedText: ['nsfw'],
          }),
        ],
        'prompt'
      );
      const csam = out.find((r) => r.label === 'csam')!;
      expect(csam.matchedPositivePrompt.sort()).toEqual(['child', 'loli', 'nude']);
      expect(csam.matchedNegativePrompt).toEqual(['adult']);
      expect(csam.matchedText.sort()).toEqual(['kid', 'nsfw']);
    });

    it('preserves empty arrays correctly', () => {
      const out = applyDerivedLabels(
        [row('young', 1), row('suggestive', 1)],
        'prompt'
      );
      const csam = out.find((r) => r.label === 'csam')!;
      expect(csam.matchedText).toEqual([]);
      expect(csam.matchedPositivePrompt).toEqual([]);
      expect(csam.matchedNegativePrompt).toEqual([]);
    });
  });

  describe('idempotence', () => {
    it('applying twice produces the same result as applying once', () => {
      const input = [row('young', 1), row('suggestive', 1), row('explicit', 1)];
      const once = applyDerivedLabels(input, 'prompt');
      // Idempotence: rerunning on the output (after stripping synthetic
      // metadata so the input shape matches) should produce the same set of
      // label names and the same synthetic flag pattern.
      const stripped = once.map(({ synthetic: _s, derivedFrom: _d, ...rest }) => rest);
      const twice = applyDerivedLabels(stripped, 'prompt');

      const namesOnce = once.map((r) => r.label).sort();
      const namesTwice = twice.map((r) => r.label).sort();
      // The synthetic `csam` row re-feeds as if it were a real input on
      // pass 2, but since the derivation rule needs `young` + any-of-sexual
      // and the pre-synth `young`/`explicit` rows are still in `stripped`,
      // we'll re-derive `csam`. Important: it doesn't multiply (we still
      // emit one csam row per rule firing).
      expect(namesTwice.filter((n) => n === 'csam')).toHaveLength(1);
      // The non-csam labels should match between passes.
      const nonCsamOnce = namesOnce.filter((n) => n !== 'csam');
      const nonCsamTwice = namesTwice.filter((n) => n !== 'csam');
      expect(nonCsamTwice).toEqual(nonCsamOnce);
    });
  });
});

describe('diffDerivedLabels', () => {
  it('reports no diff when nothing was suppressed or synthesized', () => {
    const raw = [row('bestiality', 0)];
    const derived = applyDerivedLabels(raw, 'prompt');
    const d = diffDerivedLabels(raw, derived);
    expect(d.suppressed).toEqual([]);
    expect(d.synthesized).toEqual([]);
  });

  it('reports a suppressed label', () => {
    const raw = [row('suggestive', 1), row('explicit', 1)];
    const derived = applyDerivedLabels(raw, 'prompt');
    const d = diffDerivedLabels(raw, derived);
    expect(d.suppressed).toEqual(['suggestive']);
  });

  it('reports a synthesized label with its lineage', () => {
    const raw = [row('young', 1), row('explicit', 1)];
    const derived = applyDerivedLabels(raw, 'prompt');
    const d = diffDerivedLabels(raw, derived);
    expect(d.synthesized).toEqual([{ label: 'csam', derivedFrom: ['young', 'explicit'] }]);
  });

  it('reports both when both happen', () => {
    const raw = [row('young', 1), row('suggestive', 1), row('explicit', 1)];
    const derived = applyDerivedLabels(raw, 'prompt');
    const d = diffDerivedLabels(raw, derived);
    expect(d.suppressed).toEqual(['suggestive']);
    expect(d.synthesized).toEqual([{ label: 'csam', derivedFrom: ['young', 'suggestive'] }]);
  });
});
