<script lang="ts">
  import type { Snippet } from 'svelte';
  import { untrack } from 'svelte';
  import { IconSearch } from '@tabler/icons-svelte';
  import { beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import TriageTabs from '$lib/components/triage/TriageTabs.svelte';
  import { carriedSearchParams } from '$lib/triage/filters';
  import { searchDebouncer, searchHref } from '$lib/triage/search-debounce';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  const q = $derived(page.url.searchParams.get('q') ?? '');
  // A plain GET form without JS: the tab's filters and sort ride along, while the page, the open item
  // and the old search describe the result set being replaced.
  const carried = $derived(carriedSearchParams(page.url.searchParams));

  // The box keeps what was typed while its own searches land; a search changed elsewhere (a "Clear
  // filters" link, back) replaces it.
  let value = $state(untrack(() => q));
  let sent = untrack(() => q);
  $effect(() => {
    const next = q;
    untrack(() => {
      if (next !== sent) value = sent = next;
    });
  });

  const search = searchDebouncer({
    delay: 300,
    current: () => sent,
    submit: (next) => {
      sent = next;
      void goto(searchHref(page.url, next), { keepFocus: true, noScroll: true, replaceState: true });
    },
  });
  // A pending search must not follow the moderator to another page or row. Its own navigation starts
  // after the pause has fired, so cancelling then drops nothing.
  beforeNavigate(() => search.cancel());
</script>

<!-- The root layout floats the sidebar trigger over this header (headerInline): pl-14 clears it and
     pt-2.5 centres the title's line on the trigger's 48px row. -->
<div class="flex flex-col lg:h-svh">
  <header class="flex flex-nowrap items-start justify-between gap-6 pt-2.5 pr-6 pl-14">
    <div class="min-w-0 flex-1">
      <h1 class="m-0 text-xl font-semibold text-white">Model Flags</h1>
      <p class="m-0 mt-0.5 text-[13px] text-dark-2">
        Minor and real-person flags on models. Tab = whether a flag is applied; chip = what found it.
      </p>
    </div>
    <form
      method="GET"
      class="relative w-[260px] shrink-0"
      onsubmit={(event) => {
        event.preventDefault();
        search.enter(value);
      }}
    >
      {#each carried as [name, val], i (`${name}:${i}`)}
        <input type="hidden" {name} value={val} />
      {/each}
      <IconSearch
        class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-dark-2"
        aria-hidden="true"
      />
      <Input
        name="q"
        bind:value
        oninput={() => search.input(value)}
        oncompositionstart={() => search.compositionStart()}
        oncompositionend={(event: CompositionEvent) =>
          search.compositionEnd((event.currentTarget as HTMLInputElement).value)}
        placeholder="Model name, id or uploader"
        aria-label="Search model flags"
        class="h-[30px] rounded-md border-dark-4 bg-dark-7 pl-8 text-[13px] placeholder:text-dark-2 dark:bg-dark-7"
      />
    </form>
  </header>

  <TriageTabs tabs={data.modelFlagTabs} current={page.url.pathname} label="Model Flags" />

  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
    {@render children()}
  </div>
</div>
