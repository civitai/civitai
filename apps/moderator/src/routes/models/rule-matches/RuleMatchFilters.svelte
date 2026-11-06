<script lang="ts">
  import { IconChevronDown } from '@tabler/icons-svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as DropdownMenu from '@civitai/ui/components/ui/dropdown-menu/index.js';
  import TriageFilterChips, {
    type ChipGroup,
  } from '$lib/components/triage/TriageFilterChips.svelte';
  import {
    DEFAULT_MODEL_RULE_HOLD_FILTERS,
    MODEL_RULE_HOLD_MODES,
    MODEL_RULE_HOLD_MODE_LABELS,
    MODEL_RULE_HOLD_SORTS,
    MODEL_RULE_HOLD_SORT_LABELS,
    MODEL_RULE_HOLD_STATUSES,
    MODEL_RULE_HOLD_STATUS_LABELS,
    type ModelRuleHoldFilters,
  } from '$lib/model-rule-holds';
  import { urlWith } from '$lib/url';

  let {
    filters,
    pendingCount,
    rules,
  }: {
    filters: ModelRuleHoldFilters;
    pendingCount: number | null;
    rules: { id: number; subject: string; count: number }[];
  } = $props();

  const SELECTION = 'hold';

  const modeGroup = $derived({
    key: 'mode',
    label: 'Mode',
    values: MODEL_RULE_HOLD_MODES,
    labels: MODEL_RULE_HOLD_MODE_LABELS,
    active: filters.mode,
    defaultValue: DEFAULT_MODEL_RULE_HOLD_FILTERS.mode,
  } satisfies ChipGroup);
  const statusGroup = $derived({
    key: 'status',
    label: 'Status',
    values: MODEL_RULE_HOLD_STATUSES,
    labels: MODEL_RULE_HOLD_STATUS_LABELS,
    active: filters.status,
    defaultValue: DEFAULT_MODEL_RULE_HOLD_FILTERS.status,
    counts: pendingCount === null ? undefined : { pending: pendingCount },
  } satisfies ChipGroup);
  const sortGroup = $derived({
    key: 'sort',
    label: 'Sort',
    values: MODEL_RULE_HOLD_SORTS,
    labels: MODEL_RULE_HOLD_SORT_LABELS,
    active: filters.sort,
    defaultValue: DEFAULT_MODEL_RULE_HOLD_FILTERS.sort,
  } satisfies ChipGroup);

  // The rule in use stays pickable and visible even when the other filters leave it with no holds.
  const activeRule = $derived(rules.find((rule) => rule.id === filters.rule));
  const ruleHref = (rule: number | null) =>
    urlWith(page.url, { rule, page: null, [SELECTION]: null });
</script>

<div class="flex flex-col gap-1.5">
  <TriageFilterChips groups={[modeGroup]} selectionParam={SELECTION} />
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
    <TriageFilterChips status={statusGroup} selectionParam={SELECTION} />
    <TriageFilterChips sort={sortGroup} selectionParam={SELECTION} />
    {#if rules.length || filters.rule !== null}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="ghost"
              size="sm"
              class="h-auto max-w-64 gap-1 px-1 py-[3px] text-xs font-normal text-dark-2 hover:bg-transparent hover:text-white"
            >
              <span class="truncate">
                Rule: {filters.rule === null
                  ? 'all'
                  : activeRule?.subject ?? `#${filters.rule}`}
              </span>
              <IconChevronDown class="size-3 shrink-0" aria-hidden="true" />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="start" class="max-h-80 overflow-y-auto">
          <DropdownMenu.Item
            onSelect={() => goto(ruleHref(null), { noScroll: true, keepFocus: true })}
          >
            All rules
          </DropdownMenu.Item>
          {#each rules as rule (rule.id)}
            <DropdownMenu.Item
              onSelect={() => goto(ruleHref(rule.id), { noScroll: true, keepFocus: true })}
            >
              <span class="truncate">{rule.subject}</span>
              <span class="ml-auto pl-3 text-dark-2 tabular-nums">{rule.count}</span>
            </DropdownMenu.Item>
          {/each}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/if}
  </div>
</div>
