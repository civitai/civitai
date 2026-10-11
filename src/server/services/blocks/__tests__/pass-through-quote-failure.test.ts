import { describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import {
  classifyQuoteFailure,
  quoteFailureLogLevel,
  safeQuoteReason,
  unquotedTrainingRefusal,
} from '~/server/services/blocks/pass-through-quote-failure';
import {
  annotateOrchestratorMissingBlob,
  annotateOrchestratorSubmitFailure,
} from '~/server/services/orchestrator/submit-failure';

const GENERIC = 'Training needs a price quote and none could be obtained; try again.';
const OWN_KEY = 'AMXT0PQ4Z8K2N6W1R5V9C3J7H0B4D8F2';
const FOREIGN_KEY = 'ZQ7L2M9X4C1V8B5N0K3J6H2G9F4D1S7A';
const CALLER_TEXT = JSON.stringify({ trainingData: { items: [{ air: OWN_KEY }] } });

/** What `submitWorkflow` throws for an orchestrator reply with this status. */
function orchestratorError(code: TRPCError['code'], message: string, status: number) {
  const err = new TRPCError({ code, message });
  annotateOrchestratorSubmitFailure(err, { attempt: 1, status });
  return err;
}

/** What the block receives for an error the quote threw. */
const refusalFor = (err: unknown) =>
  unquotedTrainingRefusal(classifyQuoteFailure(err, CALLER_TEXT));

describe('what a block receives for a failed training quote', () => {
  it('a validation rejection carries the orchestrator‘s reason', () => {
    const err = orchestratorError(
      'BAD_REQUEST',
      'Training requires at least 5 images, but 2 were provided.',
      400
    );
    expect(refusalFor(err)).toEqual({
      error:
        'Training could not be priced: Training requires at least 5 images, but 2 were provided.',
      errorCode: 'training-quote-rejected',
    });
  });

  it('a not-found rejection may name a key the caller sent', () => {
    // An orchestrator 404 reaches the caller as BAD_REQUEST.
    const err = orchestratorError('BAD_REQUEST', `The blob ${OWN_KEY} was not found.`, 404);
    expect(refusalFor(err)).toEqual({
      error: `Training could not be priced: The blob ${OWN_KEY} was not found.`,
      errorCode: 'training-quote-rejected',
    });
  });

  it('several validation messages are joined on one line', () => {
    const err = orchestratorError(
      'BAD_REQUEST',
      'Epochs must be between 1 and 20.,\nResolution must be a multiple of 64.',
      400
    );
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
    ['a rate limit', orchestratorError('TOO_MANY_REQUESTS', 'Slow down!', 429)],
    ['an upstream timeout', orchestratorError('BAD_REQUEST', 'Request timed out.', 408)],
    [
      'our service token refused',
      orchestratorError('UNAUTHORIZED', 'Authorization has been denied.', 401),
    ],
    [
      'insufficient funds',
      orchestratorError('BAD_REQUEST', 'Insufficient funds: balance is 120, 500 required.', 403),
    ],
    [
      'a failed blob refresh, before any request was sent',
      new TRPCError({
        code: 'BAD_REQUEST',
        message:
          'Failed to refresh image URL for blob: BLOB1.jpeg. Please try uploading the image again.',
      }),
    ],
    [
      'a BAD_REQUEST with no orchestrator response',
      new TRPCError({ code: 'BAD_REQUEST', message: 'Epochs must be between 1 and 20.' }),
    ],
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
    const err = orchestratorError('BAD_REQUEST', message, 400);
    expect(refusalFor(err)).toEqual({ error: GENERIC, errorCode: 'training-quote-rejected' });
  });

  it('a blob the orchestrator says is gone is a rejection with a host-written sentence', () => {
    const err = new TRPCError({
      code: 'BAD_REQUEST',
      message:
        'Failed to refresh image URL for blob: BLOB1.jpeg. Please try uploading the image again.',
    });
    annotateOrchestratorMissingBlob(err);
    expect(refusalFor(err)).toEqual({
      error:
        'Training could not be priced: An image in the training data is no longer available. Upload it again.',
      errorCode: 'training-quote-rejected',
    });
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

describe('quoteFailureLogLevel', () => {
  const levelFor = (err: unknown) => quoteFailureLogLevel(classifyQuoteFailure(err, '{}'), err);
  const missingBlob = () => {
    const err = new TRPCError({ code: 'BAD_REQUEST', message: 'Failed to refresh.' });
    annotateOrchestratorMissingBlob(err);
    return err;
  };

  it.each([
    ['a 400 rejection', orchestratorError('BAD_REQUEST', 'Epochs is bad.', 400)],
    ['a 404 rejection', orchestratorError('BAD_REQUEST', 'Not found.', 404)],
    ['a blob that is gone', missingBlob()],
    ['a 403 insufficient funds', orchestratorError('BAD_REQUEST', 'Insufficient funds.', 403)],
    ['a 429 rate limit', orchestratorError('TOO_MANY_REQUESTS', 'Slow down!', 429)],
  ])('%s is a warning', (_name, err) => {
    expect(levelFor(err)).toBe('warning');
  });

  it.each([
    ['a 401 (our token refused)', orchestratorError('UNAUTHORIZED', 'Denied.', 401)],
    ['a 408 upstream timeout', orchestratorError('BAD_REQUEST', 'Request timed out.', 408)],
    ['a 500', orchestratorError('SERVICE_UNAVAILABLE', 'Down.', 500)],
    [
      'a blob refresh that failed in transit',
      new TRPCError({ code: 'BAD_REQUEST', message: 'Failed to refresh.' }),
    ],
    ['an unannotated rate limit', new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'x' })],
    ['a timeout', new TRPCError({ code: 'TIMEOUT', message: 'x' })],
    ['an unrecognised throw', new Error('boom')],
  ])('%s is an error', (_name, err) => {
    expect(levelFor(err)).toBe('error');
  });
});
