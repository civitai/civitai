<script lang="ts">
  import { browser } from '$app/environment';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import ConfirmRunDialog from '$lib/components/text-scan-lab/ConfirmRunDialog.svelte';
  import { num, plural } from '$lib/format';
  import { ENTITY_TYPE_NAMES, describeExpected } from '$lib/text-scan-lab/labels';
  import type { Expected } from '$lib/text-scan-lab/types';
  import type { CaseListItem } from '../test-sets/[id]/cases/+server';
  import type { CheckResult, SetRunView } from './+page.server';
  import { actionError, type ChangesState } from './changes';
  import { postAction } from './post-action';
  import SetRunSummary from './SetRunSummary.svelte';

  let {
    testSets,
    changes,
    changedTitle,
    changesName,
    civitaiUrl,
    onstart,
    onchecked,
  }: {
    testSets: { id: number; name: string; caseCount: number }[];
    changes: ChangesState;
    changedTitle: string;
    changesName: string;
    civitaiUrl: string;
    onstart: () => void;
    onchecked: (result: CheckResult) => void;
  } = $props();

  const SHOWN_CASES = 200;

  let setId = $state('');
  let query = $state('');

  const cases = $derived(
    browser && setId
      ? fetch(`/text-scan/test-sets/${setId}/cases`).then(async (res) => {
          const body = await res.json();
          if (!res.ok) throw new Error(body.error ?? 'Could not load the cases.');
          return body.cases as CaseListItem[];
        })
      : null
  );

  const setName = (id: string) => testSets.find((s) => String(s.id) === id)?.name;
  const caseTitle = (c: CaseListItem) =>
    `${ENTITY_TYPE_NAMES[c.entityType]} ${c.entityId ?? 'text'}`;
  const expectedText = (expected: Expected) =>
    Object.values(describeExpected(expected)).join(' · ') || 'nothing scored';

  function matching(list: CaseListItem[], q: string) {
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((c) =>
      [caseTitle(c), String(c.id), c.preview ?? '', expectedText(c.expected)].some((t) =>
        t.toLowerCase().includes(needle)
      )
    );
  }

  let loadingCase = $state<number | null>(null);
  let caseError = $state<string | null>(null);

  async function loadCase(caseId: number) {
    if (changes.blankError) {
      caseError = changes.blankError;
      return;
    }
    loadingCase = caseId;
    caseError = null;
    onstart();
    const result = await postAction('checkCase', {
      setId,
      caseId: String(caseId),
      overrides: changes.json,
    });
    loadingCase = null;
    if (result.type === 'success') {
      onchecked(result.data as CheckResult);
      document.getElementById('check-results')?.scrollIntoView({ behavior: 'smooth' });
    } else caseError = actionError(result);
  }

  type ConfirmAsk = {
    needsConfirm: true;
    count: number;
    skipped: number;
    seconds: number;
    stamp: string;
    changed: boolean;
  };

  let running = $state(false);
  let runError = $state<string | null>(null);
  let view = $state<SetRunView | null>(null);
  let pending = $state<{
    request: ConfirmAsk;
    note: string | null;
    confirm: (stamp: string) => void;
  } | null>(null);
  const withChanges = $derived(changes.keys.length > 0);
  const shownView = $derived(view && String(view.setId) === setId ? view : null);

  /** Posts a set run, asking first when the server wants a confirmation. */
  async function submitRun(
    action: string,
    fields: Record<string, string>,
    note: string | null,
    confirmed = ''
  ) {
    running = true;
    runError = null;
    const result = await postAction(action, { ...fields, confirmed });
    running = false;
    if (result.type !== 'success') {
      pending = null;
      runError = actionError(result);
      return;
    }
    const data = result.data as SetRunView | ConfirmAsk;
    if ('needsConfirm' in data) {
      pending = {
        request: data,
        note,
        confirm: (stamp) => void submitRun(action, fields, note, stamp),
      };
      return;
    }
    pending = null;
    view = data;
  }

  async function runSet() {
    runError = null;
    const fields: Record<string, string> = { setId };
    if (withChanges) {
      // The run reads the changes from the database, so they are saved first.
      if (changes.blankError) {
        runError = changes.blankError;
        return;
      }
      running = true;
      const saved = await changes.flush();
      running = false;
      if (!saved || changes.draftId === null) {
        runError = changes.error ?? 'Your changes could not be saved.';
        return;
      }
      fields.draftId = String(changes.draftId);
    }
    await submitRun(
      'runSet',
      fields,
      withChanges
        ? `Each case runs twice: with the current prompts and ${changedTitle.toLowerCase()}.`
        : null
    );
  }

  function rerun(runId: number) {
    if (!shownView) return;
    void submitRun(
      'rerunSetErrors',
      {
        setId: String(shownView.setId),
        runId: String(runId),
        currentRunId: String(shownView.current.runId),
        changedRunId: shownView.changed ? String(shownView.changed.runId) : '',
      },
      null
    );
  }
</script>

<section class="mt-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="text-sm font-semibold text-white">From a test set</h2>

  <div class="mt-3 flex flex-wrap items-center gap-3">
    <Select.Root type="single" bind:value={setId}>
      <Select.Trigger class="w-72" aria-label="Test set">
        {setName(setId) ?? 'Choose a test set'}
      </Select.Trigger>
      <Select.Content>
        {#each testSets as s (s.id)}
          <Select.Item value={String(s.id)}>{s.name} ({plural(s.caseCount, 'case')})</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
    {#if setId}
      <Button
        variant="outline"
        disabled={running || changes.conflict}
        onclick={() => void runSet()}
      >
        {running ? 'Running…' : 'Run set'}
      </Button>
      <p class="text-xs text-dark-2">
        Runs every case with the current prompts{withChanges
          ? ` and ${changedTitle.toLowerCase()}`
          : ''}. The page waits until it finishes.
      </p>
    {/if}
  </div>
  {#if runError}
    <p class="mt-2 whitespace-pre-wrap text-sm text-red-300">{runError}</p>
  {/if}

  {#if cases}
    {#await cases}
      <p class="mt-3 text-sm text-dark-2">Loading cases…</p>
    {:then list}
      {@const found = matching(list, query)}
      <Input
        class="mt-3"
        placeholder="Search cases by text, type or id"
        aria-label="Search cases"
        bind:value={query}
      />
      {#if caseError}
        <p class="mt-2 whitespace-pre-wrap text-sm text-red-300">{caseError}</p>
      {/if}
      {#if found.length}
        <ul class="mt-2 max-h-80 divide-y divide-dark-4 overflow-y-auto rounded-lg border border-dark-4">
          {#each found.slice(0, SHOWN_CASES) as c (c.id)}
            <li>
              <button
                type="button"
                class="w-full px-3 py-2 text-left hover:bg-dark-5 disabled:cursor-default disabled:opacity-60"
                disabled={c.preview === null || loadingCase !== null}
                onclick={() => void loadCase(c.id)}
              >
                <span class="flex flex-wrap justify-between gap-x-3 text-xs text-dark-2">
                  <span>{caseTitle(c)}{loadingCase === c.id ? ' · checking…' : ''}</span>
                  <span>Expected: {expectedText(c.expected)}</span>
                </span>
                <span class="mt-0.5 block break-words text-sm text-dark-0">
                  {c.preview ?? 'Text removed with its source.'}
                </span>
              </button>
            </li>
          {/each}
        </ul>
        {#if found.length > SHOWN_CASES}
          <p class="mt-1 text-xs text-dark-2">
            Showing {SHOWN_CASES} of {num(found.length)} — narrow the search.
          </p>
        {/if}
      {:else}
        <p class="mt-2 text-sm text-dark-2">{list.length ? 'No case matches.' : 'This set has no cases.'}</p>
      {/if}
    {:catch e}
      <p class="mt-3 text-sm text-red-300">{e instanceof Error ? e.message : 'Could not load the cases.'}</p>
    {/await}
  {/if}

  {#if shownView}
    <SetRunSummary
      view={shownView}
      {changedTitle}
      {changesName}
      {civitaiUrl}
      busy={running || loadingCase !== null}
      onload={(caseId) => void loadCase(caseId)}
      onrerun={rerun}
    />
  {/if}
</section>

<ConfirmRunDialog
  request={pending?.request ?? null}
  onconfirm={(stamp) => pending?.confirm(stamp)}
  note={pending?.note ?? null}
  submitting={running}
  onclose={() => (pending = null)}
/>
