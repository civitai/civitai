import path from 'path';
import { describe, expect, it } from 'vitest';
import ledger from './axiom-field-ledger.json';
import { scanRepo, scanSource } from './axiom-field-scan';

/**
 * The main Axiom dataset is at its field limit. A key first written after the limit never becomes
 * a field, so a query or monitor on it sees nothing, and ingest reports no error. Every new
 * `logToAxiom` key goes under the `payload` map field, which holds any number of keys as one field.
 *
 * 🔴 A RATCHET over `axiom-field-ledger.json`, built from the code's own keys:
 * - `knownFields`: paths the code writes that ARE fields. Writing one again is free. An entry
 *   whose last writer is gone may stay: it is still a field until the dataset is vacuumed.
 * - `knownDropped`: paths the code writes that are NOT fields, so they are lost today, with how
 *   many call sites write each. A new writer of a dropped key fails like a new key does.
 * - `opaque`: per file, what the scan cannot see into (a spread, a non-literal argument, the
 *   logger passed around as a value). A new one fails.
 * Every count is exact, so a removal fails too until its entry is lowered or deleted.
 *
 * Not seen: keys added inside another file's wrapper, or under an object passed by reference
 * (`details: result`), whose subkeys flatten to fields too.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const LEDGER = 'src/server/services/__tests__/axiom-field-ledger.json';

const NEW_KEY = `A logToAxiom call to the main dataset writes a key that is not an Axiom field. The dataset is at its field limit, so the key is dropped.
Put it under \`payload\`: logToAxiom({ name, type, message, payload: { yourKey } }).
Add it to knownFields in ${LEDGER} only after confirming the dataset has a free field slot.`;
const DROPPED_COUNT = `A dropped key's writer count changed (${LEDGER} knownDropped). A higher count is a new writer of a key Axiom drops: put it under \`payload\`. A lower one is a key you moved or removed: set the entry to the received count, or delete it at 0.`;
const OPAQUE_COUNT = `A file's opaque count changed (${LEDGER} opaque). Higher: a new spread, non-literal argument or passed-around logger the scan cannot check; write the keys literally, or put them under \`payload\`. Lower: set the entry to the received count, or delete it at 0.`;

describe('no-new-axiom-field', () => {
  it('the scan sees what it must and nothing else (positive and negative control)', () => {
    const sample = [
      `import { logToAxiom as aliased } from '~/server/logging/client';`,
      `logToAxiom({ name: 'x', type: 'info', brandNewKey: 1, nested: { child: 2 }, payload: { free: 1 }, error: { e: 1 } });`,
      `// logToAxiom({ commentedOut: 1 });`,
      `logToAxiom({ otherDataset: 1 }, 'webhooks');`,
      `logToAxiom({ ...unknown });`,
      `const log = (data: object) => logToAxiom({ ...data });`,
      `log({ viaWrapper: 1 });`,
      `console.log({ notAWrapperCall: 1 });`,
      `logToAxiom({ branch: cond ? { a: 1 } : { b: 2 }, maybe: x && { c: 3 } });`,
      `function later() { const ev = { first: 1 }; ev.second = 2; ev[k] = 3; logToAxiom(ev); }`,
      `function shadow() { const ev = { notThisOne: 1 }; }`,
      `function other(ev: object) { logToAxiom(ev); }`,
      `logToAxiom({ ...safeError(e) });`,
      `aliased({ viaAlias: 1 });`,
      `run({ log: logToAxiom });`,
    ].join('\n');
    const r = scanSource('src/sample.ts', sample);
    expect([...r.paths.keys()].sort()).toEqual([
      'branch.a',
      'branch.b',
      'brandNewKey',
      'causeMessage',
      'code',
      'first',
      'innerMessage',
      'innerName',
      'innerStack',
      'maybe.c',
      'message',
      'name',
      'nested.child',
      'second',
      'stack',
      'type',
      'viaAlias',
      'viaWrapper',
    ]);
    // `...unknown`, `ev[k]`, the `other(ev)` parameter argument, and `{ log: logToAxiom }`.
    expect(Object.fromEntries(r.opaque)).toEqual({ 'src/sample.ts': 4 });
  });

  const scan = scanRepo(REPO_ROOT);
  const known = new Set(ledger.knownFields);
  const dropped: Record<string, number> = ledger.knownDropped;

  it('the repo scan found call sites (a zero would make the checks below vacuous)', () => {
    expect(scan.calls).toBeGreaterThan(1000);
    expect(scan.paths.has('name')).toBe(true);
  });

  it('no logToAxiom key outside the ledger', () => {
    const unlisted = [...scan.paths]
      .filter(([p]) => !known.has(p) && !(p in dropped))
      .map(([p, at]) => `${p}  (${at.join(', ')})`);
    expect(unlisted, NEW_KEY).toEqual([]);
  });

  it('dropped keys keep exactly their ledgered writers', () => {
    const counts = Object.fromEntries(
      [...scan.paths]
        .filter(([p]) => p in dropped && !known.has(p))
        .map(([p, at]) => [p, at.length])
    );
    expect(counts, DROPPED_COUNT).toEqual(dropped);
  });

  it('opaque call-site counts match the ledger', () => {
    expect(Object.fromEntries(scan.opaque), OPAQUE_COUNT).toEqual(ledger.opaque);
  });
});
