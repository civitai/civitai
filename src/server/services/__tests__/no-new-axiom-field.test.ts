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
 * - `knownDropped`: paths the code writes that are NOT fields, so they are lost today. Moving
 *   one under `payload` deletes its entry; the list may only shrink.
 * - `opaque`: per file, the spreads and non-literal arguments the scan cannot see into. It may
 *   not grow.
 *
 * Not seen: keys inside a spread, a non-literal argument, a wrapper called from another file, or
 * an object passed by reference (`details: result`), whose subkeys flatten to fields too.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

const MESSAGE = `A logToAxiom call to the main dataset writes a top-level (or nested non-map) key that is not an Axiom field. The dataset is at its field limit, so this key would be dropped.
Put it under \`payload\`: logToAxiom({ name, type, message, payload: { yourKey } }).
Only add it to knownFields in axiom-field-ledger.json after confirming the dataset has a free field slot.`;

describe('no-new-axiom-field', () => {
  it('the scan sees what it must and nothing else (positive and negative control)', () => {
    const sample = [
      `logToAxiom({ name: 'x', type: 'info', brandNewKey: 1, nested: { child: 2 }, payload: { free: 1 }, error: { e: 1 } });`,
      `// logToAxiom({ commentedOut: 1 });`,
      `logToAxiom({ otherDataset: 1 }, 'webhooks');`,
      `logToAxiom({ ...unknown });`,
      `const log = (data: object) => logToAxiom({ name: 'w', ...data });`,
      `log({ viaWrapper: 1 });`,
    ].join('\n');
    const r = scanSource('src/sample.ts', sample);
    expect([...r.paths.keys()].sort()).toEqual([
      'brandNewKey',
      'name',
      'nested.child',
      'type',
      'viaWrapper',
    ]);
    expect(Object.fromEntries(r.opaque)).toEqual({ 'src/sample.ts': 1 });
  });

  const scan = scanRepo(REPO_ROOT);
  const known = new Set(ledger.knownFields);
  const dropped = new Set(ledger.knownDropped);

  it('the repo scan found call sites (a zero would make the checks below vacuous)', () => {
    expect(scan.calls).toBeGreaterThan(1000);
    expect(scan.paths.has('name')).toBe(true);
  });

  it('no logToAxiom key outside the ledger', () => {
    const unlisted = [...scan.paths]
      .filter(([p]) => !known.has(p) && !dropped.has(p))
      .map(([p, at]) => `${p}  (${at.join(', ')})`);
    expect(unlisted, MESSAGE).toEqual([]);
  });

  it('knownDropped lists only keys still written (delete the entry once moved under payload)', () => {
    const stale = ledger.knownDropped.filter((p) => !scan.paths.has(p));
    expect(stale).toEqual([]);
  });

  it('opaque call-site counts match the ledger (new spreads go under payload)', () => {
    expect(Object.fromEntries(scan.opaque), MESSAGE).toEqual(ledger.opaque);
  });

  it('the two key lists do not overlap', () => {
    expect(ledger.knownDropped.filter((p) => known.has(p))).toEqual([]);
  });
});
