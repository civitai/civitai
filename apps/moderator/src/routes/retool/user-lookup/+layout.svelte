<script lang="ts">
  import { page } from '$app/state';
  import { cn } from '@civitai/ui/utils.js';
  import LookupSearch from '$lib/components/LookupSearch.svelte';
  import UserCard from '$lib/components/user-card/UserCard.svelte';
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import type { LayoutData } from './$types';
  import { ADMIN_SECTIONS, DEFAULT_SECTION, SECTIONS, SECTION_LINKS } from './sections';

  let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

  const current = $derived(page.params.section);

  // Every nav link carries the search term — it is the subject of the whole page, and dropping it on
  // a section change would land the moderator on an empty lookup.
  const href = (slug: string) =>
    data.q ? `/retool/user-lookup/${slug}?q=${encodeURIComponent(data.q)}` : `/retool/user-lookup/${slug}`;
</script>

<header class="page-header">
  <h1>User Lookup</h1>
  <p>Find a user by ID, username or email.</p>
</header>

<!-- `path` keeps the moderator on the section they are reading: searching a second account while
     looking at Reports should show that account's reports, not send them back to the top. -->
<LookupSearch
  q={data.q}
  placeholder="296765, username, or name@example.com"
  path="/retool/user-lookup/{current ?? DEFAULT_SECTION}"
/>

{#if data.notFound}
  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-dark-2">No user matches <code>{data.q}</code>.</p>
  </section>
{:else if data.result}
  <!-- The subject stays on screen in every section, so an action is never taken without the account
       it applies to being visible. -->
  <!-- Keyed: a `?q=` search does not remount the layout, and the card's open CSAM sheet would carry
       over to — and fetch for — the next account. -->
  {#key data.result.identity.id}
  <UserCard card={data.result} class="mb-4">
    {#snippet actions()}
      <!-- Retool kept Force Logout in the persistent header: it is the thing you reach for while
           reading something else. `?/forceLogout` resolves against the current section route, which
           defines the action, so this works from every section. Sessions only — it does not mute, ban
           or change the account. -->
      {#if data.canAct && data.result}
        <form method="POST" action="?/forceLogout" use:enhance>
          <input type="hidden" name="userId" value={data.result.identity.id} />
          <Button type="submit" size="xs" variant="outline">Force logout</Button>
        </form>
      {/if}
    {/snippet}
  </UserCard>
  {/key}

  <!-- A fixed-width pane here does not stack below `lg`; pinned by
       `src/__tests__/two-pane-stacking.test.ts`, which finds this container by `data-two-pane`
       and re-derives the width below.
       `lg` not `md`: the app sidebar is 16rem of FLOW width from 768px up, so `md` leaves 216px
       of content -- NARROWER than at 767px, where the sidebar is off-canvas. For scale, the
       sibling `audit/generator-restrictions` already sits at 280px at its own `lg`.
       No `items-*`: grid defaults to stretch, matching the flex row this replaced. The sibling
       DOES set `items-start`, and that divergence is deliberate. -->
  <div data-two-pane class="grid gap-6 lg:grid-cols-[14rem_1fr]">
    <nav data-pane class="min-w-0">
      <ul class="space-y-0.5">
        {#each SECTIONS as s (s.slug)}
          <li>
            <a
              href={href(s.slug)}
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

    <div data-pane class="min-w-0">
      {@render children()}
    </div>
  </div>
{/if}
