<script lang="ts">
  import { enhance } from '$app/forms';
  import { SvelteSet } from 'svelte/reactivity';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import BanConfirmForm from '$lib/components/BanConfirmForm.svelte';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import type { RestrictionRow } from '$lib/server/user-restriction.service';
  import UserWorkflowsPanel from './UserWorkflowsPanel.svelte';
  import TriggerCard from './TriggerCard.svelte';
  import StatusBadge from './StatusBadge.svelte';

  let {
    restriction,
    civitaiUrl,
    canBan,
    onStart,
    onDone,
  }: {
    restriction: RestrictionRow;
    civitaiUrl: string;
    canBan: boolean;
    /** Runs at SUBMIT time, before the reload replaces the list the successor is chosen from. */
    onStart: () => void;
    /** Selects that successor once the ruling has landed. */
    onDone: () => void;
  } = $props();

  const selected = new SvelteSet<string>();
  const toggle = (key: string) => (selected.has(key) ? selected.delete(key) : selected.add(key));

  let banning = $state(false);

  // `onSubmit` picks the successor row while the current list still holds it — the reload that follows
  // replaces it, and under the Pending filter the row just ruled on is gone by then.
  const rule = new FormState({
    onSubmit: () => onStart(),
    reload: true,
    onSuccess: () => {
      toast.success('Restriction resolved');
      onDone();
    },
  });

  const ban = new FormState({
    onSubmit: () => onStart(),
    reload: true,
    onSuccess: () => {
      banning = false;
      toast.success(`Banned ${restriction.username ?? restriction.userId}`);
      onDone();
    },
  });

  const flag = new FormState({
    // The SERVER's count, not `selected.size`: the action re-reads the restriction and drops any
    // trigger that no longer exists, so what was ticked and what was saved can differ.
    onSuccess: (data) => {
      toast.success(`Flagged ${data?.savedCount ?? selected.size} suspicious`);
      selected.clear();
    },
  });
</script>

<div>
  <div class="flex flex-wrap items-center gap-2 pb-3">
    <span class="text-sm text-dark-2">User:</span>
    <a href={userLookupUrl(restriction.username ?? restriction.userId)} class={LINK_CLASS}>
      {restriction.username ?? `#${restriction.userId}`}
    </a>
    <StatusBadge status={restriction.status} />
    <span class="text-sm text-dark-2">{dateTime(restriction.createdAt)}</span>
  </div>

  {#if rule.error ?? ban.error ?? flag.error}
    <p class="mb-3 text-sm text-red-300">{rule.error ?? ban.error ?? flag.error}</p>
  {/if}

  {#if restriction.status === 'Pending'}
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <form method="POST" action="?/resolve" use:enhance={rule.enhance}>
        <input type="hidden" name="userRestrictionId" value={restriction.id} />
        <input type="hidden" name="userId" value={restriction.userId} />
        <input type="hidden" name="status" value="Upheld" />
        <Button type="submit" size="sm" variant="destructive" disabled={rule.submitting}>Uphold mute</Button>
      </form>
      <form method="POST" action="?/resolve" use:enhance={rule.enhance}>
        <input type="hidden" name="userRestrictionId" value={restriction.id} />
        <input type="hidden" name="userId" value={restriction.userId} />
        <input type="hidden" name="status" value="Overturned" />
        <Button type="submit" size="sm" disabled={rule.submitting}>Remove mute</Button>
      </form>
      {#if canBan}
        <Button size="sm" variant="outline" onclick={() => (banning = !banning)}>Ban user</Button>
      {/if}

      {#if selected.size > 0}
        <form method="POST" action="?/flagSuspicious" use:enhance={flag.enhance}>
          <input type="hidden" name="userRestrictionId" value={restriction.id} />
          {#each [...selected] as key (key)}
            <input type="hidden" name="key" value={key} />
          {/each}
          <Button type="submit" size="sm" variant="outline" disabled={flag.submitting}>
            Flag {selected.size} suspicious
          </Button>
        </form>
      {/if}
    </div>

    {#if banning}
      <div class="mb-3">
        <BanConfirmForm
          userId={restriction.userId}
          username={restriction.username}
          enhancer={ban.enhance}
          busy={ban.submitting}
          onCancel={() => (banning = false)}
        >
          {#snippet hidden()}
            <input type="hidden" name="userRestrictionId" value={restriction.id} />
          {/snippet}
          {#snippet prompt()}
            <p class="mb-2 text-sm text-dark-0">This also upholds the restriction.</p>
          {/snippet}
        </BanConfirmForm>
      </div>
    {/if}
  {/if}

  <!-- The triggers say what one prompt tripped; this says whether the account has a history of it. -->
  <div class="mb-3">
    <UserWorkflowsPanel userId={restriction.userId} />
  </div>

  <div class="mb-2 flex items-center gap-2">
    <Badge variant="secondary">{restriction.triggers.length} triggers</Badge>
  </div>

  <div class="flex flex-col gap-3">
    {#each restriction.triggers as trigger (trigger.key)}
      <TriggerCard
        {trigger}
        {civitaiUrl}
        selected={selected.has(trigger.key)}
        onToggle={toggle}
      />
    {/each}

    {#if restriction.userMessage}
      <div class="rounded-xl border border-dark-4 bg-dark-6 p-4">
        <p class="text-xs text-dark-2">
          User context submitted {restriction.userMessageAt
            ? dateTime(restriction.userMessageAt)
            : ''}
        </p>
        <p class="text-sm text-dark-0">{restriction.userMessage}</p>
      </div>
    {/if}

    {#if restriction.resolvedAt}
      <div class="rounded-xl border border-dark-4 bg-dark-6 p-4">
        <p class="text-xs text-dark-2">Resolved {dateTime(restriction.resolvedAt)}</p>
        {#if restriction.resolvedMessage}
          <p class="text-sm text-dark-0">{restriction.resolvedMessage}</p>
        {/if}
      </div>
    {/if}
  </div>
</div>
