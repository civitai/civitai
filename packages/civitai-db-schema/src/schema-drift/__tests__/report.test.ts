import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareSchemaToCatalog } from '../compare';
import { parsePrismaSchema } from '../parse-prisma-schema';
import { formatReport } from '../report';
import type { DbCatalog } from '../types';

const here = fileURLToPath(new URL('.', import.meta.url));
const schema = parsePrismaSchema(readFileSync(join(here, 'fixtures/fixture.prisma'), 'utf8'));
const catalog = JSON.parse(
  readFileSync(join(here, 'fixtures/catalog-drifted.json'), 'utf8')
) as DbCatalog;

describe('formatReport', () => {
  const text = formatReport(compareSchemaToCatalog(schema, catalog));

  it('shows the counts for every class', () => {
    expect(text).toContain('MISSING foreign key            : 1');
    expect(text).toContain('wrong referential action       : 2');
    expect(text).toContain('nullability drift              : 2');
    expect(text).toContain('missing unique index           : 1');
  });

  it('names each finding with its table and columns', () => {
    expect(text).toContain('Comment.postId');
    expect(text).toContain('Project.projectId+position');
  });

  it('states what it did NOT check, so a clean section is not read as an all-clear', () => {
    expect(text).toContain('Not checked by this tool');
    for (const unchecked of ['check constraints', 'column defaults', 'column types', 'enum']) {
      expect(text).toContain(unchecked);
    }
    expect(text).toContain('not evidence that they are clean');
  });

  it('lists skipped models only when asked', () => {
    expect(text).not.toContain('Skipped models');
    const verbose = formatReport(compareSchemaToCatalog(schema, catalog), { verbose: true });
    expect(verbose).toContain('Skipped models');
    expect(verbose).toContain('ReportView');
  });
});
