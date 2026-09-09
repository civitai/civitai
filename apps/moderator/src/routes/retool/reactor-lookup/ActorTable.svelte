<script lang="ts">
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, num, relativeTime } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import type { Actor } from '$lib/server/reactor-lookup.service';
  import type { CategoryMeta } from './categories';

  let {
    actors,
    meta,
    sharesWithTarget,
    sharesWithOther,
  }: {
    actors: Actor[];
    meta: CategoryMeta;
    sharesWithTarget: number[];
    sharesWithOther: number[];
  } = $props();

  // The address panel's finding, brought into the ranked table. Read side by side the two are a
  // matching exercise the moderator has to do by eye, on ids, across a scroll — and the row that is
  // both highly concentrated AND sharing an address with the creator is the one that matters most.
  const withTarget = $derived(new Set(sharesWithTarget));
  const withOther = $derived(new Set(sharesWithOther));

  const pct = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}%`);

  // Ranked by count because that is the order the query can produce, then read by concentration. The
  // tint is what does the reading: on the account this was built against the confirmed sock sat sixth
  // by count among thirteen indistinguishable rows, and 100%-on-one-creator was the only thing that
  // separated it.
  const emphasis = (a: Actor) =>
    a.concentration === null
      ? ''
      : a.concentration >= 0.9 && a.owners === 1
      ? 'text-red-300'
      : a.concentration >= 0.6
      ? 'text-yellow-300'
      : 'text-dark-0';

  const STATUS_LABEL: Record<Actor['status'], string> = {
    active: '',
    banned: 'banned',
    deleted: 'deleted',
    // An id the event log still carries and Postgres has no account for.
    gone: 'no account',
  };
</script>

{#if actors.length === 0}
  <p class="text-sm text-dark-2">Nothing in this window.</p>
{:else}
  <div class="overflow-x-auto">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead class="text-right">{meta.countLabel}</TableHead>
          <TableHead class="text-right">{meta.entityLabel}</TableHead>
          <TableHead class="text-right">Of their own</TableHead>
          <TableHead class="text-right">Creators</TableHead>
          <TableHead>Account</TableHead>
          <TableHead>Age</TableHead>
          <TableHead>Flags</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each actors as a (a.userId)}
          <TableRow>
            <TableCell class="text-right tabular-nums text-dark-0">{num(a.count)}</TableCell>
            <TableCell class="text-right tabular-nums text-dark-2">{num(a.entities)}</TableCell>
            <TableCell class="text-right tabular-nums {emphasis(a)}">
              {pct(a.concentration)}
              {#if a.totalGiven !== null}
                <span class="text-xs text-dark-2">of {num(a.totalGiven)}</span>
              {/if}
            </TableCell>
            <TableCell class="text-right tabular-nums {emphasis(a)}">
              {a.owners === null ? '—' : num(a.owners)}
            </TableCell>
            <TableCell>
              <a href={userLookupUrl(a.userId)} class={LINK_CLASS}>
                {a.username ?? `#${a.userId}`}
              </a>
              <span class="ml-1 text-xs text-dark-2">{a.userId}</span>
            </TableCell>
            <TableCell class="text-dark-2">{relativeTime(a.createdAt)}</TableCell>
            <TableCell>
              <div class="flex flex-wrap gap-1">
                {#if STATUS_LABEL[a.status]}
                  <Badge variant="destructive">{STATUS_LABEL[a.status]}</Badge>
                {/if}
                {#if a.strikes > 0}
                  <Badge variant="secondary">{a.strikes} strikes</Badge>
                {/if}
                {#if a.instantVerify}
                  <Badge variant="destructive">instant verify</Badge>
                {/if}
                {#if withTarget.has(a.userId)}
                  <Badge variant="destructive">shares IP with creator</Badge>
                {:else if withOther.has(a.userId)}
                  <Badge variant="secondary">shares IP</Badge>
                {/if}
              </div>
            </TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  </div>
{/if}
