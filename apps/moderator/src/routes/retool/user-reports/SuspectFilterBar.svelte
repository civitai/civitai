<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page as pageState } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { browsingLevels, browsingLevelLabels, NsfwLevel } from '@civitai/shared';
  import type { PageData } from './$types';

  let { filters }: { filters: PageData['filters'] } = $props();

  // 0 is not a browsing level — it is an image nothing has rated yet. Without a box of its own,
  // ticking every rating reads as "all images" and silently excludes them.
  const RATINGS: [number, string][] = [
    ...browsingLevels.map((l): [number, string] => [l, browsingLevelLabels[l]]),
    [NsfwLevel.Blocked, browsingLevelLabels[NsfwLevel.Blocked]],
    [0, 'Unrated'],
  ];

  // No local-mirror effect: the page's enhancer invalidates on every write, so an effect keyed on
  // `filters` would wipe half-typed filter edits whenever a report was claimed. The parent keys this
  // component on the URL instead, which is the only thing that actually changes the filters.
  let tos = $state(untrack(() => filters.tos));
  let noPrompt = $state(untrack(() => filters.noPrompt));
  let levels = $state(untrack(() => filters.levels));
  let from = $state(untrack(() => filters.from));
  let to = $state(untrack(() => filters.to));
  let prompt = $state(untrack(() => filters.prompt));
  let negativePrompt = $state(untrack(() => filters.negativePrompt));

  const active = $derived(
    tos || noPrompt || levels.length > 0 || !!from || !!to || !!prompt || !!negativePrompt
  );

  function apply(e?: SubmitEvent) {
    e?.preventDefault();
    const url = new URL(pageState.url);
    const set = (key: string, value: string) => {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    };
    set('tos', tos ? '1' : '');
    set('noPrompt', noPrompt ? '1' : '');
    set('levels', levels.join(','));
    set('from', from);
    set('to', to);
    set('prompt', prompt.trim());
    set('negativePrompt', negativePrompt.trim());
    // A cursor from the previous filter set points into a batch that no longer exists.
    url.searchParams.delete('cursor');
    goto(url.pathname + url.search, { keepFocus: true });
  }

  function clear() {
    tos = false;
    noPrompt = false;
    levels = [];
    from = '';
    to = '';
    prompt = '';
    negativePrompt = '';
    apply();
  }

  const toggleLevel = (level: number, checked: boolean) => {
    levels = checked ? [...levels, level] : levels.filter((l) => l !== level);
  };
</script>

<form
  onsubmit={apply}
  class="mb-4 flex flex-wrap items-end gap-x-5 gap-y-3 rounded-xl border border-dark-4 bg-dark-6 p-5"
>
  <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
    <div class="flex items-center gap-2">
      <Checkbox id="f-tos" bind:checked={tos} />
      <Label for="f-tos" class="cursor-pointer font-normal text-dark-0">Only ToS'd</Label>
    </div>
    <div class="flex items-center gap-2">
      <Checkbox id="f-noprompt" bind:checked={noPrompt} />
      <Label for="f-noprompt" class="cursor-pointer font-normal text-dark-0">No prompt</Label>
    </div>
  </div>

  <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
    <span class="text-xs tracking-wide text-dark-2 uppercase">Rating</span>
    {#each RATINGS as [level, label] (level)}
      <div class="flex items-center gap-1.5">
        <Checkbox
          id="f-level-{level}"
          checked={levels.includes(level)}
          onCheckedChange={(v) => toggleLevel(level, v)}
        />
        <Label for="f-level-{level}" class="cursor-pointer font-normal text-dark-0">{label}</Label>
      </div>
    {/each}
  </div>

  <div class="flex items-center gap-2">
    <!-- UTC, and said so: the input yields a bare date, which is compared against `createdAt` in UTC.
         A moderator ten hours ahead who reads it as local time gets an empty grid for "today". -->
    <Label for="f-from" class="font-normal text-dark-0">From (UTC)</Label>
    <Input id="f-from" type="date" bind:value={from} class="w-40" />
    <Label for="f-to" class="font-normal text-dark-0">To (UTC)</Label>
    <Input id="f-to" type="date" bind:value={to} class="w-40" />
  </div>

  <Input bind:value={prompt} aria-label="Search prompt" placeholder="Search prompt" class="w-52" />
  <Input
    bind:value={negativePrompt}
    aria-label="Search negative prompt"
    placeholder="Search negative prompt"
    class="w-52"
  />

  <div class="flex gap-2">
    <Button type="submit" size="sm">Apply</Button>
    {#if active}
      <Button type="button" size="sm" variant="outline" onclick={clear}>Clear</Button>
    {/if}
  </div>
</form>
