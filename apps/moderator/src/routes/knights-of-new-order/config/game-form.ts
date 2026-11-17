import {
  KNIGHTS_GAME_SETTING_KEYS,
  KNIGHTS_GAME_SETTINGS,
  type KnightsGameSettingKey,
  type KnightsGameSettings,
} from '@civitai/shared/new-order';

/** Form field that asks to remove a stored setting, so Knights falls back to its environment. */
export const defaultField = (key: KnightsGameSettingKey) => `default.${key}`;

export const CONFIRM_FIELD = 'confirmKillSwitches';

const NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * The form posts only the settings the moderator changed. A box becomes a number and a toggle a boolean; range checks are the
 * service's (`validateGameSettingsInput`), so a well-formed value outside the range comes back with its message.
 */
export function parseGameForm(
  form: FormData
):
  | { ok: true; changes: Record<string, number | boolean | null>; confirmed: boolean }
  | { ok: false; error: string } {
  const changes: Record<string, number | boolean | null> = {};
  for (const key of KNIGHTS_GAME_SETTING_KEYS) {
    const spec = KNIGHTS_GAME_SETTINGS[key];
    if (form.get(defaultField(key)) === 'true') {
      changes[key] = null;
      continue;
    }
    const raw = form.get(key);
    if (raw === null) continue;
    const text = String(raw).trim();
    if (spec.kind === 'toggle') {
      if (text !== 'true' && text !== 'false')
        return { ok: false, error: `${spec.label} must be on or off.` };
      changes[key] = text === 'true';
    } else {
      if (!NUMBER.test(text)) return { ok: false, error: `${spec.label} must be a number.` };
      changes[key] = Number(text);
    }
  }
  if (Object.keys(changes).length === 0) return { ok: false, error: 'Nothing was changed.' };
  return { ok: true, changes, confirmed: form.get(CONFIRM_FIELD) === 'true' };
}

const showValue = (value: number | boolean | undefined) =>
  value === undefined
    ? 'Knights default'
    : typeof value === 'boolean'
    ? value
      ? 'on'
      : 'off'
    : String(value);

/** The game settings a recorded change moved, as "label: before to after", or null when it moved none. */
export function gameChangeSummary(
  before: KnightsGameSettings | undefined,
  after: KnightsGameSettings | undefined
): string | null {
  const moved = KNIGHTS_GAME_SETTING_KEYS.filter((key) => before?.[key] !== after?.[key]).map(
    (key) =>
      `${KNIGHTS_GAME_SETTINGS[key].label}: ${showValue(before?.[key])} to ${showValue(
        after?.[key]
      )}`
  );
  return moved.length ? moved.join('; ') : null;
}

/** A toggle's three choices: nothing saved (Knights follows its environment), or an explicit on or off. */
export type ToggleChoice = 'default' | 'on' | 'off';

export const toggleChoice = (saved: boolean | undefined): ToggleChoice =>
  saved === undefined ? 'default' : saved ? 'on' : 'off';

/** What a save posts for a toggle: a value to store, `clear` to remove the saved one, or null when nothing changes. */
export function toggleSubmission(
  saved: boolean | undefined,
  choice: ToggleChoice
): { set: boolean } | 'clear' | null {
  if (choice === toggleChoice(saved)) return null;
  return choice === 'default' ? 'clear' : { set: choice === 'on' };
}
