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
          <TableHead>Acted on</TableHead>
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
            <TableCell class="max-w-xl">{run.summary ?? ''}</TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  {/if}
{/if}
