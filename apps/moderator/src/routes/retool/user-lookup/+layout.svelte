<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import { LINK_CLASS } from '$lib/format';
  import { userUrl } from '$lib/entity-url';
  import type { LayoutData } from './$types';
  import { ADMIN_SECTIONS, SECTIONS } from './sections';

  let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

  // Local copy so typing doesn't navigate; re-synced whenever a search lands (incl. back/forward).
  let term = $state(untrack(() => data.q));
  $effect(() => {
    term = data.q;
  });

  const current = $derived(page.params.section);

  // Every nav link carries the search term — it is the subject of the whole page, and dropping it on
  // a section change would land the moderator on an empty lookup.
  const href = (slug: string) =>
    data.q ? `/retool/user-lookup/${slug}?q=${encodeURIComponent(data.q)}` : `/retool/user-lookup/${slug}`;

  const search = (e: SubmitEvent) => {
    e.preventDefault();
    const value = term.trim();
    // Stay on the section being viewed: searching a second account while looking at Reports should
    // show that account's reports, not send you back to the top.
    const section = current ?? SECTIONS[0].slug;
    goto(value ? `/retool/user-lookup/${section}?q=${encodeURIComponent(value)}` : `/retool/user-lookup/${section}`, {
      keepFocus: true,
    });
  };

  const identity = $derived(data.result?.identity ?? null);
  const profileUrl = $derived(
    identity?.username ? userUrl(data.civitaiUrl, identity.username) : null
  );
</script>

<header class="page-header">
  <h1>User Lookup</h1>
  <p>Find a user by ID, username or email.</p>
</header>

<form onsubmit={search} class="mb-6 flex max-w-xl gap-2">
  <Input bind:value={term} placeholder="296765, username, or name@example.com" class="flex-1" />
  <Button type="submit">Search</Button>
</form>

{#if data.notFound}
  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-dark-2">No user matches <code>{data.q}</code>.</p>
  </section>
{:else if identity}
  <!-- The subject stays on screen in every section, so an action is never taken without the account
       it applies to being visible. -->
  <div class="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-xl border border-dark-4 bg-dark-6 px-5 py-3">
    <h2 class="text-lg font-semibold text-white">
      {#if profileUrl}
        <a href={profileUrl} target="_blank" rel="noreferrer" class={LINK_CLASS}>
          {identity.username}
        </a>
      {:else}
        (no username)
      {/if}
    </h2>
    <code class="text-sm text-dark-2">#{identity.id}</code>
    {#if identity.bannedAt}<Badge variant="destructive">banned</Badge>{/if}
    {#if identity.muted}<Badge variant="destructive">muted</Badge>{/if}
    {#if identity.deletedAt}<Badge variant="secondary">deleted</Badge>{/if}
    {#if identity.isModerator}<Badge variant="secondary">moderator</Badge>{/if}
    {#if data.result?.curator.isCurator}<Badge variant="secondary">curator</Badge>{/if}
  </div>

  <div class="flex gap-6">
    <nav class="w-56 shrink-0">
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

    <div class="min-w-0 flex-1">
      {@render children()}
    </div>
  </div>
{/if}
