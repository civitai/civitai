<script lang="ts">
  import { page } from '$app/state';
  import { LINK_CLASS } from '$lib/format';
  import { urlWith } from '$lib/url';
  import { COMMENT_SPAM } from '$lib/comment-spam';
  import NewestList from './NewestList.svelte';
  import SpamList from './SpamList.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const isSpam = $derived(data.view === 'spam');
  // Links rather than `Tabs`: a moderator working a queue opens the other view in a second tab, and a
  // tab control cannot be middle-clicked. The filter boxes are dropped on the way across — the spam
  // query does not read them, so carrying them would show a URL asserting a filter nothing applied.
  const viewHref = (view: 'newest' | 'spam') =>
    urlWith(page.url, {
      view: view === 'newest' ? null : view,
      cursor: null,
      username: null,
      email: null,
    });
  const viewClass = (active: boolean) => (active ? 'text-white underline' : LINK_CLASS);
</script>

<header class="page-header">
  <h1>{isSpam ? 'Comment spam signature' : 'Newest users'}</h1>
  {#if isSpam}
    <p>
      Accounts that posted <strong>{COMMENT_SPAM.minComments}+ comments inside one hour</strong>
      within {COMMENT_SPAM.maxAccountAgeDays} days of signing up. Already-banned and deleted accounts are
      left out — this is a list of things to do.
    </p>
    <p class="mt-1 text-xs text-dark-2">
      The account's age is what makes this specific: measured over 90 days, that volume from an account
      under two days old was banned 98.9% of the time, and from an older account 1.2% of the time. Read
      from ClickHouse, so it still lists an account whose comments have already been deleted.
    </p>
  {:else}
    <p>
      Accounts by registration, newest first, read straight from the database — the site's own user
      search is Meilisearch-backed, so it lags behind registration and pages badly. For spotting a
      fresh spam ring or a ban evader coming back.
    </p>
  {/if}

  <nav class="mt-3 flex gap-3 text-sm">
    <a
      href={viewHref('newest')}
      aria-current={isSpam ? undefined : 'page'}
      class={viewClass(!isSpam)}>By registration</a
    >
    <a href={viewHref('spam')} aria-current={isSpam ? 'page' : undefined} class={viewClass(isSpam)}
      >Comment spam signature</a
    >
  </nav>
</header>

{#if isSpam}
  <SpamList {data} />
{:else}
  <NewestList {data} />
{/if}
