import {
  isValidKnightsGameSetting,
  KNIGHTS_GAME_SETTING_KEYS,
  KNIGHTS_GAME_SETTINGS,
  KNIGHTS_SOURCES_MAX_OPEN_LIMIT,
  type KnightsGameSettingKey,
  type KnightsGameSettings,
  type KnightsSourcesConfig,
} from '@civitai/shared/new-order';
import type { SourcesSettings } from '$lib/server/knights/sources-config.service';
import {
  CONFIRM_FIELD,
  defaultField,
  toggleChoice,
  toggleSubmission,
  type ToggleChoice,
} from './game-form';
import { percentToRate, rateToPercent } from './rates';

export type NumberKey = {
  [K in KnightsGameSettingKey]: (typeof KNIGHTS_GAME_SETTINGS)[K]['kind'] extends 'number'
    ? K
    : never;
}[KnightsGameSettingKey];
export type ToggleKey = Exclude<KnightsGameSettingKey, NumberKey>;

/** `percent` rows show and take a percentage; the stored value is the 0-1 rate. */
export const NUMBER_ROWS: Record<NumberKey, { unit: string; percent?: true; description: string }> =
  {
    hiddenCheckRate: {
      unit: '%',
      percent: true,
      description: 'Share of feed slots that hold a hidden skill check. 0% pauses them.',
    },
    hiddenCheckFailureWindowHours: {
      unit: 'hours',
      description: 'How far back failed checks count toward a warning or smite.',
    },
    hiddenCheckSevereDistance: {
      unit: 'levels',
      description: 'A miss this many levels off counts as severe.',
    },
    hiddenCheckSettleDelayMinutes: {
      unit: 'minutes',
      description: 'How long an unanswered check waits before it is graded.',
    },
    hiddenCheckRetireMinAnswers: {
      unit: 'answers',
      description: 'Answers a check needs before it can be retired.',
    },
    hiddenCheckRetireFailureRate: {
      unit: '%',
      percent: true,
      description: 'A check failed by more than this share of its answers is retired.',
    },
    yesNoStretch: {
      unit: 'questions',
      description: 'Questions on one topic in a row before the next topic starts.',
    },
    yesNoMaxAgeDays: {
      unit: 'days',
      description: 'A question nobody has answered for this long is closed.',
    },
    harvestHiddenCheckShare: {
      unit: '%',
      percent: true,
      description: 'Share of new moderator rulings used as skill checks instead of trials.',
    },
    inquisitorMaxOpen: {
      unit: 'reviews',
      description:
        'Open reviews the in-game inquisitor queue keeps. Past it, the oldest ones no moderator has voted on expire, so the queue shows recent images.',
    },
    skillCheckPoolCap: {
      unit: 'checks',
      description:
        'Skill checks two moderators confirmed in game that are kept. When full, the oldest is retired as a new one comes in; a lower cap retires down to it at the next confirmed check.',
    },
  };

type ToggleOption = { value: ToggleChoice; label: string };

/** Positive labels, the Knights default first. `on`/`off` are the stored boolean (true/false), whatever the label says. */
export const TOGGLE_ROWS: Record<ToggleKey, { description: string; options: ToggleOption[] }> = {
  apprenticeSmites: {
    description: 'Too many wrong answers earn an Acolyte a smite.',
    options: [
      { value: 'default', label: 'Default' },
      { value: 'on', label: 'On' },
      { value: 'off', label: 'Off' },
    ],
  },
  harvest: {
    description: 'Turns moderator rulings into trials and skill checks. Paused keeps its place.',
    options: [
      { value: 'default', label: 'Default' },
      { value: 'on', label: 'Running' },
      { value: 'off', label: 'Paused' },
    ],
  },
  shopDisabled: {
    description: 'Players can spend gold in the shop. Gold keeps accruing either way.',
    options: [
      { value: 'default', label: 'Default' },
      { value: 'off', label: 'Open' },
      { value: 'on', label: 'Closed' },
    ],
  },
  conversionDisabled: {
    description: 'Players can buy Buzz packs with gold.',
    options: [
      { value: 'default', label: 'Default' },
      { value: 'off', label: 'On' },
      { value: 'on', label: 'Off' },
    ],
  },
  inquisitorQueue: {
    description:
      'Moderators review settled ratings in the game on /play, and two agreeing moderators add skill checks served to Acolytes and Knights. Off, no review opens and the mod-confirmed pool is not served.',
    options: [
      { value: 'default', label: 'Default' },
      { value: 'off', label: 'Off' },
      { value: 'on', label: 'On' },
    ],
  },
  skillCheckServeJudged: {
    description:
      'On, a player can be served a mod-confirmed skill check on an image they already judged in the queue or answered as an Acolyte. Never the same check twice.',
    options: [
      { value: 'default', label: 'Default' },
      { value: 'off', label: 'Off' },
      { value: 'on', label: 'On' },
    ],
  },
  signalsDisabled: {
    description:
      'Judging pages drop settled items and update stats live. Off, they refresh after each judgment as before.',
    options: [
      { value: 'default', label: 'Default' },
      { value: 'off', label: 'On' },
      { value: 'on', label: 'Off' },
    ],
  },
};

export const KILL_SWITCHES: ToggleKey[] = ['shopDisabled', 'conversionDisabled', 'signalsDisabled'];

export const toggleLabel = (key: ToggleKey, stored: boolean | undefined) =>
  TOGGLE_ROWS[key].options.find((option) => option.value === toggleChoice(stored))?.label ?? '';

export type Draft = {
  sources: {
    enabled: boolean;
    sfw: string;
    nsfw: string;
    yesNo: string;
    yesNoReset: boolean;
    /** The open-item cap; blank keeps what is stored. */
    maxOpen: string;
  };
  numbers: Record<NumberKey, { text: string; reset: boolean }>;
  toggles: Record<ToggleKey, ToggleChoice>;
};

const NUMBER_KEYS = KNIGHTS_GAME_SETTING_KEYS.filter(
  (key): key is NumberKey => KNIGHTS_GAME_SETTINGS[key].kind === 'number'
);
const TOGGLE_KEYS = KNIGHTS_GAME_SETTING_KEYS.filter(
  (key): key is ToggleKey => KNIGHTS_GAME_SETTINGS[key].kind === 'toggle'
);

const numberText = (key: NumberKey, value: number | undefined) =>
  value === undefined ? '' : NUMBER_ROWS[key].percent ? rateToPercent(value) : String(value);

/** The editable copy of what is stored. An absent key has no rates chosen, so its boxes start empty. */
export function seedDraft(settings: SourcesSettings): Draft {
  const { config, stored } = settings;
  const game = config.game ?? {};
  return {
    sources: {
      enabled: config.enabled,
      sfw: stored ? rateToPercent(config.sfwRate) : '',
      nsfw: stored ? rateToPercent(config.nsfwRate) : '',
      yesNo: config.yesNoShare === undefined ? '' : rateToPercent(config.yesNoShare),
      yesNoReset: false,
      maxOpen: config.maxOpen === undefined ? '' : String(config.maxOpen),
    },
    numbers: Object.fromEntries(
      NUMBER_KEYS.map((key) => [key, { text: numberText(key, game[key]), reset: false }])
    ) as Draft['numbers'],
    toggles: Object.fromEntries(
      TOGGLE_KEYS.map((key) => [key, toggleChoice(game[key])])
    ) as Draft['toggles'],
  };
}

/** What a number row would post: a value to store, `clear`, or null when it is unchanged (a blank box keeps the value). */
function numberChange(
  settings: SourcesSettings,
  draft: Draft,
  key: NumberKey
): string | 'clear' | null {
  const saved = settings.config.game?.[key];
  const { text, reset } = draft.numbers[key];
  if (reset) return saved === undefined ? null : 'clear';
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === numberText(key, saved)) return null;
  if (!NUMBER_ROWS[key].percent) return trimmed;
  const rate = percentToRate(trimmed);
  return rate === null ? trimmed : String(rate);
}

const yesNoChange = (settings: SourcesSettings, draft: Draft): string | 'clear' | null => {
  const saved = settings.config.yesNoShare;
  if (draft.sources.yesNoReset) return saved === undefined ? null : 'clear';
  const trimmed = draft.sources.yesNo.trim();
  return trimmed === '' || trimmed === (saved === undefined ? '' : rateToPercent(saved))
    ? null
    : trimmed;
};

/** What the cap box would post: the typed text, or null when blank or unchanged (a blank box keeps the stored cap). */
const maxOpenChange = (settings: SourcesSettings, draft: Draft): string | null => {
  const trimmed = draft.sources.maxOpen.trim().replaceAll(',', '');
  const saved = settings.config.maxOpen;
  return trimmed === '' || trimmed === (saved === undefined ? '' : String(saved)) ? null : trimmed;
};

function sourceChanges(settings: SourcesSettings, draft: Draft) {
  const seed = seedDraft(settings).sources;
  const { sources } = draft;
  return [
    sources.enabled !== seed.enabled,
    sources.sfw.trim() !== seed.sfw,
    sources.nsfw.trim() !== seed.nsfw,
    yesNoChange(settings, draft) !== null,
    maxOpenChange(settings, draft) !== null,
  ];
}

export function changeCount(settings: SourcesSettings, draft: Draft): number {
  return (
    sourceChanges(settings, draft).filter(Boolean).length +
    NUMBER_KEYS.filter((key) => numberChange(settings, draft, key) !== null).length +
    TOGGLE_KEYS.filter(
      (key) => toggleSubmission(settings.config.game?.[key], draft.toggles[key]) !== null
    ).length
  );
}

/** The sources action's whole form (it always writes the switch and both rates), or null when no source field changed. */
export function sourcesFormData(settings: SourcesSettings, draft: Draft): FormData | null {
  if (!sourceChanges(settings, draft).some(Boolean)) return null;
  const form = new FormData();
  form.set('enabled', String(draft.sources.enabled));
  form.set('sfwPercent', draft.sources.sfw.trim());
  form.set('nsfwPercent', draft.sources.nsfw.trim());
  const yesNo = yesNoChange(settings, draft);
  if (yesNo === 'clear') form.set('yesNoDefault', 'true');
  else if (yesNo !== null) form.set('yesNoPercent', yesNo);
  const maxOpen = maxOpenChange(settings, draft);
  if (maxOpen !== null) form.set('maxOpen', maxOpen);
  return form;
}

/** Only the changed game settings, in the shape the game action parses, or null when none changed. */
export function gameFormData(
  settings: SourcesSettings,
  draft: Draft,
  confirmed: boolean
): FormData | null {
  const form = new FormData();
  for (const key of NUMBER_KEYS) {
    const change = numberChange(settings, draft, key);
    if (change === 'clear') form.set(defaultField(key), 'true');
    else if (change !== null) form.set(key, change);
  }
  for (const key of TOGGLE_KEYS) {
    const change = toggleSubmission(settings.config.game?.[key], draft.toggles[key]);
    if (change === 'clear') form.set(defaultField(key), 'true');
    else if (change) form.set(key, String(change.set));
  }
  if ([...form.keys()].length === 0) return null;
  if (confirmed) form.set(CONFIRM_FIELD, 'true');
  return form;
}

const NUMBER = /^-?\d+(\.\d+)?$/;

/** The inline message for a box, or null when it is blank or valid. */
export function fieldError(key: NumberKey, text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (NUMBER_ROWS[key].percent) return percentToRate(trimmed) === null ? 'Enter 0 to 100.' : null;
  if (!NUMBER.test(trimmed)) return 'Enter a number.';
  const spec = KNIGHTS_GAME_SETTINGS[key];
  return isValidKnightsGameSetting(key, Number(trimmed)) ? null : `Enter ${spec.range}.`;
}

/** Blank keeps the stored cap; anything else must be a whole number (commas allowed). */
export const maxOpenError = (text: string): string | null => {
  const trimmed = text.trim().replaceAll(',', '');
  if (trimmed === '') return null;
  return /^\d+$/.test(trimmed) && Number(trimmed) <= KNIGHTS_SOURCES_MAX_OPEN_LIMIT
    ? null
    : `Enter a whole number up to ${KNIGHTS_SOURCES_MAX_OPEN_LIMIT.toLocaleString('en-US')}.`;
};

export const percentError = (text: string, required: boolean): string | null => {
  const trimmed = text.trim();
  if (trimmed === '') return required ? 'Enter 0 to 100.' : null;
  return percentToRate(trimmed) === null ? 'Enter 0 to 100.' : null;
};

export const killSwitchChanged = (settings: SourcesSettings, draft: Draft) =>
  KILL_SWITCHES.some(
    (key) => toggleSubmission(settings.config.game?.[key], draft.toggles[key]) !== null
  );

export const startsFilling = (settings: SourcesSettings, draft: Draft) =>
  draft.sources.enabled && !(settings.stored && settings.config.enabled);

const showGame = (key: KnightsGameSettingKey, value: number | boolean | undefined) => {
  if (KNIGHTS_GAME_SETTINGS[key].kind === 'toggle')
    return toggleLabel(key as ToggleKey, value as boolean | undefined);
  if (value === undefined) return 'Default';
  const row = NUMBER_ROWS[key as NumberKey];
  return row.percent ? `${rateToPercent(value as number)}%` : `${value} ${row.unit}`;
};

/** What a recorded change moved, in the page's own words. `before` is null for the first save. */
export function changeSummary(
  before: KnightsSourcesConfig | null,
  after: KnightsSourcesConfig | null
): string {
  if (!after) return 'Cleared';
  const parts: string[] = [];
  const moved = <T>(label: string, a: T | undefined, b: T, show: (v: T) => string) => {
    if (!before) parts.push(`${label}: ${show(b)}`);
    else if (a !== b)
      parts.push(`${label}: ${a === undefined ? 'Default' : show(a)} to ${show(b)}`);
  };
  moved('Queue sources', before?.enabled, after.enabled, (v) => (v ? 'on' : 'off'));
  moved('SFW rate', before?.sfwRate, after.sfwRate, (v) => `${rateToPercent(v)}%`);
  moved('NSFW rate', before?.nsfwRate, after.nsfwRate, (v) => `${rateToPercent(v)}%`);
  if (before?.yesNoShare !== after.yesNoShare && (before || after.yesNoShare !== undefined)) {
    const show = (v: number | undefined) => (v === undefined ? 'Default' : `${rateToPercent(v)}%`);
    parts.push(
      before
        ? `Yes/no share: ${show(before.yesNoShare)} to ${show(after.yesNoShare)}`
        : `Yes/no share: ${show(after.yesNoShare)}`
    );
  }
  if (before?.maxOpen !== after.maxOpen && (before || after.maxOpen !== undefined)) {
    const show = (v: number | undefined) =>
      v === undefined ? 'Default' : v.toLocaleString('en-US');
    parts.push(
      before
        ? `Open-item cap: ${show(before.maxOpen)} to ${show(after.maxOpen)}`
        : `Open-item cap: ${show(after.maxOpen)}`
    );
  }
  const beforeGame: KnightsGameSettings = before?.game ?? {};
  const afterGame: KnightsGameSettings = after.game ?? {};
  for (const key of KNIGHTS_GAME_SETTING_KEYS) {
    if (beforeGame[key] === afterGame[key]) continue;
    parts.push(
      `${KNIGHTS_GAME_SETTINGS[key].label}: ${showGame(key, beforeGame[key])} to ${showGame(
        key,
        afterGame[key]
      )}`
    );
  }
  return parts.length ? parts.join('; ') : 'No change';
}
