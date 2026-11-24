<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import {
    MEMORIAL_BASES,
    MEMORIAL_BASIS_LABELS,
    MEMORIAL_TRIBUTES_MAX,
    type MemorialBasis,
    type MemorialState,
  } from '@civitai/shared/memorial';
  import { dateTime, LINK_CLASS } from '$lib/format';
  import { FormState } from '$lib/form-state.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import WarningAlert from '$lib/components/WarningAlert.svelte';
  import type { LayoutData } from './$types';

  type Identity = NonNullable<LayoutData['result']>['identity'];

  let {
    identity,
    panel,
  }: {
    identity: Identity;
    panel: { memorial: MemorialState | null; proposedBy: string | null; confirmedBy: string | null };
  } = $props();

  const memorial = $derived(panel.memorial);
  let basis = $state<MemorialBasis>('family');
  let tributes = $state<{ id: number; label: string; url: string }[]>([]);
  let nextTributeId = 0;
  let confirmingReverse = $state(false);

  const tributesJson = $derived(
    JSON.stringify(tributes.map(({ label, url }) => ({ label, url })))
  );

  const form = new FormState({
    reload: true,
    onSuccess: () => {
      tributes = [];
      confirmingReverse = false;
    },
  });

  const addTribute = () => {
    tributes = [...tributes, { id: nextTributeId++, label: '', url: '' }];
  };
  const removeTribute = (id: number) => {
    tributes = tributes.filter((t) => t.id !== id);
  };
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="mb-1 flex items-center gap-2">
    <h3 class="text-sm font-semibold text-white">Memorialize account</h3>
    {#if memorial?.status === 'active'}
      <Badge variant="secondary">Memorialized</Badge>
    {:else if memorial?.status === 'pending'}
      <Badge variant="outline">Waiting for a second moderator</Badge>
    {/if}
  </div>
  <p class="mb-3 text-xs text-dark-2">
    For an account whose holder has died. The profile shows a "Remembering" label and a short note;
    everything they posted stays. Nobody can sign in, message them, tip them or delete the account
    while it is memorialized. A different moderator must confirm before anything public changes.
  </p>

  {#if form.error}
    <ErrorAlert class="mb-3" message={form.error} />
  {/if}
  {#if form.warning}
    <WarningAlert class="mb-3" message={form.warning} />
  {/if}

  {#if memorial}
    <dl class="mb-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      <dt class="text-dark-2">How it was confirmed</dt>
      <dd class="text-white">{MEMORIAL_BASIS_LABELS[memorial.basis] ?? memorial.basis}</dd>
      <dt class="text-dark-2">Proposed</dt>
      <dd class="text-white">{panel.proposedBy ?? 'unknown'}, {dateTime(memorial.proposedAt)}</dd>
      {#if memorial.confirmedAt}
        <dt class="text-dark-2">Confirmed</dt>
        <dd class="text-white">
          {panel.confirmedBy ?? 'unknown'}, {dateTime(memorial.confirmedAt)}
        </dd>
      {/if}
      <dt class="text-dark-2">Tributes</dt>
      <dd class="text-white">
        {#if memorial.tributes.length}
          {#each memorial.tributes as tribute, i (i)}
            <a href={tribute.url} class="{LINK_CLASS} mr-3" target="_blank" rel="noreferrer">
              {tribute.label}
            </a>
          {/each}
        {:else}
          None
        {/if}
      </dd>
    </dl>
    <p class="mb-3 text-xs text-dark-2">The evidence note is on Notes &amp; Strikes.</p>

    <div class="flex flex-wrap gap-2">
      {#if memorial.status === 'pending'}
        <form method="POST" action="?/memorialConfirm" use:enhance={form.enhance}>
          <input type="hidden" name="userId" value={identity.id} />
          <Button type="submit" size="sm" disabled={form.submitting}>
            Confirm memorialization
          </Button>
        </form>
      {/if}
      {#if confirmingReverse}
        <form method="POST" action="?/memorialReverse" use:enhance={form.enhance}>
          <input type="hidden" name="userId" value={identity.id} />
          <Button type="submit" size="sm" variant="destructive" disabled={form.submitting}>
            {memorial.status === 'pending' ? 'Yes, cancel the proposal' : 'Yes, reverse it'}
          </Button>
        </form>
        <Button size="sm" variant="outline" onclick={() => (confirmingReverse = false)}>
          Keep it
        </Button>
      {:else}
        <Button size="sm" variant="outline" onclick={() => (confirmingReverse = true)}>
          {memorial.status === 'pending' ? 'Cancel proposal' : 'Reverse memorialization'}
        </Button>
      {/if}
    </div>
    {#if memorial.status === 'pending'}
      <p class="mt-2 text-xs text-dark-2">
        Confirming signs the account out everywhere and expires its API keys. The moderator who
        proposed it cannot confirm it.
      </p>
    {:else if confirmingReverse}
      <p class="mt-2 text-xs text-dark-2">
        Reversing removes the label and note and lets the account be deleted again. Sessions and keys
        revoked at confirmation are not restored; the holder signs in again.
      </p>
    {/if}
  {:else}
    <form method="POST" action="?/memorialPropose" use:enhance={form.enhance} class="space-y-3">
      <input type="hidden" name="userId" value={identity.id} />
      <input type="hidden" name="tributes" value={tributesJson} />
      <fieldset class="space-y-1">
        <legend class="mb-1 text-xs text-dark-2">How was the death confirmed?</legend>
        {#each MEMORIAL_BASES as option (option)}
          <label class="flex items-center gap-2 text-sm text-white">
            <input type="radio" name="basis" value={option} bind:group={basis} />
            {MEMORIAL_BASIS_LABELS[option]}
          </label>
        {/each}
      </fieldset>
      <label class="block text-xs text-dark-2">
        Private note for moderators (who told us, the obituary link). Never shown on the profile.
        <Textarea name="note" rows={3} class="mt-1" required />
      </label>
      <div class="space-y-2">
        <p class="text-xs text-dark-2">
          Tribute links shown on the profile (Civitai links only, up to {MEMORIAL_TRIBUTES_MAX}).
        </p>
        {#each tributes as tribute (tribute.id)}
          <div class="flex gap-2">
            <Input aria-label="Tribute label" placeholder="Label" bind:value={tribute.label} />
            <Input aria-label="Tribute link" placeholder="https://civitai.com/…" bind:value={tribute.url} />
            <Button type="button" size="sm" variant="outline" onclick={() => removeTribute(tribute.id)}>
              Remove
            </Button>
          </div>
        {/each}
        {#if tributes.length < MEMORIAL_TRIBUTES_MAX}
          <Button type="button" size="xs" variant="outline" onclick={addTribute}>Add tribute</Button>
        {/if}
      </div>
      <Button type="submit" size="sm" disabled={form.submitting}>Propose memorialization</Button>
    </form>
  {/if}
</section>
