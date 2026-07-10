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

  /** This version defines a licensing-fee lineage that other versions can inherit via `licensingSourceVersionId` (e.g. an ecosystem's Base / Turbo checkpoint). Selectable as a "licensing base" in the version form. */
  LicensingRoot: 1 << 1, // 2
} as const;

export type ModelVersionFlagValue = (typeof ModelVersionFlag)[keyof typeof ModelVersionFlag];

export const modelVersionFlagLabels: Record<number, string> = {
  [ModelVersionFlag.DisablePayout]: 'Disable creator payouts',
  [ModelVersionFlag.LicensingRoot]: 'Licensing lineage root',
};
