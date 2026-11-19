import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { fillCoverNote } from '../cover-note';
import { personalDataExportReadyHtml } from '~/server/email/templates/personalDataExport.email';

vi.setConfig({ testTimeout: 60_000 });

const MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20261225120000_personal_data_export/migration.sql'
);

describe('PersonalDataExport migration', () => {
  it('refuses a second in-flight export for a user, and allows one once the first is done', async () => {
    const db = new PGlite();
    // Both migrations, in the order they are applied.
    for (const f of [
      MIGRATION,
      MIGRATION.replace(
        '20261225120000_personal_data_export',
        '20261228120000_personal_data_export_request'
      ),
    ])
      await db.exec(readFileSync(f, 'utf8'));
    const queue = (userId: number) =>
      db.query(
        `INSERT INTO "PersonalDataExport" ("userId", "requestedById") VALUES ($1, 9) RETURNING id`,
        [userId]
      );

    const first = await queue(1);
    await expect(queue(1)).rejects.toThrow(/PersonalDataExport_userId_in_flight_key/);
    await queue(2); // another user is unaffected

    await db.query(`UPDATE "PersonalDataExport" SET status = 'building' WHERE id = $1`, [
      (first.rows[0] as { id: number }).id,
    ]);
    await expect(queue(1)).rejects.toThrow(/in_flight_key/);

    await db.query(`UPDATE "PersonalDataExport" SET status = 'built' WHERE id = $1`, [
      (first.rows[0] as { id: number }).id,
    ]);
    await expect(queue(1)).resolves.toBeTruthy();

    // A release must say who and when; a status outside the set is refused.
    await expect(
      db.query(`UPDATE "PersonalDataExport" SET status = 'released' WHERE id = $1`, [
        (first.rows[0] as { id: number }).id,
      ])
    ).rejects.toThrow(/release_logged_check/);
    await expect(
      db.query(`UPDATE "PersonalDataExport" SET status = 'sent' WHERE id = $1`, [
        (first.rows[0] as { id: number }).id,
      ])
    ).rejects.toThrow(/status_check/);
    await db.close();
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('personal-data-export imports', () => {
  /**
   * 🔴 Fetching a workflow through the orchestrator can activate it, and an activated workflow can
   * refund Buzz. The export reads stored documents only; nothing in it may reach the orchestrator.
   */
  it('imports nothing that talks to the orchestrator', () => {
    const files = [
      ...sourceFiles(path.resolve(__dirname, '..')),
      path.resolve(__dirname, '../../../jobs/build-personal-data-exports.ts'),
    ];
    expect(files.length).toBeGreaterThan(8);
    // `from 'x'`, a bare `import 'x'` and `import('x')`: all three load the module.
    const forbidden =
      /(?:\bfrom\s+|\bimport\s*\(?\s*)['"](~\/server\/http\/orchestrator[^'"]*|~\/server\/services\/orchestrator[^'"]*|@civitai\/client[^'"]*|~\/server\/orchestrator[^'"]*)['"]/;
    const offenders = files.filter((f) => forbidden.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
    // Control: the pattern does match an orchestrator import.
    expect(
      forbidden.test(`import { getWorkflow } from '~/server/services/orchestrator/workflows';`)
    ).toBe(true);
    expect(forbidden.test(`import { getWorkflow } from '@civitai/client';`)).toBe(true);
    expect(forbidden.test(`import '~/server/services/orchestrator/common';`)).toBe(true);
    expect(forbidden.test(`await import('~/server/http/orchestrator/x');`)).toBe(true);
  });
});

describe('cover note', () => {
  it('fills every placeholder, literally', () => {
    const text = fillCoverNote({
      username: 'a$&b',
      link: 'https://x/y?$1',
      takenAt: new Date('2026-11-06T15:15:00Z'),
    });
    expect(text).not.toMatch(/\{(username|link|taken_at)\}/);
    expect(text).toContain('Hi a$&b,');
    expect(text).toContain('https://x/y?$1');
    expect(text).toContain('November 6th, 2026 at 3:15 PM UTC');
  });

  /** Signed off by Legal, verbatim: change only with the same sign-off. */
  it('tells the owner, in "What\'s in it", that the manifest says what could not be included', () => {
    const text = fillCoverNote({
      username: 'u',
      link: 'l',
      takenAt: new Date('2026-11-06T15:15:00Z'),
    });
    const whatsInIt = text.split('\n').find((l) => l.startsWith("**What's in it.**"))!;
    expect(whatsInIt).toContain(
      'If any part could not be included in this archive, the manifest says so and why. If you would like us to look into it further, reply to this message.'
    );
  });

  it('escapes the username and link in the email', () => {
    const html = personalDataExportReadyHtml({
      username: '<script>x</script>',
      link: 'https://x/"onmouseover',
      takenAt: new Date('2026-11-06T15:15:00Z'),
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('"onmouseover');
    expect(html).not.toMatch(/\{(username|link|taken_at)\}/);
  });
});
