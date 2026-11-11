<!-- Temporary: remove after the Knights v2 launch import -->
<script lang="ts">
  import { splitCsv } from '$lib/yesno-import-chunks';

  type Counts = {
    read: number;
    toImport: number;
    inserted: number;
    updated: number;
    unchanged: number;
    refused: number;
    skipped: number;
    retired: number;
  };
  type Response = {
    ok: boolean;
    message?: string;
    read: number;
    toImport: number;
    skipped: Record<string, number>;
    retire: number;
    result?: Record<'inserted' | 'updated' | 'unchanged' | 'refused' | 'retired', number>;
  };

  const empty = (): Counts => ({
    read: 0,
    toImport: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    refused: 0,
    skipped: 0,
    retired: 0,
  });

  let file = $state<File | null>(null);
  let dryRun = $state(true);
  let running = $state(false);
  let totals = $state(empty());
  let errors = $state<string[]>([]);
  let progress = $state('');
  let finishedDry = $state(false);

  async function run() {
    if (!file || running) return;
    running = true;
    totals = empty();
    errors = [];
    finishedDry = dryRun;
    try {
      const { chunks, rows } = splitCsv(await file.text(), {});
      for (const [index, chunk] of chunks.entries()) {
        progress = `Chunk ${index + 1} of ${chunks.length} (${rows} rows)`;
        try {
          const response = await fetch('', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ csv: chunk.csv, dryRun }),
          });
          const body = (await response.json()) as Response;
          if (!response.ok || !body.ok) {
            errors.push(`Chunk ${index + 1}: ${body.message ?? response.statusText}`);
            continue;
          }
          totals.read += body.read;
          totals.toImport += body.toImport;
          totals.skipped += Object.values(body.skipped).reduce((a, b) => a + b, 0);
          totals.inserted += body.result?.inserted ?? 0;
          totals.updated += body.result?.updated ?? 0;
          totals.unchanged += body.result?.unchanged ?? 0;
          totals.refused += body.result?.refused ?? 0;
          totals.retired += body.result?.retired ?? 0;
        } catch (error) {
          errors.push(`Chunk ${index + 1}: ${error instanceof Error ? error.message : 'failed'}`);
        }
      }
      progress = `Done: ${chunks.length} chunks, ${errors.length} failed.`;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Could not read the file.');
      progress = '';
    } finally {
      running = false;
    }
  }
</script>

<svelte:head>
  <title>Yes/no import (temporary) · Knights of New Order</title>
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<h1>Yes/no question import</h1>
<p class="muted">
  Temporary, moderators only. Upload only the cleaned file. The file is split in your browser and sent a
  few hundred rows at a time; importing is idempotent per question id, so a failed chunk can simply be
  run again.
</p>

<form
  onsubmit={(event) => {
    event.preventDefault();
    void run();
  }}
>
  <label>
    CSV file
    <input
      type="file"
      accept=".csv,text/csv"
      disabled={running}
      onchange={(event) => (file = event.currentTarget.files?.[0] ?? null)}
    />
  </label>
  <label>
    <input type="checkbox" bind:checked={dryRun} disabled={running} />
    Dry run (nothing is written)
  </label>
  <button type="submit" disabled={!file || running}>{dryRun ? 'Dry run' : 'Import'}</button>
</form>

{#if progress}<p aria-live="polite">{progress}</p>{/if}

{#if totals.read > 0 || errors.length > 0}
  <h2>{finishedDry ? 'Dry run totals' : 'Totals'}</h2>
  <ul>
    <li>Read: {totals.read}</li>
    <li>{finishedDry ? 'Would import' : 'To import'}: {totals.toImport}</li>
    {#if !finishedDry}
      <li>Inserted: {totals.inserted}</li>
      <li>Updated: {totals.updated}</li>
      <li>Unchanged: {totals.unchanged}</li>
      <li>Refused (changed but already answered): {totals.refused}</li>
      <li>Retired: {totals.retired}</li>
    {/if}
    <li>Skipped (invalid rows): {totals.skipped}</li>
  </ul>
{/if}

{#if errors.length > 0}
  <h2>Errors</h2>
  <ul>
    {#each errors as message (message)}<li>{message}</li>{/each}
  </ul>
{/if}
