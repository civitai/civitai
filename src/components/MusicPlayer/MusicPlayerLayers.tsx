import type { TooltipProps } from '@mantine/core';
import { ABOVE_DIALOGS_Z_INDEX } from '~/components/Dialog/DialogProvider';
import { Tooltip } from '~/components/MantineOverlays';

/** Pencil `q5eud`: "Mini Player (top) > modals and overlays > page content". */
export const MUSIC_PLAYER_Z_INDEX = ABOVE_DIALOGS_Z_INDEX;
export const MUSIC_UP_NEXT_Z_INDEX = MUSIC_PLAYER_Z_INDEX + 1;
/** What floats above the bar from it: a timed comment's label, a comment cluster's list. */
export const MUSIC_PLAYER_FLOAT_Z_INDEX = MUSIC_PLAYER_Z_INDEX + 1;
const MUSIC_PLAYER_TOOLTIP_Z_INDEX = MUSIC_PLAYER_Z_INDEX + 2;
/**
 * The phone's now-playing sheet: over the bar. What floats from its waveform shares its layer and,
 * opened after it, shows on top; so do the player's tooltips, a layer up.
 */
export const MUSIC_SHEET_Z_INDEX = MUSIC_PLAYER_Z_INDEX + 1;
/** The phone's Up next sheet, and menus opened from the now-playing sheet: over that sheet. */
export const MUSIC_UP_NEXT_SHEET_Z_INDEX = MUSIC_SHEET_Z_INDEX + 1;

/** The desktop bar's height, above the safe-area inset. */
export const MUSIC_PLAYER_BAR_HEIGHT = 72;

/** A tooltip of the player's own controls: over the bar and the panel, not under them. */
export function PlayerTooltip(props: TooltipProps) {
  return <Tooltip zIndex={MUSIC_PLAYER_TOOLTIP_Z_INDEX} {...props} />;
}
