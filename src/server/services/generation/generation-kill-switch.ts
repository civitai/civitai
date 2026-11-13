import { TRPCError } from '@trpc/server';
import {
  generationStatusDefaultMessage,
  type GenerationStatus,
} from '~/server/schema/generation.schema';

/**
 * The global generation kill switch's decision for one caller: the message to refuse them with,
 * or null when they may generate. The one rule the onsite generator, App Blocks and preset
 * generation (`submitPresetImageGen`) apply, so a moderator's "disabled" / "members only" cannot
 * hold on one surface and not another.
 *
 * - `disabled`: refused for everyone but moderators.
 * - `memberOnly`: refused for free (no tier) callers who are not moderators.
 */
export function generationStatusRefusal(
  status: Pick<GenerationStatus, 'mode' | 'message'>,
  user: { isModerator?: boolean; tier?: string }
): string | null {
  if (user.isModerator) return null;
  const refused =
    status.mode === 'disabled' ||
    (status.mode === 'memberOnly' && (user.tier ?? 'free') === 'free');
  return refused ? status.message ?? generationStatusDefaultMessage : null;
}

/** Throws the kill switch's refusal as a BAD_REQUEST carrying the operator's message. */
export function assertGenerationStatusAllows(
  status: Pick<GenerationStatus, 'mode' | 'message'>,
  user: { isModerator?: boolean; tier?: string }
): void {
  const message = generationStatusRefusal(status, user);
  if (message !== null) throw new TRPCError({ code: 'BAD_REQUEST', message });
}
