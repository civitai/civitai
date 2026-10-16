<script lang="ts">
  import { untrack } from 'svelte';
  import TryPanel from '$lib/components/text-scan-lab/TryPanel.svelte';
  import LabSideTabs from '$lib/components/text-scan-tests/LabSideTabs.svelte';
  import TestSetsPanel from '$lib/components/text-scan-tests/TestSetsPanel.svelte';
  import type { ModelRuleView } from '$lib/server/model-rules.service';
  import { currentPromptsOf } from '$lib/text-scan-lab/changes';
  import { createChangesSync } from '$lib/text-scan-lab/changes.svelte';
  import { describeBlankPrompts } from '$lib/text-scan-lab/labels';
  import { createRuleDraftsSync } from '$lib/text-scan-lab/rule-drafts.svelte';
  import { MODEL_RULES_POLICY_KEY } from '$lib/text-scan-lab/types';
  import type { LoadedPrompts } from '$lib/server/text-scan-lab/version';
  import type { PageData } from './$types';
  import PolicyEditor from './PolicyEditor.svelte';
  import RulesList from './RulesList.svelte';

  let {
    rules,
    policy,
    authors,
    query,
    canEdit,
    canCapture,
    userId,
    url,
  }: {
    rules: ModelRuleView[];
    policy: LoadedPrompts;
    authors: Record<number, string>;
    query: PageData['query'];
    canEdit: boolean;
    canCapture: boolean;
    userId: number;
    url: URL;
  } = $props();

  const changes = createChangesSync(untrack(() => userId), () =>
    policy.ok ? currentPromptsOf(policy.value) : null
  );
  const drafts = createRuleDraftsSync(untrack(() => userId), () => rules);

  const policyDraft = $derived(changes.prompts[MODEL_RULES_POLICY_KEY]);
  const tryPrompts = $derived(
    policyDraft === undefined ? '{}' : JSON.stringify({ [MODEL_RULES_POLICY_KEY]: policyDraft })
  );
  const tryRules = $derived(JSON.stringify(drafts.overrides(rules)));
  const hasDraft = $derived(policyDraft !== undefined || tryRules !== '[]');
  const draftsError = $derived(
    policyDraft !== undefined && !policyDraft.trim()
      ? describeBlankPrompts([MODEL_RULES_POLICY_KEY])
      : null
  );
</script>

<div class="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
  <div class="min-w-0 space-y-4">
    <PolicyEditor {changes} {policy} {authors} {canEdit} />
    <RulesList {rules} {drafts} {query} {canEdit} {url} />
  </div>
  <LabSideTabs>
    {#snippet tryPanel()}
      <TryPanel
        prompts={tryPrompts}
        rules={tryRules}
        editedKeys={[MODEL_RULES_POLICY_KEY]}
        {draftsError}
        workspace="modelRules"
        {canCapture}
      />
    {/snippet}
    {#snippet testSets(visible)}
      <TestSetsPanel
        workspace="modelRules"
        {visible}
        prompts={tryPrompts}
        rules={tryRules}
        {hasDraft}
        {draftsError}
        canEdit={canCapture}
        {userId}
      />
    {/snippet}
  </LabSideTabs>
</div>
