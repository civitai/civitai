import { describe, expect, it } from 'vitest';

import {
  applicableMessagesFor,
  generatorMessageSchema,
  messageDismissId,
  messagesForSelection,
  type GeneratorMessage,
} from './messages';

const message = (overrides: Partial<GeneratorMessage> = {}): GeneratorMessage =>
  generatorMessageSchema.parse({
    id: 'm1',
    kind: 'pricing',
    message: 'Prices change on the 15th.',
    dismissible: true,
    ...overrides,
  });

describe('applicableMessagesFor', () => {
  const free = { isMember: false, tier: 'free' };
  const gold = { isMember: true, tier: 'gold' };

  it('sends an untargeted message to everyone', () => {
    const messages = [message()];
    expect(applicableMessagesFor(messages, free)).toHaveLength(1);
    expect(applicableMessagesFor(messages, gold)).toHaveLength(1);
  });

  it('splits members from non-members', () => {
    const members = message({ id: 'm1', audiences: ['members'] });
    const nonMembers = message({ id: 'm2', audiences: ['nonMembers'] });

    expect(applicableMessagesFor([members, nonMembers], gold).map((m) => m.id)).toEqual(['m1']);
    expect(applicableMessagesFor([members, nonMembers], free).map((m) => m.id)).toEqual(['m2']);
  });

  it('matches a single tier, and takes the union of several audiences', () => {
    const goldOnly = message({ audiences: ['gold'] });
    expect(applicableMessagesFor([goldOnly], gold)).toHaveLength(1);
    expect(applicableMessagesFor([goldOnly], { isMember: true, tier: 'bronze' })).toHaveLength(0);

    const either = message({ audiences: ['bronze', 'gold'] });
    expect(applicableMessagesFor([either], { isMember: true, tier: 'bronze' })).toHaveLength(1);
  });

  it('drops a message with no copy', () => {
    expect(applicableMessagesFor([message({ message: '   ' })], gold)).toHaveLength(0);
  });
});

describe('messagesForSelection', () => {
  it('shows an untargeted message for every selection', () => {
    const messages = [message()];
    expect(messagesForSelection(messages, {})).toHaveLength(1);
    expect(messagesForSelection(messages, { ecosystem: 'Flux1' })).toHaveLength(1);
  });

  it('matches on any target kind', () => {
    const eco = message({ id: 'm1', ecosystems: ['MiniMaxH3'] });
    const workflow = message({ id: 'm2', workflows: ['txt2vid'] });
    const version = message({ id: 'm3', modelVersionIds: [123] });
    const all = [eco, workflow, version];

    expect(messagesForSelection(all, { ecosystem: 'MiniMaxH3' }).map((m) => m.id)).toEqual(['m1']);
    expect(messagesForSelection(all, { workflow: 'txt2vid' }).map((m) => m.id)).toEqual(['m2']);
    expect(messagesForSelection(all, { versionIds: [123] }).map((m) => m.id)).toEqual(['m3']);
  });

  it('leaves a targeted message out of an unrelated selection', () => {
    const eco = message({ ecosystems: ['MiniMaxH3'] });
    expect(messagesForSelection([eco], { ecosystem: 'Flux1', versionIds: [9] })).toEqual([]);
  });

  it('keeps the moderator-authored order', () => {
    const first = message({ id: 'm1' });
    const second = message({ id: 'm2' });
    expect(messagesForSelection([second, first], {}).map((m) => m.id)).toEqual(['m2', 'm1']);
  });
});

// The property the dismissal design rests on: a corrected price or date reaches
// everyone who dismissed the previous wording.
describe('messageDismissId', () => {
  it('changes when the copy changes', () => {
    expect(messageDismissId(message({ message: 'Prices change on the 15th.' }))).not.toBe(
      messageDismissId(message({ message: 'Prices change on the 16th.' }))
    );
  });

  it('is stable for the same message', () => {
    expect(messageDismissId(message())).toBe(messageDismissId(message()));
  });

  it('separates two messages that share copy', () => {
    expect(messageDismissId(message({ id: 'm1' }))).not.toBe(
      messageDismissId(message({ id: 'm2' }))
    );
  });
});
