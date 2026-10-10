import { describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import {
  classifyQuoteFailure,
  safeQuoteReason,
  unquotedTrainingRefusal,
} from '~/server/services/blocks/pass-through-quote-failure';

const GENERIC = 'Training needs a price quote and none could be obtained; try again.';
const OWN_KEY = 'AMXT0PQ4Z8K2N6W1R5V9C3J7H0B4D8F2';
const FOREIGN_KEY = 'ZQ7L2M9X4C1V8B5N0K3J6H2G9F4D1S7A';
const CALLER_TEXT = JSON.stringify({ trainingData: { items: [{ air: OWN_KEY }] } });

/** What the block receives for an error the quote threw. */
const refusalFor = (err: unknown) =>
  unquotedTrainingRefusal(classifyQuoteFailure(err, CALLER_TEXT));

describe('what a block receives for a failed training quote', () => {
  it('a validation rejection carries the orchestrator‘s reason', () => {
    const err = new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Training requires at least 5 images, but 2 were provided.',
    });
    expect(refusalFor(err)).toEqual({
      error:
        'Training could not be priced: Training requires at least 5 images, but 2 were provided.',
      errorCode: 'training-quote-rejected',
    });
  });

  it('a not-found rejection may name a key the caller sent', () => {
    const err = new TRPCError({
      code: 'NOT_FOUND',
      message: `The blob ${OWN_KEY} was not found.`,
    });
    expect(refusalFor(err)).toEqual({
      error: `Training could not be priced: The blob ${OWN_KEY} was not found.`,
      errorCode: 'training-quote-rejected',
    });
  });

  it('several validation messages are joined on one line', () => {
    const err = new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Epochs must be between 1 and 20.,\nResolution must be a multiple of 64.',
    });
    expect(refusalFor(err)).toEqual({
      error:
        'Training could not be priced: Epochs must be between 1 and 20.; Resolution must be a multiple of 64.',
      errorCode: 'training-quote-rejected',
    });
  });

  it.each([
    [
      'a network failure',
      new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Generation services are temporarily unavailable. Please try again.',
        cause: new TypeError('fetch failed'),
      }),
    ],
    ['a timeout', new TRPCError({ code: 'TIMEOUT', message: 'The operation timed out.' })],
    ['a rate limit', new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Slow down!' })],
    ['a server fault', new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Epochs is bad.' })],
    ['an unrecognised throw', new Error('Epochs must be between 1 and 20.')],
    ['a non-error throw', 'Epochs must be between 1 and 20.'],
  ])('%s is unavailable, with the generic message', (_name, err) => {
    expect(refusalFor(err)).toEqual({ error: GENERIC, errorCode: 'training-quote-unavailable' });
  });

  it.each([
    ['a URL', 'Could not fetch http://upstream.example.internal/v2/blobs/x'],
    ['a non-http URL', 'Could not read s3://datasets/a'],
    ['a stack frame', 'Object reference not set at Trainer.Quote (Trainer.cs:line 42)'],
    ['a multi-line dump', 'Unhandled failure\n   at Trainer.Quote()\n   at Program.Main()'],
    ['an IP address', 'Connection to 10.1.2.3 was reset'],
    ['a host and port', 'Could not reach pricing.example.com:8443'],
    ['a private DNS name', 'Could not resolve pricing.default.svc'],
    ['a filesystem path', 'Missing file /srv/app/config/prices.json'],
    ['a serialized object', 'Rejected {"detail":"bad"}'],
    ['a database error', 'Database connection pool exhausted'],
    ['a credential', 'The bearer token was rejected'],
    ['an id the caller did not send', `The blob ${FOREIGN_KEY} was not found.`],
    ['an over-long message', `Epochs is invalid. ${'x '.repeat(200)}`],
    ['too many messages', ['a.', 'b.', 'c.', 'd.', 'e.', 'f.'].join(',\n')],
    ['an empty message', ''],
  ])('a rejection carrying %s keeps the generic message', (_name, message) => {
    const err = new TRPCError({ code: 'BAD_REQUEST', message });
    expect(refusalFor(err)).toEqual({ error: GENERIC, errorCode: 'training-quote-rejected' });
  });

  it('an unpriced answer has its own code', () => {
    expect(unquotedTrainingRefusal({ kind: 'unpriced' })).toEqual({
      error: GENERIC,
      errorCode: 'training-quote-unpriced',
    });
  });
});

describe('safeQuoteReason', () => {
  it('allows a long word that is not an identifier', () => {
    expect(safeQuoteReason('The imageResourceTrainingStepTemplate is disabled.', '{}')).toBe(
      'The imageResourceTrainingStepTemplate is disabled.'
    );
  });

  it('allows decimals in a validation message', () => {
    expect(safeQuoteReason('Learning rate must be at most 0.001.', '{}')).toBe(
      'Learning rate must be at most 0.001.'
    );
  });
});
