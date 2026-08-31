<script lang="ts">
  import { userLookupUrl } from '$lib/entity-url';
  import ShowMoreButton from '$lib/components/ShowMoreButton.svelte';
  import { browser } from '$app/environment';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { fetchImageSignals } from './image-signals';

  // `deleted` flips the emphasis: on that path the lifecycle log IS the answer, so it leads and the
  // clustering half — which cannot run without the image's createdAt as a bound — steps aside.
  let { imageId, deleted = false }: { imageId: number; deleted?: boolean } = $props();

  const SHOWN = 10;
  let expandedEvents = $state(false);

  // Off the page load: ~200-400ms of ClickHouse work against 825M and 8.2M row tables.
  const signals = $derived(browser ? fetchImageSignals(imageId) : null);
</script>

{#snippet checking()}
  <p class="text-sm text-dark-2">
    {deleted ? 'Loading the lifecycle log…' : 'Checking reaction sources…'}
  </p>
{/snippet}

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">
    {deleted ? 'Lifecycle log' : 'Reaction sources & history'}
  </h3>
  <p class="mb-3 text-xs text-dark-2">
    {#if deleted}
      Every recorded event for this image, including the removal that took it out of the database.
    {:else}
      Addresses carrying more than one reacting account, and the image's lifecycle events. Internal
      traffic excluded.
    {/if}
  </p>

  {#await signals}
    {@render checking()}
  {:then result}
    {#if !result}
      {@render checking()}
    {:else}
      {@const events = result.events.rows}
      {@const visible = expandedEvents ? events : events.slice(0, SHOWN)}
      <div class="grid gap-5 {result.reactions ? 'lg:grid-cols-2' : ''}">
        {#if result.reactions}
          {@const reactions = result.reactions}
          <div>
            <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">
              Shared addresses ({reactions.clusters.length}{reactions.truncated ? '+' : ''})
            </h4>
            <p class="mb-2 text-xs text-dark-2">
              {num(reactions.totalReactions)} reactions from {num(reactions.distinctIps)} addresses.
            </p>
            {#if reactions.clusters.length === 0}
              <!-- An affirmative negative has to say what it looked at. This set is narrowed three ways
                   the reader cannot see — reactions given (not withdrawn), external addresses only, and
                   from the image's creation onward — so "nothing suggesting a ring" alone overstates it. -->
              <p class="text-sm text-dark-2">
                No address carries more than one account.
                <span class="text-xs">
                  Counts reactions given from external addresses since the image was posted; an account
                  reacting from many addresses is not a shape this looks for.
                </span>
              </p>
            {:else}
              <ul class="space-y-2 text-sm">
                {#each reactions.clusters as cluster (cluster.ip)}
                  <li>
                    <div class="flex flex-wrap items-baseline gap-x-2">
                      <code class="text-dark-0">{cluster.ip}</code>
                      <Badge variant="destructive">
                        {cluster.accounts.length} accounts · {num(cluster.reactions)} reactions
                      </Badge>
                    </div>
                    <div class="mt-0.5 flex flex-wrap gap-x-2 text-xs">
                      {#each cluster.accounts as acct (acct.userId)}
                        <a href={userLookupUrl(acct.userId)} class={LINK_CLASS}>
                          {acct.username ?? `#${acct.userId}`}{acct.bannedAt ? ' (banned)' : ''}
                        </a>
                      {/each}
                    </div>
                  </li>
                {/each}
              </ul>
              {#if reactions.truncated}
                <p class="mt-2 text-xs text-amber-300">
                  Capped — more shared addresses exist than are shown.
                </p>
              {/if}
            {/if}
          </div>
        {/if}

        <div>
          <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">
            Lifecycle events ({events.length}{result.events.truncated ? '+' : ''})
          </h4>
          {#if events.length === 0}
            <p class="text-sm text-dark-2">No recorded events.</p>
          {:else}
            <ul class="space-y-1 text-sm">
              {#each visible as e (e.key)}
                <li class="flex flex-wrap items-baseline gap-x-2">
                  <Badge variant={e.type.startsWith('Delete') ? 'destructive' : 'secondary'}>
                    {e.type}
                  </Badge>
                  <span class="text-xs text-dark-2">{dateTime(e.time)}</span>
                  {#if e.violationType}
                    <span class="text-dark-0">{e.violationType}</span>
                  {/if}
                  {#if e.tosReason}
                    <span class="text-xs text-dark-2">{e.tosReason}</span>
                  {/if}
                  <!-- Both were already fetched and shipped to the client, and neither reached the
                       DOM: on a deleted image this row IS the record of who removed it and why. -->
                  {#if e.userId}
                    <a href={userLookupUrl(e.userId)} class="text-xs {LINK_CLASS}">by #{e.userId}</a>
                  {/if}
                  {#if e.violationDetails}
                    <span class="w-full wrap-break-word text-xs text-dark-2">
                      {e.violationDetails}
                    </span>
                  {/if}
                  {#if e.tags}
                    <span class="w-full wrap-break-word text-xs text-dark-2">tags: {e.tags}</span>
                  {/if}
                  {#if e.resources}
                    <span class="w-full wrap-break-word text-xs text-dark-2">
                      resources: {e.resources}
                    </span>
                  {/if}
                  {#if e.nsfw || (e.ownerId && e.ownerId !== e.userId) || e.via || e.ip}
                    <span class="w-full text-xs text-dark-2">
                      <!-- The deprecated four-value vocabulary (None/Soft/Mature/X/Blocked), NOT the
                           browsing-level bitmask the rest of this app speaks — and its `X` is not
                           today's X. Labelled so a 2024 event is not read as a current rating. -->
                      {#if e.nsfw}legacy rating {e.nsfw}{/if}
                      <!-- Owner at the time, shown only when it is not the actor: after a transfer the
                           current Image.userId is a different account from the one that held it here. -->
                      {#if e.ownerId && e.ownerId !== e.userId}
                        owned by
                        <a href={userLookupUrl(e.ownerId)} class={LINK_CLASS}>#{e.ownerId}</a>
                      {/if}
                      {#if e.via && e.via !== 'web'}via {e.via}{/if}
                      <!-- The ACTOR's address, not the uploader's — on a Delete/Restore row that is a
                           moderator. Unlabelled beside the owner link, a ban-evasion hunt reads it as
                           the account's own. -->
                      {#if e.ip}from {e.ip}{/if}
                    </span>
                  {/if}
                  {#if e.userAgent}
                    <span class="w-full truncate text-xs text-dark-2" title={e.userAgent}>
                      {e.userAgent}
                    </span>
                  {/if}
                </li>
              {/each}
            </ul>
            <ShowMoreButton
              total={events.length}
              shown={SHOWN}
              expanded={expandedEvents}
              capped={result.events.truncated}
              onToggle={() => (expandedEvents = !expandedEvents)}
            />
            {#if result.events.truncated}
              <!-- ORDER BY time DESC keeps the newest, so what falls off is the OLDEST — on a
                   re-deleted image that is the original removal, which is the thing being looked for. -->
              <p class="mt-2 text-xs text-amber-300">
                Capped — events older than these exist and are not shown.
              </p>
            {/if}
          {/if}
        </div>
      </div>
    {/if}
  {:catch}
    <p class="text-sm text-red-300">Could not load the lifecycle log.</p>
  {/await}
</section>
