<script lang="ts">
  import { probabilityLabel, requesterTierLabel, versionedHref } from '$lib/decisions';
  import { userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const t = $derived(data.ticket);
  const requesterLabel = $derived(requesterTierLabel(t.memberTier, t.payingPriority));
  const href = (path: string) => versionedHref(path, data.version, data.overridden);
  const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(6)}`;
</script>

<header class="page-header">
  <h1>#{t.ticketId} {t.subject}</h1>
  <p class="text-dark-2">
    <a class={LINK_CLASS} href={t.ticketUrl} target="_blank" rel="noreferrer">Freshdesk ↗</a>
    · status {t.status} · created {dateTime(t.createdAt)}
  </p>
</header>

<p class="mb-4">
  {#if t.membership}
    <a class={LINK_CLASS} href={href(`/decisions/support/${t.membership.groupKey}`)}
      >← Group: {t.membership.title ?? t.membership.groupKey}</a
    >
  {:else}
    <a class={LINK_CLASS} href={href('/decisions')}>← All decisions</a>
  {/if}
</p>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
    <dt class="text-dark-2">Requester</dt>
    <dd>
      {#if t.civitaiUserId}
        user <a class={LINK_CLASS} href={userLookupUrl(t.civitaiUserId, 'basic')}>{t.civitaiUserId}</a>
      {:else}
        <span class="text-dark-2">no linked Civitai account</span>
      {/if}
      {#if requesterLabel}· {requesterLabel}{/if}
    </dd>
    {#if data.canSeeEmail}
      <dt class="text-dark-2">Email</dt>
      <dd>{t.requesterEmail || '—'}</dd>
    {/if}

    <dt class="text-dark-2">Topic</dt>
    <dd>{t.chosenTopic} · p {probabilityLabel(t.probabilities.topic)}</dd>

    <dt class="text-dark-2">Group</dt>
    <dd>
      {#if t.membership}
        <code>{t.membership.groupKey}</code>{t.membership.isFounder ? ' (founded by this ticket)' : ''}
      {:else}
        none in this version
      {/if}
      · p group {probabilityLabel(t.probabilities.group)} · p novel {probabilityLabel(t.probabilities.novel)}
    </dd>

    <dt class="text-dark-2">Novel gate</dt>
    <dd>
      {t.isNovel ? 'NOVEL — founded a new group' : 'not novel — joined an existing group'}
      <span class="text-dark-2">· novel when p novel is at or above the novel threshold, or p group is
        below the top-match threshold</span>
    </dd>

    <dt class="text-dark-2">Model</dt>
    <dd><code>{t.model || '—'}</code></dd>
    <dt class="text-dark-2">Question spec</dt>
    <dd><code>{t.questionSpecHash || '—'}</code></dd>
    <dt class="text-dark-2">Router version</dt>
    <dd><code>{t.routerVersion}</code></dd>
    <dt class="text-dark-2">Cost</dt>
    <dd>
      {num(t.inputTokens)} input tokens · {usd(t.costMicroUsd)} · {num(t.latencyMs)} ms · routed
      {dateTime(t.routedAt)}
    </dd>
  </dl>
</section>

<!-- 🔴 TEXT, NEVER `{@html}`, in every branch: a customer's own words, arriving through a third system.
     The Freshdesk version is converted to plain text server-side. -->
{#snippet stored(note: string)}
  <p class="text-dark-2 mb-2 text-xs">{note}</p>
  <p class="break-words whitespace-pre-wrap">{t.bodyExcerpt || '—'}</p>
{/snippet}

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-2 text-white">Ticket</h2>
  <p class="text-dark-2 mb-2 text-xs">
    Customer-written. The membership shown is the CURRENT assignment only — the router keeps no
    history of earlier ones.
  </p>
  {#await data.description}
    {@render stored('Showing the stored text while the formatted version loads from Freshdesk…')}
  {:then d}
    {#if d.status === 'found'}
      <p class="break-words whitespace-pre-wrap">{d.text}</p>
      {#if d.truncated}
        <p class="text-dark-2 mt-2 text-xs">Cut short here — the rest is in Freshdesk.</p>
      {/if}
    {:else}
      {@render stored(
        `Showing the stored text, which can lose its formatting and may be cut short — ${
          d.status === 'none' ? 'Freshdesk has no description for this ticket.' : d.reason
        }`
      )}
    {/if}
  {:catch}
    {@render stored(
      'Showing the stored text, which can lose its formatting and may be cut short — Freshdesk could not be read.'
    )}
  {/await}
</section>
