import { createHmac } from 'node:crypto';
import type { TurnEvent } from '$lib/assistant/types';
import type { PermissionId } from '$lib/permissions';
import { complete, listPrices, resolveModel } from './openrouter';
import { env } from '$env/dynamic/private';
import {
  DAILY_TOKEN_CAP,
  runTurn,
  TURN_DEADLINE_MS,
  TURN_TOKEN_BUDGET,
  type TurnOutcome,
} from './loop';
import { systemPrompt } from './prompt';
import { LOOKUP, toolSpec, toolsFor } from './tools';
import { redactAddresses } from '../redact-addresses';
import type { Playbook } from './store';
import { capPrice, costUsd } from '$lib/assistant/models';
import { capsFor, resolveDailyCap } from './spend-cap';
import {
  finishTurn,
  DEFAULT_CHAT_TITLE,
  getChat,
  getMaskSalt,
  getPlaybook,
  hasRunningTurn,
  listPlaybooks,
  listTurns,
  recordTurnTokens,
  renameChat,
  startTurn,
  tokensToday,
  usdToday,
} from './store';

const MIN_TURN_BUDGET = 5_000;

// A setting, not a constant: the pilot's per-question budget is to be set from the real distribution
// of turns, without a release each time. Out-of-range values are clamped, so a tighter setting never
// comes out looser; anything that is not a whole number falls back to the default.
export function turnTokenBudget(raw = env.ASSISTANT_TURN_TOKEN_BUDGET): number {
  const n = Number(raw?.trim() || NaN);
  if (!Number.isInteger(n)) return TURN_TOKEN_BUDGET;
  return Math.min(Math.max(n, MIN_TURN_BUDGET), DAILY_TOKEN_CAP);
}

/** Earlier turns replayed to the model as plain prompt/answer pairs; their tool results are not. */
export const HISTORY_TURNS = 12;

export type TurnRefusal = { status: 404 | 409 | 429; error: string };

export const BUSY = 'Another of your questions is still being answered. Wait for it to finish.';

export const OVER_ALLOWANCE =
  'You have used today’s assistant allowance. It resets at midnight UTC.';

/** Where a moderator's day stands against their dollar cap and the token circuit breaker. */
export type Allowance = { spentUsd: number; capUsd: number; usedTokens: number };

export async function allowanceToday(moderator: {
  id: number;
  roles: readonly string[];
}): Promise<Allowance> {
  const [spentUsd, caps, usedTokens] = await Promise.all([
    usdToday(moderator.id),
    capsFor(moderator),
    tokensToday(moderator.id),
  ]);
  return { spentUsd, capUsd: resolveDailyCap(caps, moderator).usd, usedTokens };
}

/**
 * Everything a turn checks before it may start. Separate from running it so the endpoint can refuse
 * with a status code before it opens a stream.
 */
export async function admitTurn(
  chatId: number,
  moderator: { id: number; roles: readonly string[] }
): Promise<{ ok: true; allowance: Allowance } | ({ ok: false } & TurnRefusal)> {
  const chat = await getChat(chatId, moderator.id);
  if (!chat) return { ok: false, status: 404, error: 'No such chat.' };
  if (await hasRunningTurn(moderator.id, TURN_DEADLINE_MS * 2))
    return { ok: false, status: 409, error: BUSY };
  const allowance = await allowanceToday(moderator);
  if (allowance.spentUsd >= allowance.capUsd || allowance.usedTokens >= DAILY_TOKEN_CAP)
    return { ok: false, status: 429, error: OVER_ALLOWANCE };
  return { ok: true, allowance };
}

/**
 * The tokens left in the day on this model: the dollars left at the dearer of its input and output
 * price, so whatever the prompt/completion split, spending them cannot cost more than is left. Never
 * past the circuit breaker.
 */
export function remainingTokens(allowance: Allowance, price: { input: number; output: number }) {
  const perToken = Math.max(price.input, price.output) / 1_000_000;
  const dollars = Math.max(allowance.capUsd - allowance.spentUsd, 0);
  const byDollars = perToken > 0 ? Math.floor(dollars / perToken) : Infinity;
  return Math.max(Math.min(byDollars, DAILY_TOKEN_CAP - allowance.usedTokens), 0);
}

export async function executeTurn(input: {
  chatId: number;
  moderator: { id: number; username: string | null };
  prompt: string;
  playbookSlug: string | null;
  /** The moderator's pick, already checked against `ASSISTANT_MODELS`; null runs the default. */
  model: string | null;
  canAccess: (path: string) => boolean;
  hasGrant: (permission: PermissionId) => boolean;
  allowance: Allowance;
  emit: (event: TurnEvent) => void;
}): Promise<TurnOutcome & { turnId: number }> {
  const [chat, turns, allPlaybooks, chosen, salt] = await Promise.all([
    getChat(input.chatId, input.moderator.id),
    listTurns(input.chatId),
    listPlaybooks(),
    input.playbookSlug ? getPlaybook(input.playbookSlug) : null,
    getMaskSalt(input.chatId),
  ]);
  // Playbook text can quote addresses; it reaches the model only as this moderator may read it.
  const shown = (p: Playbook): Playbook =>
    input.canAccess(LOOKUP)
      ? p
      : { ...p, summary: redactAddresses(p.summary), body: redactAddresses(p.body) };
  const playbooks = allPlaybooks.map(shown);
  const playbook = chosen && shown(chosen);

  const model = resolveModel(input.model);
  const { price } = capPrice(model, await listPrices());
  const turnId = await startTurn({
    chatId: input.chatId,
    moderatorId: input.moderator.id,
    prompt: input.prompt,
    playbookSlug: playbook?.slug ?? null,
    playbookVersion: playbook?.version ?? null,
    model,
  });
  input.emit({ type: 'started', turnId });
  // A chat started from "New chat" is named by its first question, or the list reads as a column of
  // identical titles.
  if (chat?.title === DEFAULT_CHAT_TITLE && !turns.length)
    await renameChat(input.chatId, input.moderator.id, chatTitleFrom(input.prompt));

  const history = turns.slice(-HISTORY_TURNS).map((t) => ({ prompt: t.prompt, answer: t.answer }));
  const ctx = {
    moderatorId: input.moderator.id,
    chatId: input.chatId,
    turnId,
    canAccess: input.canAccess,
    hasGrant: input.hasGrant,
    mask: addressLabeler(salt),
    conversation: () => [...history, { prompt: input.prompt, answer: null }],
  };
  const tools = toolsFor(ctx);

  // The moderator's playbook rides in the user message at the version they picked, so the audit row
  // (which records the version) says exactly what the model was told.
  const prompt = playbook
    ? `Follow the playbook "${playbook.title}" (${playbook.slug} v${playbook.version}):\n\n${playbook.body}\n\n---\n\n${input.prompt}`
    : input.prompt;

  const outcome = await runTurn({
    system: systemPrompt({
      moderator: input.moderator.username,
      today: new Date(),
      playbooks,
      seed: { userId: chat?.seedUserId ?? null, reportId: chat?.seedReportId ?? null },
    }),
    history,
    prompt,
    tools,
    specs: tools.map(toolSpec),
    ctx,
    budget: remainingTokens(input.allowance, price),
    turnBudget: turnTokenBudget(),
    knownRefs: turns.flatMap((t) => t.sources.map((s) => s.ref)),
    complete: (req) => complete({ ...req, model }),
    onUsage: (prompt, completion) =>
      recordTurnTokens(turnId, prompt, completion).catch((e) =>
        console.error('[assistant] could not record a running turn’s tokens', e)
      ),
    emit: input.emit,
  });

  // Priced again at the end: the live price can refresh mid-turn.
  const charged = capPrice(model, await listPrices());
  await finishTurn(turnId, outcome, {
    usd: costUsd(outcome.promptTokens, outcome.completionTokens, charged.price),
    source: charged.source,
  });
  input.emit({
    type: 'done',
    turnId,
    status: outcome.status,
    answer: outcome.answer,
    error: outcome.error,
  });
  return { ...outcome, turnId };
}

/** `address 1a2b3c4d`: the same label for the same address all chat long. */
export const addressLabeler = (salt: string) => (cluster: string) =>
  `address ${createHmac('sha256', salt).update(cluster).digest('hex').slice(0, 8)}`;

export const chatTitleFrom = (prompt: string) => {
  const line = prompt.trim().split('\n')[0];
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};
