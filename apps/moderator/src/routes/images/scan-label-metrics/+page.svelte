<script lang="ts">
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import { num } from '$lib/format';
  import QuotaPanel from './QuotaPanel.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const share = (part: number, whole: number) =>
    whole ? `${Math.round((part / whole) * 100)}%` : '–';
  const quotaError = $derived(
    form && 'error' in form && (form.scope === 'quota' || form.scope === 'denied') ? form.error ?? null : null
  );
  const quotaSaved = $derived(form && 'saved' in form ? form.saved ?? null : null);
</script>

<div class="flex flex-col gap-4">
  <header>
    <h1 class="text-xl font-semibold text-white">Scan label metrics</h1>
    <p class="text-sm text-dark-2">Last {data.windowDays} UTC days.</p>
  </header>

  <dl class="grid grid-cols-3 gap-3 rounded-xl border border-dark-4 bg-dark-6 p-4 text-sm">
    <div>
      <dt class="text-dark-2">Blocked by majority</dt>
      <dd class="text-lg font-semibold text-dark-0">{num(data.actions.blocked)}</dd>
    </div>
    <div>
      <dt class="text-dark-2">Majority reached, not yet blocked</dt>
      <dd class="text-lg font-semibold text-dark-0">{num(data.actions.pending)}</dd>
    </div>
    <div>
      <dt class="text-dark-2">Block failed (retrying)</dt>
      <dd
        class={data.actions.failing
          ? 'text-lg font-semibold text-red-300'
          : 'text-lg font-semibold text-dark-0'}
      >
        {num(data.actions.failing)}
      </dd>
    </div>
  </dl>

  <QuotaPanel
    rows={data.quota}
    canEdit={!!data.grants['scan-label.quota.edit']}
    error={quotaError}
    saved={quotaSaved}
  />

  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h2 class="mb-3 text-lg font-semibold text-white">Per flagger version (decided items)</h2>
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Version</TableHead>
          <TableHead class="text-right">Decided</TableHead>
          <TableHead class="text-right">Majority block</TableHead>
          <TableHead class="text-right">3-0 block</TableHead>
          <TableHead class="text-right">3-0 clear</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each data.versions as v (v.flaggerVersion)}
          <TableRow>
            <TableCell>{v.flaggerVersion}</TableCell>
            <TableCell class="text-right tabular-nums">{num(v.decided)}</TableCell>
            <TableCell class="text-right tabular-nums">{share(v.majorityBlock, v.decided)}</TableCell>
            <TableCell class="text-right tabular-nums">{share(v.unanimousBlock, v.decided)}</TableCell>
            <TableCell class="text-right tabular-nums">{share(v.unanimousClear, v.decided)}</TableCell>
          </TableRow>
        {:else}
          <TableRow><TableCell colspan={5} class="text-dark-2">Nothing decided yet.</TableCell></TableRow>
        {/each}
      </TableBody>
    </Table>
  </section>

  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h2 class="mb-3 text-lg font-semibold text-white">Per day</h2>
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Day</TableHead>
          <TableHead class="text-right">Flagged</TableHead>
          <TableHead class="text-right">Votes</TableHead>
          <TableHead class="text-right">Decided</TableHead>
          <TableHead class="text-right">Decided block</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each data.totals as t (t.day)}
          <TableRow>
            <TableCell>{t.day}</TableCell>
            <TableCell class="text-right tabular-nums">{num(t.flagged)}</TableCell>
            <TableCell class="text-right tabular-nums">{num(t.votes)}</TableCell>
            <TableCell class="text-right tabular-nums">{num(t.decided)}</TableCell>
            <TableCell class="text-right tabular-nums">{num(t.blocked)}</TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  </section>

  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h2 class="mb-3 text-lg font-semibold text-white">Per moderator</h2>
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Moderator</TableHead>
          <TableHead class="text-right">Votes</TableHead>
          <TableHead class="text-right">Agrees with outcome</TableHead>
          <TableHead class="text-right">Median time per vote</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each data.moderators as m (m.userId)}
          <TableRow>
            <TableCell>{m.username ?? `#${m.userId}`}</TableCell>
            <TableCell class="text-right tabular-nums">{num(m.votes)}</TableCell>
            <TableCell class="text-right tabular-nums">
              {m.agreement === null ? '–' : `${Math.round(m.agreement * 100)}%`}
            </TableCell>
            <TableCell class="text-right tabular-nums">
              {m.medianMs === null ? '–' : `${(m.medianMs / 1000).toFixed(1)}s`}
            </TableCell>
          </TableRow>
        {:else}
          <TableRow><TableCell colspan={4} class="text-dark-2">No votes yet.</TableCell></TableRow>
        {/each}
      </TableBody>
    </Table>
  </section>
</div>
