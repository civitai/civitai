import { describe, expect, it } from 'vitest';
import {
  isValidKnightsGameSetting,
  KNIGHTS_SOURCES_DEFAULT_MAX_OPEN,
  knightsSourcesMaxOpen,
  parseKnightsSourcesConfig,
  KNIGHTS_RULE_GUIDE_LIMITS,
  readKnightsSourcesConfig,
  readRuleGuide,
} from '../new-order';

describe('readKnightsSourcesConfig', () => {
  it.each([null, '', 'not json', '[]', '"on"', 'null'])('is not stored for %j', (raw) => {
    expect(readKnightsSourcesConfig(raw)).toEqual({
      stored: false,
      config: { enabled: false, sfwRate: 1, nsfwRate: 0.3 },
    });
  });

  it('is stored for an object, filling a missing rate with the default', () => {
    expect(readKnightsSourcesConfig('{"enabled":true,"sfwRate":0.05}')).toEqual({
      stored: true,
      config: { enabled: true, sfwRate: 0.05, nsfwRate: 0.3 },
    });
  });

  it('reads a Buffer like a string and agrees with parseKnightsSourcesConfig', () => {
    const raw = '{"enabled":true,"sfwRate":4,"nsfwRate":-1}';
    expect(parseKnightsSourcesConfig(Buffer.from(raw))).toEqual({
      enabled: true,
      sfwRate: 1,
      nsfwRate: 0,
    });
    expect(parseKnightsSourcesConfig(raw)).toEqual(readKnightsSourcesConfig(raw).config);
  });

  it.each([
    ['a fraction', 99.7],
    ['past the safe integer range', 2 ** 53],
  ])('leaves out a maxOpen that is %s, so the default applies', (_, maxOpen) => {
    const { config } = readKnightsSourcesConfig(JSON.stringify({ enabled: true, maxOpen }));
    expect(config).toEqual({ enabled: true, sfwRate: 1, nsfwRate: 0.3 });
    expect(knightsSourcesMaxOpen(config)).toBe(KNIGHTS_SOURCES_DEFAULT_MAX_OPEN);
  });

  it('reads maxOpen as a whole number of open items, and leaves it out when missing or unusable', () => {
    expect(readKnightsSourcesConfig('{"enabled":true,"maxOpen":1200}').config.maxOpen).toBe(1200);
    expect(readKnightsSourcesConfig('{"enabled":true,"maxOpen":0}').config.maxOpen).toBe(0);
    for (const maxOpen of ['5000', -1, null, true]) {
      expect(readKnightsSourcesConfig(JSON.stringify({ enabled: true, maxOpen })).config).toEqual({
        enabled: true,
        sfwRate: 1,
        nsfwRate: 0.3,
      });
    }
  });
});

describe('readKnightsSourcesConfig yesNoShare', () => {
  it('reads a stored yes/no share between 0 and 1, 0 included', () => {
    expect(readKnightsSourcesConfig('{"enabled":true,"yesNoShare":0}').config.yesNoShare).toBe(0);
    expect(readKnightsSourcesConfig('{"enabled":true,"yesNoShare":0.4}').config.yesNoShare).toBe(
      0.4
    );
  });

  it('leaves the share out when missing or unusable, so the Knights default applies', () => {
    for (const yesNoShare of [undefined, '0.5', -0.1, 1.5, null, Number.NaN]) {
      expect(
        readKnightsSourcesConfig(JSON.stringify({ enabled: true, yesNoShare })).config
      ).not.toHaveProperty('yesNoShare');
    }
  });
});

describe('knightsSourcesMaxOpen', () => {
  it('is the stored cap, or the default when none is stored', () => {
    expect(knightsSourcesMaxOpen(parseKnightsSourcesConfig('{"maxOpen":250}'))).toBe(250);
    expect(knightsSourcesMaxOpen(parseKnightsSourcesConfig('{"maxOpen":0}'))).toBe(0);
    expect(knightsSourcesMaxOpen(parseKnightsSourcesConfig('{"enabled":true}'))).toBe(
      KNIGHTS_SOURCES_DEFAULT_MAX_OPEN
    );
  });
});

describe('readKnightsSourcesConfig game settings', () => {
  it('reads every stored game setting that is in range', () => {
    const game = {
      hiddenCheckRate: 0,
      hiddenCheckFailureWindowHours: 12.5,
      hiddenCheckSevereDistance: 3,
      hiddenCheckSettleDelayMinutes: 0,
      hiddenCheckRetireMinAnswers: 40,
      hiddenCheckRetireFailureRate: 1,
      yesNoStretch: 4,
      yesNoMaxAgeDays: 7,
      apprenticeSmites: false,
      shopDisabled: true,
      conversionDisabled: false,
      harvest: false,
      harvestHiddenCheckShare: 0.25,
    };
    expect(readKnightsSourcesConfig(JSON.stringify({ enabled: true, game })).config).toEqual({
      enabled: true,
      sfwRate: 1,
      nsfwRate: 0.3,
      game,
    });
  });

  it.each([
    ['hiddenCheckRate', 1.5],
    ['hiddenCheckRate', -0.1],
    ['hiddenCheckFailureWindowHours', 0],
    ['hiddenCheckSevereDistance', 1.5],
    ['hiddenCheckSettleDelayMinutes', -1],
    ['hiddenCheckRetireMinAnswers', 0],
    ['hiddenCheckRetireFailureRate', 0],
    ['yesNoStretch', 2.5],
    ['yesNoMaxAgeDays', 0],
    ['yesNoMaxAgeDays', '7'],
    ['apprenticeSmites', 'off'],
    ['shopDisabled', 1],
    ['conversionDisabled', null],
    ['harvest', 'on'],
    ['harvestHiddenCheckShare', 1.5],
    ['harvestHiddenCheckShare', -0.1],
  ])('leaves out %s = %j, so the Knights default applies', (key, value) => {
    // A valid neighbour shows that only the bad field is dropped.
    const other = key === 'yesNoMaxAgeDays' ? 'yesNoStretch' : 'yesNoMaxAgeDays';
    const raw = JSON.stringify({ enabled: true, game: { [other]: 3, [key]: value } });
    expect(readKnightsSourcesConfig(raw).config.game).toEqual({ [other]: 3 });
  });

  it('leaves game out when nothing in it is usable, so the main app reads its three fields unchanged', () => {
    for (const game of [undefined, null, 'x', [], {}, { unknown: 1 }]) {
      expect(readKnightsSourcesConfig(JSON.stringify({ enabled: true, game })).config).toEqual({
        enabled: true,
        sfwRate: 1,
        nsfwRate: 0.3,
      });
    }
  });
});

describe('isValidKnightsGameSetting', () => {
  it('uses the same ranges as the Knights environment readers', () => {
    expect(isValidKnightsGameSetting('hiddenCheckRate', 0)).toBe(true);
    expect(isValidKnightsGameSetting('hiddenCheckRetireFailureRate', 0)).toBe(false);
    expect(isValidKnightsGameSetting('hiddenCheckSevereDistance', 2)).toBe(true);
    expect(isValidKnightsGameSetting('hiddenCheckSevereDistance', 2.5)).toBe(false);
    expect(isValidKnightsGameSetting('yesNoMaxAgeDays', Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidKnightsGameSetting('shopDisabled', true)).toBe(true);
    expect(isValidKnightsGameSetting('shopDisabled', 'true')).toBe(false);
  });
});

describe('readKnightsSourcesConfig ruleGuide', () => {
  const set = (title: string, points: string[], notes?: string) => ({
    title,
    ...(notes ? { notes } : {}),
    points,
  });
  const read = (ruleGuide: unknown) =>
    readKnightsSourcesConfig(JSON.stringify({ enabled: true, ruleGuide })).config;

  it('leaves ruleGuide out when nothing is stored, keeping the other fields', () => {
    expect(
      readKnightsSourcesConfig('{"enabled":true,"game":{"shopDisabled":true}}').config
    ).toEqual({
      enabled: true,
      sfwRate: 1,
      nsfwRate: 0.3,
      game: { shopDisabled: true },
    });
  });

  it('reads a stored guide back, trimmed', () => {
    expect(
      read({ intro: '  Why we ask  ', sets: [set(' First set ', [' One ', 'Two'], 'A note')] })
        .ruleGuide
    ).toEqual({ intro: 'Why we ask', sets: [set('First set', ['One', 'Two'], 'A note')] });
  });

  it('keeps a set that has only notes', () => {
    expect(read({ sets: [{ title: 'Short', notes: 'Just a line.' }] }).ruleGuide).toEqual({
      sets: [set('Short', [], 'Just a line.')],
    });
  });

  it('drops blank points, and a set left with neither points nor notes', () => {
    const guide = read({
      sets: [
        { title: 'Kept', points: ['One', '  ', 3] },
        { title: 'Empty', points: [''] },
      ],
    }).ruleGuide;
    expect(guide).toEqual({ sets: [set('Kept', ['One'])] });
  });

  it('drops what is over the limits instead of truncating it', () => {
    const tooMany = Array.from({ length: KNIGHTS_RULE_GUIDE_LIMITS.sets + 2 }, (_, i) =>
      set(`Set ${i}`, ['One'])
    );
    expect(read({ sets: tooMany }).ruleGuide?.sets).toHaveLength(KNIGHTS_RULE_GUIDE_LIMITS.sets);
    const longPoint = 'x'.repeat(KNIGHTS_RULE_GUIDE_LIMITS.point + 1);
    expect(read({ sets: [set('T', [longPoint, 'Two'])] }).ruleGuide).toEqual({
      sets: [set('T', ['Two'])],
    });
    expect(
      read({ intro: 'x'.repeat(KNIGHTS_RULE_GUIDE_LIMITS.intro + 1), sets: [set('T', ['One'])] })
        .ruleGuide
    ).toEqual({
      sets: [set('T', ['One'])],
    });
  });

  it('ignores an unusable guide without losing the rest of the config', () => {
    for (const ruleGuide of ['text', 3, [], { sets: 'x' }, { sets: [] }, null]) {
      const config = readKnightsSourcesConfig(
        JSON.stringify({ enabled: true, yesNoShare: 0.2, ruleGuide })
      ).config;
      expect(config).not.toHaveProperty('ruleGuide');
      expect(config.yesNoShare).toBe(0.2);
    }
  });

  it('agrees with readRuleGuide', () => {
    const value = { sets: [set('T', ['One'])] };
    expect(read(value).ruleGuide).toEqual(readRuleGuide(value));
  });
});
