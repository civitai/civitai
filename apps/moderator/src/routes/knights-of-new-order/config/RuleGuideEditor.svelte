<script lang="ts">
  import { untrack } from 'svelte';
  import { deserialize } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Card from '@civitai/ui/components/ui/card/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Separator } from '@civitai/ui/components/ui/separator/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { KNIGHTS_RULE_GUIDE_LIMITS as LIMITS, type KnightsRuleGuide } from '@civitai/shared/new-order';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';

  let { guide }: { guide: KnightsRuleGuide | undefined } = $props();

  type DraftSet = { title: string; notes: string; levels: { code: string; description: string }[] };

  const emptyLevel = () => ({ code: '', description: '' });
  const emptySet = (): DraftSet => ({ title: '', notes: '', levels: [emptyLevel()] });

  // Seeded once: the page re-keys this component when the stored settings change after a save.
  const seed = untrack(() => guide);
  let intro = $state(seed?.intro ?? '');
  let sets = $state<DraftSet[]>(
    seed?.sets.map((set) => ({
      title: set.title,
      notes: set.notes ?? '',
      levels: set.levels.map((level) => ({ ...level })),
    })) ?? []
  );
  let submitting = $state(false);
  let error = $state<string | null>(null);

  const normalized = (value: { intro?: string; sets: DraftSet[] | KnightsRuleGuide['sets'] } | null) =>
    JSON.stringify(
      value && value.sets.length
        ? {
            intro: value.intro?.trim() ?? '',
            sets: value.sets.map((set) => ({
              title: set.title.trim(),
              notes: set.notes?.trim() ?? '',
              levels: set.levels.map((l) => ({ code: l.code.trim(), description: l.description.trim() })),
            })),
          }
        : null
    );

  const posted = $derived(sets.length ? { intro, sets } : null);
  const dirty = $derived(normalized(posted) !== normalized(seed ?? null));

  async function save() {
    submitting = true;
    error = null;
    try {
      const body = new FormData();
      body.set('ruleGuide', JSON.stringify(posted));
      const response = await fetch('?/rules', {
        method: 'POST',
        body,
        headers: { 'x-sveltekit-action': 'true' },
      });
      const result = deserialize(await response.text());
      if (result.type === 'failure') {
        error = String(result.data?.error ?? 'The rules could not be saved. Try again.');
        return;
      }
      if (result.type !== 'success') {
        error = 'The rules could not be saved. Nothing was changed; try again.';
        return;
      }
      toast.success('Saved');
      await invalidateAll();
    } catch {
      error = 'The rules could not be saved. Check your connection and try again.';
    } finally {
      submitting = false;
    }
  }
</script>

<Card.Root id="question-rules">
  <Card.Header>
    <Card.Title>Question rules</Card.Title>
    <Card.Description class="text-dark-2">
      Shown to players below the rating levels in the Codex and the in-game rating guide, and
      from yes/no questions. Saved on its own; players see it within about 30 seconds.
    </Card.Description>
  </Card.Header>
  <Card.Content class="flex flex-col gap-4">
    <div class="flex flex-col gap-1.5">
      <Label for="rules-intro">Intro</Label>
      <Textarea id="rules-intro" rows={3} maxlength={LIMITS.intro} bind:value={intro} />
    </div>

    {#each sets as set, s (s)}
      <Separator />
      <fieldset class="flex flex-col gap-3">
        <legend class="sr-only">Rule set {s + 1}</legend>
        <div class="flex items-end gap-2">
          <div class="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label for="rules-{s}-title">Set {s + 1} title</Label>
            <Input id="rules-{s}-title" maxlength={LIMITS.title} bind:value={set.title} />
          </div>
          <Button type="button" variant="outline" size="sm" onclick={() => sets.splice(s, 1)}>
            Remove set
          </Button>
        </div>
        {#each set.levels as level, l (l)}
          <div class="flex items-start gap-2">
            <Input
              class="w-20 shrink-0"
              aria-label="Set {s + 1}, level {l + 1} code"
              placeholder="Code"
              maxlength={LIMITS.code}
              bind:value={level.code}
            />
            <Textarea
              class="min-w-0 flex-1"
              rows={2}
              aria-label="Set {s + 1}, level {l + 1} description"
              placeholder="What this level means"
              maxlength={LIMITS.description}
              bind:value={level.description}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Remove set {s + 1}, level {l + 1}"
              disabled={set.levels.length === 1}
              onclick={() => set.levels.splice(l, 1)}
            >
              Remove
            </Button>
          </div>
        {/each}
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={set.levels.length >= LIMITS.levels}
            onclick={() => set.levels.push(emptyLevel())}
          >
            Add level
          </Button>
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="rules-{s}-notes">Set {s + 1} notes</Label>
          <Textarea id="rules-{s}-notes" rows={2} maxlength={LIMITS.notes} bind:value={set.notes} />
        </div>
      </fieldset>
    {/each}

    <div class="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={sets.length >= LIMITS.sets}
        onclick={() => sets.push(emptySet())}
      >
        Add rule set
      </Button>
      <div class="flex-1"></div>
      <Button type="button" size="sm" disabled={!dirty || submitting} onclick={save}>
        {sets.length ? 'Save rules' : 'Save (clears the rules)'}
      </Button>
    </div>
    {#if error}<ErrorAlert message={error} />{/if}
  </Card.Content>
</Card.Root>
