import { describe, expect, it } from 'vitest';
import { checkSfwFaceSchema, modelUpsertSchema } from '~/server/schema/model.schema';

/** The .com title takes the .red name's 150 cap in the live check and on save; trailing spaces don't count. */

const base = {
  name: 'Red title',
  type: 'LORA',
  uploadType: 'Created',
  status: 'Draft',
  allowNoCredit: true,
  allowCommercialUse: [],
  allowDerivatives: true,
  allowDifferentLicense: true,
};
const upsert = (fields: object) => modelUpsertSchema.safeParse({ ...base, ...fields });
const messages = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.error?.issues.map((i) => i.message) ?? [];

describe('.com face caps', () => {
  it('saves a 150-character .com title', () => {
    expect(upsert({ sfwName: 'a'.repeat(150) }).success).toBe(true);
  });

  it('refuses a 151-character .com title with a length message', () => {
    const r = upsert({ sfwName: 'a'.repeat(151) });
    expect(r.success).toBe(false);
    expect(messages(r)).toContain('Title must be 150 characters or fewer.');
  });

  it('refuses a .com description over 50,000 characters on save', () => {
    expect(upsert({ sfwDescription: 'a'.repeat(50_000) }).success).toBe(true);
    const r = upsert({ sfwDescription: 'a'.repeat(50_001) });
    expect(r.success).toBe(false);
    expect(messages(r)).toContain('Description is too long.');
  });

  it('the live check takes the same title cap as save', () => {
    expect(checkSfwFaceSchema.safeParse({ sfwName: 'a'.repeat(150) }).success).toBe(true);
    expect(checkSfwFaceSchema.safeParse({ sfwName: `${'a'.repeat(150)} ` }).success).toBe(true);
    expect(upsert({ sfwName: `${'a'.repeat(150)} ` }).success).toBe(true);
    expect(checkSfwFaceSchema.safeParse({ sfwName: 'a'.repeat(151) }).success).toBe(false);
  });
});
