/**
 * GitHub Actions annotations for the test-file typecheck ratchet
 * (`typecheck-tests-gate.mjs`).
 *
 * Turns each blocking diagnostic into an `::error` workflow command so the check
 * run carries file, line, column and TS code. Pure: no environment reads or
 * printing; the gate decides whether it is running under Actions.
 */

// GitHub keeps at most 10 error annotations per step; further `::error` lines
// are dropped from the check run.
export const MAX_ERROR_ANNOTATIONS = 10;

// Workflow-command escaping, as in @actions/core's `escapeData`/`escapeProperty`.
export function escapeData(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function escapeProperty(value) {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

const byPosition = (a, b) => a.line - b.line || a.col - b.col;

/**
 * The diagnostics that made the gate block, most useful first.
 *
 * Every error in a file that is NOT in the baseline is new, so those come first.
 * A baselined file that got worse is listed after them, and all of its errors are
 * included: the baseline is a per-file count, so the gate cannot tell which of
 * them is the new one. Within each group files are interleaved round-robin
 * (first error of every file, then the second, …) so the 10 annotations GitHub
 * keeps cover as many files as possible; within a file, by line and column.
 *
 * Returns `[{ diagnostic, worsened: null | { was, now } }]`.
 */
export function selectBlockingDiagnostics(diagnostics, result) {
  const byFile = new Map();
  for (const d of diagnostics ?? []) {
    if (!byFile.has(d.file)) byFile.set(d.file, []);
    byFile.get(d.file).push(d);
  }

  const roundRobin = (entries) => {
    const queues = entries
      .map(({ file, worsened }) => ({
        worsened,
        items: [...(byFile.get(file) ?? [])].sort(byPosition),
      }))
      .filter((q) => q.items.length);
    const out = [];
    for (let i = 0; queues.some((q) => i < q.items.length); i++) {
      for (const q of queues) {
        if (i < q.items.length) out.push({ diagnostic: q.items[i], worsened: q.worsened });
      }
    }
    return out;
  };

  return [
    ...roundRobin((result?.newlyDirty ?? []).map(({ file }) => ({ file, worsened: null }))),
    ...roundRobin(
      (result?.worsened ?? []).map(({ file, was, now }) => ({ file, worsened: { was, now } }))
    ),
  ];
}

function errorCommand({ diagnostic: d, worsened }) {
  const message = worsened
    ? `${d.message}\n(Baselined file, ${worsened.was} -> ${worsened.now} errors: the gate ` +
      'counts per file, so this may be one of the existing ones.)'
    : d.message;
  return (
    `::error file=${escapeProperty(d.file)},line=${d.line},col=${d.col},` +
    `title=${escapeProperty(`TS${d.code}`)}::${escapeData(message)}`
  );
}

/**
 * The lines to print for a blocked run: one `::error` per blocking diagnostic up
 * to `max`, then — only if there are more — the rest as plain log lines and a
 * final `::notice` saying how many there are.
 * Returns `[]` when the run did not block.
 */
export function formatAnnotations({ diagnostics, result, max = MAX_ERROR_ANNOTATIONS }) {
  if (!result?.blocked) return [];
  const selected = selectBlockingDiagnostics(diagnostics, result);
  const lines = selected.slice(0, max).map(errorCommand);
  const rest = selected.slice(max);
  if (rest.length) {
    lines.push(`typecheck-tests-gate: ${rest.length} more blocking diagnostic(s), not annotated:`);
    for (const { diagnostic: d } of rest) {
      lines.push(`${d.file}:${d.line}:${d.col} TS${d.code} ${d.message.split('\n')[0]}`);
    }
    lines.push(
      `::notice title=typecheck-tests-gate::${rest.length} more blocking type error(s) are listed ` +
        `in the job log (GitHub keeps ${max} error annotations per step).`
    );
  }
  return lines;
}
