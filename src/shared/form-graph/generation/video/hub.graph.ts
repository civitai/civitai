import { z } from 'zod';
import { branch, defFamily, defineGraph } from 'form-graph';
import { VID_QUANTITY_ECOSYSTEMS } from '~/shared/constants/generation.constants';
import { getEcosystemStates, resolveCompatibleEcosystem } from '../ecosystem-gates';
import { modelSelectorRules } from '../reconcile';
import type { RootCtx, FamilyExt } from '../shared';

import { ltx } from './ltx.graph';
import { seedance } from './seedance.graph';
import { isWanEcosystem, wan } from './wan.graph';

/**
 * The VIDEO hub: ecosystem selection scoped to video output, plus quantity for
 * the video ecosystems that batch, then the family dispatch. Workflow and the
 * output/input computeds live on the root (`../hub.ts`), which mounts this hub
 * only when the workflow's output type is video — so nothing here handles
 * image/audio/model3d ecosystems, and `priority`/`outputFormat` (image-only in
 * the oracle) never appear.
 */

const QUANTITY = defFamily((max: number) => {
  const snap = (val: number) => Math.min(Math.max(Math.round(val), 1), max);
  return {
    input: z.coerce
      .number()
      .optional()
      .transform((val) => (val === undefined ? undefined : snap(val))),
    output: z.number().min(1).max(max),
    default: 1,
    meta: { min: 1, max, step: 1 },
  };
});

/** Which family graph owns an ecosystem. Untagged: the oracle has no family key. */
const families = branch((ext: FamilyExt) => {
  if (isWanEcosystem(ext.ecosystem)) return wan;
  switch (ext.ecosystem) {
    case 'Seedance':
      return seedance;
    case 'LTXV2':
    case 'LTXV23':
    case 'LTXV25':
    default:
      return ltx;
  }
});

export const videoHub = defineGraph<RootCtx>()
  .field('ecosystem', ({ _ext }) => {
    const { compatibleEcosystems, hiddenEcosystems, ecosystemStates } = getEcosystemStates(
      _ext.workflow,
      _ext
    );
    const hiddenSet = new Set(hiddenEcosystems);
    const disabledSet = new Set(ecosystemStates.map((e) => e.key));
    const usableEcosystems = disabledSet.size
      ? compatibleEcosystems.filter((key) => !disabledSet.has(key))
      : compatibleEcosystems;
    const defaultValue = usableEcosystems.includes('Seedance')
      ? 'Seedance'
      : usableEcosystems[0] ?? compatibleEcosystems[0] ?? 'Seedance';

    return {
      input: z
        .string()
        .optional()
        .transform((v) => {
          if (!v) return undefined;
          // Hidden values are dropped at the boundary so a stale stored value
          // falls back to the default; disabled/memberOnly are kept so the
          // picker can explain them, and refused on output. A value that
          // doesn't support the workflow redirects to the workflow's default
          // (v1's sync effect).
          if (hiddenSet.has(v)) return undefined;
          return resolveCompatibleEcosystem(_ext.workflow, v);
        }),
      output:
        hiddenSet.size || disabledSet.size
          ? z.string().refine((v) => !hiddenSet.has(v) && !disabledSet.has(v), {
              message: 'Ecosystem is currently unavailable',
            })
          : z.string(),
      default: defaultValue,
      // v1 stores the ecosystem selection per OUTPUT type
      scope: 'video',
      meta: {
        compatibleEcosystems,
        hiddenEcosystems,
        ecosystemStates,
        mediaType: 'video',
      },
      // the SELECTION: shadowed off the wire by each family's
      // `emit: 'ecosystem'` computed, which carries the derived backend
    };
  })
  .field('quantity', ({ ecosystem, _ext }) => {
    if (!VID_QUANTITY_ECOSYSTEMS.has(ecosystem)) return null;
    return QUANTITY(_ext.limits.vidQuantity);
  })
  .use(families)
  // interactive model picks reconcile selectors the same way the parse boundary does
  .effect(modelSelectorRules);

export type VideoState = ReturnType<typeof videoHub.resolve>;
