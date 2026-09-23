<script lang="ts">
  import * as Table from '@civitai/ui/components/ui/table/index.js';
  import {
    ADOPTION_DESCRIPTION,
    ADOPTION_KINDS,
    ADOPTION_LABEL,
  } from '$lib/monetization/admin-channels';
  import type { AdoptionRow } from '$lib/server/admin/monetization-overview';

  let { adoption }: { adoption: AdoptionRow[] | null } = $props();

  const num = (n: number) => n.toLocaleString();

  // Ordered by the vocabulary, not by what the read returned, so a row with no activity holds its place.
  const rows = $derived(
    ADOPTION_KINDS.map((kind) => ({ kind, row: adoption?.find((a) => a.kind === kind) ?? null }))
  );
</script>

<section class="cs-panel mb-6 p-4">
  <div class="mb-3">
    <p class="m-0 text-sm font-medium text-white">Monetization settings in use</p>
    <p class="m-0 text-xs text-dark-2">
      A snapshot of what is set right now — not affected by the selected period. Deleted models are
      excluded; drafts are not.
    </p>
  </div>

  {#if !adoption}
    <p class="placeholder">Settings counts are unavailable right now.</p>
  {:else}
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head class="w-full">Setting</Table.Head>
          <Table.Head class="w-px text-right">Versions</Table.Head>
          <Table.Head class="w-px text-right">Models</Table.Head>
          <Table.Head class="w-px text-right">Creators</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each rows as { kind, row } (kind)}
          <Table.Row>
            <Table.Cell>
              <div class="text-white">{ADOPTION_LABEL[kind]}</div>
              <div class="text-xs text-dark-2">{ADOPTION_DESCRIPTION[kind]}</div>
            </Table.Cell>
            <Table.Cell class="w-px whitespace-nowrap text-right tabular-nums text-white">
              {num(row?.versions ?? 0)}
            </Table.Cell>
            <Table.Cell class="w-px whitespace-nowrap text-right tabular-nums text-dark-1">
              {num(row?.models ?? 0)}
            </Table.Cell>
            <Table.Cell class="w-px whitespace-nowrap text-right tabular-nums text-dark-1">
              {num(row?.creators ?? 0)}
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
    <p class="mt-3 text-xs text-dark-2">
      A version can appear on more than one row — a licensing fee, a gate and a donation goal are
      independent of each other.
    </p>
  {/if}
</section>
