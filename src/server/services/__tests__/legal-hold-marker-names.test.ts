import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HOLD_MARKER_TABLE, HOLD_MARKER_VIEW } from '~/server/services/legal-hold.service';

const SCHEMA_DIR = fileURLToPath(
  new URL('../../../../packages/civitai-db-schema/prisma/', import.meta.url)
);
const migrationsSql = () => {
  const dir = join(SCHEMA_DIR, 'migrations');
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      try {
        return readFileSync(join(dir, d.name, 'migration.sql'), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
};
const created = (kind: 'VIEW' | 'TABLE', prefix: string) =>
  [
    ...migrationsSql().matchAll(
      new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?${kind}\\s+"(${prefix}\\w*)"`, 'g')
    ),
  ].map((m) => m[1]);

// The account-deletion guard looks the marker up by name and treats it as absent while it is, so a
// rename would turn it off without a sound. Once a migration creates them, they must be these names.
describe('the hold marker account deletion checks', () => {
  it('is the view a migration creates, if one does', () => {
    const views = created('VIEW', 'EvidenceHeld');
    if (views.length) expect(views).toContain(HOLD_MARKER_VIEW);
    else expect(HOLD_MARKER_VIEW).toBe('EvidenceHeldUser');
  });

  it('is backed by the table a migration creates, if one does', () => {
    const tables = created('TABLE', 'EvidenceHold');
    if (tables.length) expect(tables).toContain(HOLD_MARKER_TABLE);
    else expect(HOLD_MARKER_TABLE).toBe('EvidenceHold');
  });

  it('is not renamed by a Prisma @@map', () => {
    const schema = readFileSync(join(SCHEMA_DIR, 'schema.full.prisma'), 'utf8');
    const models = [...schema.matchAll(/^model (EvidenceHold|EvidenceHeldUser) \{([\s\S]*?)^\}/gm)];
    for (const [, , body] of models) expect(body).not.toMatch(/@@map\(/);
  });

  it('CONTROL: the migration scan finds a table it knows exists', () => {
    expect(created('TABLE', 'CsamReport')).toContain('CsamReport');
  });

  it('CONTROL: the migration scan finds a view it knows exists', () => {
    expect(created('VIEW', 'ModelReportStat')).toContain('ModelReportStat');
  });

  // The two pins above pass on an empty scan. Once a migration names the marker, the scan must see
  // what it creates, or a CREATE written another way would switch them off.
  it('sees the marker in any migration that names it', () => {
    if (!migrationsSql().includes('EvidenceHold')) return;
    expect(created('VIEW', 'EvidenceHeld').length).toBeGreaterThan(0);
    expect(created('TABLE', 'EvidenceHold').length).toBeGreaterThan(0);
  });
});
