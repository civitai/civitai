import { deserialize } from '$app/forms';
import { browserStorage } from '$lib/text-scan-lab/changes.svelte';
import { isStalePending, readPending, setPending } from './alias-suggestions-store';
import {
  searchAliases,
  type PollAnswer,
  type SearchAnswer,
  type SearchOutcome,
} from './alias-search';
import type { AliasResultAnswer, SuggestAliasesResult } from './suggest-aliases';

export type SearchRule = { subject: string; description: string; aliases: string[] };

/** Where a rule's pending search is remembered; null for a rule that has no saved identity yet. */
export type PendingSlot = { key: string; ruleId: number; updatedAt: string };

async function callAction<T>(pathname: string, name: string, fields: Record<string, string>) {
  const body = new FormData();
  for (const [field, value] of Object.entries(fields)) body.set(field, value);
  const response = await fetch(`${pathname}?/${name}`, {
    method: 'POST',
    body,
    headers: { 'x-sveltekit-action': 'true' },
  });
  const result = deserialize(await response.text());
  if (result.type === 'success') return result.data as unknown as T;
  if (result.type === 'failure')
    throw new Error(String(result.data?.error ?? 'The suggester refused this rule.'));
  throw new Error(result.type === 'error' ? result.error.message : 'The suggester did not answer.');
}

const ruleFields = (rule: SearchRule) => ({
  subject: rule.subject,
  description: rule.description,
  aliases: rule.aliases.join('\n'),
});

const submit = async (pathname: string, rule: SearchRule): Promise<SearchAnswer> => {
  const answer = await callAction<SuggestAliasesResult>(
    pathname,
    'suggestAliases',
    ruleFields(rule)
  );
  return answer.status === 'pending'
    ? { status: 'pending', workflowId: answer.workflowId }
    : { status: 'done', suggestions: answer.suggestions, costTotal: answer.costTotal };
};

const poll = async (
  pathname: string,
  rule: SearchRule,
  workflowId: string
): Promise<PollAnswer> => {
  const answer = await callAction<AliasResultAnswer>(pathname, 'aliasSuggestionResult', {
    ...ruleFields(rule),
    workflowId,
  });
  if (answer.status === 'pending') return { status: 'pending' };
  if (answer.status === 'failed') return { status: 'failed', error: answer.error };
  return { status: 'done', suggestions: answer.suggestions, costTotal: answer.costTotal };
};

/** A fresh stored search for this rule version, if any; a stale one belongs to an edited rule and is dropped. */
export function storedWorkflowId(slot: PendingSlot | null): string | undefined {
  if (!slot) return undefined;
  const store = browserStorage();
  const entry = readPending(store, slot.key)[slot.ruleId];
  if (!entry) return undefined;
  if (isStalePending(entry, slot.updatedAt)) {
    setPending(store, slot.key, slot.ruleId, null);
    return undefined;
  }
  return entry.workflowId;
}

/**
 * Runs, or resumes, one rule's search. The workflow id is stored the moment it exists and removed
 * only when the search finished or really failed, so a reload or a Stop never loses a billed search
 * and never pays for a second one.
 */
export async function runRuleSearch(opts: {
  pathname: string;
  rule: SearchRule;
  slot: PendingSlot | null;
  signal?: AbortSignal;
}): Promise<SearchOutcome> {
  const { pathname, rule, slot } = opts;
  const store = browserStorage();
  const outcome = await searchAliases({
    workflowId: storedWorkflowId(slot),
    signal: opts.signal,
    submit: () => submit(pathname, rule),
    poll: (workflowId) => poll(pathname, rule, workflowId),
    onWorkflowId: (workflowId) => {
      if (slot) setPending(store, slot.key, slot.ruleId, { updatedAt: slot.updatedAt, workflowId });
    },
  });
  if (slot && (outcome.status === 'done' || outcome.status === 'failed'))
    setPending(store, slot.key, slot.ruleId, null);
  return outcome;
}
