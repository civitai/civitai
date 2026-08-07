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
              <p class="text-sm text-dark-2">
                No address carries more than one account — nothing suggesting a ring.
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
