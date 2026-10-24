<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import {
    Table,
    TableBody,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import { SvelteSet } from 'svelte/reactivity';
  import LinkTabs from '$lib/components/LinkTabs.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { num } from '$lib/format';
  import { ruleMatchesText } from '$lib/model-rules';
  import type { ModelRuleView } from '$lib/server/model-rules.service';
  import type { RuleDraftsState } from '$lib/text-scan-lab/rule-drafts';
  import { urlWith } from '$lib/url';
  import type { PageData } from './$types';
  import { notifySaved } from './notify-saved';
  import RuleHistoryDrawer from './RuleHistoryDrawer.svelte';
  import RuleRow from './RuleRow.svelte';

  let {
    rules,
    dismissals,
    drafts,
    query,
    canEdit,
    url,
  }: {
    rules: ModelRuleView[];
    dismissals: Record<number, number>;
    drafts: RuleDraftsState;
    query: PageData['query'];
    canEdit: boolean;
    url: URL;
  } = $props();

  const expanded = new SvelteSet<number>();
  let historyRuleId = $state<number | null>(null);

  const shown = $derived(
    rules.filter(
      (rule) =>
        (query.status === 'all' || rule.enabled === (query.status === 'enabled')) &&
        ruleMatchesText(rule, query.q)
    )
  );
  const newIds = $derived(drafts.ids.filter((id) => id < 0));
  const payload = $derived(drafts.saveAllPayload(rules));

  const STATUSES = [
    { value: 'all', label: 'All' },
    { value: 'enabled', label: 'Enabled' },
    { value: 'disabled', label: 'Disabled' },
  ] as const;
  const statusItems = $derived(
    STATUSES.map(({ value, label }) => ({
      value,
      label,
      href: urlWith(url, { status: value === 'all' ? null : value }),
    }))
  );

  const dropSaved = (data: Record<string, unknown> | undefined) =>
    drafts.drop(((data?.saved as { draftId: number }[] | undefined) ?? []).map((s) => s.draftId));
  const saveAll = new FormState({
    reload: true,
    reset: false,
    onSuccess: (data) => {
      dropSaved(data);
      notifySaved(data);
    },
    onSettled: (result) => {
      if (result.type !== 'failure') return;
      dropSaved(result.data);
      if ((result.data?.saved as unknown[] | undefined)?.length) void invalidateAll();
    },
  });

  const reloaded = (id: number) => rules.find((rule) => rule.id === id);
  const toggleRow = (id: number) => (expanded.has(id) ? expanded.delete(id) : expanded.add(id));
  function addRule() {
    expanded.add(drafts.add());
  }
</script>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-4">
  <div class="mb-3 flex flex-wrap items-end gap-3">
    <form method="GET" class="flex items-end gap-2">
      <input type="hidden" name="tab" value="rules" />
      {#if query.status !== 'all'}<input type="hidden" name="status" value={query.status} />{/if}
      <Input
        name="q"
        value={query.q}
        placeholder="Search subject, aliases, description"
        class="w-64"
        aria-label="Search rules"
      />
      <Button type="submit" variant="outline" size="sm">Search</Button>
    </form>
    <LinkTabs items={statusItems} active={query.status} />
    <span class="text-sm text-dark-2">{num(shown.length)} of {num(rules.length)}</span>
    <div class="ml-auto flex gap-2">
      <Button size="sm" variant="outline" onclick={addRule}>Add rule</Button>
      {#if canEdit}
        <form method="POST" action="?/saveAll" use:enhance={saveAll.enhance}>
          <input type="hidden" name="rules" value={JSON.stringify(payload)} />
          <Button type="submit" size="sm" disabled={!payload.length || saveAll.submitting}>
            {saveAll.submitting
              ? 'Saving…'
              : `Save all${payload.length ? ` (${payload.length})` : ''}`}
          </Button>
        </form>
      {/if}
    </div>
  </div>
  {#if saveAll.error}
    <p class="mb-3 whitespace-pre-wrap text-sm text-red-300">{saveAll.error}</p>
  {/if}

  {#if !shown.length && !newIds.length}
    <p class="text-sm text-dark-2">
      {rules.length ? 'No rules match these filters.' : 'No model rules yet.'}
    </p>
  {:else}
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Subject</TableHead>
          <TableHead>Aliases</TableHead>
          <TableHead class="text-right">Enabled</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each newIds as id (id)}
          <RuleRow
            rule={null}
            dismissed={0}
            draftId={id}
            {drafts}
            {canEdit}
            expanded={expanded.has(id)}
            ontoggle={() => toggleRow(id)}
            onhistory={() => {}}
            {reloaded}
          />
        {/each}
        {#each shown as rule (rule.id)}
          <RuleRow
            {rule}
            dismissed={dismissals[rule.id] ?? 0}
            draftId={rule.id}
            {drafts}
            {canEdit}
            expanded={expanded.has(rule.id)}
            ontoggle={() => toggleRow(rule.id)}
            onhistory={() => (historyRuleId = rule.id)}
            {reloaded}
          />
        {/each}
      </TableBody>
    </Table>
  {/if}
</section>

<RuleHistoryDrawer
  bind:ruleId={historyRuleId}
  subject={historyRuleId === null ? null : reloaded(historyRuleId)?.subject ?? null}
  {canEdit}
/>
