<script lang="ts">
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import { dateTime, num, LINK_CLASS } from '$lib/format';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const counters = $derived(Object.entries(data.run.counters).sort(([a], [b]) => a.localeCompare(b)));

  // Two digits, not a percentage. These are the producer's own 0..1 scores and are NOT comparable
  // across detectors — rendering "94%" invites exactly the cross-detector ranking that would be
  // meaningless, and a bare decimal reads as the raw number it is.
  const confidence = (v: number) => v.toFixed(2);

  // Sorted actioned-first so the rows with consequences lead, then by the producer's confidence. The
  // service already returns confidence-desc; this is a stable second pass over the same array.
  const rows = $derived(
    [...data.findings].sort((a, b) => Number(b.actioned) - Number(a.actioned) || b.confidence - a.confidence)
  );
</script>

<header class="page-header">
  <h1>{data.run.detector}</h1>
  <p class="text-dark-2">
    Ran {dateTime(data.run.startedAt)} → {dateTime(data.run.finishedAt)}
    · reported {dateTime(data.run.receivedAt)}
  </p>
</header>

<p class="mb-4"><a class={LINK_CLASS} href="/abuse">← All runs</a></p>

{#if data.run.summary}
  <p class="mb-4">{data.run.summary}</p>
{/if}

{#if counters.length > 0}
  <dl class="mb-6 flex flex-wrap gap-x-6 gap-y-1">
    {#each counters as [key, value] (key)}
      <div>
        <dt class="text-dark-2 text-sm">{key}</dt>
        <dd>{num(value)}</dd>
      </div>
    {/each}
  </dl>
{/if}

{#if rows.length === 0}
  <!-- A run with no findings is a real, healthy result and must not read as a broken page. -->
  <p class="text-dark-2">This run reported no findings.</p>
{:else}
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>User</TableHead>
        <TableHead>Confidence</TableHead>
        <TableHead>Acted</TableHead>
        <TableHead>Reason</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each rows as f (f.id)}
        <TableRow>
          <TableCell>
            <!-- `?q=`, not `?userId=` — the bare route redirects to the default section carrying `q`
                 forward, and an unknown param is dropped, landing the moderator on an empty search. -->
            <a class={LINK_CLASS} href="/retool/user-lookup?q={f.userId}">{f.userId}</a>
          </TableCell>
          <TableCell>{confidence(f.confidence)}</TableCell>
          <!-- "No" is the common and important case: detected, scored, deliberately left alone. It is
               spelled out rather than shown as a blank, which would read as missing data. -->
          <TableCell>{f.actioned ? f.action : 'No'}</TableCell>
          <TableCell class="max-w-2xl">{f.reason}</TableCell>
        </TableRow>
      {/each}
    </TableBody>
  </Table>
{/if}
