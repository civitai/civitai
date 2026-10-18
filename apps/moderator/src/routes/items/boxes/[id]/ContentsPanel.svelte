<script lang="ts">
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { ITEM_TYPE, type BoxDraft, type RewardInfo } from '$lib/mystery-box';

  let {
    draft = $bindable(),
    rewards,
    teams,
    boxId,
  }: {
    draft: BoxDraft;
    rewards: SvelteMap<number, RewardInfo>;
    teams: string[];
    boxId: number;
  } = $props();

  const ALL = '__all';
  const NO_EVENT = '__none';

  // Selection is by reward: a content's id is null until saved, but its reward is unique in the box.
  const selected = new SvelteSet<number>();
  let pickedTeamFilter = $state(ALL);
  // A pick whose tier, team or event has since gone reads as unpicked.
  let pickedTierFilter = $state(ALL);
  let pickedMoveTo = $state('');
  const validTier = (key: string, fallback: string) =>
    draft.tiers.some((tier) => tier.key === key) ? key : fallback;
  const tierFilter = $derived(validTier(pickedTierFilter, ALL));
  const teamFilter = $derived(teams.includes(pickedTeamFilter) ? pickedTeamFilter : ALL);
  const moveTo = $derived(validTier(pickedMoveTo, ''));

  const tierName = (key: string) => draft.tiers.find((tier) => tier.key === key)?.name ?? key;
  const visible = $derived(
    draft.contents.filter((content) => {
      const reward = rewards.get(content.rewardDefinitionId);
      if (tierFilter !== ALL && content.tierKey !== tierFilter) return false;
      if (teamFilter !== ALL && reward?.team !== null && reward?.team !== teamFilter) return false;
      return true;
    })
  );
  const allVisibleSelected = $derived(
    visible.length > 0 && visible.every((c) => selected.has(c.rewardDefinitionId))
  );

  function toggleAll() {
    if (allVisibleSelected) for (const c of visible) selected.delete(c.rewardDefinitionId);
    else for (const c of visible) selected.add(c.rewardDefinitionId);
  }
  function forSelected(apply: (content: BoxDraft['contents'][number]) => void) {
    for (const content of draft.contents) if (selected.has(content.rewardDefinitionId)) apply(content);
  }
  function removeSelected() {
    draft.contents = draft.contents.filter((c) => !selected.has(c.rewardDefinitionId));
    selected.clear();
  }

  let pickedAddEvent = $state('');
  let addIds = $state('');
  let pickedAddTier = $state('');
  const addEvent = $derived(pickedAddEvent && pickedAddEvent === draft.event ? pickedAddEvent : '');
  const addTier = $derived(validTier(pickedAddTier, ''));
  let adding = $state(false);
  let addError = $state<string | null>(null);
  let addResult = $state<string | null>(null);

  async function addRewards() {
    adding = true;
    addError = null;
    addResult = null;
    try {
      const params = new URLSearchParams(addEvent ? { event: addEvent } : { cosmeticIds: addIds });
      const response = await fetch(`/items/boxes/${boxId}/rewards?${params}`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `Lookup failed (${response.status}).`);
      const found = body as { rewards: RewardInfo[]; undefinedCosmetics: number };
      const inBox = new Set(draft.contents.map((c) => c.rewardDefinitionId));
      let added = 0;
      let skipped = 0;
      for (const reward of found.rewards) {
        rewards.set(reward.id, reward);
        if (inBox.has(reward.id) || reward.type !== ITEM_TYPE.cosmetic) {
          skipped += 1;
          continue;
        }
        draft.contents.push({ id: null, rewardDefinitionId: reward.id, tierKey: addTier, enabled: true });
        inBox.add(reward.id);
        added += 1;
      }
      addResult =
        `Added ${added} to ${tierName(addTier)}.` +
        (skipped ? ` ${skipped} already in the box or not a cosmetic.` : '') +
        (found.undefinedCosmetics
          ? ` ${found.undefinedCosmetics} cosmetics have no item definition yet; create them on Item Definitions.`
          : '');
      addIds = '';
    } catch (e) {
      addError = e instanceof Error ? e.message : 'Lookup failed.';
    } finally {
      adding = false;
    }
  }
</script>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-3 text-base font-semibold text-white">Contents</h2>

  <div class="mb-4 rounded-lg border border-dark-4 p-3">
    <h3 class="mb-2 text-sm font-semibold text-white">Add rewards</h3>
    <div class="grid gap-2 md:grid-cols-[1fr_1fr_160px_auto] md:items-end">
      <div>
        <label class="text-xs text-dark-2" for="add-event">Every cosmetic of an event</label>
        <Select.Root
          type="single"
          bind:value={() => addEvent || NO_EVENT, (v) => (pickedAddEvent = v === NO_EVENT ? '' : v)}
        >
          <Select.Trigger id="add-event" class="mt-1 w-full">{addEvent || 'No event'}</Select.Trigger>
          <Select.Content>
            <Select.Item value={NO_EVENT}>No event</Select.Item>
            {#if draft.event}
              <Select.Item value={draft.event}>{draft.event}</Select.Item>
            {/if}
          </Select.Content>
        </Select.Root>
      </div>
      <div>
        <label class="text-xs text-dark-2" for="add-ids">Or cosmetic ids</label>
        <Input id="add-ids" class="mt-1" disabled={!!addEvent} bind:value={addIds} placeholder="101, 102" />
      </div>
      <div>
        <label class="text-xs text-dark-2" for="add-tier">Into tier</label>
        <Select.Root type="single" bind:value={() => addTier, (v) => (pickedAddTier = v)}>
          <Select.Trigger id="add-tier" class="mt-1 w-full">{addTier ? tierName(addTier) : 'Pick a tier'}</Select.Trigger>
          <Select.Content>
            {#each draft.tiers as tier (tier.key)}
              <Select.Item value={tier.key}>{tier.name}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
      <Button
        variant="outline"
        disabled={adding || !addTier || (!addEvent && !addIds.trim())}
        onclick={addRewards}
      >
        Add
      </Button>
    </div>
    {#if addError}
      <ErrorAlert class="mt-2" message={addError} />
    {/if}
    {#if addResult}
      <p class="mt-2 text-xs text-dark-0">{addResult}</p>
    {/if}
  </div>

  <div class="mb-2 flex flex-wrap items-center gap-2">
    <Select.Root type="single" bind:value={() => tierFilter, (v) => (pickedTierFilter = v)}>
      <Select.Trigger class="w-40">{tierFilter === ALL ? 'Every tier' : tierName(tierFilter)}</Select.Trigger>
      <Select.Content>
        <Select.Item value={ALL}>Every tier</Select.Item>
        {#each draft.tiers as tier (tier.key)}
          <Select.Item value={tier.key}>{tier.name}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
    {#if teams.length}
      <Select.Root type="single" bind:value={() => teamFilter, (v) => (pickedTeamFilter = v)}>
        <Select.Trigger class="w-40">{teamFilter === ALL ? 'Every team' : teamFilter}</Select.Trigger>
        <Select.Content>
          <Select.Item value={ALL}>Every team</Select.Item>
          {#each teams as team (team)}
            <Select.Item value={team}>{team}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    {/if}
    <span class="text-xs text-dark-2">{visible.length} of {draft.contents.length}</span>
  </div>

  {#if selected.size}
    <div class="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-dark-4 p-2">
      <span class="text-sm text-dark-0">{selected.size} selected</span>
      <Select.Root type="single" bind:value={() => moveTo, (v) => (pickedMoveTo = v)}>
        <Select.Trigger class="w-40">{moveTo ? tierName(moveTo) : 'Move to tier'}</Select.Trigger>
        <Select.Content>
          {#each draft.tiers as tier (tier.key)}
            <Select.Item value={tier.key}>{tier.name}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      <Button size="sm" variant="outline" disabled={!moveTo} onclick={() => forSelected((c) => (c.tierKey = moveTo))}>
        Move
      </Button>
      <Button size="sm" variant="outline" onclick={() => forSelected((c) => (c.enabled = true))}>Enable</Button>
      <Button size="sm" variant="outline" onclick={() => forSelected((c) => (c.enabled = false))}>Disable</Button>
      <Button size="sm" variant="destructive" onclick={removeSelected}>Remove</Button>
      <Button size="sm" variant="ghost" onclick={() => selected.clear()}>Clear</Button>
    </div>
  {/if}

  {#if draft.contents.length === 0}
    <p class="text-sm text-dark-2">Nothing in the box yet.</p>
  {:else}
    <div class="max-h-[32rem] overflow-y-auto">
      <table class="w-full text-sm">
        <thead class="sticky top-0 bg-dark-6 text-left text-xs text-dark-2">
          <tr>
            <th class="w-8 py-1">
              <Checkbox
                aria-label="Select all shown"
                bind:checked={() => allVisibleSelected, () => toggleAll()}
              />
            </th>
            <th>Reward</th>
            <th>Team</th>
            <th>Tier</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {#if visible.length === 0}
            <tr><td colspan="5" class="py-2 text-sm text-dark-2">Nothing matches these filters.</td></tr>
          {/if}
          {#each visible as content (content.rewardDefinitionId)}
            {@const reward = rewards.get(content.rewardDefinitionId)}
            <tr class="border-t border-dark-4">
              <td class="py-1">
                <Checkbox
                  aria-label="Select"
                  bind:checked={
                    () => selected.has(content.rewardDefinitionId),
                    () =>
                      selected.has(content.rewardDefinitionId)
                        ? selected.delete(content.rewardDefinitionId)
                        : selected.add(content.rewardDefinitionId)
                  }
                />
              </td>
              <td>
                <div class="flex items-center gap-2">
                  {#if reward?.imageUrl}
                    <EdgeMedia src={reward.imageUrl} width={64} alt="" class="size-7 rounded object-contain" />
                  {/if}
                  <span class={content.enabled ? 'text-dark-0' : 'text-dark-2 line-through'}>
                    {reward?.name ?? `#${content.rewardDefinitionId}`}
                  </span>
                  {#if reward && reward.type !== ITEM_TYPE.cosmetic}
                    <Badge variant="destructive">{reward.type}</Badge>
                  {/if}
                </div>
              </td>
              <td class="text-dark-2">{reward?.team ?? 'every team'}</td>
              <td class="text-dark-2">{tierName(content.tierKey)}</td>
              <td class="text-dark-2">
                {content.enabled ? 'on' : 'off'}{content.id === null ? ' · new' : ''}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>
