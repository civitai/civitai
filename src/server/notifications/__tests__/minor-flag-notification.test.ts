import { describe, expect, it } from 'vitest';
import { minorFlagNotifications } from '~/server/notifications/minor-flag.notifications';

type Def = (typeof minorFlagNotifications)['model-flagged-minor'];
const def = (minorFlagNotifications as Record<string, Def>)['model-flagged-minor'];

const LAST_SENT = '2026-07-30 00:00:00';
const query = () =>
  def.prepareQuery!({ lastSent: LAST_SENT, lastSentDate: new Date(0), clickhouse: undefined }) as string;

describe('model-flagged-minor — registration shape', () => {
  it('is a non-toggleable System notification', () => {
    expect(def).toBeTruthy();
    expect(def.category).toBe('System');
    expect(def.toggleable).toBe(false);
  });
});

describe('model-flagged-minor — prepareMessage', () => {
  it('renders the agreed copy and links to the model', () => {
    const m = def.prepareMessage({
      type: 'model-flagged-minor',
      details: { modelId: 42, modelName: 'Cool Model' },
    } as Parameters<Def['prepareMessage']>[0]);

    expect(m!.message).toBe(
      'Your model Cool Model has been marked as depicting a minor. If you believe this is a mistake, contact support.'
    );
    expect(m!.url).toBe('/models/42/cool-model');
  });

  it('names no hash, no matched model, and no restriction detail', () => {
    const m = def.prepareMessage({
      type: 'model-flagged-minor',
      details: { modelId: 42, modelName: 'Cool Model' },
    } as Parameters<Def['prepareMessage']>[0]);

    for (const leak of ['hash', 'sha', 'sfwOnly', 'nsfw', 'gallery', 'locked', 'automat']) {
      expect(m!.message.toLowerCase()).not.toContain(leak);
    }
  });

  it('returns undefined when details are empty', () => {
    expect(
      def.prepareMessage({ type: 'model-flagged-minor', details: {} } as Parameters<
        Def['prepareMessage']
      >[0])
    ).toBeUndefined();
  });
});

describe('model-flagged-minor — prepareQuery', () => {
  it('matches confirmedFrom before source, so a confirmed auto-flag still notifies', () => {
    const sql = query();
    expect(sql).toContain("m.meta->'minorFlagSnapshot'->>'confirmedFrom'");
    expect(sql).toContain("m.meta->'minorFlagSnapshot'->>'source'");
    expect(sql).toMatch(/COALESCE\(\s*m\.meta->'minorFlagSnapshot'->>'confirmedFrom'/);
  });

  it('bounds on the snapshot timestamp against lastSent', () => {
    const sql = query();
    expect(sql).toContain("(m.meta->'minorFlagSnapshot'->>'at')::timestamptz");
    expect(sql).toContain(LAST_SENT);
  });

  it('excludes the system user that deleted models are reassigned to', () => {
    expect(query()).toContain('m."userId" <> -1');
  });

  it('emits the notification type and a key scoped to model + window', () => {
    const sql = query();
    expect(sql).toContain("'model-flagged-minor' \"type\"");
    expect(sql).toContain("concat('model-flagged-minor:', details->>'modelId'");
  });

  it('requires the model to currently be minor, so a stale or undone snapshot does not notify', () => {
    expect(query()).toMatch(/AND\s+m\.minor\s*\n/);
  });
});
