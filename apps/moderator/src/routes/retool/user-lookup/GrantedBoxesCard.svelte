<script lang="ts">
  import { enhance } from '$app/forms';
  import { onMount } from 'svelte';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import ConfirmButton from '$lib/components/ConfirmButton.svelte';
  import type { FormState } from '$lib/form-state.svelte';
  import { dateTime } from '$lib/format';
  import { MAX_BOXES_PER_USER, newBoxGrantId } from '$lib/mystery-box';
  import { denied } from '$lib/permissions';
  import type { Account } from './user-account';

  let {
    grantedBoxes,
    grantableBoxes,
    userId,
    canGrantBoxes,
    granting,
    takingBack,
  }: {
    grantedBoxes: Account['grantedBoxes'];
    grantableBoxes: Account['grantableBoxes'];
    userId: number;
    canGrantBoxes: boolean;
    /** Owned by ShopPanel, which shows their alerts: a write reloads the account and remounts this card. */
    granting: FormState;
    takingBack: FormState;
  } = $props();

  // On each mount: a landed grant reloads the account and remounts this card, so the next grant gets
  // a new id.
  let grantId = $state('');
  onMount(() => (grantId = newBoxGrantId()));
  let boxId = $state('');

  const STATE_LABEL = { held: 'unopened', opened: 'opened', takenBack: 'taken back' } as const;
  const boxLabel = (box: { id: number; name: string }) => `#${box.id} ${box.name}`;
  const chosen = $derived(grantableBoxes.find((b) => String(b.id) === boxId));
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Mystery boxes</h3>
  <p class="mb-3 text-xs text-dark-2">
    A granted box is free: no purchase, no Buzz. Taking one back removes the box, or what it gave
    once opened.
  </p>
  {#if !canGrantBoxes}
    <p class="text-sm text-dark-2">{denied('items.boxes.grant')}</p>
  {:else if grantableBoxes.length === 0}
    <p class="text-sm text-dark-2">No box is published.</p>
  {:else}
    <form method="POST" action="?/grantBox" use:enhance={granting.enhance} class="mb-4">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="grantId" value={grantId} />
      <div class="flex flex-wrap items-end gap-2">
        <Select.Root type="single" name="boxId" bind:value={boxId}>
          <Select.Trigger class="min-w-56 flex-1">
            {chosen ? boxLabel(chosen) : 'Choose a box'}
          </Select.Trigger>
          <Select.Content>
            {#each grantableBoxes as b (b.id)}
              <Select.Item value={String(b.id)}>{boxLabel(b)}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
        <Input
          type="number"
          name="count"
          min={1}
          max={MAX_BOXES_PER_USER}
          value={1}
          class="h-8 w-20"
          aria-label="How many boxes"
        />
        <Button type="submit" size="sm" disabled={!chosen || !grantId || granting.submitting}>
          Grant
        </Button>
      </div>
    </form>
  {/if}

  {#if grantedBoxes.items.length}
    <ul class="space-y-1 text-sm">
      {#each grantedBoxes.items as box (box.sourceKey)}
        <li class="flex flex-wrap items-baseline gap-x-2">
          <span class="text-dark-0">{box.boxName}</span>
          <Badge variant={box.state === 'takenBack' ? 'outline' : 'secondary'}>
            {STATE_LABEL[box.state]}
          </Badge>
          {#if box.reward}
            <span class="text-xs text-dark-2">gave {box.reward}</span>
          {/if}
          <span class="text-xs text-dark-2">{dateTime(box.at)}</span>
          {#if canGrantBoxes && box.state !== 'takenBack'}
            <form method="POST" action="?/takeBackGrantedBox" use:enhance={takingBack.enhance}>
              <input type="hidden" name="userId" value={userId} />
              <input type="hidden" name="sourceKey" value={box.sourceKey} />
              <ConfirmButton
                label="Take back"
                title="Take back this box?"
                description={box.state === 'held'
                  ? 'The unopened box is removed from this account.'
                  : `The ${box.reward ?? 'reward'} it gave is removed from this account. The opening stays on record.`}
                disabled={takingBack.submitting}
              />
            </form>
          {/if}
        </li>
      {/each}
    </ul>
    {#if grantedBoxes.truncated}
      <p class="mt-2 text-xs text-dark-2">Showing the latest {grantedBoxes.items.length}.</p>
    {/if}
  {:else}
    <p class="text-sm text-dark-2">No boxes granted to this account.</p>
  {/if}
</section>
