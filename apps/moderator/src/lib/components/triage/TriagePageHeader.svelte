<script lang="ts">
  import { untrack } from 'svelte';
  import { IconSearch } from '@tabler/icons-svelte';
  import { afterNavigate, beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { carriedSearchParams } from '$lib/triage/filters';
  import { searchDebouncer, searchHref } from '$lib/triage/search-debounce';

  let {
    title,
    subtitle,
    placeholder,
    searchLabel,
  }: {
    title: string;
    subtitle?: string;
    /** Both this and `searchLabel` render a search box that writes `?q=`; without them the page has none. */
    placeholder?: string;
    searchLabel?: string;
  } = $props();

  const q = $derived(page.url.searchParams.get('q') ?? '');
  // A plain GET form without JS: the filters and sort ride along, while the page, the open item
  // and the old search describe the result set being replaced.
  const carried = $derived(carriedSearchParams(page.url.searchParams));

  let value = $state(untrack(() => q));
  const search = searchDebouncer({
    delay: 300,
    current: () => page.url.searchParams.get('q') ?? '',
    submit: (next) => {
      void goto(searchHref(page.url, next), { keepFocus: true, noScroll: true, replaceState: true });
    },
  });
  beforeNavigate(() => search.cancel());
  afterNavigate(({ to }) => {
    if (!search.pending()) value = to?.url.searchParams.get('q') ?? '';
  });
</script>

<!-- The root layout floats the sidebar trigger over this header (headerInline): pl-14 clears it and
     pt-2.5 centres the title's line on the trigger's 48px row. -->
<header class="flex flex-nowrap items-start justify-between gap-6 pt-2.5 pr-6 pb-3 pl-14">
  <div class="min-w-0 flex-1">
    <h1 class="m-0 text-xl font-semibold text-white">{title}</h1>
    {#if subtitle}<p class="m-0 mt-0.5 text-[13px] text-dark-2">{subtitle}</p>{/if}
  </div>
  {#if placeholder && searchLabel}
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
        oninput={(event: Event) => search.input((event.currentTarget as HTMLInputElement).value)}
        oncompositionstart={() => search.compositionStart()}
        oncompositionend={(event: CompositionEvent) =>
          search.compositionEnd((event.currentTarget as HTMLInputElement).value)}
        {placeholder}
        aria-label={searchLabel}
        class="h-[30px] rounded-md border-dark-4 bg-dark-7 pl-8 text-[13px] placeholder:text-dark-2 dark:bg-dark-7"
      />
    </form>
  {/if}
</header>
