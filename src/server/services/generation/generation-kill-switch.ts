import { TRPCError } from '@trpc/server';
import {
  generationStatusDefaultMessage,
  type GenerationStatus,
} from '~/server/schema/generation.schema';

/**
 * What a generation request is told when the generation settings (the kill switch or the gate
 * rules) cannot be read and this process has never read them.
 */
export const GENERATION_CONFIG_UNAVAILABLE_MESSAGE =
  'Generation is temporarily unavailable. Please try again in a few minutes.';

/**
 * The 503 for unreadable generation settings. Its own class so a caller can tell it from every
 * other 503, above all the orchestrator submit's own (a submit that may already be queued).
 */
export class GenerationConfigUnavailableError extends TRPCError {
  constructor() {
    super({ code: 'SERVICE_UNAVAILABLE', message: GENERATION_CONFIG_UNAVAILABLE_MESSAGE });
  }
}

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

/**
 * The kill switch's refusal: a BAD_REQUEST carrying the operator's message. Its own class so a
 * surface that rewrites generation errors for display passes this one through verbatim.
 */
export class GenerationStatusRefusedError extends TRPCError {
  constructor(message: string) {
    super({ code: 'BAD_REQUEST', message });
  }
}

/** Throws the kill switch's refusal (`GenerationStatusRefusedError`). */
export function assertGenerationStatusAllows(
  status: Pick<GenerationStatus, 'mode' | 'message'>,
  user: { isModerator?: boolean; tier?: string }
): void {
  const message = generationStatusRefusal(status, user);
  if (message !== null) throw new GenerationStatusRefusedError(message);
}
