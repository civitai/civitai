import { describe, expect, it } from 'vitest';
import { blockEventBatchSchema } from '~/server/schema/track.schema';
import { modelFileUpsertSchema } from '~/server/schema/model-file.schema';
import { clickupWebhookSchema, hqWebhookSchema } from '~/server/schema/bug.schema';
import { getFlaggedModelsSchema } from '~/server/schema/model-flag.schema';
import { getBuzzTransactionResponse } from '~/server/schema/buzz.schema';
import { appStorageSetInput } from '~/server/services/apps/app-storage.service';

// From zod 4.4 an object key whose schema accepts `undefined` without `.optional()` (z.unknown(),
// z.any(), z.undefined()) must be PRESENT; an absent key fails with `expected nonoptional`. Each
// schema here accepted the key absent before, and its callers omit it.

describe('keys a caller may leave out', () => {
  it('a model file upsert without an id is a create', () => {
    const create = {
      name: 'model.safetensors',
      url: 'https://example.com/model.safetensors',
      sizeKB: 1,
      type: 'Model',
      modelVersionId: 1,
    };
    const parsed = modelFileUpsertSchema.parse(create);
    expect(parsed).toMatchObject(create);
    expect('id' in parsed).toBe(false);
  });

  it('one block event without an eventName does not reject the batch', () => {
    const parsed = blockEventBatchSchema.parse({
      events: [
        { appBlockId: 'a', blockInstanceId: 'i', eventName: 'opened' },
        { appBlockId: 'a', blockInstanceId: 'i' },
      ],
    });
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[0].eventName).toBe('opened');
  });

  it('an HQ webhook without data', () => {
    expect(hqWebhookSchema.parse({ type: 'task.updated' })).toEqual({ type: 'task.updated' });
  });

  it('a ClickUp history item without after', () => {
    const parsed = clickupWebhookSchema.parse({
      event: 'taskUpdated',
      history_items: [{ field: 'name' }],
    });
    expect(parsed.history_items).toEqual([{ field: 'name' }]);
  });

  it('a flagged-model filter without a value', () => {
    const parsed = getFlaggedModelsSchema.parse({ filters: [{ id: 'name' }] });
    expect(parsed.filters).toEqual([{ id: 'name' }]);
  });

  it('an app-storage write without a value', () => {
    expect(appStorageSetInput.parse({ key: 'k' })).toEqual({ key: 'k' });
  });

  it('a buzz transaction without a type reads as no type', () => {
    const { type } = getBuzzTransactionResponse.parse({
      date: '2026-08-31T00:05:00',
      fromAccountId: 0,
      toAccountId: 1,
      fromAccountType: 'User',
      toAccountType: 'User',
      amount: 10,
    });
    expect(type).toBeUndefined();
  });
});
