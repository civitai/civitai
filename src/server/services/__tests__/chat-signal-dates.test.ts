import { describe, expect, it } from 'vitest';
import { reviveChatMessageDates } from '~/shared/utils/chat';

/**
 * A message as it actually arrives from the signals worker: JSON off a
 * websocket, so every date is a string — while the handler receives it typed as
 * the router's output, where they are `Date`.
 */
const overWire = (message: Record<string, unknown>) => JSON.parse(JSON.stringify(message)) as never;

const message = {
  id: 4221084,
  chatId: 341440,
  userId: 18085,
  content: 'hey',
  createdAt: new Date('2026-08-19T10:00:00.000Z'),
  editedAt: null as Date | null,
  deletedAt: null as Date | null,
  referenceMessage: null as { createdAt: Date; deletedAt: Date | null } | null,
};

/**
 * The failure this guards is invisible at the point of the mistake: writing a
 * string-dated payload into the cache succeeds, and the throw lands later in
 * whichever consumer first calls a `Date` method — for this bug, `isSameDay`'s
 * `.getFullYear()`, two components away and inside an error boundary that took
 * the whole page down. Neither the write nor the type system objects.
 */
describe('reviveChatMessageDates', () => {
  it('turns the wire payload back into real Dates', () => {
    const revived = reviveChatMessageDates(overWire(message));

    expect(revived.createdAt).toBeInstanceOf(Date);
    expect(revived.createdAt.toISOString()).toBe('2026-08-19T10:00:00.000Z');
  });

  it('survives what the crash actually called', () => {
    // The consumer, not the cache write, is where the old code died. Calling it
    // here is the difference between asserting a type and asserting the bug is
    // gone: `'2026-08-19T10:00:00.000Z'.getFullYear` is not a function.
    const revived = reviveChatMessageDates(overWire(message));
    expect(() => revived.createdAt.getFullYear()).not.toThrow();
    expect(revived.createdAt.getFullYear()).toBe(2026);
  });

  it('revives every date the message carries, not just the one that crashed', () => {
    const revived = reviveChatMessageDates(
      overWire({
        ...message,
        editedAt: new Date('2026-08-19T11:00:00.000Z'),
        deletedAt: new Date('2026-08-19T12:00:00.000Z'),
        referenceMessage: {
          id: 4221070,
          content: 'quoted',
          createdAt: new Date('2026-08-18T09:00:00.000Z'),
          deletedAt: null,
        },
      })
    );

    expect(revived.editedAt).toBeInstanceOf(Date);
    expect(revived.deletedAt).toBeInstanceOf(Date);
    expect(revived.referenceMessage?.createdAt).toBeInstanceOf(Date);
  });

  it('leaves a null date null rather than inventing 1970', () => {
    // `new Date(null)` is the epoch, which would render as a real timestamp and
    // read as an edit that never happened.
    const revived = reviveChatMessageDates(overWire(message));
    expect(revived.editedAt).toBeNull();
    expect(revived.deletedAt).toBeNull();
    expect(revived.referenceMessage).toBeNull();
  });

  it('is a no-op on a payload that already holds Dates', () => {
    // The same handler shape is used where data does not cross the wire.
    const revived = reviveChatMessageDates(message);
    expect(revived.createdAt).toBeInstanceOf(Date);
    expect(revived.createdAt.getTime()).toBe(message.createdAt.getTime());
  });
});
