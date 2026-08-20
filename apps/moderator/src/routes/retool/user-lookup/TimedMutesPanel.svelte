<script lang="ts">
  import { browser } from '$app/environment';
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import type { LayoutData } from './$types';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { fetchSupport } from './user-support';
  import { MUTE_PRESETS } from './enforcement-options';
  import { FormState } from '$lib/form-state.svelte';

  type Identity = NonNullable<LayoutData['result']>['identity'];

  let {
    identity,
    canAct,
  }: { identity: Identity; canAct: boolean; } = $props();

  // `scope: 'account'` is shared with AccountActionsPanel because both post the same form actions;
  // the two are never on screen together, so the scope does not need splitting with the panel.

  let version = $state(0);
  let muteHours = $state(24);
  // A DATE rather than a free-text hours box, for the same reason as the presets below: a date shows
  // you what you picked, where `240` does not announce itself as ten days.
  let customUntil = $state('');
  const useCustom = $derived(muteHours === 0);
  const customUntilIso = $derived(
    customUntil ? (Number.isNaN(Date.parse(customUntil)) ? '' : new Date(customUntil).toISOString()) : ''
  );

  const support = $derived(browser ? fetchSupport(identity.id, version) : null);

  const form = new FormState({
    reload: true,
    onSuccess: () => {
      version += 1;
      // `update({reset:true})` clears the DOM field but fires no input event, so `bind:value` would
      // keep the submitted timestamp while the control renders empty.
      customUntil = '';
    },
  });
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Timed mutes</h3>
  <p class="mb-3 text-xs text-dark-2">
    A mute that lifts on its own. An indefinite mute, bans and content actions are on Admin.
  </p>

  {#if form.error}
    <div
      class="mb-3 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
      role="alert"
    >
      {form.error}
    </div>
  {/if}

  {#if canAct}
    <form method="POST" action="?/addTimedMute" use:enhance={form.enhance}>
      <input type="hidden" name="userId" value={identity.id} />
      <div class="flex flex-wrap items-end gap-2">
        <label class="text-xs text-dark-2">
          Duration
          <!-- Retool's presetMutes. A free-text hours box invites 240 where someone meant 24. -->
          <div class="mt-1 flex flex-wrap gap-1">
            {#each MUTE_PRESETS as [value, label] (value)}
              <Button
                type="button"
                size="xs"
                variant={muteHours === value ? 'default' : 'outline'}
                onclick={() => (muteHours = value)}
              >
                {label}
              </Button>
            {/each}
            <Button
              type="button"
              size="xs"
              variant={useCustom ? 'default' : 'outline'}
              onclick={() => (muteHours = 0)}
            >
              Until…
            </Button>
          </div>
          {#if useCustom}
            <Input
              type="datetime-local"
              aria-label="Mute until"
              bind:value={customUntil}
              class="mt-1"
              required
            />
            <!-- `datetime-local` submits no offset, and `new Date(...)` on a bare date-time resolves in
                 the SERVER's zone (UTC in the containers) — so the moderator's 23:00 became 23:00 UTC.
                 Submitting the resolved instant instead keeps the clock time they picked. -->
            <input type="hidden" name="until" value={customUntilIso} />
          {:else}
            <input type="hidden" name="hours" value={muteHours} />
          {/if}
        </label>
        <label class="flex-1 text-xs text-dark-2">
          Reason
          <Input name="reason" placeholder="Why is this mute being applied?" class="mt-1" required />
        </label>
        <Button type="submit" size="sm" disabled={form.submitting}>Apply</Button>
      </div>
    </form>
  {/if}

  {#await support}
    <p class="mt-5 text-sm text-dark-2">Loading mutes…</p>
  {:then result}
    {#if result}
      <div class="mt-5">
        <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">
          History ({result.timedMutes.length})
        </h4>
        {#if result.timedMutes.length === 0}
          <p class="text-sm text-dark-2">This account has never been given a timed mute.</p>
        {:else}
          <ul class="space-y-1.5 text-sm">
            {#each result.timedMutes as m (m.id)}
              <li class="flex flex-wrap items-baseline gap-x-2">
                {#if m.active}
                  <Badge variant="destructive">active</Badge>
                {:else}
                  <Badge variant="secondary">ended</Badge>
                {/if}
                <span class="text-dark-0">until {dateTime(m.muteEnd)}</span>
                <span class="text-xs text-dark-2">{m.createdBy ?? 'unknown'}</span>
                {#if m.muteReason}
                  <span class="text-xs text-dark-2">— {m.muteReason}</span>
                {/if}
                {#if m.active && canAct}
                  <form method="POST" action="?/revokeTimedMute" use:enhance={form.enhance}>
                    <input type="hidden" name="id" value={m.id} />
                    <input type="hidden" name="userId" value={identity.id} />
                    <button type="submit" disabled={form.submitting} class="text-xs {LINK_CLASS}">
                      revoke
                    </button>
                  </form>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  {:catch}
    <p class="mt-5 text-sm text-red-300">Could not load this account's timed mutes.</p>
  {/await}
</section>
