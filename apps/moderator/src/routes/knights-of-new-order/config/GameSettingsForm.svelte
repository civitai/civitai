<script lang="ts">
  import { untrack } from 'svelte';
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import {
    ToggleGroup,
    ToggleGroupItem,
  } from '@civitai/ui/components/ui/toggle-group/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import {
    KNIGHTS_GAME_SETTINGS,
    type KnightsGameSettingKey,
    type KnightsGameSettings,
  } from '@civitai/shared/new-order';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import {
    CONFIRM_FIELD,
    defaultField,
    toggleChoice,
    toggleSubmission,
    type ToggleChoice,
  } from './game-form';

  let { game }: { game: KnightsGameSettings | undefined } = $props();

  type NumberKey = {
    [K in KnightsGameSettingKey]: (typeof KNIGHTS_GAME_SETTINGS)[K]['kind'] extends 'number'
      ? K
      : never;
  }[KnightsGameSettingKey];
  type ToggleKey = Exclude<KnightsGameSettingKey, NumberKey>;

  const SECTIONS: {
    title: string;
    help: string;
    numbers: NumberKey[];
    toggles: ToggleKey[];
  }[] = [
    {
      title: 'Skill checks',
      help: 'Hidden checks served in the feed, how misses are judged, and when a bad check retires.',
      numbers: [
        'hiddenCheckRate',
        'hiddenCheckFailureWindowHours',
        'hiddenCheckSevereDistance',
        'hiddenCheckSettleDelayMinutes',
        'hiddenCheckRetireMinAnswers',
        'hiddenCheckRetireFailureRate',
      ],
      toggles: [],
    },
    {
      title: 'Yes/no',
      help: 'The yes/no share is set with the sources above.',
      numbers: ['yesNoStretch', 'yesNoMaxAgeDays'],
      toggles: [],
    },
    {
      title: 'Acolytes',
      help: 'Off stops new wrong-answer smites and holds the career reset of Acolytes whose smites are all wrong-answer ones.',
      numbers: [],
      toggles: ['apprenticeSmites'],
    },
    {
      title: 'Shop and conversion',
      help: 'Kill switches. Gold keeps accruing either way; saving a change asks first.',
      numbers: [],
      toggles: ['shopDisabled', 'conversionDisabled'],
    },
  ];

  const CHOICES: { value: ToggleChoice; label: string }[] = [
    { value: 'default', label: 'Knights default (env)' },
    { value: 'on', label: 'On' },
    { value: 'off', label: 'Off' },
  ];
  const KILL_SWITCHES: ToggleKey[] = ['shopDisabled', 'conversionDisabled'];

  // Seeded once from the server: the inputs are the moderator's draft until a save reloads the page.
  const seed: KnightsGameSettings = untrack(() => game ?? {});
  const seedText = (key: NumberKey) => (seed[key] === undefined ? '' : String(seed[key]));

  const numberKeys = SECTIONS.flatMap((section) => section.numbers);
  const toggleKeys = SECTIONS.flatMap((section) => section.toggles);
  let numbers = $state(
    Object.fromEntries(numberKeys.map((key) => [key, seedText(key)])) as Record<NumberKey, string>
  );
  // The moderator app cannot see the Knights environment, so a toggle with nothing saved shows "Knights default", not a guess.
  let toggles = $state(
    Object.fromEntries(toggleKeys.map((key) => [key, toggleChoice(seed[key])])) as Record<
      ToggleKey,
      ToggleChoice
    >
  );
  let useDefault = $state(
    Object.fromEntries(numberKeys.map((key) => [key, false])) as Record<NumberKey, boolean>
  );
  let confirming = $state(false);

  // Only changed settings are posted, so a save never rewrites a field the moderator did not touch.
  const numberChanged = (key: NumberKey) =>
    !useDefault[key] && numbers[key].trim() !== '' && numbers[key].trim() !== seedText(key);
  const clearing = (key: NumberKey) => useDefault[key] && seed[key] !== undefined;
  const toggleChange = (key: ToggleKey) => toggleSubmission(seed[key], toggles[key]);

  const anyChange = $derived(
    numberKeys.some((key) => numberChanged(key) || clearing(key)) ||
      toggleKeys.some((key) => toggleChange(key) !== null)
  );
  const killSwitchChange = $derived(KILL_SWITCHES.some((key) => toggleChange(key) !== null));

  const form = new FormState({
    reload: true,
    reset: false,
    onSuccess: (result) => {
      confirming = false;
      toast.success(result?.changed === false ? 'Nothing to change' : 'Saved');
    },
  });

  const status = (key: KnightsGameSettingKey) =>
    seed[key] === undefined
      ? `Knights default: ${KNIGHTS_GAME_SETTINGS[key].env}, else built in.`
      : 'Saved here.';
</script>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5" aria-labelledby="game-heading">
  <h2 id="game-heading" class="mb-1 text-base font-semibold text-white">Game settings</h2>
  <p class="mb-4 text-sm text-dark-2">
    Each setting overrides the Knights environment variable named under it. Changes reach Knights
    within about 30 seconds. A blank box keeps its current value.
  </p>

  <form method="POST" action="?/game" use:enhance={form.enhance} class="flex flex-col gap-6">
    {#each SECTIONS as section (section.title)}
      <fieldset class="flex flex-col gap-3">
        <legend class="mb-1 text-sm font-semibold text-white">{section.title}</legend>
        <p class="-mt-1 text-xs text-dark-2">{section.help}</p>

        {#each section.numbers as key (key)}
          {@const spec = KNIGHTS_GAME_SETTINGS[key]}
          <div class="grid gap-1.5">
            <Label for="game-{key}">{spec.label}</Label>
            <Input
              id="game-{key}"
              name={numberChanged(key) ? key : undefined}
              type="text"
              inputmode="decimal"
              autocomplete="off"
              placeholder="Knights default"
              disabled={useDefault[key]}
              bind:value={() => numbers[key], (value) => ((numbers[key] = value), (confirming = false))}
            />
            <p class="text-xs text-dark-2">{spec.range[0].toUpperCase() + spec.range.slice(1)}. {status(key)}</p>
            {#if seed[key] !== undefined}
              <div class="flex items-center gap-2" data-touch-target>
                {#if useDefault[key]}<input type="hidden" name={defaultField(key)} value="true" />{/if}
                <Checkbox
                  id="game-{key}-default"
                  bind:checked={
                    () => useDefault[key], (value) => ((useDefault[key] = value), (confirming = false))
                  }
                />
                <Label for="game-{key}-default" class="text-xs font-normal text-dark-2">
                  Use the Knights default
                </Label>
              </div>
            {/if}
          </div>
        {/each}

        {#each section.toggles as key (key)}
          {@const spec = KNIGHTS_GAME_SETTINGS[key]}
          {@const change = toggleChange(key)}
          <div class="grid gap-1.5">
            <span class="text-sm font-medium" id="game-{key}-label">{spec.label}</span>
            {#if change === 'clear'}
              <input type="hidden" name={defaultField(key)} value="true" />
            {:else if change}
              <input type="hidden" name={key} value={String(change.set)} />
            {/if}
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              aria-labelledby="game-{key}-label"
              value={toggles[key]}
              onValueChange={(value) => {
                // A second click on the chosen item would empty a single group; keep the choice instead.
                if (value) toggles[key] = value as ToggleChoice;
                confirming = false;
              }}
            >
              {#each CHOICES as choice (choice.value)}
                <ToggleGroupItem value={choice.value}>{choice.label}</ToggleGroupItem>
              {/each}
            </ToggleGroup>
            <p class="text-xs text-dark-2">{status(key)}</p>
          </div>
        {/each}
      </fieldset>
    {/each}

    {#if form.error}<ErrorAlert message={form.error} />{/if}

    <div class="flex flex-wrap items-center gap-2">
      {#if killSwitchChange && confirming}
        <input type="hidden" name={CONFIRM_FIELD} value="true" />
        <span class="text-sm text-amber-300">This changes whether players can shop or convert gold.</span>
        <Button type="submit" size="sm" disabled={form.submitting} data-touch-target>
          Yes, save
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onclick={() => (confirming = false)}
          data-touch-target
        >
          Cancel
        </Button>
      {:else if killSwitchChange}
        <Button
          type="button"
          size="sm"
          disabled={form.submitting}
          onclick={() => (confirming = true)}
          data-touch-target
        >
          Save
        </Button>
      {:else}
        <Button type="submit" size="sm" disabled={form.submitting || !anyChange} data-touch-target>
          Save
        </Button>
      {/if}
    </div>
  </form>
</section>
