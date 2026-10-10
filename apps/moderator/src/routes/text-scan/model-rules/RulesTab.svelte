<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import LinkTabs from '$lib/components/LinkTabs.svelte';
  import { dateTime, num } from '$lib/format';
  import { urlWith } from '$lib/url';
  import RuleEditor from './RuleEditor.svelte';
  import type { PageData } from './$types';

  type Rules = NonNullable<PageData['rules']>;

  let {
    rules,
    total,
    query,
    canEdit,
    url,
    form,
    editorOpen = $bindable(false),
  }: {
    rules: Rules;
    total: number;
    query: PageData['query'];
    canEdit: boolean;
    url: URL;
    form: { error?: string } | null | undefined;
    editorOpen?: boolean;
  } = $props();

  let editingId = $state<number | 'new' | null>(null);
  let toggling = $state(false);

  // Derived from the list so an editor never shows a row the reloaded list no longer holds.
  const editingRule = $derived(
    typeof editingId === 'number' ? rules.find((r) => r.id === editingId) : undefined
  );

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

  $effect(() => {
    editorOpen = editingId === 'new' || !!editingRule;
  });

  $effect(() => {
    if (typeof editingId === 'number' && !editingRule) editingId = null;
  });
</script>

<div class="mb-3 flex flex-wrap items-end gap-3">
  <form method="GET" class="flex items-end gap-2">
    <input type="hidden" name="tab" value="rules" />
    {#if query.status !== 'all'}<input type="hidden" name="status" value={query.status} />{/if}
    <Input
      name="q"
      value={query.q}
      placeholder="Search subject, aliases, description"
      class="w-72"
      aria-label="Search rules"
    />
    <Button type="submit" variant="outline" size="sm">Search</Button>
  </form>

  <LinkTabs items={statusItems} active={query.status} />

  <span class="text-sm text-dark-2">{num(rules.length)} of {num(total)}</span>

  {#if canEdit}
    <Button class="ml-auto" size="sm" onclick={() => (editingId = 'new')}>New rule</Button>
  {/if}
</div>

{#if editingId === 'new' || editingRule}
  {#key editingId}
    <RuleEditor rule={editingRule ?? null} {form} onclose={() => (editingId = null)} />
  {/key}
{/if}

{#if rules.length === 0}
  <p class="text-sm text-dark-2">No rules match.</p>
{:else}
  <div class="rounded-xl border border-dark-4 bg-dark-6">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Id</TableHead>
          <TableHead>Subject</TableHead>
          <TableHead>Description</TableHead>
          <TableHead>Aliases</TableHead>
          <TableHead>Last edited</TableHead>
          <TableHead class="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each rules as rule (rule.id)}
          <TableRow class={cn(!rule.enabled && 'opacity-60')}>
            <TableCell class="align-top tabular-nums">{rule.id}</TableCell>
            <TableCell class="max-w-56 whitespace-normal align-top">
              <div class="break-words font-medium text-white">{rule.subject}</div>
              <div class="mt-1 flex flex-wrap gap-1">
                <Badge variant={rule.enabled ? 'default' : 'secondary'}>
                  {rule.enabled ? 'Enabled' : 'Disabled'}
                </Badge>
                {#if rule.needsAttention}<Badge variant="destructive">Needs attention</Badge>{/if}
                {#if rule.legacy}<Badge variant="outline">Regex</Badge>{/if}
              </div>
              {#if rule.legacyMatch}
                <details class="mt-2 text-xs text-dark-2">
                  <summary class="cursor-pointer">Legacy regex</summary>
                  <pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all">{rule.legacyMatch}</pre>
                </details>
              {/if}
            </TableCell>
            <TableCell class="max-w-72 whitespace-normal align-top text-dark-0">
              <p class="break-words">{rule.description || '—'}</p>
              {#if rule.note && rule.note !== rule.description}
                <p class="mt-1 break-words text-xs text-dark-2">Note: {rule.note}</p>
              {/if}
            </TableCell>
            <TableCell class="max-w-64 whitespace-normal break-words align-top text-dark-0">
              {rule.aliases.length ? rule.aliases.join(', ') : '—'}
            </TableCell>
            <TableCell class="whitespace-normal align-top text-xs text-dark-2">
              {rule.editedBy ?? (rule.editedById ? `User ${rule.editedById}` : '—')}
              <div>{dateTime(rule.updatedAt)}</div>
            </TableCell>
            <TableCell class="align-top">
              {#if canEdit}
                <div class="flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={rule.legacy}
                    title={rule.legacy ? 'Convert the regex rules first' : undefined}
                    onclick={() => (editingId = rule.id)}
                  >
                    Edit
                  </Button>
                  <form
                    method="POST"
                    action="?/toggle"
                    use:enhance={({ cancel }) => {
                      if (toggling) {
                        cancel();
                        return;
                      }
                      toggling = true;
                      return async ({ update }) => {
                        try {
                          await update();
                        } finally {
                          toggling = false;
                        }
                      };
                    }}
                  >
                    <input type="hidden" name="id" value={rule.id} />
                    <input type="hidden" name="enabled" value={String(!rule.enabled)} />
                    <Button type="submit" size="sm" variant="outline" disabled={toggling}>
                      {rule.enabled ? 'Disable' : 'Enable'}
                    </Button>
                  </form>
                </div>
              {/if}
            </TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  </div>
{/if}
