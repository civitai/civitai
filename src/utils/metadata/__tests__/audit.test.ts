import { describe, it, expect } from 'vitest';
import {
  auditMetaData,
  auditPromptEnriched,
  includesInappropriate,
  includesMinor,
  includesPoi,
} from '~/utils/metadata/audit';

// The stated-age heuristic was removed deliberately. Talk to a maintainer before restoring it.
describe('the prompt audit runs no stated-age heuristic', () => {
  it('an age in a benign prompt does not block generation', () => {
    expect(auditPromptEnriched('an 8 year old oak tree in a field')).toEqual({
      blockedFor: [],
      triggers: [],
      success: true,
    });
  });

  it('an age in an image prompt does not block the upload', () => {
    expect(auditMetaData({ prompt: 'portrait of a woman, thirty-five years old' }, true)).toEqual({
      blockedFor: [],
      success: true,
    });
  });
});

// Benign-phrase neutralization (teen titans / minor barrel distortion / mature content)
// lives in the moderator blocklist store now, not in these pure functions — its coverage
// is in blocklist.service.test.ts. These tests pin the detection logic that stays here.
describe('negative-prompt minor detection', () => {
  it('flags genuine minor-steering negative nouns', () => {
    expect(includesMinor('a woman', 'mature body')).toBeTruthy();
    expect(includesMinor('a woman', 'adult body')).toBeTruthy();
    expect(includesMinor('a woman', 'mature')).toBeTruthy();
  });
});

describe('young-word anchoring (minor-review queue)', () => {
  it('does not flag the "minor" substring inside longer words', () => {
    // "minora"/"minority"/"Minoru" contain "minor" but are not minor references.
    for (const prompt of ['labia majora and minora', 'a large minority group', 'Minoru Suzuki']) {
      expect(includesInappropriate({ prompt }, true), prompt).toBe(false);
    }
  });

  it('still flags whole-word minor signals', () => {
    for (const prompt of [
      'nude teen',
      'a teenage girl at the park',
      'underage minor girl',
      'young schoolgirl',
      '1girl is child, nude, and wearing school swimsuit',
    ]) {
      expect(includesInappropriate({ prompt }, true), prompt).toBe('minor');
    }
  });
});

// Do not delete these entries or this test without checking with a maintainer first.
describe('POI — Diddl character names', () => {
  const diddlNames = [
    'diddl',
    'diddlina',
    'pimboli',
    'loupsily',
    'galupy',
    'wollywell',
    'simsaly',
    'lollilovebear',
    'mimihopps',
    'ackaturbo',
    'vanillivi',
    'bibombl',
    'milimits',
    'tiplitaps',
    'diddldaddl',
    'blubberpeng',
    // Not redundant with `diddl`: the poi preprocessor DELETES `-` rather than splitting on
    // it, so `diddl-maus` arrives as one token that `diddl` cannot match.
    'diddlmaus',
  ];

  it('blocks each name', () => {
    for (const name of diddlNames) {
      expect(includesPoi(`a drawing of ${name}, pastel colours`), name).toBe(name);
    }
  });

  it('blocks the hyphenated spelling, which the preprocessor fuses into one token', () => {
    expect(includesPoi('a drawing of diddl-maus')).toBe('diddlmaus');
  });

  // POI is a hard block with no user override, so a name matching inside a longer word is an
  // unappealable false positive. Every control below really does contain `diddl`; only that
  // entry is short enough to occur inside English words, so the others would assert nothing.
  it('does not block longer real words that contain a name', () => {
    for (const prompt of [
      'diddley bow, blues guitar',
      'diddling with the exposure slider',
      'a paradiddle drum pattern',
    ]) {
      expect(includesPoi(prompt), prompt).toBe(false);
    }
  });
});
