<script lang="ts">
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import { csamReportUrl } from '$lib/entity-url';
  import { holdLegLabels } from '$lib/csam-hold-legs';
  import { dateTime, num, LINK_CLASS } from '$lib/format';
  import type { CsamQueueUser } from '$lib/server/image-review.service';
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';
  import CsamQueueTabs from './CsamQueueTabs.svelte';

  let {
    data,
    form,
  }: {
    data: {
      title: string;
      civitaiUrl: string;
      level: number;
      users: CsamQueueUser[];
      truncated: boolean;
    };
    form: { error?: string; cleared?: string } | null;
  } = $props();

  const queueHref = (userId: number) => `/images/csam?userId=${userId}&level=${data.level}`;

  let pending = $state<number | null>(null);
  const clearSubmit =
    (userId: number): SubmitFunction =>
    () => {
      pending = userId;
      return async ({ update }) => {
        await update();
        pending = null;
      };
    };
</script>

<header class="page-header flex flex-wrap items-center justify-between gap-2">
  <h1>{data.title}</h1>
  <CsamQueueTabs active="user" level={data.level} />
</header>

{#if form?.error}
  <div
    class="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-200"
    role="alert"
  >
    {form.error}
  </div>
{:else if form?.cleared}
  <p class="mb-3 text-sm text-emerald-300" role="status">{form.cleared}</p>
{/if}

{#if data.truncated}
  <p class="mb-3 text-sm text-amber-300" role="status">
    Showing the first {num(data.users.length)} users, most flagged first.
  </p>
{/if}

{#if data.users.length === 0}
  <p class="text-sm text-dark-2">No images to review in this queue.</p>
{:else}
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>User</TableHead>
        <TableHead class="text-right">Flagged</TableHead>
        <TableHead>CSAM report</TableHead>
        <TableHead></TableHead>
        <TableHead>Removed images</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each data.users as user (user.userId)}
        <TableRow>
          <TableCell>
            {user.username ?? '[deleted]'}
            <span class="text-xs text-dark-2">#{user.userId}</span>
          </TableCell>
          <TableCell class="text-right tabular-nums">{num(user.flagged)}</TableCell>
          <TableCell class="text-xs">
            {#if user.reportSentAt}
              Sent {dateTime(user.reportSentAt)}
            {:else if user.reported}
              <span class="text-amber-300">Filed, not sent</span>
            {:else}
              <span class="text-dark-2">None</span>
            {/if}
          </TableCell>
          <TableCell class="whitespace-nowrap text-right text-sm">
            <a href={queueHref(user.userId)} class={LINK_CLASS}>Images</a>
            <span class="text-dark-4">·</span>
            <a
              href={csamReportUrl(data.civitaiUrl, user.userId)}
              target="_blank"
              rel="noreferrer"
              class={LINK_CLASS}>Report page</a
            >
          </TableCell>
          <TableCell class="whitespace-nowrap text-sm">
            {#if user.heldBy.length}
              <span class="text-xs text-dark-2">
                Held: {holdLegLabels(user.heldBy)} · review one by one
              </span>
            {:else if user.removed > 0}
              <form
                method="POST"
                action="?/dismissUserFlags"
                class="flex items-center gap-2"
                use:enhance={clearSubmit(user.userId)}
              >
                <input type="hidden" name="userId" value={user.userId} />
                <input type="hidden" name="expectedCount" value={user.removed} />
                <ConfirmSubmit
                  label="Clear"
                  name="op"
                  value="clear"
                  count={user.removed}
                  noun="removed-image flag"
                  submitting={pending === user.userId}
                />
              </form>
            {/if}
          </TableCell>
        </TableRow>
      {/each}
    </TableBody>
  </Table>
{/if}
