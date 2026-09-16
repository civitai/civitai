<script lang="ts">
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import { num, shortAge } from '$lib/format';
  import { queueSeverityClass } from '$lib/queue-thresholds';
  import { JOB_QUEUE_UNCONSUMED_TYPES } from '@civitai/shared/job-queue';
  import type { JobQueueHealthPayload } from './api/job-queue-health/types';

  let { health }: { health: JobQueueHealthPayload } = $props();

  const unconsumed: string[] = JOB_QUEUE_UNCONSUMED_TYPES;

  /**
   * The indicator is THREE-valued on purpose, and deliberately not `queueSeverityClass`. That scale
   * runs green → lime → yellow → orange → red by magnitude, so one overdue row renders lime — a step
   * nobody reads as "something is wrong". Healthy vs not is the question this panel answers; the
   * magnitude scale still colours the Overdue column beside it.
   *
   * `bg-current` on the dot is what lets a TEXT colour drive a filled shape.
   */
  const SEVERE_OVERDUE = 200;
  const tones = { Healthy: 'text-green-400', Overdue: 'text-amber-300', Stranded: 'text-red-400' };

  const magnitude = (overdue: number) =>
    queueSeverityClass('jobQueueOverdue', overdue) ?? 'text-dark-0';

  const lanes = $derived(
    health.lanes
      .filter((lane) => lane.depth > 0)
      .map((lane) => {
        // "Stranded" and "Overdue" are not the same fact: a stranded lane will never drain on its
        // own, so telling a moderator to wait it out is wrong.
        const label = unconsumed.includes(lane.type)
          ? 'Stranded'
          : lane.overdue > 0
          ? 'Overdue'
          : 'Healthy';
        return {
          ...lane,
          label,
          tone: label === 'Overdue' && lane.overdue >= SEVERE_OVERDUE ? tones.Stranded : tones[label],
        };
      })
  );

  const overallTone = $derived(
    health.overdue === 0
      ? tones.Healthy
      : health.overdue >= SEVERE_OVERDUE
      ? tones.Stranded
      : tones.Overdue
  );
</script>

{#snippet status(label: string, tone: string)}
  <span class="inline-flex items-center gap-1.5 whitespace-nowrap {tone}">
    <span class="inline-block size-2 shrink-0 rounded-full bg-current"></span>
    {label}
  </span>
{/snippet}

<section class="rounded-xl border border-dark-4 bg-dark-6 p-4">
  <header class="mb-1 flex items-baseline justify-between gap-2">
    <h2 class="text-sm font-semibold text-white">Background jobs</h2>
    {@render status(
      health.overdue === 0 ? 'All healthy' : `${num(health.overdue)} overdue`,
      overallTone
    )}
  </header>
  <p class="mb-3 text-xs text-dark-2">
    Rows waiting in the JobQueue. Several of these hold work on purpose — a blocked image waits 7 days
    before anything may delete it — so a deep queue is usually a healthy one. Nothing here is actioned
    by hand: an overdue lane means a cron has stopped and wants an engineer.
  </p>

  {#if lanes.length === 0}
    <p class="py-1 text-sm text-dark-2">Nothing queued</p>
  {:else}
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead class="w-32">Status</TableHead>
          <TableHead>Job</TableHead>
          <TableHead>Entity</TableHead>
          <TableHead class="text-right">Waiting</TableHead>
          <TableHead class="text-right">Overdue</TableHead>
          <TableHead class="text-right">Oldest</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each lanes as lane (`${lane.type}:${lane.entityType}`)}
          <TableRow class="odd:bg-dark-7/40">
            <TableCell>{@render status(lane.label, lane.tone)}</TableCell>
            <TableCell class="text-dark-0">
              {lane.type}
              {#if lane.label === 'Stranded'}
                <span class="block text-xs text-dark-2">nothing drains this</span>
              {/if}
            </TableCell>
            <TableCell class="text-dark-2">{lane.entityType}</TableCell>
            <TableCell class="text-right tabular-nums text-dark-0">{num(lane.depth)}</TableCell>
            <TableCell
              class="text-right tabular-nums {lane.overdue > 0
                ? magnitude(lane.overdue)
                : 'text-dark-2'}"
            >
              {num(lane.overdue)}
            </TableCell>
            <TableCell class="text-right tabular-nums text-dark-2">
              {lane.oldestAt ? shortAge(lane.oldestAt) : '—'}
            </TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  {/if}
</section>
