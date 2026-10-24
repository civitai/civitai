<script lang="ts">
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { dateTime } from '$lib/format';
  import type { PageAccessChange } from '$lib/server/page-access';

  let {
    changes,
    historyError,
  }: {
    changes: (PageAccessChange & { actorName: string | null })[];
    historyError: string | null;
  } = $props();

  const roleList = (roles: string[]) =>
    roles.map((role) => role.replace('moderator:', '')).join(', ') || 'nobody';
  const TH = 'py-2 pl-4 text-left text-xs tracking-wide text-dark-2 uppercase';
</script>

<h2 class="mt-6 mb-2 text-sm font-semibold text-white">Recent changes</h2>
<p class="mb-3 text-sm text-dark-2">
  A change marked <em>unconfirmed</em> was recorded but never confirmed as written or refused: check the
  grant above before relying on it.
</p>
{#if historyError}
  <ErrorAlert message={historyError} />
{:else if changes.length}
  <div class="overflow-x-auto rounded-xl border border-dark-4 bg-dark-6">
    <table class="w-full min-w-xl text-sm">
      <caption class="sr-only">Recent permission grant changes</caption>
      <thead>
        <tr class="border-b border-dark-4">
          <th scope="col" class={TH}>When</th>
          <th scope="col" class={TH}>Who</th>
          <th scope="col" class={TH}>Grant</th>
          <th scope="col" class={TH}>Before → after</th>
          <th scope="col" class="{TH} pr-4">Via</th>
        </tr>
      </thead>
      <tbody>
        {#each changes as c (c.id)}
          <tr class="border-t border-dark-4 align-top">
            <td class="py-2 pl-4 text-dark-2">{dateTime(c.at)}</td>
            <td class="py-2 pl-4 text-dark-0">{c.actorName ?? `#${c.actorId}`}</td>
            <td class="py-2 pl-4 text-dark-0"><code>{c.path}</code></td>
            <td class="py-2 pl-4">
              {roleList(c.before)} → {roleList(c.after)}
              {#if c.reason}<div class="text-dark-2">{c.reason}</div>{/if}
            </td>
            <td class="py-2 pr-4 pl-4">
              {c.via === 'api' ? 'API' : 'Admin page'}
              {#if c.gateRef}<div class="break-all text-dark-2">{c.gateRef}</div>{/if}
              {#if c.outcome === 'pending'}
                <div class="text-red-300">unconfirmed</div>
              {:else if c.outcome === 'refused'}
                <div class="text-dark-2">refused, not written</div>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else}
  <p class="text-sm text-dark-2">No changes recorded yet.</p>
{/if}
