<script lang="ts">
  import { Avatar, AvatarFallback } from '@civitai/ui/components/ui/avatar/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { describeChange, groupByDay, type AuditRow } from './audit';
  import { longDay } from './shop-view';

  let {
    rows,
    onopenitem = null,
  }: {
    rows: readonly AuditRow[];
    /** Omit on one item's own history, where the item name is already the title. */
    onopenitem?: ((id: number) => void) | null;
  } = $props();

  const groups = $derived(groupByDay(rows));
  const time = (value: Date | string) => `${new Date(value).toISOString().slice(11, 16)} UTC`;
  const who = (row: AuditRow) => row.moderatorUsername ?? `user #${row.moderatorId}`;
</script>

<div class="flex flex-col gap-6">
  {#each groups as group (group.day)}
    <section>
      <h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-dark-2">
        {longDay(group.day)}
      </h3>
      <ol class="ml-3.5 flex flex-col gap-5 border-l border-dark-4">
        {#each group.rows as row (row.id)}
          {@const described = describeChange(row)}
          <li class="relative pl-6">
            <Avatar class="absolute -left-3.5 top-0 size-7 ring-4 ring-dark-6">
              <AvatarFallback class="text-xs">
                {who(row).replace(/^user #/, '#').charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <p class="text-sm text-dark-0">
              <span class="font-medium text-white">{who(row)}</span>
              {described.verb}
              {#if onopenitem}
                <button
                  type="button"
                  class="text-blue-4 hover:underline"
                  onclick={() => onopenitem(row.itemId)}>{row.itemName}</button
                >
              {:else}
                this item
              {/if}
              <span class="ml-1 text-xs text-dark-2">{time(row.createdAt)}</span>
            </p>
            {#if described.chips.length}
              <div class="mt-1.5 flex flex-wrap gap-1.5">
                {#each described.chips as chip (chip.field)}
                  <Badge variant="outline" class="h-auto py-0.5 font-normal">
                    <span class="text-dark-2">{chip.field}</span>
                    {#if chip.from !== null}
                      <span class="text-dark-2">{chip.from} →</span>
                    {/if}
                    <span class="text-dark-0">{chip.to}</span>
                  </Badge>
                {/each}
              </div>
            {/if}
          </li>
        {/each}
      </ol>
    </section>
  {/each}
</div>
