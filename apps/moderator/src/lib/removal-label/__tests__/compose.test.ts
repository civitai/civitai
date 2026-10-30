import { describe, expect, it } from 'vitest';
import { composeLabel, disagreement } from '../compose';
import type { Answers } from '../questions';

const base: Answers = {
  minorPresent: 'appears_minor',
  sexualLevel: 'none',
  violence: 'none',
  schoolSetting: 'other_setting',
};
const a = (over: Partial<Answers>): Answers => ({ ...base, ...over });

describe('composeLabel', () => {
  it.each([
    [a({ sexualLevel: 'partial_nudity' }), 'minor_sexual'],
    [a({ sexualLevel: 'suggestive_clothed' }), 'minor_sexual'],
    [
      a({ sexualLevel: 'explicit_nudity', schoolSetting: 'school_classroom_or_campus' }),
      'minor_sexual_school',
    ],
    // A uniform outside a school is NOT the school variant: fusing them recreates the label problem.
    [
      a({ sexualLevel: 'explicit_nudity', schoolSetting: 'school_uniform_only_no_school_setting' }),
      'minor_sexual',
    ],
    [
      a({ minorPresent: 'ambiguous_could_be_minor', violence: 'threat_or_aiming' }),
      'minor_violence',
    ],
    [a({ violence: 'weapon_present_no_threat' }), 'minor_no_mature_context'],
    [a({ minorPresent: 'clearly_adult', violence: 'graphic_gore' }), 'gore'],
    [a({ minorPresent: 'clearly_adult', sexualLevel: 'sexual_act' }), 'no_minor'],
    [a({ minorPresent: 'no_person_or_character' }), 'no_minor'],
  ] as const)('%o -> %s', (answers, expected) => {
    expect(composeLabel(answers)).toBe(expected);
  });

  it.each(['minorPresent', 'sexualLevel', 'violence', 'schoolSetting'] as const)(
    'proposes nothing when %s is cannot_tell',
    (q) => {
      expect(composeLabel(a({ sexualLevel: 'sexual_act', [q]: 'cannot_tell' }))).toBeNull();
    }
  );
});

describe('disagreement', () => {
  it('removed as minor-sexual, model sees a non-sexual minor: the accusation case', () => {
    expect(
      disagreement({ stratum: 'removed', bucket: 'animatedMinorNsfw' }, 'minor_violence')
    ).toBe('not_sexual');
    expect(
      disagreement({ stratum: 'removed', bucket: 'realisticMinorNsfw' }, 'minor_no_mature_context')
    ).toBe('not_sexual');
  });

  it('removed, model sees no minor', () => {
    expect(disagreement({ stratum: 'removed', bucket: 'schoolNsfw' }, 'no_minor')).toBe('no_minor');
    expect(disagreement({ stratum: 'removed', bucket: 'realisticMinor' }, 'gore')).toBe('no_minor');
  });

  it('realisticMinor is contradicted only by "no minor": style is not one of the questions', () => {
    expect(
      disagreement({ stratum: 'removed', bucket: 'realisticMinor' }, 'minor_no_mature_context')
    ).toBeNull();
  });

  it('school removal without a school setting', () => {
    expect(disagreement({ stratum: 'removed', bucket: 'schoolNsfw' }, 'minor_sexual')).toBe(
      'not_school'
    );
    expect(
      disagreement({ stratum: 'removed', bucket: 'schoolNsfw' }, 'minor_sexual_school')
    ).toBeNull();
  });

  it('a school proposal on a plain minor-sexual removal is a refinement, not a disagreement', () => {
    expect(
      disagreement({ stratum: 'removed', bucket: 'animatedMinorNsfw' }, 'minor_sexual_school')
    ).toBeNull();
  });

  it('not removed: the model flags what enforcement let through', () => {
    expect(disagreement({ stratum: 'not_removed' }, 'minor_sexual')).toBe('flags_minor_sexual');
    expect(disagreement({ stratum: 'not_removed' }, 'minor_sexual_school')).toBe(
      'flags_minor_sexual'
    );
    expect(disagreement({ stratum: 'not_removed' }, 'minor_violence')).toBe('flags_minor_violence');
    expect(disagreement({ stratum: 'not_removed' }, 'no_minor')).toBeNull();
    expect(disagreement({ stratum: 'not_removed' }, 'minor_no_mature_context')).toBeNull();
  });
});
