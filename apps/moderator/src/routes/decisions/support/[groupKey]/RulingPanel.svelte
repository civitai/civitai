<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { RadioGroup, RadioGroupItem } from '@civitai/ui/components/ui/radio-group/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { GROUP_RULINGS, GROUP_RULING_LABEL, type GroupRuling } from '$lib/decision-rulings';
  import { dateTime } from '$lib/format';

  let {
    version,
    topic,
    topics,
    targets,
    current,
    canRule,
    error,
  }: {
    /** The version this page showed — posted, so the ruling is recorded against it. */
    version: string;
    topic: string;
    topics: string[];
    targets: { groupKey: string; title: string; topic: string }[];
    current: { ruling: GroupRuling; ruledBy: number; ruledAt: Date; targetKey: string | null } | null;
    canRule: boolean;
    /** This panel's refusal, if the last submit was refused. */
    error: string | null;
  } = $props();

  // Component-local: the choice in progress. The page `{#key}`s this panel on the group, so it never
  // carries over to another group.
  let ruling = $state('');
  let targetKey = $state('');
  let escalateTo = $state('');
  let submitting = $state(false);

  const targetLabel = $derived(
    targets.find((t) => t.groupKey === targetKey)?.title ?? 'Choose the original group'
  );

  const submit: SubmitFunction = () => {
    submitting = true;
    return async ({ result, update }) => {
      // `update` applies the result — a `fail()` lands in `form` and renders below — and reloads on
      // success, so "Last ruling" comes from the database rather than from this click.
      await update();
      submitting = false;
      if (result.type === 'success') ruling = targetKey = escalateTo = '';
    };
  };

  const HINT: Partial<Record<GroupRuling, string>> = {
    duplicate_of: 'Recorded only. The router keeps the group until this is applied router-side.',
    park: 'Recorded only. The router keeps routing to it until this is applied router-side.',
  };
</script>

<section class="mt-6 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-1 text-white">Ruling on the group</h2>
  {#if current}
    <p class="text-dark-2 mb-3 text-sm">
      Last ruling: <strong class="text-dark-0">{GROUP_RULING_LABEL[current.ruling]}</strong>
      {#if current.targetKey}(of <code>{current.targetKey}</code>){/if}
      by user {current.ruledBy} · {dateTime(current.ruledAt)}
    </p>
  {:else}
    <p class="text-dark-2 mb-3 text-sm">Not ruled yet.</p>
  {/if}

  {#if error}
    <ErrorAlert class="mb-3" message={error} />
  {/if}

  {#if canRule}
    <form method="POST" action="?/rule" use:enhance={submit} class="space-y-4">
      <input type="hidden" name="version" value={version} />
      <RadioGroup name="ruling" bind:value={ruling} class="grid gap-2 sm:grid-cols-2">
        {#each GROUP_RULINGS as r (r)}
          <div class="flex items-center gap-2">
            <RadioGroupItem value={r} id="ruling-{r}" />
            <Label for="ruling-{r}" class="font-normal text-dark-0">{GROUP_RULING_LABEL[r]}</Label>
          </div>
        {/each}
      </RadioGroup>

      {#if ruling === 'duplicate_of'}
        <div>
          <Label for="ruling-target">Original group</Label>
          <Select.Root type="single" name="targetKey" bind:value={targetKey}>
            <Select.Trigger id="ruling-target" class="mt-1 w-full max-w-xl">{targetLabel}</Select.Trigger>
            <Select.Content>
              {#each targets as t (t.groupKey)}
                <Select.Item value={t.groupKey}>
                  {t.title} · {t.topic}{t.topic === topic ? '' : ' (other area)'}
                </Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
      {:else if ruling === 'escalate'}
        <div>
          <Label for="ruling-escalate">Escalate to area</Label>
          <Select.Root type="single" name="escalateTo" bind:value={escalateTo}>
            <Select.Trigger id="ruling-escalate" class="mt-1 w-64">
              {escalateTo || 'Choose an area'}
            </Select.Trigger>
            <Select.Content>
              {#each topics as t (t)}
                <Select.Item value={t}>{t}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
      {/if}

      {#if ruling && HINT[ruling as GroupRuling]}
        <p class="text-dark-2 text-sm">{HINT[ruling as GroupRuling]}</p>
      {/if}

      <div>
        <Label for="ruling-note">Note (optional)</Label>
        <Textarea id="ruling-note" name="note" maxlength={2000} rows={2} class="mt-1 max-w-xl" />
      </div>

      <Button type="submit" size="sm" disabled={submitting || !ruling}>
        {submitting ? 'Recording…' : 'Record ruling'}
      </Button>
    </form>
  {/if}
</section>
