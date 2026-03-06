import type { FreshdeskWebhookPayload } from '~/server/http/freshdesk/freshdesk.schema';
import { logToAxiom } from '~/server/logging/client';
import { openrouter } from '~/server/services/ai/openrouter';
import { executeToolCall, getToolsForPhase } from './freshdesk-tools';
import { buildUserMessage, getSystemPrompt } from './freshdesk-prompts';
import { freshdeskCaller } from '~/server/http/freshdesk/freshdesk.caller';
import { agentLog, getDebugContext } from './freshdesk-debug';

const log = (data: Record<string, unknown>) =>
  logToAxiom({ name: 'freshdesk-agent', ...data }, 'webhooks').catch(() => null);

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
    const userMessage = buildUserMessage(payload);

    agentLog(
      'TOOLS',
      tools.map((t) => t.function.name)
    );
    agentLog(
      'SYSTEM PROMPT',
      systemPrompt.slice(0, 500) + (systemPrompt.length > 500 ? '...' : '')
    );
    agentLog('USER MESSAGE', userMessage);

    const result = await openrouter.runAgentLoop({
      system: systemPrompt,
      userMessage,
      tools,
      executeToolCall,
      maxTurns: 25,
    });

    const durationMs = Date.now() - startTime;

    agentLog('FINAL RESPONSE', result.response);
    agentLog('COMPLETE', {
      turnsUsed: result.turnsUsed,
      toolCallsExecuted: result.toolCallsExecuted,
      exhausted: result.exhausted,
      durationMs,
    });

    await log({
      type: result.exhausted ? 'exhausted' : 'complete',
      ticket_id,
      phase,
      turnsUsed: result.turnsUsed,
      toolCallsExecuted: result.toolCallsExecuted,
      durationMs,
    });

    if (result.exhausted) {
      const summary = result.response || 'No summary available.';
      const ctx = getDebugContext();
      if (ctx?.dryRun) {
        agentLog('DRY RUN INTERCEPTED: handoff note', { ticket_id, summary });
      } else {
        await freshdeskCaller.addNote(
          ticket_id,
          `<p><strong>⚠️ Agent Handoff (${phase})</strong></p><p>The automated agent reached its turn limit before completing. Here is a summary of findings so far:</p><p>${summary}</p><p><em>A human agent should continue from here.</em></p>`
        );
      }
    }
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

    await log({ type: 'error', ticket_id, phase, message, durationMs });

    // Try to add an error note to the ticket so staff knows something went wrong
    const ctx = getDebugContext();
    if (ctx?.dryRun) {
      agentLog('DRY RUN INTERCEPTED: error note', { ticket_id, message });
    } else {
      try {
        await freshdeskCaller.addNote(
          ticket_id,
          `<p><strong>⚠️ Agent Error (${phase})</strong></p><p>The automated agent encountered an error processing this ticket. A human agent should review manually.</p><p><em>Error: ${message}</em></p>`
        );
      } catch (error) {
        // If we can't even add a note, just log it
        const errorMessage = error instanceof Error ? error.message : String(error);
        await log({
          type: 'error',
          ticket_id,
          phase,
          message: 'Failed to add error note',
          error: errorMessage,
        });
      }
    }
  }
}
