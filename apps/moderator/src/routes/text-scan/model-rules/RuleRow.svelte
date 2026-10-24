<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { TableCell, TableRow } from '@civitai/ui/components/ui/table/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import ConfirmButton from '$lib/components/ConfirmButton.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { dateTime, plural } from '$lib/format';
  import {
    DEFAULT_MODEL_RULE_HOLD_FILTERS,
    MODEL_RULE_MATCHES_PATH,
    modelRuleHoldFilterParams,
  } from '$lib/model-rule-holds';
  import { BROAD_ALIAS_WARNING, aliasBreadth, appendAliases, parseAliases } from '$lib/model-rules';
  import type { ModelRuleView } from '$lib/server/model-rules.service';
  import { EMPTY, type RuleDraftsState, type RuleFields } from '$lib/text-scan-lab/rule-drafts';
  import { notifySaved } from './notify-saved';
  import SuggestAliases from './SuggestAliases.svelte';

  let {
    rule,
    dismissed,
    draftId,
    drafts,
    canEdit,
    expanded,
    ontoggle,
    onhistory,
    reloaded,
  }: {
    rule: ModelRuleView | null;
    /** Holds dismissed as "not this subject" that matched this rule. */
    dismissed: number;
    draftId: number;
    drafts: RuleDraftsState;
    canEdit: boolean;
    expanded: boolean;
    ontoggle: () => void;
    onhistory: () => void;
    /** The rule as the page now holds it: this row unmounts when a filter hides the toggled rule. */
    reloaded: (id: number) => ModelRuleView | undefined;
  } = $props();

  const fields = $derived<RuleFields>(rule ? drafts.fields(rule) : (drafts.get(draftId) ?? EMPTY));
  const draft = $derived(drafts.get(draftId));
  const stale = $derived(rule ? drafts.isStale(rule) : false);
  const readonly = $derived(!!rule?.legacy);
  const aliasList = $derived(parseAliases(fields.aliases));
  const broadAliases = $derived(aliasList.filter((alias) => aliasBreadth(alias) !== null));
  const dismissedHref = $derived(
    rule
      ? `${MODEL_RULE_MATCHES_PATH}?${new URLSearchParams(
          modelRuleHoldFilterParams({
            ...DEFAULT_MODEL_RULE_HOLD_FILTERS,
            status: 'dismissed',
            rule: rule.id,
          })
        )}`
      : null
  );
  // Saving a flagged rule unchanged is how a person marks it reviewed.
  const canSave = $derived(!!draft || !!rule?.needsAttention);

  function update(patch: Partial<RuleFields>) {
    const next = { ...fields, ...patch };
    if (rule) drafts.edit(rule, next);
    else drafts.editNew(draftId, next);
  }

  const save = new FormState({
    reload: true,
    reset: false,
    onSuccess: (data) => {
      drafts.drop([draftId]);
      // A save clears what a refused Enable said: "review and save first".
      toggle.error = null;
      notifySaved(data);
    },
  });
  // Rebase: the toggle bumps updatedAt, which would flag the open draft as stale.
  let toggledFrom: ModelRuleView | null = null;
  const toggle = new FormState({
    reload: true,
    reset: false,
    onSubmit: () => {
      toggledFrom = rule;
    },
    onSuccess: (data) => {
      const after = toggledFrom && reloaded(toggledFrom.id);
      if (toggledFrom && after) drafts.rebaseOwnWrite(toggledFrom, after);
      toggledFrom = null;
      notifySaved(data);
    },
  });

  const discardWhat = $derived(rule ? `your edits to “${rule.subject}”` : 'this new rule');

  function discard() {
    drafts.drop([draftId]);
  }
</script>

<TableRow class={cn(rule && !rule.enabled && 'opacity-70', expanded && 'border-b-0')}>
  <TableCell class="max-w-72 whitespace-normal align-top">
    <button
      type="button"
      class="flex w-full flex-wrap items-center gap-2 text-left"
      aria-expanded={expanded}
      onclick={ontoggle}
    >
      <span class="break-words font-medium text-white">{fields.subject || 'New rule'}</span>
      {#if draft}<span class="text-xs text-amber-300">● unsaved</span>{/if}
      {#if !rule}<Badge variant="outline">New</Badge>{/if}
      {#if rule?.needsAttention}
        <Badge variant="destructive">Needs attention — not scanned</Badge>
      {/if}
      {#if rule?.legacy}<Badge variant="outline">Regex</Badge>{/if}
    </button>
    {#if dismissed && dismissedHref}
      <a
        href={dismissedHref}
        class="mt-1 inline-block"
        title="Holds a moderator dismissed as “not this subject” that matched this rule. A rule that over-matches usually needs a fuller alias. The link lists every dismissal of this rule."
      >
        <Badge variant="outline">{plural(dismissed, 'dismissal')}</Badge>
      </a>
    {/if}
  </TableCell>
  <TableCell class="max-w-80 whitespace-normal break-words align-top text-dark-0">
    {aliasList.length ? aliasList.join(', ') : '—'}
  </TableCell>
  <TableCell class="align-top">
    <div class="flex flex-wrap items-center justify-end gap-2">
      {#if rule}
        <Badge variant={rule.enabled ? 'default' : 'secondary'}>
          {rule.enabled ? 'Enabled' : 'Disabled'}
        </Badge>
        {#if canEdit}
          <form method="POST" action="?/toggle" use:enhance={toggle.enhance}>
            <input type="hidden" name="id" value={rule.id} />
            <input type="hidden" name="enabled" value={String(!rule.enabled)} />
            <Button
              type="submit"
              size="xs"
              variant="outline"
              disabled={toggle.submitting || (!rule.enabled && rule.needsAttention)}
              title={!rule.enabled && rule.needsAttention
                ? 'Review and save this rule first (Edit, then Save as reviewed).'
                : undefined}
            >
              {rule.enabled ? 'Disable' : rule.needsAttention ? 'Review to enable' : 'Enable'}
            </Button>
          </form>
        {/if}
        <Button size="xs" variant="ghost" onclick={onhistory}>History</Button>
      {/if}
      <Button size="xs" variant="ghost" aria-expanded={expanded} onclick={ontoggle}>
        {expanded ? 'Close' : readonly ? 'View' : 'Edit'}
      </Button>
    </div>
    {#if toggle.error}
      <p class="mt-1 text-right text-xs text-red-300">{toggle.error}</p>
    {/if}
  </TableCell>
</TableRow>

{#if expanded}
  <TableRow class="hover:bg-transparent">
    <TableCell colspan={3} class="whitespace-normal pb-4">
      {#if readonly && rule}
        <div class="space-y-2 text-sm">
          <p class="text-xs text-dark-2">Still regex: read-only until the one-off conversion runs.</p>
          {#if rule.description}<p class="break-words text-dark-0">{rule.description}</p>{/if}
          {#if rule.note}<p class="break-words text-xs text-dark-2">Note: {rule.note}</p>{/if}
          {#if rule.legacyMatch}
            <pre
              class="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs text-dark-2">{rule.legacyMatch}</pre>
          {/if}
        </div>
      {:else}
        <div class="space-y-3">
          {#if stale && rule}
            <div class="rounded-md border border-amber-500/40 p-3 text-sm text-amber-300">
              <p>Someone saved this rule after your edit started. Keep your edit or discard it.</p>
              <div class="mt-2 flex gap-2">
                <Button size="xs" variant="outline" onclick={() => drafts.keepMine(rule)}>
                  Keep my edit
                </Button>
                <ConfirmButton
                  size="xs"
                  label="Discard"
                  title="Discard this draft?"
                  description="Drops {discardWhat}; the saved rule is untouched."
                  onconfirm={discard}
                />
              </div>
            </div>
          {/if}
          <div class="grid gap-3 sm:grid-cols-2">
            <div>
              <Label for="rule-subject-{draftId}" class="text-xs text-dark-2">Subject</Label>
              <Input
                id="rule-subject-{draftId}"
                maxlength={200}
                class="mt-1"
                bind:value={() => fields.subject, (v) => update({ subject: v })}
              />
            </div>
            <div>
              <Label for="rule-aliases-{draftId}" class="text-xs text-dark-2">
                Aliases (one per line)
              </Label>
              <Textarea
                id="rule-aliases-{draftId}"
                rows={3}
                class="mt-1"
                bind:value={() => fields.aliases, (v) => update({ aliases: v })}
              />
              {#if broadAliases.length}
                <ul class="mt-1 space-y-0.5 text-xs text-amber-300" aria-label="Broad aliases">
                  {#each broadAliases as alias (alias)}
                    <li><span class="break-words font-medium">{alias}</span>: {BROAD_ALIAS_WARNING}</li>
                  {/each}
                </ul>
              {/if}
              {#if canEdit}
                <SuggestAliases
                  id={draftId}
                  subject={fields.subject}
                  description={fields.description}
                  aliases={fields.aliases}
                  {rule}
                  onadd={(added) => update({ aliases: appendAliases(fields.aliases, added) })}
                />
              {/if}
            </div>
            <div class="sm:col-span-2">
              <Label for="rule-description-{draftId}" class="text-xs text-dark-2">
                Description (what the scan should look for)
              </Label>
              <Textarea
                id="rule-description-{draftId}"
                rows={3}
                maxlength={2000}
                class="mt-1"
                bind:value={() => fields.description, (v) => update({ description: v })}
              />
            </div>
            <div class="sm:col-span-2">
              <Label for="rule-note-{draftId}" class="text-xs text-dark-2">
                Internal note (not shown to the scan)
              </Label>
              <Textarea
                id="rule-note-{draftId}"
                rows={2}
                maxlength={2000}
                class="mt-1"
                bind:value={() => fields.note, (v) => update({ note: v })}
              />
            </div>
          </div>
          {#if canEdit}
            <form
              method="POST"
              action="?/save"
              use:enhance={save.enhance}
              class="flex flex-wrap items-center gap-2"
            >
              {#if rule}<input type="hidden" name="id" value={rule.id} />{/if}
              {#if draft?.baseUpdatedAt}
                <input type="hidden" name="baseUpdatedAt" value={draft.baseUpdatedAt} />
              {/if}
              <input type="hidden" name="subject" value={fields.subject} />
              <input type="hidden" name="description" value={fields.description} />
              <input type="hidden" name="aliases" value={fields.aliases} />
              <input type="hidden" name="note" value={fields.note} />
              <Button type="submit" size="sm" disabled={!canSave || stale || save.submitting}>
                {save.submitting
                  ? 'Saving…'
                  : rule?.needsAttention && !draft
                    ? 'Save as reviewed'
                    : 'Save'}
              </Button>
              <ConfirmButton
                size="sm"
                label="Discard"
                title="Discard this draft?"
                description="Drops {discardWhat}; the saved rule is untouched."
                disabled={!draft}
                onconfirm={discard}
              />
              {#if rule}
                <span class="text-xs text-dark-2">
                  Last saved {dateTime(rule.updatedAt)} by {rule.editedBy ?? 'unknown'}
                </span>
              {/if}
            </form>
            {#if save.error}
              <p class="text-sm text-red-300">{save.error}</p>
            {/if}
          {:else}
            <div class="flex flex-wrap items-center gap-2">
              <ConfirmButton
                size="sm"
                label="Discard"
                title="Discard this draft?"
                description="Drops {discardWhat}; the saved rule is untouched."
                disabled={!draft}
                onconfirm={discard}
              />
              <p class="text-xs text-dark-2">
                You can try this edit; saving needs the Model rules edit permission.
              </p>
            </div>
          {/if}
        </div>
      {/if}
    </TableCell>
  </TableRow>
{/if}
