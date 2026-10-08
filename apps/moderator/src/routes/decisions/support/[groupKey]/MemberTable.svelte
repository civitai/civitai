<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { SvelteMap } from 'svelte/reactivity';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import {
    MEMBER_RULINGS,
    MEMBER_RULING_LABEL,
    MEMBER_RULING_SHORT_LABEL,
    type MemberRuling,
  } from '$lib/decision-rulings';
  import { probabilityLabel } from '$lib/decisions';
  import { LINK_CLASS, MUTED_LINK_CLASS, dateTime } from '$lib/format';
  import type { PageData } from './$types';
  import type { AnswerDraft } from './answer-draft.svelte';

  type Member = NonNullable<PageData['detail']['decision']>['members'][number];

  let {
    members,
    labels,
    version,
    ticketHref,
    canRule,
    canAnswer,
    draft,
  }: {
    members: Member[];
    labels: PageData['memberLabels'];
    version: string;
    ticketHref: (ticketId: string) => string;
    canRule: boolean;
    canAnswer: boolean;
    /** Opening a member's replies goes through the draft the ruling panel records. */
    draft: AnswerDraft;
  } = $props();

  /** The accessible name starts with the visible word, so a voice command naming it still works. */
  const memberRulingName = (r: MemberRuling) =>
    MEMBER_RULING_SHORT_LABEL[r] === MEMBER_RULING_LABEL[r]
      ? MEMBER_RULING_LABEL[r]
      : `${MEMBER_RULING_SHORT_LABEL[r]} — ${MEMBER_RULING_LABEL[r].toLowerCase()}`;

  const toneClass = (on: boolean) =>
    on ? 'bg-blue-4/20 text-white' : 'text-dark-2 hover:text-dark-0';
  /** "Use a reply" — a standalone toggle. */
  const toggleClass = (on: boolean) =>
    `rounded border px-2 py-0.5 text-xs disabled:opacity-50 ${
      on ? 'border-blue-4' : 'border-dark-4'
    } ${toneClass(on)}`;
  /** One segment of the label control; the group draws the border and the dividers. */
  const segmentClass = (on: boolean) =>
    `px-2 py-0.5 text-xs disabled:opacity-50 ${toneClass(on)}`;

  // ticketId → the label this session just submitted, shown until its own write settles.
  const pending = new SvelteMap<string, MemberRuling>();
  // ticketId → why the last label on that row was refused. Held HERE, per row, rather than read off
  // the page-level `form`: that one is shared with the ruling panel, and a refusal routed by a scope
  // the server stamps is exactly the shape that renders in two panels, or in none.
  const refused = new SvelteMap<string, string>();

  /**
   * One row's label submit. Optimistic, and it reverts: the mark goes on before the server answers
   * and comes off when THIS write settles — after the reload on success, so the stored label takes
   * over; at once on a refusal, which is then shown on the row.
   *
   * One write per row at a time: the row's buttons are disabled while its mark is pending, so a
   * second click cannot have its mark or refusal overwritten by the first one settling.
   *
   * 🔴 Reads only `ticketId` (the `{#each}` key) and `ruling` (the inner key) — `use:enhance` captures
   * this closure once at mount.
   */
  const submit =
    (ticketId: string, ruling: MemberRuling): SubmitFunction =>
    () => {
      pending.set(ticketId, ruling);
      refused.delete(ticketId);
      return async ({ result, update }) => {
        if (result.type !== 'success') {
          pending.delete(ticketId);
          refused.set(
            ticketId,
            result.type === 'failure' && typeof result.data?.error === 'string'
              ? result.data.error
              : 'The label was NOT recorded.'
          );
        }
        // Applies the result (so `form` is current) and reloads on success only. `finally` so the
        // row can never stay disabled if the reload rejects.
        try {
          await update({ invalidateAll: result.type === 'success' });
        } finally {
          if (result.type === 'success') pending.delete(ticketId);
        }
      };
    };
</script>

<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Member</TableHead>
      <TableHead>Created</TableHead>
      <TableHead>Topic (p)</TableHead>
      <TableHead class="text-right">p group</TableHead>
      <TableHead class="text-right">p novel</TableHead>
      <TableHead>Status</TableHead>
      <TableHead>Fits the definition?</TableHead>
      {#if canAnswer}<TableHead>Answer</TableHead>{/if}
    </TableRow>
  </TableHeader>
  <TableBody>
    {#each members as m (m.ticketId)}
      {@const shown = pending.get(m.ticketId) ?? labels[m.ticketId]?.ruling ?? null}
      <TableRow>
        <TableCell class="whitespace-normal">
          {#if m.routed}
            <a class={LINK_CLASS} href={ticketHref(m.ticketId)}>#{m.ticketId}</a>
          {:else}
            #{m.ticketId}
          {/if}
          <a
            class={MUTED_LINK_CLASS}
            href={m.ticketUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="Open #{m.ticketId} in Freshdesk">↗</a
          >
          {#if m.isFounder}<Badge variant="secondary" class="ml-1">founder</Badge>{/if}
          {#if m.subject}<div class="text-dark-2 max-w-md text-xs break-words">{m.subject}</div>{/if}
        </TableCell>
        <TableCell class="min-w-32 whitespace-normal">{dateTime(m.ticketCreatedAt)}</TableCell>
        <TableCell>{m.chosenTopic || '—'} {probabilityLabel(m.probabilities.topic)}</TableCell>
        <TableCell class="text-right">{probabilityLabel(m.probabilities.group)}</TableCell>
        <TableCell class="text-right">{probabilityLabel(m.probabilities.novel)}</TableCell>
        <TableCell>{m.status ?? '—'}</TableCell>
        <TableCell>
          {#if m.isFounder}
            <span class="text-dark-2 text-xs">founder</span>
          {:else if canRule}
            <div
              class="inline-flex divide-x divide-dark-4 overflow-hidden rounded border border-dark-4"
              role="group"
              aria-label="Does #{m.ticketId} fit the group definition?"
            >
              {#each MEMBER_RULINGS as r (r)}
                <form
                  method="POST"
                  action="?/label"
                  class="flex"
                  use:enhance={submit(m.ticketId, r)}
                >
                  <input type="hidden" name="version" value={version} />
                  <input type="hidden" name="ticketId" value={m.ticketId} />
                  <input type="hidden" name="ruling" value={r} />
                  <button
                    type="submit"
                    disabled={pending.has(m.ticketId)}
                    aria-pressed={shown === r}
                    aria-label={memberRulingName(r)}
                    title={MEMBER_RULING_LABEL[r]}
                    class={segmentClass(shown === r)}>{MEMBER_RULING_SHORT_LABEL[r]}</button
                  >
                </form>
              {/each}
            </div>
          {:else}
            <span class="text-dark-2 text-xs">{shown ? MEMBER_RULING_LABEL[shown] : '—'}</span>
          {/if}
          {#if refused.has(m.ticketId)}
            <p class="mt-1 text-xs text-red-300" role="alert">{refused.get(m.ticketId)}</p>
          {/if}
        </TableCell>
        {#if canAnswer}
          <TableCell>
            <button
              type="button"
              aria-pressed={draft.replyTicket === m.ticketId}
              class={toggleClass(draft.replyTicket === m.ticketId)}
              onclick={() => (draft.replyTicket = m.ticketId)}>Use a reply ▸</button
            >
          </TableCell>
        {/if}
      </TableRow>
    {/each}
  </TableBody>
</Table>
