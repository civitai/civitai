import { describe, expect, it } from 'vitest';
import { processDefinitionSchema } from '@civitai/moderation/process-definition';
import { checkIntakeValues, submittedUrls, targetsFromUrls } from '../intake-values';

const def = processDefinitionSchema.parse({
  key: 'dmca-notice',
  title: 'DMCA',
  mailbox: 'dmca@civitai.com',
  fields: [
    { id: 'urls', label: 'URLs', kind: 'urlList', required: true },
    { id: 'email', label: 'Email', kind: 'email', required: true },
    { id: 'phone', label: 'Phone', kind: 'text' },
    {
      id: 'relationship',
      label: 'You are',
      kind: 'select',
      required: true,
      options: [{ value: 'owner', label: 'The owner' }],
    },
    { id: 'good-faith', label: 'Good faith', kind: 'checkbox', required: true },
  ],
  states: [{ id: 'received', label: 'Received' }],
  initialState: 'received',
});

const ok = {
  urls: ['https://civitai.com/models/12/x'],
  email: 'a@example.com',
  relationship: 'owner',
  'good-faith': true,
};

describe('checkIntakeValues', () => {
  it('accepts a complete submission', () => {
    expect(checkIntakeValues(def, ok)).toEqual({});
  });

  it('reports every missing required field, an unticked statement included', () => {
    expect(Object.keys(checkIntakeValues(def, {})).sort()).toEqual([
      'email',
      'good-faith',
      'relationship',
      'urls',
    ]);
    expect(checkIntakeValues(def, { ...ok, 'good-faith': false })).toHaveProperty('good-faith');
  });

  it('refuses a field the form does not have', () => {
    expect(checkIntakeValues(def, { ...ok, extra: 'x' })).toHaveProperty('extra');
  });

  it('refuses a bad email, a non-web URL and an option not on the list', () => {
    const errors = checkIntakeValues(def, {
      ...ok,
      email: 'nope',
      urls: ['javascript:alert(1)'],
      relationship: 'other',
    });
    expect(Object.keys(errors).sort()).toEqual(['email', 'relationship', 'urls']);
  });
});

describe('targetsFromUrls', () => {
  it('reads the entity from a Civitai path and leaves other URLs bare', () => {
    expect(
      targetsFromUrls(
        submittedUrls(def, {
          urls: 'https://civitai.com/models/12/name?modelVersionId=99 https://civitai.com/images/7 https://example.com/models/5',
        })
      )
    ).toEqual([
      {
        url: 'https://civitai.com/models/12/name?modelVersionId=99',
        entityType: 'Model',
        entityId: 12,
      },
      { url: 'https://civitai.com/images/7', entityType: 'Image', entityId: 7 },
      { url: 'https://example.com/models/5', entityType: null, entityId: null },
    ]);
  });

  it('does not take an id beyond the database integer range', () => {
    expect(targetsFromUrls(['https://civitai.com/images/99999999999'])[0].entityId).toBeNull();
  });
});
