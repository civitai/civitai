import { describe, expect, it } from 'vitest';
import type { SourcesSettings } from '$lib/server/knights/sources-config.service';
import {
  changeCount,
  changeSummary,
  fieldError,
  gameFormData,
  killSwitchChanged,
  seedDraft,
  sourcesFormData,
  startsFilling,
  TOGGLE_ROWS,
  toggleLabel,
} from '../config-draft';

const settings = (
  config: Partial<SourcesSettings['config']> = {},
  stored = true
): SourcesSettings => ({
  stored,
  config: { enabled: true, sfwRate: 0.5, nsfwRate: 0.25, ...config },
});

const entries = (form: FormData | null) => (form ? Object.fromEntries(form.entries()) : null);

describe('toggle labels', () => {
  it('lists the Knights default first, then positive labels mapped to the stored boolean', () => {
    expect(TOGGLE_ROWS.shopDisabled.options).toEqual([
      { value: 'default', label: 'Default' },
      { value: 'off', label: 'Open' },
      { value: 'on', label: 'Closed' },
    ]);
    expect(TOGGLE_ROWS.conversionDisabled.options.map((o) => o.label)).toEqual([
      'Default',
      'On',
      'Off',
    ]);
    expect(TOGGLE_ROWS.conversionDisabled.options[1].value).toBe('off');
    expect(TOGGLE_ROWS.apprenticeSmites.options.map((o) => [o.value, o.label])).toEqual([
      ['default', 'Default'],
      ['on', 'On'],
      ['off', 'Off'],
    ]);
  });

  it('names a stored value by its positive label', () => {
    expect(toggleLabel('shopDisabled', true)).toBe('Closed');
    expect(toggleLabel('shopDisabled', false)).toBe('Open');
    expect(toggleLabel('apprenticeSmites', undefined)).toBe('Default');
  });
});

describe('seedDraft and changeCount', () => {
  it('starts from what is stored, with no changes', () => {
    const seed = settings({ yesNoShare: 0.4, game: { hiddenCheckRate: 0.05, shopDisabled: true } });
    const draft = seedDraft(seed);
    expect(draft.sources).toEqual({
      enabled: true,
      sfw: '50',
      nsfw: '25',
      yesNo: '40',
      yesNoReset: false,
      maxOpen: '',
    });
    expect(draft.numbers.hiddenCheckRate).toEqual({ text: '5', reset: false });
    expect(draft.numbers.yesNoStretch).toEqual({ text: '', reset: false });
    expect(draft.toggles.shopDisabled).toBe('on');
    expect(draft.toggles.apprenticeSmites).toBe('default');
    expect(changeCount(seed, draft)).toBe(0);
  });

  it('starts the rate boxes empty when nothing is stored', () => {
    expect(seedDraft(settings({}, false)).sources).toMatchObject({ sfw: '', nsfw: '' });
  });

  it('counts each changed row once, resets of stored values included', () => {
    const seed = settings({ yesNoShare: 0.4, game: { yesNoStretch: 4, apprenticeSmites: true } });
    const draft = seedDraft(seed);
    draft.sources.sfw = '60';
    draft.sources.yesNoReset = true;
    draft.numbers.yesNoStretch.reset = true;
    draft.numbers.yesNoMaxAgeDays.text = '9';
    draft.toggles.apprenticeSmites = 'off';
    draft.toggles.shopDisabled = 'off';
    expect(changeCount(seed, draft)).toBe(6);
  });

  it('does not count a reset of a value that is not stored, a blank box, or the same value retyped', () => {
    const seed = settings({ game: { yesNoStretch: 4 } });
    const draft = seedDraft(seed);
    draft.numbers.yesNoMaxAgeDays.reset = true;
    draft.numbers.hiddenCheckRate.text = '  ';
    draft.numbers.yesNoStretch.text = ' 4 ';
    draft.sources.yesNoReset = true;
    expect(changeCount(seed, draft)).toBe(0);
  });
});

describe('form data', () => {
  it('posts nothing to an action whose fields did not change', () => {
    const seed = settings();
    const draft = seedDraft(seed);
    expect(sourcesFormData(seed, draft)).toBeNull();
    expect(gameFormData(seed, draft, false)).toBeNull();
  });

  it('posts the whole sources form, as the existing action expects, when any source field changed', () => {
    const seed = settings({ yesNoShare: 0.4 });
    const draft = seedDraft(seed);
    draft.sources.nsfw = '30';
    expect(entries(sourcesFormData(seed, draft))).toEqual({
      enabled: 'true',
      sfwPercent: '50',
      nsfwPercent: '30',
    });
    draft.sources.yesNoReset = true;
    expect(entries(sourcesFormData(seed, draft))).toMatchObject({ yesNoDefault: 'true' });
    draft.sources.yesNoReset = false;
    draft.sources.yesNo = '0';
    expect(entries(sourcesFormData(seed, draft))).toMatchObject({ yesNoPercent: '0' });
  });

  it('posts the open-item cap only when it changed, and counts it as a change', () => {
    const seed = settings({ maxOpen: 18300 });
    const draft = seedDraft(seed);
    expect(draft.sources.maxOpen).toBe('18300');
    draft.sources.maxOpen = ' 18300 ';
    expect(sourcesFormData(seed, draft)).toBeNull();
    draft.sources.maxOpen = '60000';
    expect(changeCount(seed, draft)).toBe(1);
    expect(entries(sourcesFormData(seed, draft))).toEqual({
      enabled: 'true',
      sfwPercent: '50',
      nsfwPercent: '25',
      maxOpen: '60000',
    });
  });

  it('posts only changed game settings: percents as 0-1 rates, resets, toggles as stored booleans', () => {
    const seed = settings({ game: { yesNoStretch: 4, apprenticeSmites: true } });
    const draft = seedDraft(seed);
    draft.numbers.hiddenCheckRate.text = '2.5';
    draft.numbers.yesNoStretch.reset = true;
    draft.numbers.yesNoMaxAgeDays.text = '9';
    draft.toggles.shopDisabled = 'off';
    draft.toggles.apprenticeSmites = 'default';
    expect(entries(gameFormData(seed, draft, true))).toEqual({
      hiddenCheckRate: '0.025',
      'default.yesNoStretch': 'true',
      yesNoMaxAgeDays: '9',
      shopDisabled: 'false',
      'default.apprenticeSmites': 'true',
      confirmKillSwitches: 'true',
    });
  });
});

describe('fieldError', () => {
  it('checks percent boxes as 0 to 100 and other boxes against the setting range', () => {
    expect(fieldError('hiddenCheckRate', '150')).toBe('Enter 0 to 100.');
    expect(fieldError('hiddenCheckRate', '5')).toBeNull();
    expect(fieldError('yesNoStretch', '2.5')).toBe('Enter a whole number greater than 0.');
    expect(fieldError('yesNoStretch', 'abc')).toBe('Enter a number.');
    expect(fieldError('yesNoStretch', '')).toBeNull();
  });

  it('takes the skill-check pool cap as a whole number greater than 0', () => {
    expect(fieldError('skillCheckPoolCap', '500')).toBeNull();
    expect(fieldError('skillCheckPoolCap', '0')).toBe('Enter a whole number greater than 0.');
    expect(fieldError('skillCheckPoolCap', '12.5')).toBe('Enter a whole number greater than 0.');
  });
});

describe('skill-check pool rows', () => {
  it('offers the serve-judged toggle as Default, then Off, then On', () => {
    expect(TOGGLE_ROWS.skillCheckServeJudged.options.map((o) => [o.value, o.label])).toEqual([
      ['default', 'Default'],
      ['off', 'Off'],
      ['on', 'On'],
    ]);
    expect(toggleLabel('skillCheckServeJudged', undefined)).toBe('Default');
    expect(toggleLabel('skillCheckServeJudged', true)).toBe('On');
  });

  it('round-trips a stored pool cap through the draft unchanged', () => {
    const seed = settings({ game: { skillCheckPoolCap: 250 } });
    const draft = seedDraft(seed);
    expect(draft.numbers.skillCheckPoolCap.text).toBe('250');
    expect(changeCount(seed, draft)).toBe(0);
    draft.numbers.skillCheckPoolCap.text = '300';
    expect(entries(gameFormData(seed, draft, true))).toMatchObject({ skillCheckPoolCap: '300' });
  });
});

describe('confirmations', () => {
  it('flags a change to either kill switch, a reset included', () => {
    const seed = settings({ game: { conversionDisabled: true } });
    const draft = seedDraft(seed);
    expect(killSwitchChanged(seed, draft)).toBe(false);
    draft.toggles.conversionDisabled = 'default';
    expect(killSwitchChanged(seed, draft)).toBe(true);
  });

  it('flags turning the sources on', () => {
    const off = settings({ enabled: false });
    const draft = seedDraft(off);
    draft.sources.enabled = true;
    expect(startsFilling(off, draft)).toBe(true);
    expect(startsFilling(settings(), seedDraft(settings()))).toBe(false);
  });
});

describe('harvest rows', () => {
  it('offers Default / Running / Paused, mapped to the stored harvest boolean', () => {
    expect(TOGGLE_ROWS.harvest.options.map((o) => [o.value, o.label])).toEqual([
      ['default', 'Default'],
      ['on', 'Running'],
      ['off', 'Paused'],
    ]);
    expect(toggleLabel('harvest', false)).toBe('Paused');
  });

  it('posts the share as a 0-1 rate and an explicit pause, and asks no kill switch confirmation', () => {
    const seed = settings({ game: { harvestHiddenCheckShare: 0.2 } });
    const draft = seedDraft(seed);
    expect(draft.numbers.harvestHiddenCheckShare).toEqual({ text: '20', reset: false });
    expect(draft.toggles.harvest).toBe('default');
    draft.numbers.harvestHiddenCheckShare.text = '0';
    draft.toggles.harvest = 'off';
    expect(changeCount(seed, draft)).toBe(2);
    expect(entries(gameFormData(seed, draft, false))).toEqual({
      harvestHiddenCheckShare: '0',
      harvest: 'false',
    });
    expect(killSwitchChanged(seed, draft)).toBe(false);
    expect(fieldError('harvestHiddenCheckShare', '120')).toBe('Enter 0 to 100.');
  });

  it('clears a saved share and names harvest changes in the summary', () => {
    const seed = settings({ game: { harvestHiddenCheckShare: 0.2, harvest: false } });
    const draft = seedDraft(seed);
    draft.numbers.harvestHiddenCheckShare.reset = true;
    draft.toggles.harvest = 'default';
    expect(entries(gameFormData(seed, draft, false))).toEqual({
      'default.harvestHiddenCheckShare': 'true',
      'default.harvest': 'true',
    });
    expect(
      changeSummary(
        { enabled: true, sfwRate: 1, nsfwRate: 0.3, game: { harvest: false } },
        {
          enabled: true,
          sfwRate: 1,
          nsfwRate: 0.3,
          game: { harvest: true, harvestHiddenCheckShare: 0.1 },
        }
      )
    ).toBe('Harvest: Paused to Running; Rulings used as skill checks: Default to 10%');
  });
});

describe('changeSummary', () => {
  it('names a change of the open-item cap', () => {
    expect(
      changeSummary(
        { enabled: true, sfwRate: 0.5, nsfwRate: 0.25, maxOpen: 18300 },
        { enabled: true, sfwRate: 1, nsfwRate: 0.3, maxOpen: 60000 }
      )
    ).toBe('SFW rate: 50% to 100%; NSFW rate: 25% to 30%; Open-item cap: 18,300 to 60,000');
  });

  it('names what a recorded change moved, in page terms', () => {
    expect(
      changeSummary(
        {
          enabled: true,
          sfwRate: 1,
          nsfwRate: 0.3,
          game: { shopDisabled: false, hiddenCheckRate: 0.05 },
        },
        {
          enabled: false,
          sfwRate: 0.5,
          nsfwRate: 0.3,
          game: { hiddenCheckRate: 0.1, apprenticeSmites: false },
        }
      )
    ).toBe(
      'Queue sources: on to off; SFW rate: 100% to 50%; Skill check rate: 5% to 10%; Acolyte wrong-answer smites: Default to Off; Shop: Open to Default'
    );
  });

  it('describes a first save and an unchanged record', () => {
    expect(changeSummary(null, { enabled: true, sfwRate: 1, nsfwRate: 0.3 })).toBe(
      'Queue sources: on; SFW rate: 100%; NSFW rate: 30%'
    );
    expect(
      changeSummary(
        { enabled: true, sfwRate: 1, nsfwRate: 0.3 },
        { enabled: true, sfwRate: 1, nsfwRate: 0.3 }
      )
    ).toBe('No change');
  });
});
