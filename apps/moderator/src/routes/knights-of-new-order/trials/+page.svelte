<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import YesNoPicker from './YesNoPicker.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import LinkTabs from '$lib/components/LinkTabs.svelte';
  import NumberedPager from '$lib/components/NumberedPager.svelte';
  import { urlWith } from '$lib/url';
  import { FormState } from '$lib/form-state.svelte';
  import CoreItemCard from './CoreItemCard.svelte';
  import LevelPicker from './LevelPicker.svelte';
  import ListSearch from './ListSearch.svelte';
  import SpotCheckCard from './SpotCheckCard.svelte';
  import YesNoReferenceCard from './YesNoReferenceCard.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const tabs = $derived([
    { value: 'core', label: `Core set (${data.counts.core})`, href: '?tab=core' },
    { value: 'fresh', label: `Fresh (${data.counts.fresh})`, href: '?tab=fresh' },
    { value: 'spot-check', label: `Spot-check (${data.counts.spotCheck})`, href: '?tab=spot-check' },
    { value: 'yes-no', label: `Yes/No (${data.counts.yesNo})`, href: '?tab=yes-no' },
  ]);
  const nouns = {
    core: 'core images',
    fresh: 'fresh images',
    'spot-check': 'images to spot-check',
    'yes-no': 'pairs',
  } as const;
  const toPage = (p: number) =>
    goto(urlWith(page.url, { page: p === 1 ? null : p }), { keepFocus: true, noScroll: true });
  const empty = {
    core: 'The core set is empty. Add an image above, or promote one from the Fresh tab.',
    fresh: 'No fresh images are in Trials right now. They arrive with the next harvest of moderator rulings.',
    'spot-check': 'Nothing is waiting for a spot-check.',
    'yes-no': 'No yes/no reference pairs yet. Add one above.',
  } as const;

  const noMatch = 'Nothing in this tab matches that image.';
  const searchProps = $derived({
    text: data.search.text,
    error: data.search.error,
    total: data.paging.total,
    noun: nouns[data.tab],
  });

  let level = $state<number | null>(null);
  let answer = $state<'yes' | 'no' | null>(null);
  const addYesNo = new FormState({
    onSuccess: () => {
      answer = null;
      void invalidateAll();
      toast.success('Pair added');
    },
  });
  const add = new FormState({
    onSuccess: () => {
      level = null;
      void invalidateAll();
      toast.success('Added to the core set');
    },
  });
</script>

<header class="page-header">
  <h1>Knights of New Order Trials</h1>
  <p>
    Images Acolytes are tested on. Core images teach: they are always in a run and show their
    explanation after the answer. Fresh images come from recent moderator rulings and are what scores
    a run. Promote a good fresh image to the core set, retire one that misleads, and rate pending
    images blind when the spot-check is on.
  </p>
</header>

<LinkTabs class="mb-4" items={tabs} active={data.tab} />

{#if data.tab === 'core'}
  <section class="mb-6 rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h2 class="mb-2 font-medium">Add a core image</h2>
    {#if add.error}<ErrorAlert class="mb-2" message={add.error} />{/if}
    <form method="POST" action="?/add" use:enhance={add.enhance} class="flex flex-col gap-2">
      <label class="flex items-center gap-2 text-sm text-dark-2">
        Image id
        <Input name="imageId" inputmode="numeric" required class="w-40" />
      </label>
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-sm text-dark-2">Answer</span>
        <LevelPicker bind:value={level} />
      </div>
      <Textarea
        name="explanation"
        rows={2}
        required
        placeholder="Why this rating, shown to Acolytes after they answer"
      />
      <div>
        <Button type="submit" size="sm" disabled={add.submitting || level === null}>Add</Button>
      </div>
    </form>
  </section>
{/if}

{#if data.tab === 'yes-no'}
  <section class="mb-6 rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h2 class="mb-2 font-medium">Add a yes/no reference pair</h2>
    <p class="mb-3 text-sm text-dark-2">
      An image with a known answer to a yes/no question. Acolytes are graded against these; Knights
      and above still decide yes/no questions by consensus.
    </p>
    {#if addYesNo.error}<ErrorAlert class="mb-2" message={addYesNo.error} />{/if}
    <form method="POST" action="?/addYesNo" use:enhance={addYesNo.enhance} class="flex flex-col gap-2">
      <label class="flex items-center gap-2 text-sm text-dark-2">
        Image id or URL
        <Input name="image" required class="w-80" placeholder="123 or https://civitai.com/images/123" />
      </label>
      <label class="flex items-center gap-2 text-sm text-dark-2">
        Question
        <select
          name="questionKey"
          required
          class="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
        >
          <option value="">Pick a question</option>
          {#each data.yesNo.questions as q (q.key)}
            <option value={q.key}>{q.prompt} ({q.key}{q.active ? '' : ', inactive'})</option>
          {/each}
        </select>
      </label>
      <label class="flex items-center gap-2 text-sm text-dark-2">
        Acolytes are asked
        <Input
          name="prompt"
          required
          maxlength={600}
          class="min-w-0 flex-1"
          placeholder="The yes/no question about this image, e.g. Is a weapon being held?"
        />
      </label>
      <div class="flex items-center gap-2">
        <span class="text-sm text-dark-2">Correct answer</span>
        <YesNoPicker value={answer} onchange={(v) => (answer = v)} />
      </div>
      <Textarea
        name="explanation"
        rows={2}
        placeholder="Optional: why this is the answer, shown to Acolytes after they answer"
      />
      <div>
        <Button type="submit" size="sm" disabled={addYesNo.submitting || answer === null}>Add</Button>
      </div>
    </form>
  </section>
  <ListSearch {...searchProps} />
  {#if data.yesNo.items.length === 0}
    <p class="text-sm text-dark-2">{data.search.text ? noMatch : empty['yes-no']}</p>
  {:else}
    <div class="flex flex-col gap-3">
      {#each data.yesNo.items as item (item.id)}
        <YesNoReferenceCard {item} />
      {/each}
    </div>
  {/if}
{:else if data.tab === 'spot-check'}
  <p class="mb-3 text-sm text-dark-2">
    Rate each image without seeing the rating it was harvested with. A match lets it into Trials; a
    different rating keeps it out.
  </p>
  <ListSearch {...searchProps} />
  {#if data.spotCheck.length === 0}
    <p class="text-sm text-dark-2">{data.search.text ? noMatch : empty['spot-check']}</p>
  {:else}
    <div class="flex flex-col gap-3">
      {#each data.spotCheck as item (item.id)}
        <SpotCheckCard {item} />
      {/each}
    </div>
  {/if}
{:else}
  {#if data.tab === 'fresh'}
    <p class="mb-3 text-sm text-dark-2">
      Flagged images are those Acolytes miss at a high rate once enough have answered (at least
      {data.flagRule.minAnswers} answers, {Math.round(data.flagRule.failureRate * 100)}% missed). Look
      at them first: the rating may be wrong. Fresh images age out on their own.
    </p>
  {/if}
  {#key data.tab}<ListSearch {...searchProps} />{/key}
  {#if data.items.length === 0}
    <p class="text-sm text-dark-2">{data.search.text ? noMatch : empty[data.tab]}</p>
  {:else}
    <div class="flex flex-col gap-3">
      {#each data.items as item (item.id)}
        <CoreItemCard {item} mode={data.tab === 'fresh' ? 'fresh' : 'core'} />
      {/each}
    </div>
  {/if}
{/if}

<NumberedPager
  page={data.paging.page}
  total={data.paging.total}
  perPage={data.pageSize}
  label={nouns[data.tab]}
  onPageChange={toPage}
/>
