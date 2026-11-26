<!-- Temporary: remove after the Knights v2 launch import -->
<script lang="ts">
  import {
    addChunk,
    emptyTotals,
    skippedText,
    splitCsv,
    type ChunkResponse,
  } from '$lib/yesno-import-chunks';

  type Response = ChunkResponse & { ok: boolean; message?: string };

  let file = $state<File | null>(null);
  let dryRun = $state(true);
  let running = $state(false);
  let totals = $state(emptyTotals());
  let errors = $state<string[]>([]);
  let progress = $state('');
  let finishedDry = $state(false);

  async function run() {
    if (!file || running) return;
    running = true;
    totals = emptyTotals();
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
          totals = addChunk(totals, body);
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
      <li>Moderated (left as a moderator set them): {totals.moderated}</li>
      <li>Retired: {totals.retired}</li>
    {/if}
    <li>Skipped: {skippedText(totals.skipped)}</li>
  </ul>
{/if}

{#if errors.length > 0}
  <h2>Errors</h2>
  <ul>
    {#each errors as message (message)}<li>{message}</li>{/each}
  </ul>
{/if}
