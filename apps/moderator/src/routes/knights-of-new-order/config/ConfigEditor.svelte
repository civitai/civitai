<script lang="ts">
  import { untrack } from 'svelte';
  import { deserialize } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import * as AlertDialog from '@civitai/ui/components/ui/alert-dialog/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Card from '@civitai/ui/components/ui/card/index.js';
  import { Separator } from '@civitai/ui/components/ui/separator/index.js';
  import { Switch } from '@civitai/ui/components/ui/switch/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import {
    ToggleGroup,
    ToggleGroupItem,
  } from '@civitai/ui/components/ui/toggle-group/index.js';
  import { KNIGHTS_GAME_SETTINGS } from '@civitai/shared/new-order';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import type { SourcesSettings } from '$lib/server/knights/sources-config.service';
  import {
    changeCount,
    fieldError,
    gameFormData,
    killSwitchChanged,
    NUMBER_ROWS,
    maxOpenError,
    percentError,
    seedDraft,
    sourcesFormData,
    startsFilling,
    TOGGLE_ROWS,
    type NumberKey,
    type ToggleKey,
  } from './config-draft';
  import type { ToggleChoice } from './game-form';
  import NumberInput from './NumberInput.svelte';
  import SettingRow from './SettingRow.svelte';

  let { settings }: { settings: SourcesSettings } = $props();

  // Seeded once: the page re-keys this component when the stored settings change after a save.
  const seed = untrack(() => settings);
  let draft = $state(seedDraft(seed));
  let submitting = $state(false);
  let error = $state<string | null>(null);
  let confirmOpen = $state(false);

  const count = $derived(changeCount(seed, draft));
  const sourcesTouched = $derived(sourcesFormData(seed, draft) !== null);
  const errors = $derived({
    sfw: sourcesTouched ? percentError(draft.sources.sfw, true) : null,
    nsfw: sourcesTouched ? percentError(draft.sources.nsfw, true) : null,
    yesNo: draft.sources.yesNoReset ? null : percentError(draft.sources.yesNo, false),
    maxOpen: maxOpenError(draft.sources.maxOpen),
    ...Object.fromEntries(
      (Object.keys(NUMBER_ROWS) as NumberKey[]).map((key) => [
        key,
        draft.numbers[key].reset ? null : fieldError(key, draft.numbers[key].text),
      ])
    ),
  } as Record<string, string | null>);
  const invalid = $derived(Object.values(errors).filter(Boolean).length);
  const needsConfirm = $derived(killSwitchChanged(seed, draft) || startsFilling(seed, draft));

  const SECTIONS: { id: string; title: string; numbers: NumberKey[]; toggles: ToggleKey[] }[] = [
    {
      id: 'skill-checks',
      title: 'Skill checks',
      numbers: [
        'hiddenCheckRate',
        'hiddenCheckFailureWindowHours',
        'hiddenCheckSevereDistance',
        'hiddenCheckSettleDelayMinutes',
        'hiddenCheckRetireMinAnswers',
        'hiddenCheckRetireFailureRate',
        'skillCheckPoolCap',
      ],
      toggles: ['inquisitorQueue', 'skillCheckServeJudged'],
    },
    { id: 'yes-no', title: 'Yes/no questions', numbers: ['yesNoStretch', 'yesNoMaxAgeDays'], toggles: [] },
    { id: 'acolytes', title: 'Acolytes', numbers: [], toggles: ['apprenticeSmites'] },
    {
      id: 'harvest',
      title: 'Harvest',
      numbers: ['harvestHiddenCheckShare'],
      toggles: ['harvest'],
    },
  ];
  const DANGER: ToggleKey[] = ['shopDisabled', 'conversionDisabled', 'signalsDisabled'];

  async function post(action: string, body: FormData) {
    const response = await fetch(`?/${action}`, {
      method: 'POST',
      body,
      headers: { 'x-sveltekit-action': 'true' },
    });
    return deserialize(await response.text());
  }

  // Through the page's two existing actions, so validation, carry-over and the audit stay the server's.
  async function save(confirmed: boolean) {
    submitting = true;
    error = null;
    try {
      const steps: [string, FormData | null][] = [
        ['save', sourcesFormData(seed, draft)],
        ['game', gameFormData(seed, draft, confirmed)],
      ];
      for (const [action, body] of steps) {
        if (!body) continue;
        const result = await post(action, body);
        if (result.type === 'failure') {
          error = String(result.data?.error ?? 'The settings could not be saved. Try again.');
          return;
        }
        if (result.type !== 'success') {
          error = 'The settings could not be saved. Nothing was changed; try again.';
          return;
        }
      }
      toast.success('Saved');
      await invalidateAll();
    } catch {
      error = 'The settings could not be saved. Check your connection and try again.';
    } finally {
      submitting = false;
    }
  }

  const discard = () => {
    draft = seedDraft(seed);
    error = null;
  };

  const numberCustom = (key: NumberKey) =>
    !draft.numbers[key].reset && draft.numbers[key].text.trim() !== '';
  const setNumber = (key: NumberKey, text: string) => (draft.numbers[key] = { text, reset: false });
  const resetNumber = (key: NumberKey) => (draft.numbers[key] = { text: '', reset: true });
  const setToggle = (key: ToggleKey, value: string) => {
    // A second click on the chosen item would empty a single group; keep the choice instead.
    if (value) draft.toggles[key] = value as ToggleChoice;
  };
</script>

{#snippet numberRow(key: NumberKey)}
  {@const row = NUMBER_ROWS[key]}
  <SettingRow
    id="cfg-{key}"
    label={KNIGHTS_GAME_SETTINGS[key].label}
    description={row.description}
    custom={numberCustom(key)}
    env={KNIGHTS_GAME_SETTINGS[key].env}
    error={errors[key]}
    onreset={() => resetNumber(key)}
  >
    <NumberInput
      id="cfg-{key}"
      unit={row.unit}
      value={draft.numbers[key].text}
      invalid={Boolean(errors[key])}
      oninput={(value) => setNumber(key, value)}
    />
  </SettingRow>
{/snippet}

{#snippet toggleRow(key: ToggleKey)}
  <SettingRow
    id="cfg-{key}"
    label={KNIGHTS_GAME_SETTINGS[key].label}
    description={TOGGLE_ROWS[key].description}
    custom={draft.toggles[key] !== 'default'}
    env={KNIGHTS_GAME_SETTINGS[key].env}
  >
    <ToggleGroup
      type="single"
      size="sm"
      variant="outline"
      aria-labelledby="cfg-{key}-label"
      value={draft.toggles[key]}
      onValueChange={(value) => setToggle(key, value)}
    >
      {#each TOGGLE_ROWS[key].options as option (option.value)}
        <ToggleGroupItem value={option.value} class="min-w-16">{option.label}</ToggleGroupItem>
      {/each}
    </ToggleGroup>
  </SettingRow>
{/snippet}

{#snippet rows(keys: { numbers: NumberKey[]; toggles: ToggleKey[] })}
  {@const all = [
    ...keys.toggles.map((key) => ({ kind: 'toggle' as const, key })),
    ...keys.numbers.map((key) => ({ kind: 'number' as const, key })),
  ]}
  {#each all as item, i (item.key)}
    {#if i > 0}<Separator />{/if}
    {#if item.kind === 'toggle'}
      {@render toggleRow(item.key)}
    {:else}
      {@render numberRow(item.key)}
    {/if}
  {/each}
{/snippet}

<div class="flex flex-col gap-4">
  <Card.Root id="queue-sources">
    <Card.Header>
      <Card.Title>Queue sources</Card.Title>
    </Card.Header>
    <Card.Content>
      <SettingRow
        id="cfg-enabled"
        label="Sources on"
        description="Send a share of newly scanned images, and every owner rating, to the Knights."
      >
        <Switch
          id="cfg-enabled"
          aria-labelledby="cfg-enabled-label"
          bind:checked={draft.sources.enabled}
        />
      </SettingRow>
      <Separator />
      <SettingRow
        id="cfg-sfw"
        label="SFW rate"
        description="Share of safe-looking scanned images that are queued."
        error={errors.sfw}
      >
        <NumberInput
          id="cfg-sfw"
          unit="%"
          placeholder=""
          value={draft.sources.sfw}
          invalid={Boolean(errors.sfw)}
          oninput={(value) => (draft.sources.sfw = value)}
        />
      </SettingRow>
      <Separator />
      <SettingRow
        id="cfg-nsfw"
        label="NSFW rate"
        description="Share of NSFW scanned images that are queued."
        error={errors.nsfw}
      >
        <NumberInput
          id="cfg-nsfw"
          unit="%"
          placeholder=""
          value={draft.sources.nsfw}
          invalid={Boolean(errors.nsfw)}
          oninput={(value) => (draft.sources.nsfw = value)}
        />
      </SettingRow>
      <Separator />
      <SettingRow
        id="cfg-max-open"
        label="Open-item cap"
        description="Scan intake pauses while more Knight-stage rating items than this are open. Owner ratings always queue. Blank keeps the stored cap (5,000 when none is stored)."
        error={errors.maxOpen}
      >
        <NumberInput
          id="cfg-max-open"
          unit="items"
          placeholder="5000"
          value={draft.sources.maxOpen}
          invalid={Boolean(errors.maxOpen)}
          oninput={(value) => (draft.sources.maxOpen = value)}
        />
      </SettingRow>
      <Separator />
      <SettingRow
        id="cfg-yesno"
        label="Yes/no share"
        description="How often yes/no questions are served. 0% turns them off."
        custom={!draft.sources.yesNoReset && draft.sources.yesNo.trim() !== ''}
        env="KNIGHTS_YESNO_SHARE"
        error={errors.yesNo}
        onreset={() => ((draft.sources.yesNo = ''), (draft.sources.yesNoReset = true))}
      >
        <NumberInput
          id="cfg-yesno"
          unit="%"
          value={draft.sources.yesNo}
          invalid={Boolean(errors.yesNo)}
          oninput={(value) => ((draft.sources.yesNo = value), (draft.sources.yesNoReset = false))}
        />
      </SettingRow>
    </Card.Content>
  </Card.Root>

  {#each SECTIONS as section (section.id)}
    <Card.Root id={section.id}>
      <Card.Header>
        <Card.Title>{section.title}</Card.Title>
      </Card.Header>
      <Card.Content>
        {@render rows(section)}
      </Card.Content>
    </Card.Root>
  {/each}

  <Card.Root id="shop-and-conversion" class="ring-destructive/40">
    <Card.Header>
      <Card.Title class="text-destructive">Shop and conversion</Card.Title>
      <Card.Description class="text-dark-2">
        These switch player-facing spending off. Saving a change asks first.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      {@render rows({ numbers: [], toggles: DANGER })}
    </Card.Content>
  </Card.Root>

  {#if count > 0}
    <div
      class="sticky bottom-4 z-10 flex flex-col gap-2 rounded-xl border border-dark-4 bg-dark-6 p-3 shadow-lg sm:flex-row sm:items-center"
      role="region"
      aria-label="Unsaved changes"
    >
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium text-dark-0">
          {count} unsaved {count === 1 ? 'change' : 'changes'}
        </p>
        {#if invalid}
          <p class="text-xs text-red-400">Fix {invalid === 1 ? 'the field' : `${invalid} fields`} marked above to save.</p>
        {/if}
        {#if error}<ErrorAlert message={error} />{/if}
      </div>
      <div class="flex gap-2">
        <Button type="button" variant="outline" size="sm" disabled={submitting} onclick={discard} data-touch-target>
          Discard
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={submitting || invalid > 0}
          onclick={() => (needsConfirm ? (confirmOpen = true) : save(false))}
          data-touch-target
        >
          {submitting ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  {/if}
</div>

<AlertDialog.Root bind:open={confirmOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Save these changes?</AlertDialog.Title>
      <AlertDialog.Description>
        {#if killSwitchChanged(seed, draft)}This changes whether players can shop or buy Buzz with gold.{/if}
        {#if startsFilling(seed, draft)}Turning the sources on starts filling the queue.{/if}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action
        onclick={() => {
          confirmOpen = false;
          save(true);
        }}>Save</AlertDialog.Action
      >
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
