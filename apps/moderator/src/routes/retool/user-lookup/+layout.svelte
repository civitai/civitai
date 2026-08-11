<script lang="ts">
  import { page } from '$app/state';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import LookupSearch from '$lib/components/LookupSearch.svelte';
  import { LINK_CLASS } from '$lib/format';
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
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
    {#if identity.bannedAt}
      <!-- Retool's "Banned for CSAM" was its own chip. The reason decides what a moderator does next —
           a Nudify ban and a SexualMinor ban are not the same conversation — so it rides on the badge
           rather than sitting one section away under Admin. -->
      <Badge variant="destructive">
        banned{identity.banReason ? `: ${identity.banReason}` : ''}
      </Badge>
      {#if identity.banReason?.startsWith('SexualMinor')}
        <Badge variant="destructive">CSAM ban</Badge>
      {/if}
    {/if}
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
    <!-- The rest of Retool's persistent header: prior enforcement, what they pay, and how to reach
         them. Each was section-local, so judging an account meant visiting three tabs first. -->
    {#if data.result?.strikes.count}
      <Badge variant="destructive">
        {data.result.strikes.count} active strike{data.result.strikes.count > 1 ? 's' : ''}
        ({data.result.strikes.points} pt{data.result.strikes.points > 1 ? 's' : ''})
      </Badge>
    {/if}
    <!-- Retool-era strikes are a DIFFERENT table that the live strike system never writes. Shown apart
         so the two are not read as one number. -->
    {#if data.result?.legacyStrikeCount}
      <Badge variant="secondary">{data.result.legacyStrikeCount} legacy</Badge>
    {/if}
    {#if data.result?.subscription?.productName}
      <!-- Status is carried, not assumed: a cancelled subscription must not read as a paying one. -->
      <Badge variant="secondary">
        {data.result.subscription.productName}{data.result.subscription.status === 'active'
          ? ''
          : ` (${data.result.subscription.status})`}
      </Badge>
    {/if}
    {#if data.result?.modContact.chats}
      <Badge variant="secondary">
        spoke with a mod ×{data.result.modContact.chats}
      </Badge>
    {/if}
    {#if identity.browsingLevel}
      <Badge variant="secondary">Viewing: {getBrowsingLevelLabel(identity.browsingLevel)}</Badge>
    {/if}
    {#if identity.email}
      <span class="text-xs text-dark-2">{identity.email}</span>
    {/if}
  </div>

  <!-- The ticket asked for open reports "very clearly at the top", and actionable from here. A report
       nobody has ruled on changes what every other panel on this page means. -->
  <!-- Retool's Copy pair. "Copy Retool URL" has no meaning in the app that replaces Retool, so the
       useful half is ported: the account's public profile, and a link to this lookup that a moderator
       can paste into a ticket or a thread. `?q=` is the whole address of a lookup. -->
  {#if identity}
    <div class="mb-2 flex flex-wrap items-center justify-end gap-3 text-xs">
      {#if profileUrl}
        <button
          type="button"
          class={LINK_CLASS}
          onclick={() => navigator.clipboard?.writeText(profileUrl)}
        >
          Copy profile URL
        </button>
      {/if}
      <button
        type="button"
        class={LINK_CLASS}
        onclick={() =>
          navigator.clipboard?.writeText(
            `${location.origin}/retool/user-lookup/${current}?q=${identity.id}`
          )}
      >
        Copy lookup URL
      </button>
    </div>
  {/if}

  <!-- Retool kept Force Logout in the persistent header, not one section away: it is the thing you
       reach for while reading something else. `?/forceLogout` resolves against the current section
       route, which defines the action, so this works from every section. Sessions only — it does not
       mute, ban or change the account. -->
  {#if data.canAct && identity}
    <form
      method="POST"
      action="?/forceLogout"
      use:enhance
      class="mb-4 flex justify-end"
    >
      <input type="hidden" name="userId" value={identity.id} />
      <Button type="submit" size="xs" variant="outline">Force logout</Button>
    </form>
  {/if}

  {#if identity.openReportCount > 0}
    <div
      class="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-200"
      role="status"
    >
      <span>
        {identity.openReportCount} open report{identity.openReportCount > 1 ? 's' : ''} against this
        account.
      </span>
      <a href="/reports/user?status=Pending&status=Processing" class={LINK_CLASS}>
        Triage in the report queue
      </a>
    </div>
  {/if}

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
