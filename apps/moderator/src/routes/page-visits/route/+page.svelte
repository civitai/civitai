<script lang="ts">
  import { IconArrowLeft } from '@tabler/icons-svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const numberFmt = new Intl.NumberFormat('en-US');
  const userLabel = (u: PageData['users'][number]) => u.username ?? `user #${u.userId}`;
</script>

<header class="page-header">
  <a href="/page-visits" class="mb-3 inline-flex items-center gap-1 text-sm text-dark-2 hover:text-dark-0">
    <IconArrowLeft size={15} /> All routes
  </a>
  <h1 class="font-mono !text-xl">{data.location}</h1>
  <p>
    {numberFmt.format(data.totalVisits)} visits by {data.users.length} moderators in the last {data.days}
    days.
  </p>
</header>

{#if data.users.length === 0}
  <div class="placeholder">No visits to this route in the window.</div>
{:else}
  <div class="overflow-hidden rounded-xl border border-dark-4 bg-dark-6">
    <table class="w-full text-sm">
      <thead>
        <tr class="border-b border-dark-4 text-left text-xs uppercase tracking-wider text-dark-3">
          <th class="px-4 py-3 font-semibold">Moderator</th>
          <th class="px-4 py-3 text-right font-semibold">Visits</th>
          <th class="px-4 py-3 font-semibold">Last visit</th>
        </tr>
      </thead>
      <tbody>
        {#each data.users as user (user.userId)}
          <tr class="border-b border-dark-7/60 last:border-0 hover:bg-white/5">
            <td class="px-4 py-2.5 text-dark-0">
              {userLabel(user)}
              <span class="ml-1 text-xs text-dark-3">#{user.userId}</span>
            </td>
            <td class="px-4 py-2.5 text-right tabular-nums text-dark-0">
              {numberFmt.format(Number(user.visits))}
            </td>
            <td class="px-4 py-2.5 font-mono text-xs text-dark-2">{user.lastVisit}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
