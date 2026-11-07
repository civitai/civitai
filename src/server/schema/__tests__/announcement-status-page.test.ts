import { describe, expect, it } from 'vitest';
import {
  announcementMetaSchema,
  upsertAnnouncementSchema,
} from '~/server/schema/announcement.schema';

const base = { title: 't', content: 'c', color: 'blue' };

describe('metadata.statusPage', () => {
  it('survives the upsert input', () => {
    const parsed = upsertAnnouncementSchema.parse({ ...base, metadata: { statusPage: true } });
    expect(parsed.metadata.statusPage).toBe(true);
  });

  it('keeps an explicit false', () => {
    const parsed = upsertAnnouncementSchema.parse({ ...base, metadata: { statusPage: false } });
    expect(parsed.metadata.statusPage).toBe(false);
  });

  // `.partial()` over `.default(false)` still applies the default on this zod version,
  // so an absent key is saved as an explicit false.
  it('saves an absent flag as off', () => {
    const parsed = upsertAnnouncementSchema.parse({ ...base, metadata: {} });
    expect(parsed.metadata.statusPage).toBe(false);
  });

  it('reads stored metadata that predates the flag as off', () => {
    const legacy = announcementMetaSchema.parse({
      dismissible: false,
      targetAudience: 'authenticated',
    });
    expect(legacy.statusPage).toBe(false);
    expect(legacy.dismissible).toBe(false);
  });

  it('rejects a non-boolean flag', () => {
    expect(() =>
      upsertAnnouncementSchema.parse({ ...base, metadata: { statusPage: 'yes' } })
    ).toThrow();
  });
});
