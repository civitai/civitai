import { Flags } from '~/shared/utils/flags';

/**
 * Model Version Flags — Bitwise opt-out / behavior flags stored on `ModelVersion.flags`.
 *
 * Each flag is a power of 2 so they can be combined with bitwise OR.
 * Use `Flags.hasFlag(modelVersion.flags, ModelVersionFlag.DisablePayout)` to check.
 */
export const ModelVersionFlag = {
  None: 0,

  /** This version opts out of creator payouts — tips and creator compensation (e.g. licensed models earning via license fees instead). */
  DisablePayout: 1 << 0, // 1

  /**
   * This version is blocked from the on-site generator — a moderator override on
   * top of generation coverage. Read per-row via `isGenerationDisabled` to gate
   * `canGenerate`. Moderator-controlled (reuses the retired LicensingRoot bit).
   *
   * NOTE: the value (2) is also hardcoded in the event-engine-common model feed,
   * which can't import from this repo. Changing this bit means changing it there.
   */
  DisableGeneration: 1 << 1, // 2

  /** This version is not a derivative of a licensing root — so the version form doesn't require or auto-select a "fine-tuned from" parent for it (e.g. an ecosystem's API-only official checkpoints). It can still set its own licensing fee. Moderator-controlled. */
  NotDerivative: 1 << 2, // 4
} as const;

export type ModelVersionFlagValue = (typeof ModelVersionFlag)[keyof typeof ModelVersionFlag];

export const modelVersionFlagLabels: Record<number, string> = {
  [ModelVersionFlag.DisablePayout]: 'Disable creator payouts',
  [ModelVersionFlag.DisableGeneration]: 'Disable generation',
  [ModelVersionFlag.NotDerivative]: 'Not a derivative (no licensing parent)',
};

/**
 * Whether a version is blocked from the on-site generator (moderator override on
 * top of generation coverage). The single place the DisableGeneration bit is read
 * — negate for "available for generation".
 */
export const isGenerationDisabled = (flags: number) =>
  Flags.hasFlag(flags, ModelVersionFlag.DisableGeneration);
