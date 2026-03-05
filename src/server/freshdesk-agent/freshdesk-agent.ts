import type { FreshdeskWebhookPayload } from '~/server/http/freshdesk/freshdesk.schema';
import { logToAxiom } from '~/server/logging/client';
import { openrouter } from '~/server/services/ai/openrouter';
import { executeToolCall, getToolsForPhase } from './freshdesk-tools';
import { buildUserMessage, getSystemPrompt } from './freshdesk-prompts';
import { freshdeskCaller } from '~/server/http/freshdesk/freshdesk.caller';

const log = (data: Record<string, unknown>) =>
  logToAxiom({ name: 'freshdesk-agent', ...data }, 'webhooks').catch(() => {});

export async function processFreshdeskAgent(payload: FreshdeskWebhookPayload) {
  const { ticket_id, phase } = payload;
  const startTime = Date.now();

  await log({ type: 'start', ticket_id, phase });

  try {
    if (!openrouter) {
      throw new Error('OpenRouter client not initialized (missing OPENROUTER_API_KEY)');
    }

    const tools = getToolsForPhase(phase);
    const systemPrompt = getSystemPrompt(phase);
    const userMessage = buildUserMessage(ticket_id, phase);

    const result = await openrouter.runAgentLoop({
      system: systemPrompt,
      userMessage,
      tools,
      executeToolCall,
    });

    const durationMs = Date.now() - startTime;
    await log({
      type: 'complete',
      ticket_id,
      phase,
      turnsUsed: result.turnsUsed,
      toolCallsExecuted: result.toolCallsExecuted,
      durationMs,
    });
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

    await log({ type: 'error', ticket_id, phase, message, durationMs });

    // Try to add an error note to the ticket so staff knows something went wrong
    try {
      await freshdeskCaller.addNote(
        ticket_id,
        `<p><strong>⚠️ Agent Error (${phase})</strong></p><p>The automated agent encountered an error processing this ticket. A human agent should review manually.</p><p><em>Error: ${message}</em></p>`
      );
    } catch {
      // If we can't even add a note, just log it
      await log({ type: 'error-note-failed', ticket_id, phase });
    }
  }
}
