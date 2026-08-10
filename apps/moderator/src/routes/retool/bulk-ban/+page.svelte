<script lang="ts">
  import { page } from "$app/state";
  import { untrack } from 'svelte';
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import type { ActionData, PageData } from './$types';
  import { writeEnhancer } from '$lib/form-action';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import { BAN_REASONS } from '$lib/enforcement';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let ids = $state(untrack(() => data.ids));
  let names = $state(untrack(() => data.names));
  let ips = $state(untrack(() => data.ips));
  // Keyed on the URL, not on `data`: this page's enhancer reloads, so banning a list re-ran `load` and
  // overwrote whatever the moderator had pasted into these boxes since the last check.
  const subject = $derived(page.url.search);
  $effect(() => {
    subject;
    untrack(() => {
      ids = data.ids;
      names = data.names;
      ips = data.ips;
    });
  });

  let reasonCode = $state('Other');
  let confirming = $state(false);
  let submitting = $state(false);
  const onSubmit = writeEnhancer({
    reload: true,
    onSuccess: () => (confirming = false),
    busy: (v) => (submitting = v),
  });

  const load = () =>
    goto(
      `?ids=${encodeURIComponent(ids)}&names=${encodeURIComponent(names)}&ips=${encodeURIComponent(ips)}`,
      { keepFocus: true }
    );

  // Only accounts that are neither already banned nor deleted are actually actionable — the rest are
  // shown so the moderator can see why the number they pasted and the number banned differ.
  const bannable = $derived(data.candidates.filter((c) => !c.bannedAt && !c.deletedAt));
  const bannableIds = $derived(bannable.map((c) => c.id).join(','));
</script>

<header class="page-header">
  <h1>Bulk Ban</h1>
  <p>
    Paste a list of accounts, check what it actually contains, then ban them together. The clustering
    below is how a list of one becomes a list of a ring.
  </p>
</header>

{#if !data.canAct}
  <div class="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
    You can investigate here but not ban. Mass banning is restricted to senior moderators.
  </div>
{/if}

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="grid gap-3 lg:grid-cols-3">
    <label class="flex flex-col gap-1 text-xs text-dark-2">
      User IDs
      <Textarea bind:value={ids} rows={4} placeholder="One per line, or comma separated" />
    </label>
    <label class="flex flex-col gap-1 text-xs text-dark-2">
      Usernames
      <Textarea bind:value={names} rows={4} placeholder="One per line" />
    </label>
    <label class="flex flex-col gap-1 text-xs text-dark-2">
      IPs — find accounts registered on these
      <Textarea bind:value={ips} rows={4} placeholder="One per line" />
    </label>
  </div>
  <Button class="mt-3" onclick={load}>Check list</Button>
</section>

{#if form?.error}
  <div class="mb-4 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300" role="alert">
    {form.error}
  </div>
{:else if form && 'warning' in form && form.warning}
  <div class="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-sm text-amber-200" role="status">
    {form.warning}
  </div>
{:else if form?.success}
  <div class="mb-4 rounded-md border border-green-500/30 bg-green-500/10 p-2 text-sm text-green-200" role="status">
    Banned {num(form.banned ?? 0)} accounts.
  </div>
{/if}

{#if data.candidates.length || data.unmatched.length}
  <div class="flex flex-col gap-4 xl:flex-row xl:items-start">
    <section class="min-w-0 flex-1 rounded-xl border border-dark-4 bg-dark-6 p-5">
      <h2 class="mb-1 text-sm font-semibold text-white">
        {num(bannable.length)} bannable of {num(data.candidates.length)} matched
      </h2>
      <p class="mb-3 text-xs text-dark-2">
        Already-banned and deleted accounts are listed but will be skipped.
        {#if data.unmatched.length}
          <span class="text-amber-300">
            {num(data.unmatched.length)} id(s) matched no account: {data.unmatched.slice(0, 10).join(', ')}
          </span>
        {/if}
      </p>

      <ul class="space-y-1 text-sm">
        {#each data.candidates as c (c.id)}
          <li class="flex flex-wrap items-baseline gap-x-2">
            <a href={userLookupUrl(c.id)} class={LINK_CLASS}>{c.username ?? `#${c.id}`}</a>
            <code class="text-xs text-dark-2">#{c.id}</code>
            <span class="text-xs text-dark-2">{c.email ?? '—'}</span>
            {#if c.bannedAt}<Badge variant="destructive">already banned</Badge>{/if}
            {#if c.deletedAt}<Badge variant="secondary">deleted</Badge>{/if}
          </li>
        {/each}
      </ul>

      {#if data.canAct && bannable.length}
        {#if !confirming}
          <Button class="mt-4" variant="destructive" onclick={() => (confirming = true)}>
            Ban {num(bannable.length)} accounts
          </Button>
        {:else}
          <form method="POST" action="?/banAll" use:enhance={onSubmit} class="mt-4">
            <input type="hidden" name="userIds" value={bannableIds} />
            <div class="rounded-md border border-red-500/40 bg-red-500/10 p-3">
              <p class="mb-2 text-sm text-white">
                Ban <strong>{num(bannable.length)}</strong> accounts? Each is banned individually, with
                its own notification and content purge. The run stops after 5 consecutive failures.
              </p>
              <div class="flex flex-wrap items-end gap-2">
                <label class="flex flex-col gap-1 text-xs text-dark-2">
                  Reason
                  <Select.Root type="single" bind:value={reasonCode}>
                    <Select.Trigger class="w-56">{reasonCode}</Select.Trigger>
                    <Select.Content>
                      {#each BAN_REASONS as r (r)}
                        <Select.Item value={r}>{r}</Select.Item>
                      {/each}
                    </Select.Content>
                  </Select.Root>
                </label>
                <input type="hidden" name="reasonCode" value={reasonCode} />
                <Input name="detailsInternal" placeholder="Internal details (optional)" class="min-w-48 flex-1" />
                <Input name="note" placeholder="Note on each account (optional)" class="min-w-48 flex-1" />
                <Button type="submit" variant="destructive" size="sm" disabled={submitting}>
                  {submitting ? 'Banning…' : `Ban ${num(bannable.length)}`}
                </Button>
                <Button type="button" size="sm" variant="outline" onclick={() => (confirming = false)}>
                  Cancel
                </Button>
              </div>
            </div>
          </form>
        {/if}
      {/if}
    </section>

    <section class="min-w-0 rounded-xl border border-dark-4 bg-dark-6 p-5 xl:w-96 xl:shrink-0">
      <h2 class="mb-3 text-sm font-semibold text-white">What they have in common</h2>

      <h3 class="text-xs tracking-wide text-dark-2 uppercase">Registration IPs</h3>
      {#if data.registrationIps.length === 0}
        <p class="mb-3 text-sm text-dark-2">None recorded.</p>
      {:else}
        <ul class="mb-3 space-y-0.5 text-sm">
          {#each data.registrationIps as ip (ip.ip)}
            <li class="flex justify-between gap-2">
              <code class="text-dark-0">{ip.ip}</code>
              <span class="tabular-nums text-dark-2">{num(ip.registrations)}</span>
            </li>
          {/each}
        </ul>
      {/if}

      <h3 class="text-xs tracking-wide text-dark-2 uppercase">Email domains</h3>
      {#if data.domains.length === 0}
        <p class="mb-3 text-sm text-dark-2">None.</p>
      {:else}
        <ul class="mb-3 space-y-0.5 text-sm">
          {#each data.domains as d (d.domain)}
            <li class="flex justify-between gap-2">
              <span class="text-dark-0">{d.domain}</span>
              <span class="tabular-nums text-dark-2">{num(d.accounts)}</span>
            </li>
          {/each}
        </ul>
      {/if}

      {#if data.ipAccounts.length}
        <h3 class="text-xs tracking-wide text-dark-2 uppercase">
          Accounts on those IPs ({num(data.ipAccounts.length)})
        </h3>
        <p class="mb-1 text-xs text-dark-2">
          Registration only. A carrier or office IP will list unrelated accounts — confirm before adding.
        </p>
        <ul class="space-y-0.5 text-sm">
          {#each data.ipAccounts as a (a.userId)}
            <li class="flex justify-between gap-2">
              <a href={userLookupUrl(a.userId)} class={LINK_CLASS}>#{a.userId}</a>
              <span class="text-xs text-dark-2">{dateTime(a.registeredAt)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
{/if}
