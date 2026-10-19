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
  const KBD = 'h-[15px] min-w-[15px] rounded border border-dark-4 bg-dark-6 px-1 text-[11px] font-semibold text-dark-0';
</script>

<!-- The root layout floats the sidebar trigger over this header (headerInline): pl-14 clears it and
     pt-2.5 centres the title's line on the trigger's 48px row. -->
<div class="flex flex-col lg:h-svh">
  <header class="flex flex-nowrap items-start justify-between gap-6 pt-2.5 pr-6 pl-14">
    <div class="min-w-0 flex-1">
      <h1 class="m-0 text-xl font-semibold text-white">Model Flags</h1>
      <p class="m-0 mt-0.5 text-[13px] text-dark-2">
        Minor and real-person flags on models: appeals, automation flags and file-match leads in one
        place.
      </p>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <!-- Keyed on q: the Input's value is bindable, so a one-way prop would latch on what was typed. -->
      {#key q}
        <form method="GET" class="relative w-[260px]">
          {#each carried as [name, value], i (`${name}:${i}`)}
            <input type="hidden" {name} {value} />
          {/each}
          <IconSearch
            class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-dark-2"
            aria-hidden="true"
          />
          <Input
            name="q"
            value={q}
            placeholder="Model name, id or uploader"
            aria-label="Search model flags"
            class="h-[30px] rounded-md border-dark-4 bg-dark-7 pl-8 text-[13px] placeholder:text-dark-2 dark:bg-dark-7"
          />
        </form>
      {/key}
      <p class="m-0 flex items-center gap-1 text-xs whitespace-nowrap text-dark-2">
        <Kbd class={KBD}>1</Kbd> flag stays <Kbd class="{KBD} ml-1.5">2</Kbd> no flag
        <Kbd class="{KBD} ml-1.5">J/K</Kbd> move
      </p>
    </div>
  </header>

  <TriageTabs tabs={data.modelFlagTabs} current={page.url.pathname} label="Model Flags" />

  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
    {@render children()}
  </div>
</div>
