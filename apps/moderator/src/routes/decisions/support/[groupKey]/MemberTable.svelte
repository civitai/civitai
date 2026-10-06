<script lang="ts">
  import { enhance } from '$app/forms';
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
  import { optimisticEnhancer } from '$lib/form-action';
  import { MEMBER_RULINGS, MEMBER_RULING_LABEL, type MemberRuling } from '$lib/decision-rulings';
  import { probabilityLabel } from '$lib/decisions';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import type { PageData } from './$types';

  type Member = NonNullable<PageData['detail']['decision']>['members'][number];

  let {
    members,
    labels,
    version,
    ticketHref,
    canRule,
    error,
  }: {
    members: Member[];
    labels: PageData['memberLabels'];
    version: string;
    ticketHref: (ticketId: string) => string;
    canRule: boolean;
    /** The refused label, if the last submit was one — rendered on its own row. */
    error: { ticketId: string; message: string } | null;
  } = $props();

  // ticketId → the label this session just submitted, shown until the reload lands or it is refused.
  const pending = new SvelteMap<string, MemberRuling>();
  $effect(() => {
    // 🔴 READ FOR ITS DEPENDENCY: a reload replaces `labels`, and the optimistic marks must give way to
    // what was actually stored.
    labels;
    pending.clear();
  });

  // 🔴 Reads only `ticketId`, the `{#each}` key — `use:enhance` captures this closure once at mount.
  const submit = (ticketId: string, ruling: MemberRuling) =>
    optimisticEnhancer(
      () => {
        pending.set(ticketId, ruling);
        return () => pending.delete(ticketId);
      },
      { reload: true }
    );
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
      <TableHead>Belongs?</TableHead>
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
          <a class="text-dark-2 text-xs hover:underline" href={m.ticketUrl} target="_blank" rel="noreferrer"
            >↗</a
          >
          {#if m.isFounder}<Badge variant="secondary" class="ml-1">founder</Badge>{/if}
          {#if m.subject}<div class="text-dark-2 max-w-md truncate text-xs">{m.subject}</div>{/if}
        </TableCell>
        <TableCell>{dateTime(m.ticketCreatedAt)}</TableCell>
        <TableCell>{m.chosenTopic || '—'} {probabilityLabel(m.probabilities.topic)}</TableCell>
        <TableCell class="text-right">{probabilityLabel(m.probabilities.group)}</TableCell>
        <TableCell class="text-right">{probabilityLabel(m.probabilities.novel)}</TableCell>
        <TableCell>{m.status ?? '—'}</TableCell>
        <TableCell>
          {#if m.isFounder}
            <span class="text-dark-2 text-xs">founder</span>
          {:else if canRule}
            <div class="flex gap-1">
              {#each MEMBER_RULINGS as r (r)}
                <form method="POST" action="?/label" use:enhance={submit(m.ticketId, r)}>
                  <input type="hidden" name="version" value={version} />
                  <input type="hidden" name="ticketId" value={m.ticketId} />
                  <input type="hidden" name="ruling" value={r} />
                  <button
                    type="submit"
                    aria-pressed={shown === r}
                    class="rounded border px-2 py-0.5 text-xs {shown === r
                      ? 'border-blue-4 bg-blue-4/20 text-white'
                      : 'border-dark-4 text-dark-2 hover:text-dark-0'}">{MEMBER_RULING_LABEL[r]}</button
                  >
                </form>
              {/each}
            </div>
          {:else}
            <span class="text-dark-2 text-xs">{shown ? MEMBER_RULING_LABEL[shown] : '—'}</span>
          {/if}
          {#if error && error.ticketId === m.ticketId}
            <p class="mt-1 text-xs text-red-300" role="alert">{error.message}</p>
          {/if}
        </TableCell>
      </TableRow>
    {/each}
  </TableBody>
</Table>
