<script lang="ts">
  import type { Snippet } from 'svelte';
  import { IconSearch } from '@tabler/icons-svelte';
  import { page } from '$app/state';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Kbd } from '@civitai/ui/components/ui/kbd/index.js';
  import TriageTabs from '$lib/components/triage/TriageTabs.svelte';
  import { carriedSearchParams } from '$lib/triage/filters';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  const q = $derived(page.url.searchParams.get('q') ?? '');
  // A plain GET form: the tab's filters and sort ride along, while the page, the open item and the
  // old search describe the result set being replaced.
  const carried = $derived(carriedSearchParams(page.url.searchParams));
</script>

<div class="flex flex-col gap-3 pb-4 lg:h-[calc(100svh-3rem)]">
  <header class="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-6">
    <div class="min-w-0">
      <h1 class="m-0 text-2xl font-semibold text-white">Model Flags</h1>
      <p class="m-0 mt-1 text-sm text-dark-1">
        Minor and real-person flags on models: appeals, automation flags and file-match leads in one
        place.
      </p>
    </div>
    <div class="flex flex-wrap items-center gap-4">
      <!-- Keyed on q: the Input's value is bindable, so a one-way prop would latch on what was typed. -->
      {#key q}
        <form method="GET" class="relative w-72">
          {#each carried as [name, value], i (`${name}:${i}`)}
            <input type="hidden" {name} {value} />
          {/each}
          <IconSearch
            class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-dark-2"
            aria-hidden="true"
          />
          <Input
            name="q"
            value={q}
            placeholder="Model name, id or uploader"
            aria-label="Search model flags"
            class="h-9 pl-9 text-sm"
          />
        </form>
      {/key}
      <p class="m-0 flex items-center gap-1.5 text-sm text-dark-1">
        <Kbd>1</Kbd> flag stays <Kbd>2</Kbd> no flag <Kbd>J/K</Kbd> move
      </p>
    </div>
  </header>

  <TriageTabs tabs={data.modelFlagTabs} current={page.url.pathname} label="Model Flags" />

  <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6">
    {@render children()}
  </div>
</div>
