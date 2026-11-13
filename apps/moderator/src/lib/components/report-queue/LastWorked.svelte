<script lang="ts">
  import * as Popover from '@civitai/ui/components/ui/popover/index.js';
  import { sidebarLastActioned } from '$lib/sidebar-counts.svelte';
  import { minuteClock } from '$lib/minute-clock.svelte';
  import { reportCountKey, type ReportEntity } from '$lib/reports';
  import { LAST_ACTIONED_WINDOW_DAYS } from '$lib/queue-thresholds';
  import { dateTime, num, shortAge } from '$lib/format';

  let { entity }: { entity: ReportEntity } = $props();

  const lastActioned = sidebarLastActioned();
  const clock = minuteClock();
  const last = $derived(lastActioned.value?.[reportCountKey(entity)]);

  // Fetched on each open, so it is never older than the click.
  let open = $state(false);
  const workers = $derived(
    open
      ? fetch(`/api/report-queue-workers?type=${entity}`).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<{ by: string | null; at: string; count: number }[]>;
        })
      : null
  );
</script>

<!-- Nothing until the lookup lands: a missing entry means "nobody in the window", which is not yet known. -->
{#if lastActioned.value}
  <p class="m-0 text-[13px] text-dark-2">
    {#if last}
      Last worked by <span class="text-dark-0">{last.by ?? 'an unknown moderator'}</span>,
      <time datetime={last.at} title={dateTime(last.at)}>{shortAge(last.at, clock.now)} ago</time>
      <Popover.Root bind:open>
        <Popover.Trigger class="ml-1 text-primary hover:underline">History</Popover.Trigger>
        <Popover.Content align="start" class="w-[min(22rem,calc(100vw-2rem))] p-3">
          <p class="mb-2 text-xs text-dark-2">
            Moderators who reviewed these reports in the last {LAST_ACTIONED_WINDOW_DAYS} days. A report
            counts for whoever set its status last.
          </p>
          {#if workers}
            {#await workers}
              <p class="text-sm text-dark-2">Loading…</p>
            {:then rows}
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-left text-xs text-dark-2">
                    <th class="pb-1 font-normal">Moderator</th>
                    <th class="pb-1 font-normal">Last worked</th>
                    <th class="pb-1 text-right font-normal">Reviewed</th>
                  </tr>
                </thead>
                <tbody>
                  {#each rows as row, i (`${row.by}:${i}`)}
                    <tr>
                      <td class="py-0.5 text-dark-0">{row.by ?? 'unknown'}</td>
                      <td class="py-0.5 text-dark-2">
                        <time datetime={row.at} title={dateTime(row.at)}>
                          {shortAge(row.at, clock.now)} ago
                        </time>
                      </td>
                      <td class="py-0.5 text-right text-dark-2">{num(row.count)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {:catch}
              <p class="text-sm text-red-300">Could not load the history.</p>
            {/await}
          {/if}
        </Popover.Content>
      </Popover.Root>
    {:else}
      No moderator action in {LAST_ACTIONED_WINDOW_DAYS} days
    {/if}
  </p>
{/if}
