<script lang="ts">
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import type { BoxDraft } from '$lib/mystery-box';

  let {
    draft = $bindable(),
    events,
    teams,
  }: { draft: BoxDraft; events: { event: string }[]; teams: string[] } = $props();

  const NO_EVENT = '__none';

  function setArt(team: string, side: 'closed' | 'open', value: string) {
    const art = { ...draft.art[team], [side]: value.trim() || undefined };
    if (!art.closed && !art.open) delete draft.art[team];
    else draft.art[team] = art;
  }
</script>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-3 text-base font-semibold text-white">Details</h2>
  <div class="grid gap-3 md:grid-cols-2">
    <div>
      <label class="text-sm text-dark-2" for="box-name">Name</label>
      <Input id="box-name" class="mt-1" bind:value={draft.name} />
    </div>
    <div>
      <label class="text-sm text-dark-2" for="box-event">Event</label>
      <Select.Root
        type="single"
        bind:value={() => draft.event || NO_EVENT, (v) => (draft.event = v === NO_EVENT ? '' : v)}
      >
        <Select.Trigger id="box-event" class="mt-1 w-full">{draft.event || 'No event'}</Select.Trigger>
        <Select.Content>
          <Select.Item value={NO_EVENT}>No event</Select.Item>
          {#each events as { event } (event)}
            <Select.Item value={event}>{event}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      <p class="mt-1 text-xs text-dark-2">
        An event box is sold under the event's rules, and each buyer draws only from their team's
        cosmetics.
      </p>
    </div>
    <div class="md:col-span-2">
      <label class="text-sm text-dark-2" for="box-description">Description</label>
      <Textarea id="box-description" class="mt-1" rows={2} bind:value={draft.description} />
    </div>
    <div class="md:col-span-2">
      <label class="text-sm text-dark-2" for="box-image">Image url</label>
      <Input id="box-image" class="mt-1" bind:value={draft.imageUrl} placeholder="https://" />
    </div>
    <div>
      <span class="text-sm text-dark-2">When nothing is left for its holder</span>
      <p class="mt-1 text-sm text-dark-0">The box stays held until new contents arrive.</p>
    </div>
  </div>

  {#if teams.length}
    <h3 class="mt-4 mb-2 text-sm font-semibold text-white">Box art per team</h3>
    <p class="mb-2 text-xs text-dark-2">Image urls. A team with none gets a gift box in its colour.</p>
    <div class="space-y-2">
      {#each teams as team (team)}
        <div class="grid items-center gap-2 md:grid-cols-[100px_1fr_1fr]">
          <span class="text-sm text-dark-0">{team}</span>
          <Input
            aria-label="{team} closed"
            placeholder="Closed"
            bind:value={() => draft.art[team]?.closed ?? '', (v) => setArt(team, 'closed', v ?? '')}
          />
          <Input
            aria-label="{team} open"
            placeholder="Open"
            bind:value={() => draft.art[team]?.open ?? '', (v) => setArt(team, 'open', v ?? '')}
          />
        </div>
      {/each}
    </div>
  {/if}
</section>
