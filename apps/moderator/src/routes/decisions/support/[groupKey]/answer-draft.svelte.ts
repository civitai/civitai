import type { GroupRuling } from '$lib/decision-rulings';
import type { ResolutionAnswer } from '$lib/server/decision-resolution.service';
import type { AgentReply } from '$lib/server/freshdesk.service';

/**
 * The group ruling being drafted, shared by the member table (which opens a ticket's replies) and the
 * ruling panel (which records it).
 *
 * 🔴 ONE PER GROUP. The page builds it from the group key alone, so a draft never follows the
 * moderator onto another group, and a reload of the SAME group (the 409 refresh) keeps it.
 */
export class AnswerDraft {
  ruling = $state<GroupRuling | ''>('');
  text = $state('');
  /** The reply the text was pre-filled from. Cleared to record the answer without a source. */
  source = $state<(NonNullable<ResolutionAnswer['source']> & { text: string }) | null>(null);
  /** The member whose replies are open, or null. */
  replyTicket = $state<string | null>(null);

  /** Whether the text still reads exactly as the reply it was pre-filled from. */
  readonly edited = $derived(this.source !== null && this.text.trim() !== this.source.text);

  constructor(readonly groupKey: string) {}

  /** Pre-fill the answer from one reply. Nothing is written until the ruling is recorded. */
  use(ticketId: string, reply: AgentReply): void {
    this.ruling = 'resolved';
    this.text = reply.text;
    this.source = { ticketId, conversationId: reply.conversationId, text: reply.text };
    this.replyTicket = null;
  }

  reset(): void {
    this.ruling = '';
    this.text = '';
    this.source = null;
    this.replyTicket = null;
  }
}
