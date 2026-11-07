<script lang="ts">
  import { untrack } from 'svelte';
  import { enhance } from '$app/forms';
  import { IconBolt, IconCrown, IconPalette } from '@tabler/icons-svelte';
  import { SHOP_TIERS, dealPrice } from '@civitai/shared/knights-shop';
  import { Alert, AlertDescription } from '@civitai/ui/components/ui/alert/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { Switch } from '@civitai/ui/components/ui/switch/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { ToggleGroup, ToggleGroupItem } from '@civitai/ui/components/ui/toggle-group/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import type { ShopItemRow } from '$lib/server/knights/shop-catalog.service';
  import CosmeticPicker, { type Cosmetic } from './CosmeticPicker.svelte';
  import ItemThumb from './ItemThumb.svelte';
  import PlayerCard from './PlayerCard.svelte';
  import { impactOfAdd, impactOfChange } from './impact';
  import {
    KIND_ONE,
    KIND_ORDER,
    humanize,
    titleCase,
    whatItIs,
    type CardModel,
    type Kind,
    type Today,
  } from './shop-view';

  let {
    item,
    items,
    ranks,
    day,
    today,
    ondone,
    onstatus,
  }: {
    item: ShopItemRow | null;
    items: readonly ShopItemRow[];
    ranks: readonly string[];
    day: string;
    today: Today;
    ondone: () => void;
    onstatus: (action: 'retire' | 'restore') => void;
  } = $props();

  const KIND_BLURB: Record<Kind, string> = {
    buzz_pack: 'Sells an amount of Buzz for gold.',
    membership: 'One perks-only week of a Civitai membership.',
    cosmetic: 'A badge, nameplate, decoration or other cosmetic.',
  };
  const KIND_ICON = { buzz_pack: IconBolt, membership: IconCrown, cosmetic: IconPalette } as const;

  const seed = untrack(() => item);
  const editing = seed !== null;
  let kind = $state<Kind | null>(seed ? (seed.kind as Kind) : null);
  let tier = $state<string>(seed?.tier ?? SHOP_TIERS[0]);
  let buzz = $state('');
  let cosmetic = $state<Cosmetic | null>(null);
  let name = $state(seed?.name ?? '');
  let price = $state(seed ? String(seed.price) : '');
  let minRank = $state(seed?.minRank ?? '');
  let rotating = $state(seed?.rotating ?? false);
  let sortOrder = $state(seed ? String(seed.sortOrder) : '0');
  let description = $state(seed?.description ?? '');

  const form = new FormState({
    reload: true,
    reset: false,
    onSuccess: (result) => {
      toast.success(result?.changed === false ? 'Nothing to change' : editing ? 'Saved' : 'Added');
      ondone();
    },
  });

  const rankOptions = $derived(
    seed?.minRank && !ranks.includes(seed.minRank) ? [...ranks, seed.minRank] : ranks
  );
  const priceNumber = $derived(/^\d{1,9}$/.test(price.trim()) ? Number(price) : null);

  const notices = $derived.by(() => {
    if (!kind) return [];
    if (!seed) return impactOfAdd(rotating);
    return impactOfChange([...items], day, seed.id, {
      ...(priceNumber !== null && priceNumber > 0 ? { price: priceNumber } : {}),
      rotating,
    });
  });

  const card = $derived<CardModel>({
    kind: kind ?? 'buzz_pack',
    name: name.trim() || (kind ? `New ${KIND_ONE[kind].toLowerCase()}` : 'New item'),
    ...(seed && today.get(seed.id)?.deal && priceNumber
      ? { price: dealPrice(priceNumber), listPrice: priceNumber }
      : { price: priceNumber, listPrice: null }),
    minRank: minRank || null,
    buzz: seed ? seed.buzz : /^\d{1,9}$/.test(buzz.trim()) ? Number(buzz) : null,
    tier,
    cosmeticType: seed ? seed.cosmeticType : cosmetic?.type ?? null,
    cosmeticData: seed ? seed.cosmeticData : cosmetic?.data ?? null,
    hidden: null,
  });

  const ready = $derived(kind !== null && (kind !== 'cosmetic' || editing || cosmetic !== null));
</script>

<form
  method="POST"
  action={editing ? '?/save' : '?/add'}
  use:enhance={form.enhance}
  class="flex flex-col gap-5"
>
  {#if seed}<input type="hidden" name="id" value={seed.id} />{/if}

  {#if !seed && kind === null}
    <div>
      <p class="mb-2 text-sm font-medium text-white">What are you adding?</p>
      <div class="grid gap-2 sm:grid-cols-3">
        {#each KIND_ORDER as option (option)}
          {@const Icon = KIND_ICON[option]}
          <button
            type="button"
            class="flex flex-col items-start gap-2 rounded-lg border border-dark-4 bg-dark-7 p-3 text-left hover:border-blue-5 hover:bg-dark-5"
            onclick={() => (kind = option)}
          >
            <Icon class="size-6 text-blue-4" />
            <span class="text-sm font-medium text-white">{KIND_ONE[option]}</span>
            <span class="text-xs text-dark-2">{KIND_BLURB[option]}</span>
          </button>
        {/each}
      </div>
    </div>
  {:else if kind}
    <input type="hidden" name="kind" value={kind} />
    <div class="@container"><div class="grid gap-5 @3xl:grid-cols-[minmax(0,1fr)_16rem]">
      <div class="flex min-w-0 flex-col gap-4">
        {#if seed}
          <div class="flex items-center gap-3 rounded-lg border border-dark-4 bg-dark-7 p-3">
            <ItemThumb
              kind={seed.kind as Kind}
              name={seed.name}
              tier={seed.tier}
              cosmeticType={seed.cosmeticType}
              cosmeticData={seed.cosmeticData}
            />
            <div class="min-w-0">
              <p class="text-xs text-dark-2">{KIND_ONE[kind]}</p>
              <p class="truncate text-sm text-white">
                {seed.cosmeticName ?? whatItIs(seed)}
                {#if seed.kind === 'cosmetic'}<span class="text-dark-2">
                    · {seed.cosmeticType ? humanize(seed.cosmeticType) : 'missing'} · #{seed.cosmeticId}</span
                  >{/if}
              </p>
              <p class="text-xs text-dark-2">
                To change this, retire the item and add a new one.
              </p>
            </div>
          </div>
        {:else}
          <div class="flex items-center justify-between text-sm">
            <span class="text-dark-2">Kind: <span class="text-white">{KIND_ONE[kind]}</span></span>
            <Button type="button" size="sm" variant="ghost" onclick={() => (kind = null)}>
              Change
            </Button>
          </div>
          {#if kind === 'buzz_pack'}
            <div class="grid gap-1.5">
              <Label for="shop-buzz">Buzz</Label>
              <Input
                id="shop-buzz"
                name="buzz"
                inputmode="numeric"
                required
                bind:value={buzz}
                class="w-40"
              />
            </div>
          {:else if kind === 'membership'}
            <div class="grid gap-1.5">
              <Label>Tier</Label>
              <input type="hidden" name="tier" value={tier} />
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                class="justify-start"
                bind:value={() => tier, (value) => value && (tier = value)}
              >
                {#each SHOP_TIERS as option (option)}
                  <ToggleGroupItem value={option}>{titleCase(option)}</ToggleGroupItem>
                {/each}
              </ToggleGroup>
              <input type="hidden" name="days" value="7" />
              <p class="text-xs text-dark-2">1 week. The shop sells memberships one week at a time.</p>
            </div>
          {:else}
            <div class="grid gap-1.5">
              <Label>Cosmetic</Label>
              <CosmeticPicker
                bind:selected={cosmetic}
                onpick={(picked) => {
                  if (!name.trim()) name = picked.name;
                }}
              />
            </div>
          {/if}
        {/if}

        <div class="grid gap-1.5">
          <Label for="shop-name">Name</Label>
          <Input id="shop-name" name="name" required bind:value={name} />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="grid gap-1.5">
            <Label for="shop-price">Price (gold)</Label>
            <Input id="shop-price" name="price" inputmode="numeric" required bind:value={price} />
          </div>
          <div class="grid gap-1.5">
            <Label for="shop-sort">Sort order</Label>
            <Input id="shop-sort" name="sortOrder" inputmode="numeric" required bind:value={sortOrder} />
          </div>
        </div>
        <div class="grid gap-1.5">
          <Label for="shop-rank">Minimum rank</Label>
          <input type="hidden" name="minRank" value={minRank} />
          <Select.Root type="single" bind:value={minRank}>
            <Select.Trigger id="shop-rank" class="w-48">{minRank || 'Anyone'}</Select.Trigger>
            <Select.Content>
              <Select.Item value="">Anyone</Select.Item>
              {#each rankOptions as rank (rank)}<Select.Item value={rank}>{rank}</Select.Item>{/each}
            </Select.Content>
          </Select.Root>
        </div>
        <div class="flex items-center justify-between gap-4 rounded-lg border border-dark-4 p-3">
          <div>
            <Label for="shop-rotating">Rotating</Label>
            <p class="text-xs text-dark-2">
              Rotating items are drawn a few at a time each UTC day. Others are always on sale.
            </p>
          </div>
          <input type="hidden" name="rotating" value={rotating ? 'on' : ''} />
          <Switch id="shop-rotating" bind:checked={() => rotating, (value) => (rotating = value)} />
        </div>
        <div class="grid gap-1.5">
          <Label for="shop-description">Description</Label>
          <Textarea id="shop-description" name="description" rows={3} bind:value={description} />
        </div>
      </div>

      <aside class="flex flex-col gap-2 @3xl:sticky @3xl:top-0 @3xl:self-start">
        <p class="text-xs font-semibold uppercase tracking-wide text-dark-2">How players see it</p>
        <PlayerCard {card} variant={card.listPrice === null ? 'compact' : 'deal'} />
        {#if description.trim()}<p class="text-xs text-dark-2">{description.trim()}</p>{/if}
      </aside>
    </div></div>

    <div class="sticky bottom-0 -mx-5 -mb-5 flex flex-col gap-2 border-t border-dark-4 bg-popover px-5 py-3">
      {#each notices as notice (notice)}
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      {/each}
      {#if form.error}<ErrorAlert message={form.error} />{/if}
      <div class="flex items-center gap-2">
        <Button type="submit" disabled={form.submitting || !ready}>
          {editing ? 'Save changes' : 'Add item'}
        </Button>
        <Button type="button" variant="ghost" onclick={ondone}>Cancel</Button>
        {#if seed}
          <Button
            type="button"
            variant="ghost"
            class="ml-auto {seed.active ? 'text-red-300' : ''}"
            onclick={() => onstatus(seed.active ? 'retire' : 'restore')}
          >
            {seed.active ? 'Retire item' : 'Restore item'}
          </Button>
        {/if}
      </div>
    </div>
  {/if}
</form>
