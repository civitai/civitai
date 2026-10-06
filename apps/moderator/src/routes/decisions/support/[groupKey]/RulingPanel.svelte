<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { RadioGroup, RadioGroupItem } from '@civitai/ui/components/ui/radio-group/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import {
    ANSWER_MAX_LENGTH,
    GROUP_RULINGS,
    GROUP_RULING_LABEL,
    type GroupRuling,
  } from '$lib/decision-rulings';
  import { dateTime, plural } from '$lib/format';
  import { FormState } from '$lib/form-state.svelte';
  import { denied } from '$lib/permissions';
  import type { ResolutionAnswer } from '$lib/server/decision-resolution.service';
  import type { AnswerDraft } from './answer-draft.svelte';

  let {
    version,
    topic,
    topics,
    targets,
    fingerprint,
    current,
    answer,
    notBelongs,
    draft,
    canRule,
    canAnswer,
  }: {
    /** The version this page showed — posted, so the ruling is recorded against it. */
    version: string;
    topic: string;
    topics: string[];
    targets: { groupKey: string; title: string; topic: string }[];
    /** The fingerprint of what this page rendered — posted so the server can refuse a ruling on a
     *  group that changed underneath it. */
    fingerprint: string;
    current: { ruling: GroupRuling; ruledBy: number; ruledAt: Date; targetKey: string | null } | null;
    /** The current ruling's answer, when it is `resolved`. */
    answer: ResolutionAnswer | null;
    /** Members currently labelled "does not belong" — they would not get the answer. */
    notBelongs: number;
    /** The ruling and answer in progress — page-owned, because the member table pre-fills it. */
    draft: AnswerDraft;
    canRule: boolean;
    /** `decisions.answer` as well as `decisions.rule`: what a `resolved` ruling needs. */
    canAnswer: boolean;
  } = $props();

  // Component-local: the follow-ups in progress. The page `{#key}`s this panel on the group, so they
  // never carry over to another group.
  let targetKey = $state('');
  let escalateTo = $state('');

  const targetLabel = $derived(
    targets.find((t) => t.groupKey === targetKey)?.title ?? 'Choose the original group'
  );
  // The follow-up a ruling needs, checked before the round trip. The server checks it again.
  const incomplete = $derived(
    !draft.ruling ||
      (draft.ruling === 'duplicate_of' && !targetKey) ||
      (draft.ruling === 'escalate' && !escalateTo) ||
      (draft.ruling === 'resolved' && (!canAnswer || !draft.text.trim()))
  );

  // Its own submit state and refusal — reloads on success, so "Last ruling" comes from the database.
  const rule = new FormState({
    onSuccess: () => {
      targetKey = escalateTo = '';
      draft.reset();
    },
    reload: true,
    // A 409 means the group moved under the page: refresh it so the next submit compares against what
    // is now on screen. A failure does not reset the form, so the moderator's note survives.
    onSettled: (r) => {
      if (r.type === 'failure' && r.status === 409) void invalidateAll();
    },
  });

  const HINT: Partial<Record<GroupRuling, string>> = {
    duplicate_of: 'Recorded only. The router keeps the group until this is applied router-side.',
    park: 'Recorded only. The router keeps routing to it until this is applied router-side.',
    resolved: 'Also records the grouping as correct.',
  };
</script>

<section class="mt-6 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-1 text-white">Ruling on the group</h2>
  <p class="text-dark-2 mb-3 text-sm">
    While the router runs in shadow mode, rulings are recorded as training data and change nothing in
    Freshdesk. A Resolved group's answer is the reply meant for later tickets that match the group.
  </p>
  {#if current}
    <p class="text-dark-2 mb-3 text-sm">
      Last ruling: <strong class="text-dark-0">{GROUP_RULING_LABEL[current.ruling]}</strong>
      {#if current.targetKey}(of <code>{current.targetKey}</code>){/if}
      by user {current.ruledBy} · {dateTime(current.ruledAt)}
    </p>
    {#if answer}
      <blockquote
        class="mb-3 max-w-xl border-l-2 border-dark-4 pl-3 text-sm break-words whitespace-pre-wrap"
      >
        {answer.text}
      </blockquote>
      {#if answer.source}
        <p class="text-dark-2 mb-3 text-xs">
          From a reply on ticket #{answer.source.ticketId}.
        </p>
      {/if}
    {/if}
  {:else}
    <p class="text-dark-2 mb-3 text-sm">Not ruled yet.</p>
  {/if}

  {#if rule.error}
    <ErrorAlert class="mb-3" message={rule.error} />
  {/if}

  {#if canRule}
    <form method="POST" action="?/rule" use:enhance={rule.enhance} class="space-y-4">
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="fingerprint" value={fingerprint} />
      <RadioGroup name="ruling" bind:value={draft.ruling} class="grid gap-2 sm:grid-cols-2">
        {#each GROUP_RULINGS as r (r)}
          <div class="flex items-center gap-2">
            <RadioGroupItem value={r} id="ruling-{r}" disabled={r === 'resolved' && !canAnswer} />
            <Label for="ruling-{r}" class="font-normal text-dark-0">{GROUP_RULING_LABEL[r]}</Label>
          </div>
        {/each}
      </RadioGroup>
      {#if !canAnswer}
        <p class="text-dark-2 text-xs">{denied('decisions.answer')}</p>
      {/if}

      {#if draft.ruling === 'resolved'}
        <div class="space-y-2">
          <Label for="ruling-answer">Canonical answer (required — no customer details)</Label>
          <Textarea
            id="ruling-answer"
            name="answerText"
            bind:value={draft.text}
            maxlength={ANSWER_MAX_LENGTH}
            rows={6}
            class="max-w-xl"
          />
          {#if draft.source}
            <input type="hidden" name="answerTicketId" value={draft.source.ticketId} />
            <input type="hidden" name="answerConversationId" value={draft.source.conversationId} />
            <p class="text-dark-2 text-xs">
              Pre-filled from a reply on ticket #{draft.source.ticketId}{draft.edited
                ? ' — edited'
                : ' — not edited yet'}.
              <button
                type="button"
                class="underline hover:text-dark-0"
                onclick={() => (draft.source = null)}>Remove the source</button
              >
            </p>
          {:else}
            <p class="text-dark-2 text-xs">
              To start from a past reply, choose “Use a reply” on a member below.
            </p>
          {/if}
          {#if notBelongs > 0}
            <p class="text-sm text-amber-300">
              ⚠ {plural(notBelongs, 'member')} labelled “does not belong” — they would not get this answer.
            </p>
          {/if}
          {#if current?.ruling === 'resolved'}
            <p class="text-sm text-amber-300">⚠ This replaces the recorded answer.</p>
          {/if}
        </div>
      {:else if current?.ruling === 'resolved' && draft.ruling}
        <p class="text-sm text-amber-300">
          ⚠ This withdraws the recorded answer — the group will have no answer until it is resolved again.
        </p>
      {/if}

      {#if draft.ruling === 'duplicate_of'}
        <div>
          <Label for="ruling-target">Original group</Label>
          <Select.Root type="single" name="targetKey" bind:value={targetKey}>
            <Select.Trigger id="ruling-target" class="mt-1 w-full max-w-xl">{targetLabel}</Select.Trigger>
            <Select.Content>
              {#if targets.length === 0}
                <Select.Item value="" disabled>No other open groups in this version</Select.Item>
              {/if}
              {#each targets as t (t.groupKey)}
                <Select.Item value={t.groupKey}>
                  {t.title} · {t.topic}{t.topic === topic ? '' : ' (other area)'}
                </Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
      {:else if draft.ruling === 'escalate'}
        <div>
          <Label for="ruling-escalate">Escalate to area</Label>
          <Select.Root type="single" name="escalateTo" bind:value={escalateTo}>
            <Select.Trigger id="ruling-escalate" class="mt-1 w-64">
              {escalateTo || 'Choose an area'}
            </Select.Trigger>
            <Select.Content>
              {#each topics as t (t)}
                <Select.Item value={t}>{t}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
      {/if}

      {#if draft.ruling && HINT[draft.ruling]}
        <p class="text-dark-2 text-sm">{HINT[draft.ruling]}</p>
      {/if}

      <div>
        <Label for="ruling-note">Note (optional)</Label>
        <Textarea id="ruling-note" name="note" maxlength={2000} rows={2} class="mt-1 max-w-xl" />
      </div>

      <Button type="submit" size="sm" disabled={rule.submitting || incomplete}>
        {rule.submitting ? 'Recording…' : 'Record ruling'}
      </Button>
    </form>
  {/if}
</section>
