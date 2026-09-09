<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import { LINK_CLASS, num } from '$lib/format';
  import { MIN_FLAGGED } from '$lib/reactions';
  import type { Account, Reactions } from './user-account';

  let { account }: { account: Promise<Account> | null } = $props();

  type Target = Reactions['targets'][number];

  // `dateTime` appends a second (UTC) clock — too wide for a cell holding two dates.
  const day = (value: string) =>
    new Date(value).toLocaleDateString('en-GB', {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });

  const span = (t: Target) => {
    const first = day(t.first);
    const last = day(t.last);
    return first === last ? first : `${first} → ${last}`;
  };

  const REACTIONS = [
    { key: 'heart', label: 'Heart' },
    { key: 'like', label: 'Like' },
    { key: 'laugh', label: 'Laugh' },
    { key: 'cry', label: 'Cry' },
    { key: 'dislike', label: 'Dislike' },
  ] as const;
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  {#await account}
    <p class="text-sm text-dark-2">Loading reactions…</p>
  {:then result}
    {#if result}
      {@const reactions = result.reactions}
      <h3 class="mb-1 text-sm font-semibold text-white">
        Image reactions given ({num(reactions.total)})
      </h3>
      <p class="mb-3 text-xs text-dark-2">
        Across {num(reactions.creators)}
        {reactions.creators === 1 ? 'creator' : 'creators'}. Read the mix, not the total — Laugh, Cry
        and Dislike aimed at one creator is what a harassment report looks like, while the same volume
        of Heart and Like is an audience. Images only — article and comment reactions are not counted.
      </p>
      {#if reactions.targets.length === 0}
        <p class="text-sm text-dark-2">None.</p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Creator</TableHead>
              <TableHead class="text-right">Total</TableHead>
              {#each REACTIONS as r (r.key)}
                <TableHead class="text-right">{r.label}</TableHead>
              {/each}
              <TableHead>Span</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each reactions.targets as t (t.userId)}
              <TableRow class={t.flagged ? 'bg-amber-500/10' : ''}>
                <TableCell>
                  <a href="?q={t.userId}" class={LINK_CLASS}>{t.username ?? `#${t.userId}`}</a>
                  {#if t.flagged}
                    <Badge variant="destructive" class="ml-1">
                      {Math.round(100 * t.negativeShare)}% negative
                    </Badge>
                  {/if}
                </TableCell>
                <TableCell class="text-right tabular-nums text-dark-0">{num(t.count)}</TableCell>
                {#each REACTIONS as r (r.key)}
                  <TableCell class="text-right tabular-nums {t[r.key] ? 'text-dark-0' : 'text-dark-2'}">
                    {t[r.key] ? num(t[r.key]) : '—'}
                  </TableCell>
                {/each}
                <TableCell class="whitespace-nowrap text-xs text-dark-2">{span(t)}</TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
        <p class="mt-2 text-xs text-dark-2">
          The creators reacted to most, of {num(reactions.creators)}, plus those whose reactions are
          majority Laugh, Cry or Dislike over at least {MIN_FLAGGED} — highlighted above, worst share
          first. Such a creator need not be high-volume and usually is not, so a highlighted row can
          sit far below the top by count.
          {#if reactions.flaggedTotal > reactions.targets.filter((t) => t.flagged).length}
            <span class="text-amber-300">
              {num(reactions.flaggedTotal)} creators match that pattern in total — more than are shown.
            </span>
          {/if}
        </p>
      {/if}
    {/if}
  {:catch}
    <p class="text-sm text-red-300">Could not load reactions.</p>
  {/await}
</section>
