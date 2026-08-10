<script lang="ts">
  import { page } from '$app/state';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import LookupSearch from '$lib/components/LookupSearch.svelte';
  import { LINK_CLASS } from '$lib/format';
  import { userUrl } from '$lib/entity-url';
  import type { LayoutData } from './$types';
  import { ADMIN_SECTIONS, DEFAULT_SECTION, SECTIONS, SECTION_LINKS } from './sections';

  let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

  const current = $derived(page.params.section);

  // Every nav link carries the search term — it is the subject of the whole page, and dropping it on
  // a section change would land the moderator on an empty lookup.
  const href = (slug: string) =>
    data.q ? `/retool/user-lookup/${slug}?q=${encodeURIComponent(data.q)}` : `/retool/user-lookup/${slug}`;

  const identity = $derived(data.result?.identity ?? null);
  const profileUrl = $derived(
    identity?.username ? userUrl(data.civitaiUrl, identity.username) : null
  );
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
    <!-- Retool put both of these in the persistent header. A CSAM report against the account is the
         single most important thing on the screen, and a Pending restriction is a SYSTEM mute nobody
         has ruled on — without it that account reads as an unexplained manual mute. -->
    {#if identity.csamReportCount > 0}
      <Badge variant="destructive">
        CSAM report{identity.csamReportCount > 1 ? ` ×${identity.csamReportCount}` : ''}
      </Badge>
    {/if}
    {#if identity.muted}<Badge variant="destructive">muted</Badge>{/if}
    {#if identity.restrictionStatus}
      <Badge variant={identity.restrictionStatus === 'Pending' ? 'destructive' : 'secondary'}>
        {identity.restrictionType ?? 'restriction'}: {identity.restrictionStatus}
      </Badge>
    {/if}
    <!-- Retool's Quick Info. Not accepting the TOS is normal for a new account and abnormal for an
         old one, and leaderboard exclusion is the first thing a cheating investigation asks about. -->
    {#if !identity.onboarding}<Badge variant="secondary">TOS not accepted</Badge>{/if}
    {#if identity.excludeFromLeaderboards}
      <Badge variant="secondary">excluded from leaderboards</Badge>
    {/if}
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
          <!-- Retool's sidebar puts Bulk Image Manager third. It leaves the page, carrying the account
               with it, so it renders in position rather than as a section of its own. -->
          {#if s.slug === 'socials' && data.result}
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

    <div class="min-w-0 flex-1">
      {@render children()}
    </div>
  </div>
{/if}
