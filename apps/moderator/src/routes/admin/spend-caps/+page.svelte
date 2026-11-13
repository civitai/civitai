<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { dateTime } from '$lib/format';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const money = (usd: number | null) => (usd === null ? 'none' : `$${usd.toFixed(2)}`);
  const field = (usd: number | null) => (usd === null ? '' : usd.toFixed(2));
  const shortRole = (role: string) => role.replace('moderator:', '');
  const TH = 'py-2 pl-4 text-left text-xs tracking-wide text-dark-2 uppercase';
</script>

<header class="page-header">
  <h1>Assistant spend caps</h1>
  <p>
    What each moderator may spend on the mod assistant per UTC day, in USD. A moderator's own cap wins
    in both directions (a $0 cap turns the assistant off for them); without one, the highest cap among
    their roles applies; with neither, {money(data.defaultUsd)}. Leave a field blank to remove that cap.
  </p>
</header>

{#if form?.error}
  <ErrorAlert class="mb-4" message={form.error} />
{:else if form?.success}
  <div
    class="mb-4 rounded-md border border-green-500/30 bg-green-500/10 p-2 text-sm text-green-200"
    role="status"
  >
    {form.changed ? 'Saved.' : 'That was already the cap, so nothing changed.'}
  </div>
{/if}

{#snippet capForm(scope: 'role' | 'user', subject: string, usd: number | null, label: string)}
  <!-- `reset: false`: a reset puts the input back to the value it was first rendered with, and a save
       that changes nothing pushes no new value to undo that, so the next save would write the stale
       one. -->
  <form
    method="POST"
    action="?/save"
    use:enhance={() =>
      ({ update }) =>
        update({ reset: false })}
    class="flex flex-wrap items-center gap-2"
  >
    <input type="hidden" name="scope" value={scope} />
    <input type="hidden" name="subject" value={subject} />
    <input type="hidden" name="expect" value={field(usd)} />
    <Input
      name="usd"
      inputmode="decimal"
      value={field(usd)}
      placeholder="none"
      aria-label="Daily cap in USD for {label}"
      class="w-28"
    />
    <Input name="reason" placeholder="Reason (optional)" aria-label="Reason" class="w-56" />
    <Button type="submit" size="sm" variant="outline">Save</Button>
  </form>
{/snippet}

<h2 class="mb-2 text-sm font-semibold text-white">By role</h2>
<div class="overflow-x-auto rounded-xl border border-dark-4 bg-dark-6">
  <table class="w-full min-w-xl text-sm">
    <thead>
      <tr class="border-b border-dark-4">
        <th scope="col" class={TH}>Role</th>
        <th scope="col" class={TH}>Daily cap (USD)</th>
      </tr>
    </thead>
    <tbody>
      {#each data.roles as r (r.role)}
        <tr class="border-t border-dark-4">
          <td class="py-2 pl-4 text-dark-0">{shortRole(r.role)}</td>
          <td class="py-2 pr-4 pl-4">{@render capForm('role', r.role, r.usd, r.role)}</td>
        </tr>
      {/each}
      {#each data.retiredRoleCaps as c (c.subject)}
        <tr class="border-t border-dark-4">
          <td class="py-2 pl-4 text-dark-2">{c.subject} <em>(no longer in the auth hub)</em></td>
          <td class="py-2 pr-4 pl-4">{@render capForm('role', c.subject, c.usd, c.subject)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<h2 class="mt-6 mb-2 text-sm font-semibold text-white">Per moderator</h2>
<div class="overflow-x-auto rounded-xl border border-dark-4 bg-dark-6">
  <table class="w-full min-w-xl text-sm">
    <thead>
      <tr class="border-b border-dark-4">
        <th scope="col" class={TH}>Moderator</th>
        <th scope="col" class={TH}>Daily cap (USD)</th>
      </tr>
    </thead>
    <tbody>
      {#each data.users as u (u.userId)}
        <tr class="border-t border-dark-4">
          <td class="py-2 pl-4 text-dark-0">
            {u.username ?? 'unknown'} <span class="text-dark-2">#{u.userId}</span>
          </td>
          <td class="py-2 pr-4 pl-4">
            {@render capForm('user', String(u.userId), u.usd, u.username ?? `user ${u.userId}`)}
          </td>
        </tr>
      {:else}
        <tr><td colspan="2" class="p-4 text-dark-2">No moderator has a cap of their own.</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<form method="POST" action="?/save" use:enhance class="mt-3 flex flex-wrap items-center gap-2">
  <input type="hidden" name="scope" value="user" />
  <input type="hidden" name="expect" value="" />
  <Input
    name="subject"
    inputmode="numeric"
    placeholder="User id"
    aria-label="User id"
    class="w-28"
    required
  />
  <Input
    name="usd"
    inputmode="decimal"
    placeholder="USD per day"
    aria-label="Daily cap in USD"
    class="w-28"
    required
  />
  <Input name="reason" placeholder="Reason (optional)" aria-label="Reason" class="w-56" />
  <Button type="submit" size="sm" variant="outline">Add override</Button>
</form>

<h2 class="mt-6 mb-2 text-sm font-semibold text-white">Recent changes</h2>
{#if data.changes.length}
  <div class="overflow-x-auto rounded-xl border border-dark-4 bg-dark-6">
    <table class="w-full min-w-xl text-sm">
      <caption class="sr-only">Recent spend cap changes</caption>
      <thead>
        <tr class="border-b border-dark-4">
          <th scope="col" class={TH}>When</th>
          <th scope="col" class={TH}>Who</th>
          <th scope="col" class={TH}>Cap</th>
          <th scope="col" class="{TH} pr-4">Before → after</th>
        </tr>
      </thead>
      <tbody>
        {#each data.changes as c (c.id)}
          <tr class="border-t border-dark-4 align-top">
            <td class="py-2 pl-4 text-dark-2">{dateTime(c.at)}</td>
            <td class="py-2 pl-4 text-dark-0">{c.actorName ?? `#${c.actorId}`}</td>
            <td class="py-2 pl-4 text-dark-0">
              {c.scope === 'role' ? shortRole(c.subject) : `${c.subjectName ?? 'user'} #${c.subject}`}
            </td>
            <td class="py-2 pr-4 pl-4">
              {money(c.before)} → {money(c.after)}
              {#if c.reason}<div class="text-dark-2">{c.reason}</div>{/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else}
  <p class="text-sm text-dark-2">No changes recorded yet.</p>
{/if}
