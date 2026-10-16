<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { DEFAULT_DAILY_QUOTA, type QuotaRow, type QuotaStatus } from '$lib/scan-labels';

  let {
    windowDays,
    rows,
    canEdit,
    error,
    notice,
  }: {
    windowDays: number;
    rows: QuotaRow[];
    canEdit: boolean;
    error: string | null;
    notice: string | null;
  } = $props();

  const STATUS_CLASS: Record<QuotaStatus, string> = {
    met: 'bg-emerald-500/20 text-emerald-300',
    missed: 'bg-red-500/20 text-red-300',
    off: 'text-dark-2',
    'in-progress': 'text-dark-0',
    unlisted: 'text-dark-2 italic',
  };

  const days = $derived(rows[0]?.days.map((d) => d.day) ?? []);
  const count = (row: QuotaRow, status: QuotaStatus) =>
    row.days.filter((d) => d.status === status).length;
</script>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="text-lg font-semibold text-white">Daily votes vs quota</h2>
  <p class="mb-3 text-sm text-dark-2">
    Last {windowDays} UTC days. A day with no votes is a day off; a day with some votes but fewer than
    the quota is a miss. Today never counts as a miss. Days are judged against the current quota.
  </p>

  {#if rows.length === 0}
    <p class="text-sm text-dark-2">Nobody is on the roster and nobody has voted yet.</p>
  {:else}
    <div class="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Moderator</TableHead>
            <TableHead class="text-right">Quota</TableHead>
            <TableHead class="text-right">Missed</TableHead>
            <TableHead class="text-right">Off</TableHead>
            {#each days as day (day)}
              <TableHead class="text-right text-xs">{day.slice(5)}</TableHead>
            {/each}
            {#if canEdit}<TableHead><span class="sr-only">Remove</span></TableHead>{/if}
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each rows as row (row.userId)}
            <TableRow>
              <TableCell>
                <span class="text-dark-0">{row.username ?? `#${row.userId}`}</span>
                {#if !row.onRoster}<span class="ml-1 text-xs text-dark-2">(not on roster)</span>{/if}
              </TableCell>
              <TableCell class="text-right tabular-nums">{row.quota}</TableCell>
              <TableCell class="text-right tabular-nums">{count(row, 'missed')}</TableCell>
              <TableCell class="text-right tabular-nums">{count(row, 'off')}</TableCell>
              {#each row.days as d (d.day)}
                <TableCell class="text-right tabular-nums">
                  <span class={['rounded px-1.5 py-0.5', STATUS_CLASS[d.status]]}>{d.votes}</span>
                </TableCell>
              {/each}
              {#if canEdit}
                <TableCell class="text-right">
                  {#if row.onRoster}
                    <form method="POST" action="?/removeParticipant" use:enhance>
                      <input type="hidden" name="userId" value={row.userId} />
                      <Button type="submit" size="sm" variant="outline">Remove</Button>
                    </form>
                  {/if}
                </TableCell>
              {/if}
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    </div>
  {/if}

  {#if canEdit}
    <form method="POST" action="?/setQuota" use:enhance class="mt-4 flex flex-wrap items-end gap-3">
      <div>
        <Label for="quota-user" class="text-xs text-dark-2">User id or username</Label>
        <Input id="quota-user" name="user" required class="mt-1 w-48" />
      </div>
      <div>
        <Label for="quota-votes" class="text-xs text-dark-2">Daily votes</Label>
        <Input
          id="quota-votes"
          name="dailyVotes"
          type="number"
          min={DEFAULT_DAILY_QUOTA}
          value={DEFAULT_DAILY_QUOTA}
          required
          class="mt-1 w-28"
        />
      </div>
      <Button type="submit" size="sm">Add participant</Button>
    </form>
    <p class="mt-2 text-xs text-dark-2">
      Adding someone opens the Scan Labels page for them; Remove closes it. Adding someone already on
      the roster updates their daily votes.
    </p>
    {#if error}
      <ErrorAlert message={error} class="mt-2" />
    {:else if notice}
      <p class="mt-2 text-sm text-emerald-300">{notice}</p>
    {/if}
  {/if}
</section>
