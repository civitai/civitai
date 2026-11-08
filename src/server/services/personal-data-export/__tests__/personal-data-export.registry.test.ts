import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { EXCLUDED, REGISTRY } from '../registry';

/**
 * The export's table list is a decision per table. A model that references a user must be either
 * exported (REGISTRY) or excluded with a reason (EXCLUDED): this fails for a new one that is in
 * neither, so it cannot be silently left out of an access request, or silently put in.
 */

const models = Prisma.dmmf.datamodel.models;

/** Columns of a model that hold a user id: relations to User, and bare user-id columns. */
function userColumns(model: (typeof models)[number]): string[] {
  const rel = new Set<string>();
  for (const f of model.fields)
    if (f.kind === 'object' && f.type === 'User')
      for (const c of f.relationFromFields ?? []) rel.add(c);
  for (const f of model.fields)
    if (
      f.kind === 'scalar' &&
      /^(userId|ownerId|creatorId|\w*UserId)$/.test(f.name) &&
      !f.name.startsWith('old')
    )
      rel.add(f.name);
  return [...rel];
}

const userKeyed = models.filter((m) => userColumns(m).length > 0);

describe('personal-data-export registry', () => {
  it('covers every model that references a user, exactly once', () => {
    const unclassified = userKeyed
      .map((m) => m.name)
      .filter((name) => !(name in REGISTRY) && !(name in EXCLUDED));
    const both = Object.keys(REGISTRY).filter((name) => name in EXCLUDED);
    expect(unclassified).toEqual([]);
    expect(both).toEqual([]);
    // Positive control on the scan itself: it sees the tables the export is built around.
    expect(userKeyed.map((m) => m.name)).toEqual(
      expect.arrayContaining(['UserProfile', 'Image', 'Account'])
    );
    expect(userKeyed.length).toBeGreaterThan(150);
  });

  it('classifies every user column of an exported table as subject, staff or other user', () => {
    const loose: string[] = [];
    for (const [name, entry] of Object.entries(REGISTRY)) {
      const model = models.find((m) => m.name === name);
      if (!model) {
        loose.push(`${name}: not a model`);
        continue;
      }
      const known = new Set([...entry.subject, ...(entry.staff ?? []), ...(entry.others ?? [])]);
      for (const c of userColumns(model)) if (!known.has(c)) loose.push(`${name}.${c}`);
      for (const c of known)
        if (!model.fields.some((f) => f.name === c)) loose.push(`${name}.${c}: not a field`);
      if (!entry.subject.length) loose.push(`${name}: no subject column`);
    }
    expect(loose).toEqual([]);
  });

  it('never exports a safety or legal-hold record', () => {
    // The account owner reading these would learn of a report or an investigation.
    const safety = models
      .map((m) => m.name)
      .filter((n) => /^(Csam|Evidence)/.test(n) && userKeyed.some((m) => m.name === n));
    expect(safety.length).toBeGreaterThan(3);
    expect(safety.filter((n) => n in REGISTRY)).toEqual([]);
    expect('PersonalDataExport' in REGISTRY).toBe(false);
    expect('ModActivity' in REGISTRY).toBe(false);
  });
});
