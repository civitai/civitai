<script lang="ts">
  import { goto } from '$app/navigation';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import { Tabs, TabsList, TabsTrigger } from '@civitai/ui/components/ui/tabs/index.js';
  import { dateTime, num, LINK_CLASS } from '$lib/format';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const ALL = '__all__';
  // `||`, not `??`: `/abuse?detector=` parses to an empty string, which is not nullish, so `??`
  // left no tab selected while the table showed everything.
  const active = $derived(data.detector || ALL);

  function select(value: string) {
    goto(value === ALL ? '/abuse' : `/abuse?detector=${encodeURIComponent(value)}`);
  }

  // A run's headline number is what it FOUND; what it ACTED on is the smaller, separate figure. Shown
  // as "n of m" rather than one total, because the gap between them is the thing worth reading — a
  // detector finding 40 and acting on 2 is the normal, healthy shape, and a total alone hides it.
  const actionedLabel = (actioned: number, total: number) =>
    total === 0 ? '—' : `${num(actioned)} of ${num(total)}`;

  /**
   * How much of a run a MODERATOR has ruled on — the column that says which runs still need
   * attention.
   *
   * 🔴 IT IS NOT "Acted on". That column is the DETECTOR's own self-report and reads a permanent
   * "0 of N" for every shadow-mode detector, so a board of forty runs offered no way to tell the
   * reviewed ones from the untouched ones.
   *
   * 🔴 `null` RENDERS AS AN EM DASH, NEVER AS ZERO. It means this deployment has no verdict columns
   * — nothing here has been ruled because nothing CAN be — and a "0 of 40" would present a missing
   * capability as a backlog somebody could work through.
   */
  const ruledLabel = (ruled: number | null, total: number) =>
    ruled === null || total === 0 ? '—' : `${num(ruled)} of ${num(total)}`;
</script>

<header class="page-header">
  <h1>Abuse Detection</h1>
</header>

{#if data.status === 'no-schema'}
  <p class="text-dark-2 mb-4">
    The abuse-detection tables do not exist yet. They are applied by hand — run
    <code>apps/moderator/abuse-detection/schema.sql</code> against
    <code>MODERATOR_DATABASE_URL</code>.
  </p>
{:else if data.status === 'no-grant'}
  <p class="text-dark-2 mb-4">
    The abuse-detection tables exist but this app's database role cannot read them. They were most
    likely created by a different role — re-run
    <code>apps/moderator/abuse-detection/schema.sql</code> as the application role, or grant it
    <code>SELECT, INSERT, UPDATE, DELETE</code> on both tables and their sequences.
  </p>
{:else if data.status === 'not-configured'}
  <!-- Names the variable the CLIENT reads (`getModeratorDb()` → RETOOL_DATABASE_URL), not the one
       the DDL comment names. They resolve to the same instance today, so an operator told to check
       the wrong one would find it set and conclude the message was lying. -->
  <p class="text-dark-2 mb-4">
    <code>RETOOL_DATABASE_URL</code> is not configured for this environment.
  </p>
{:else if data.status === 'unreachable'}
  <p class="text-dark-2 mb-4">
    Could not reach the abuse-detection database. The server log has the error.
  </p>
{:else}
  {#if data.detectors.length > 1}
    <Tabs value={active} onValueChange={(v) => v && select(v)} class="mb-4">
      <TabsList>
        <TabsTrigger value={ALL}>All detectors</TabsTrigger>
        {#each data.detectors as d (d)}
          <TabsTrigger value={d}>{d}</TabsTrigger>
        {/each}
      </TabsList>
    </Tabs>
  {/if}

  {#if data.runs.length === 0}
    <p class="text-dark-2">
      No runs reported{data.detector ? ` by ${data.detector}` : ''} yet.
    </p>
  {:else}
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Detector</TableHead>
          <TableHead>Run</TableHead>
          <TableHead>Findings</TableHead>
          <TableHead>Acted on (detector)</TableHead>
          <TableHead>Reviewed (moderator)</TableHead>
          <TableHead>Summary</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each data.runs as run (run.id)}
          <TableRow>
            <TableCell>{run.detector}</TableCell>
            <TableCell>
              <a class={LINK_CLASS} href="/abuse/{run.id}">{dateTime(run.startedAt)}</a>
            </TableCell>
            <TableCell>{num(run.findingCount)}</TableCell>
            <TableCell>{actionedLabel(run.actionedCount, run.findingCount)}</TableCell>
            <TableCell>{ruledLabel(run.ruledCount, run.findingCount)}</TableCell>
            <!-- Same opt-in as the run page's reason cell: `TableCell`'s `whitespace-nowrap` is
                 wrong for prose, and a one-line summary overruns the width this `max-w-xl` asks
                 for. -->
            <!-- An em dash, matching the two count columns beside it. A blank cell reads as a
                 rendering failure next to two that spell their absence out. -->
            <TableCell class="max-w-xl break-words whitespace-normal">{run.summary ?? '—'}</TableCell
            >
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  {/if}
{/if}
