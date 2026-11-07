import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { notificationProcessors } from '~/server/notifications/utils.notifications';

/**
 * An `externalProducer` type is sent by one other app, which decides the recipients, the daily cap
 * and the access rule. `createNotification` applies none of that (and, for an `optIn` type, would
 * drop exactly the subscribers), so only the owning app's bulk send may deliver it.
 *
 * A source scan: it catches only a literal type name in a file that calls `createNotification(`,
 * not a type held in a variable or built at runtime.
 */
const ROOTS = ['src', 'apps/notifications/src'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const externalTypes = Object.entries(notificationProcessors)
  .filter(([, processor]) => processor.externalProducer)
  .map(([type]) => type);

describe('externalProducer types', () => {
  it('exist, so the scan below is not vacuous', () => {
    expect(externalTypes.length).toBeGreaterThan(0);
  });

  it('are never sent through createNotification', () => {
    const offenders: string[] = [];
    for (const file of ROOTS.flatMap(sourceFiles)) {
      const source = readFileSync(file, 'utf8');
      if (!/\bcreateNotification\(/.test(source)) continue;
      for (const type of externalTypes) {
        if (source.includes(`'${type}'`) || source.includes(`"${type}"`)) {
          offenders.push(`${file}: ${type}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
