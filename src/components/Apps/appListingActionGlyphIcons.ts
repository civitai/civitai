import {
  IconExternalLink,
  IconInfoCircle,
  IconPlayerPlay,
  IconPlugConnected,
} from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import type { PrimaryActionGlyph } from '~/components/Apps/appListingActionGlyph';

/**
 * Glyph → Tabler icon. SINGLE SOURCE OF TRUTH for what a primary-action glyph
 * actually renders as, shared by the store card and the listing detail — the
 * `marketplaceCategoryIcons.ts` pattern applied to CTAs.
 *
 * Split out of `appListingActionGlyph.ts` so that module stays runtime-pure and
 * node-importable; this one carries the `@tabler/icons-react` value import.
 *
 * 🔴 `launch` and `external` must stay DIFFERENT icons. The whole point of the
 * glyph vocabulary is that "runs here" and "leaves the site" look different —
 * mapping them to the same icon reinstates exactly the defect #3391's badge
 * removal assumed was already handled. Pinned in
 * `__tests__/appListingActionGlyph.test.ts`.
 */
export const ACTION_GLYPH_ICONS: Record<PrimaryActionGlyph, Icon> = {
  /** In-site nav to the in-host page runner — a play/run affordance, no new tab. */
  launch: IconPlayerPlay,
  /** Leaves civitai.com in a new tab (`target="_blank"` + `rel="noopener noreferrer"`). */
  external: IconExternalLink,
  /** OAuth connect affordance (stubbed until the cutover wires it). */
  connect: IconPlugConnected,
  /** Informational — no launch, no navigation off-site. */
  info: IconInfoCircle,
};
