<script lang="ts">
  import { page } from '$app/state';
  import { afterNavigate } from '$app/navigation';
  import { cn } from '@civitai/ui/utils.js';
  import LookupSearch from '$lib/components/LookupSearch.svelte';
  import InvestigateButton from '$lib/components/InvestigateButton.svelte';
  import UserCard from '$lib/components/user-card/UserCard.svelte';
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import type { LayoutData } from './$types';
  import {
    FEEDBACK_CAPTURE_ACCOUNT_NOTE,
    isFeedbackCaptureOwner,
  } from '@civitai/shared/feedback-capture';
  import { ADMIN_SECTIONS, DEFAULT_SECTION, SECTIONS, SECTION_LINKS } from './sections';

  let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

  const current = $derived(page.params.section);

  // From `lg` this region scrolls instead of the window, and SvelteKit resets only the window. A new
  // section or account starts at the top; paging within one keeps its place.
  let content = $state<HTMLElement>();
  afterNavigate(({ from, to }) => {
    if (!from || !to) return;
    const moved =
      from.url.pathname !== to.url.pathname ||
      from.url.searchParams.get('q') !== to.url.searchParams.get('q');
    if (moved) content?.scrollTo(0, 0);
  });

  // Every nav link carries the search term — it is the subject of the whole page, and dropping it on
  // a section change would land the moderator on an empty lookup.
  const href = (slug: string) =>
    data.q ? `/retool/user-lookup/${slug}?q=${encodeURIComponent(data.q)}` : `/retool/user-lookup/${slug}`;
</script>

<!-- `lg` not `md`: the app sidebar is 16rem of FLOW width from 768px up, so `md` leaves too little
     content width; pinned by `src/__tests__/two-pane-stacking.test.ts`. -->
<div data-two-pane class="flex flex-col lg:grid lg:h-svh lg:grid-cols-[16rem_1fr]">
  <aside data-pane class="flex min-w-0 flex-col border-dark-4 lg:min-h-0 lg:border-r">
    <div class="shrink-0 border-b border-dark-4 px-4 pt-2.5 pb-4">
      <h1 class="m-0 pl-10 md:pl-0 text-xl font-semibold text-white">User Lookup</h1>
      <p class="m-0 mt-0.5 mb-3 pl-10 md:pl-0 text-[13px] text-dark-2">By ID, username or email.</p>
      <!-- `path` keeps the moderator on the section they are reading: searching a second account while
           looking at Reports should show that account's reports, not send them back to the top. -->
      <LookupSearch
        q={data.q}
        placeholder="ID, username or email"
        path="/retool/user-lookup/{current ?? DEFAULT_SECTION}"
        class="mb-0"
      />
    </div>

    {#if data.result}
      <nav aria-label="User sections" class="px-2 py-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        <ul class="space-y-0.5">
          {#each SECTIONS as s (s.slug)}
            <li>
              <a
                href={href(s.slug)}
                aria-current={current === s.slug ? 'page' : undefined}
                class={cn(
                  'block rounded-md px-3 py-1.5 text-sm',
                  current === s.slug ? 'bg-dark-4 text-white' : 'text-dark-2 hover:bg-dark-5 hover:text-dark-0'
                )}
              >
                {s.label}
              </a>
            </li>
            <!-- Retool's sidebar puts Bulk Image Manager third. It leaves the page, carrying the account
                 with it, so it renders in position rather than as a section of its own.
                 Anchored to a slug that is IN `SECTIONS`: it was pinned to `socials`, and retiring that
                 section silently removed the only render site this link has. -->
            {#if s.slug === 'basic' && data.result}
              <li>
                <a
                  href={SECTION_LINKS['bulk-image-manager'].href(data.result.identity.id)}
                  class="block rounded-md px-3 py-1.5 text-sm text-dark-2 hover:bg-dark-5 hover:text-dark-0"
                >
                  {SECTION_LINKS['bulk-image-manager'].label} ↗
                </a>
              </li>
            {/if}
          {/each}
        </ul>

        <ul class="mt-4 space-y-0.5 border-t border-dark-4 pt-4">
          {#each ADMIN_SECTIONS as s (s.slug)}
            <li>
              <a
                href={href(s.slug)}
                aria-current={current === s.slug ? 'page' : undefined}
                class={cn(
                  'block rounded-md px-3 py-1.5 text-sm',
                  current === s.slug ? 'bg-dark-4 text-white' : 'text-dark-2 hover:bg-dark-5 hover:text-dark-0'
                )}
              >
                {s.label}
              </a>
            </li>
          {/each}
        </ul>
      </nav>
    {/if}
  </aside>

  <div data-pane class="flex min-w-0 flex-col lg:min-h-0">
    {#if data.notFound}
      <section class="m-6 rounded-xl border border-dark-4 bg-dark-6 p-5">
        <p class="text-sm text-dark-2">No user matches <code>{data.q}</code>.</p>
      </section>
    {:else if data.result}
      <!-- Outside the scrolling region, so from `lg` an action is never taken without the account it
           applies to in view. -->
      <header class="shrink-0 border-b border-dark-4">
        {#if isFeedbackCaptureOwner(data.result.identity.id)}
          <div
            class="mx-6 mt-3 rounded-md border border-sky-500/40 bg-sky-500/10 px-4 py-2 text-sm text-sky-200"
            role="note"
          >
            {FEEDBACK_CAPTURE_ACCOUNT_NOTE}
          </div>
        {/if}
        <!-- Keyed: a `?q=` search does not remount the layout, and the card's open CSAM sheet would
             carry over to — and fetch for — the next account. -->
        {#key data.result.identity.id}
          <UserCard
            card={data.result}
            class="rounded-none border-0 bg-transparent px-6 py-3"
          >
            {#snippet actions()}
              <!-- Retool kept Force Logout in the persistent header: it is the thing you reach for while
                   reading something else. `?/forceLogout` resolves against the current section route,
                   which defines the action, so this works from every section. Sessions only — it does
                   not mute, ban or change the account. -->
              {#if data.canAct && data.result}
                <form method="POST" action="?/forceLogout" use:enhance>
                  <input type="hidden" name="userId" value={data.result.identity.id} />
                  <Button type="submit" size="xs" variant="outline">Force logout</Button>
                </form>
              {/if}
              {#if data.canInvestigate && data.result}
                <InvestigateButton userId={data.result.identity.id} />
              {/if}
            {/snippet}
          </UserCard>
        {/key}
      </header>

      <!-- `relative`: SelectionBar bounds itself by its nearest relative ancestor, which keeps it to
           this region rather than spanning the section nav. -->
      <div bind:this={content} class="relative min-h-0 flex-1 px-6 pt-4 pb-10 lg:overflow-y-auto">
        {@render children()}
      </div>
    {:else}
      <p class="m-6 text-sm text-dark-2">Search for a user to see their account.</p>
    {/if}
  </div>
</div>
