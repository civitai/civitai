<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { dateTime } from '$lib/format';
  import type { Account } from './user-account';
  import type { FormResult } from './form-result';
  import ListCard from './ListCard.svelte';

  let {
    account,
    userId,
    canAct,
    form,
    onSubmit,
    submitting,
  }: {
    account: Promise<Account> | null;
    userId: number;
    canAct: boolean;
    form: FormResult;
    onSubmit: SubmitFunction;
    submitting: boolean;
  } = $props();

  const error = $derived(form?.scope === 'notify' ? form.error : null);
  let sending = $state(false);
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="mb-1 flex items-baseline justify-between gap-3">
    <h3 class="text-sm font-semibold text-white">Send a notification</h3>
    {#if canAct && !sending}
      <Button size="sm" onclick={() => (sending = true)}>Compose</Button>
    {/if}
  </div>
  <p class="mb-3 text-xs text-dark-2">
    Goes to this user as a system notification. There is no reply channel — for a conversation, use
    Chat.
  </p>

  {#if error}
    <div
      class="mb-3 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
      role="alert"
    >
      {error}
    </div>
  {/if}

  {#if !canAct}
    <p class="text-sm text-dark-2">Sending requires the Users permission.</p>
  {:else if sending}
    <form method="POST" action="?/sendNotification" use:enhance={onSubmit}>
      <input type="hidden" name="userId" value={userId} />
      <Textarea name="message" rows={3} placeholder="What should this user be told?" required />
      <div class="mt-2 flex gap-2">
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting ? 'Sending…' : 'Send'}
        </Button>
        <Button type="button" size="sm" variant="outline" onclick={() => (sending = false)}>
          Cancel
        </Button>
      </div>
    </form>
  {/if}
</section>

{#await account}
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-dark-2">Loading notifications…</p>
  </div>
{:then result}
  {#if result?.notifications === null}
    <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <h3 class="mb-3 text-sm font-semibold text-white">Notifications</h3>
      <p class="text-sm text-amber-300">Notifications service unavailable.</p>
    </div>
  {:else if result}
    {@const notifications = result.notifications}
    <ListCard
      title="Notifications sent"
      total={notifications.length}
      shown={15}
      hint="What the site has told this user — context for “I was never warned”."
    >
      {#snippet children(limit)}
        <ul class="space-y-1 text-sm">
          {#each notifications.slice(0, limit) as n (n.id)}
            <li class="flex flex-wrap items-baseline gap-x-2">
              <span class="text-dark-0">{n.type}</span>
              <Badge variant="secondary">{n.category}</Badge>
              {#if !n.read}<span class="text-xs text-dark-2">unread</span>{/if}
              <span class="text-xs text-dark-2">{dateTime(n.createdAt)}</span>
            </li>
          {/each}
        </ul>
      {/snippet}
    </ListCard>
  {/if}
{:catch}
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-red-300">Could not load notifications.</p>
  </div>
{/await}
