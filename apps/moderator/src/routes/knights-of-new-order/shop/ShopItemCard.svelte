<script lang="ts">
  import { untrack } from 'svelte';
  import { enhance } from '$app/forms';
  import * as AlertDialog from '@civitai/ui/components/ui/alert-dialog/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import CosmeticSample from '$lib/components/CosmeticSample.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { num } from '$lib/format';
  import { isSellable } from '@civitai/shared/knights-shop';
  import type { ShopItemRow } from '$lib/server/knights/shop-catalog.service';
  import LiveWarning from './LiveWarning.svelte';

  let { item, ranks }: { item: ShopItemRow; ranks: readonly string[] } = $props();

  let editing = $state(false);
  let minRank = $state(untrack(() => item.minRank ?? ''));
  let rotating = $state(untrack(() => item.rotating));
  let toggled = 'Saved';
  let confirming = $state(false);
  let toggleForm: HTMLFormElement | undefined = $state();

  const save = new FormState({
    reload: true,
    reset: false,
    onSuccess: (result) => {
      editing = false;
      toast.success(result?.changed === false ? 'Nothing to change' : 'Saved');
    },
  });
  const toggle = new FormState({
    reload: true,
    onSubmit: ({ action }) => {
      toggled = action.search === '?/restore' ? 'Restored' : 'Retired';
    },
    onSuccess: (result) => toast.success(result?.changed === false ? 'Nothing to change' : toggled),
  });

  function toggleEdit() {
    editing = !editing;
    if (editing) {
      minRank = item.minRank ?? '';
      rotating = item.rotating;
    }
  }

  const rankOptions = $derived(
    item.minRank && !ranks.includes(item.minRank) ? [...ranks, item.minRank] : ranks
  );
  const notSold = $derived(
    isSellable(item) ? null : 'The shop sells memberships one month at a time.'
  );

  const what = $derived(
    item.kind === 'buzz_pack'
      ? `${num(item.buzz ?? 0)} Buzz`
      : item.kind === 'membership'
      ? `${item.tier} membership, ${item.months} month${item.months === 1 ? '' : 's'}`
      : (item.cosmeticName ?? `Cosmetic #${item.cosmeticId}`)
  );
</script>

<article
  class="flex flex-col gap-3 rounded-xl border border-dark-4 bg-dark-6 p-4 {item.active
    ? ''
    : 'opacity-60'}"
>
  <div class="flex flex-wrap items-start gap-4">
    {#if item.kind === 'cosmetic' && item.cosmeticType}
      <CosmeticSample type={item.cosmeticType} name={item.name} data={item.cosmeticData} />
    {/if}
    <div class="flex min-w-0 flex-1 flex-col gap-1">
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-medium">{item.name}</span>
        <Badge variant="secondary">{item.kind.replace('_', ' ')}</Badge>
        {#if item.cosmeticType}<Badge variant="outline">{item.cosmeticType}</Badge>{/if}
        {#if !item.active}<Badge variant="destructive">Retired</Badge>{/if}
        {#if notSold}<Badge variant="outline" title={notSold}>Not sold</Badge>{/if}
        {#if item.rotating}<Badge variant="outline">Rotating</Badge>{/if}
        {#if item.minRank}<Badge variant="outline">{item.minRank}+</Badge>{/if}
      </div>
      <p class="text-sm text-dark-2">
        {what} · {num(item.price)} gold · sort {item.sortOrder} · <code>{item.id}</code>
      </p>
      {#if notSold}<p class="text-sm text-dark-2">Not sold: {notSold}</p>{/if}
      {#if item.description}<p class="text-sm text-dark-2">{item.description}</p>{/if}
    </div>
    <div class="flex gap-2">
      <Button size="sm" variant="outline" onclick={toggleEdit}>
        {editing ? 'Close' : 'Edit'}
      </Button>
      {#if item.active}
        <Button size="sm" variant="outline" disabled={toggle.submitting} onclick={() => (confirming = true)}>
          Retire
        </Button>
      {:else}
        <form method="POST" action="?/restore" use:enhance={toggle.enhance}>
          <input type="hidden" name="id" value={item.id} />
          <Button type="submit" size="sm" variant="outline" disabled={toggle.submitting}>Restore</Button>
        </form>
      {/if}
    </div>
  </div>

  {#if toggle.error}<ErrorAlert message={toggle.error} />{/if}

  {#if editing}
    <form
      method="POST"
      action="?/save"
      use:enhance={save.enhance}
      class="flex flex-col gap-2 border-t border-dark-4 pt-3"
    >
      <input type="hidden" name="id" value={item.id} />
      <LiveWarning />
      {#if save.error}<ErrorAlert message={save.error} />{/if}
      <div class="flex flex-wrap items-center gap-3 text-sm text-dark-2">
        <label class="flex items-center gap-2">
          Name <Input name="name" required value={item.name} class="w-56" />
        </label>
        <label class="flex items-center gap-2">
          Price (gold)
          <Input name="price" inputmode="numeric" required value={item.price} class="w-28" />
        </label>
        <label class="flex items-center gap-2">
          Sort order
          <Input name="sortOrder" inputmode="numeric" required value={item.sortOrder} class="w-24" />
        </label>
        <label class="flex items-center gap-2">
          Minimum rank
          <input type="hidden" name="minRank" value={minRank} />
          <Select.Root type="single" bind:value={minRank}>
            <Select.Trigger class="w-36">{minRank || 'Anyone'}</Select.Trigger>
            <Select.Content>
              <Select.Item value="">Anyone</Select.Item>
              {#each rankOptions as rank (rank)}<Select.Item value={rank}>{rank}</Select.Item>{/each}
            </Select.Content>
          </Select.Root>
        </label>
        <label class="flex items-center gap-2">
          <input type="hidden" name="rotating" value={rotating ? 'on' : ''} />
          <Checkbox bind:checked={rotating} /> Rotating
        </label>
      </div>
      <label class="flex items-center gap-2 text-sm text-dark-2">
        Description
        <Input name="description" value={item.description} class="flex-1" />
      </label>
      <div><Button type="submit" size="sm" disabled={save.submitting}>Save</Button></div>
    </form>
  {/if}
</article>

<form bind:this={toggleForm} method="POST" action="?/retire" use:enhance={toggle.enhance} hidden>
  <input type="hidden" name="id" value={item.id} />
</form>

<AlertDialog.Root bind:open={confirming}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Retire {item.name}?</AlertDialog.Title>
      <AlertDialog.Description>
        It leaves the shop on the next request and today's rotation is drawn again without it.
        Purchases already made keep their record; it stays listed here and can be restored.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action
        variant="destructive"
        onclick={() => {
          confirming = false;
          toggleForm?.requestSubmit();
        }}>Retire</AlertDialog.Action
      >
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
