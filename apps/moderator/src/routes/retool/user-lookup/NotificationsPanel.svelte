<script lang="ts">
  import { FormState } from '$lib/form-state.svelte';
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { browser } from '$app/environment';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import type { Capped, Notification } from './user-account';
  import { dateTime } from '$lib/format';
  import ListCard from './ListCard.svelte';

  // `details` keys vary by notification type — the notifications service stores a raw payload and the
  // monolith renders it. These are the ones that carry prose; anything else is ids and is not worth
  // showing. Falls back to nothing rather than dumping JSON at a moderator.
  const BODY_KEYS = ['message', 'details', 'content', 'reason', 'body'];

  const notificationBody = (details: Record<string, unknown>) => {
    for (const key of BODY_KEYS) {
      const value = details?.[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
    return null;
  };

  let {
    userId,
    canAct,
    onSuccess,
  }: {
    userId: number;
    canAct: boolean;
    onSuccess: () => void;
  } = $props();

  // Retool's "Number of Notifs". Fetched separately from the account bundle so changing it does not
  // refetch twelve other queries.
  const COUNTS: [string, string][] = [
    ['25', '25'],
    ['50', '50'],
    ['100', '100'],
    ['200', '200'],
  ];
  let notifLimit = $state('25');
  const notifications = $derived(
    browser
      ? fetch(`/api/user-notifications/${userId}?limit=${notifLimit}`).then(
          (r): Promise<Capped<Notification> | null> => {
            if (!r.ok) throw new Error(String(r.status));
            return r.json();
          }
        )
      : null
  );

  // Called through, not captured: reading the prop inside the closure is what stops a re-passed
  // callback being ignored (svelte’s `state_referenced_locally`).
  const form = new FormState({ onSuccess: () => onSuccess() });
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

  {#if form.error}
    <div
      class="mb-3 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
      role="alert"
    >
      {form.error}
    </div>
  {/if}

  {#if !canAct}
    <p class="text-sm text-dark-2">Sending requires the Users permission.</p>
  {:else if sending}
    <form method="POST" action="?/sendNotification" use:enhance={form.enhance}>
      <input type="hidden" name="userId" value={userId} />
      <Textarea name="message" rows={3} placeholder="What should this user be told?" required />
      <!-- Retool's `notificationLink`. Live on the receiving end already: `system-announcement`'s
           `prepareMessage` reads `details.url` and renders it as the click-through, so without this the
           notification is dead text. Retool sent /safety, or /generate for its non-AI-content reason. -->
      <Input
        name="url"
        class="mt-2"
        placeholder="Link (optional) — e.g. /safety or /generate"
      />
      <div class="mt-2 flex gap-2">
        <Button type="submit" size="sm" disabled={form.submitting}>
          {form.submitting ? 'Sending…' : 'Send'}
        </Button>
        <Button type="button" size="sm" variant="outline" onclick={() => (sending = false)}>
          Cancel
        </Button>
      </div>
    </form>
  {/if}
</section>

{#await notifications}
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-dark-2">Loading notifications…</p>
  </div>
{:then notifications}
  {#if notifications === null}
    <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <h3 class="mb-3 text-sm font-semibold text-white">Notifications</h3>
      <p class="text-sm text-amber-300">Notifications service unavailable.</p>
    </div>
  {:else if notifications}
    <ListCard
      title="Notifications sent"
      total={notifications.items.length} capped={notifications.truncated}
      shown={15}
      hint="What the site has told this user — context for “I was never warned”."
    >
      {#snippet controls()}
        <label class="mb-3 flex items-center gap-2 text-xs text-dark-2">
          Number of notifications
          <Select.Root type="single" bind:value={notifLimit}>
            <Select.Trigger class="w-20">{notifLimit}</Select.Trigger>
            <Select.Content>
              {#each COUNTS as [value, label] (value)}
                <Select.Item {value}>{label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </label>
      {/snippet}
      {#snippet children(limit)}
        <ul class="space-y-1 text-sm">
          {#each notifications.items.slice(0, limit) as n (n.id)}
            <li class="min-w-0">
              <div class="flex flex-wrap items-baseline gap-x-2">
                <span class="text-dark-0">{n.type}</span>
                <Badge variant="secondary">{n.category}</Badge>
                {#if !n.read}<span class="text-xs text-dark-2">unread</span>{/if}
                <span class="text-xs text-dark-2">{dateTime(n.createdAt)}</span>
              </div>
              <!-- The body is the whole point of the panel; type and date cannot settle whether the
                   user was told. `details` is the raw payload — the monolith enriches it downstream,
                   so keys vary by type and the useful ones are shown as-is. -->
              {#if notificationBody(n.details)}
                <p class="wrap-break-word text-xs text-dark-2">{notificationBody(n.details)}</p>
              {/if}
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
