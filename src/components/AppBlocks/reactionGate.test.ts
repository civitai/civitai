import { describe, expect, it, vi } from 'vitest';

import {
  classifyEntityReactionError,
  createReactionReplyLatch,
  resolveGetEntityReactionsRequest,
  resolveSetEntityReactionRequest,
} from './reactionGate';
import { APP_REACTION_SERVER_ERRORS } from '~/shared/constants/block-reaction.constants';

const GRANTED = ['social:react:self'];
const ok = { ready: true, signedIn: true, reviewMode: false, grantedScopes: GRANTED };
const SET = {
  requestId: 'r1',
  entityType: 'image',
  entityId: 5,
  reaction: 'Heart',
  reacted: true,
  ticket: 'v1.1.sig',
};

describe('resolveSetEntityReactionRequest', () => {
  it('proceeds with a well-formed, consented request', () => {
    expect(resolveSetEntityReactionRequest({ raw: SET, ...ok })).toEqual({
      kind: 'proceed',
      request: SET,
    });
  });

  it('drops a payload with no requestId — there is nothing to reply to', () => {
    expect(resolveSetEntityReactionRequest({ raw: { ...SET, requestId: '' }, ...ok })).toEqual({
      kind: 'drop',
    });
    expect(resolveSetEntityReactionRequest({ raw: null, ...ok })).toEqual({ kind: 'drop' });
  });

  it('refuses in a fixed order: review-mode, not-ready, sign-in-required, then payload, then consent', () => {
    const refuse = (over: Partial<typeof ok>, raw: unknown = SET) =>
      resolveSetEntityReactionRequest({ raw, ...ok, ...over });
    // Each case also fails every LATER check, so it can only pass if the order holds.
    const bad = { ...SET, reaction: 'Dislike' };
    expect(
      refuse({ reviewMode: true, ready: false, signedIn: false, grantedScopes: [] }, bad)
    ).toMatchObject({ kind: 'refuse', error: 'review-mode' });
    expect(refuse({ ready: false, signedIn: false, grantedScopes: [] }, bad)).toMatchObject({
      error: 'not-ready',
    });
    expect(refuse({ signedIn: false, grantedScopes: [] }, bad)).toMatchObject({
      error: 'sign-in-required',
    });
    expect(refuse({ grantedScopes: [] }, bad)).toMatchObject({ error: 'invalid-request' });
    expect(refuse({ grantedScopes: [] })).toMatchObject({ error: 'needs-consent' });
  });

  it.each([
    ['Dislike', { reaction: 'Dislike' }],
    ['a non-image entity', { entityType: 'post' }],
    ['a string id', { entityId: '5' }],
    ['a non-boolean reacted', { reacted: 'yes' }],
    ['an oversized ticket', { ticket: 'x'.repeat(300) }],
  ])('refuses %s as invalid-request', (_label, change) => {
    expect(resolveSetEntityReactionRequest({ raw: { ...SET, ...change }, ...ok })).toMatchObject({
      kind: 'refuse',
      error: 'invalid-request',
    });
  });

  it.each([
    ['a zero id', { entityId: 0 }],
    ['a fractional id', { entityId: 1.5 }],
    ['a non-string requestId', { requestId: 7 }],
    ['a ticket one over the cap', { ticket: 'x'.repeat(257) }],
  ])('refuses or drops %s', (label, change) => {
    const gate = resolveSetEntityReactionRequest({ raw: { ...SET, ...change }, ...ok });
    if (label === 'a non-string requestId') expect(gate).toEqual({ kind: 'drop' });
    else expect(gate).toMatchObject({ kind: 'refuse', error: 'invalid-request' });
  });

  it('accepts a ticket exactly at the cap', () => {
    const gate = resolveSetEntityReactionRequest({
      raw: { ...SET, ticket: 'x'.repeat(256) },
      ...ok,
    });
    expect(gate.kind).toBe('proceed');
  });

  it('passes a missing ticket through — the SERVER owns the provenance refusal', () => {
    const { ticket: _t, ...noTicket } = SET;
    const gate = resolveSetEntityReactionRequest({ raw: noTicket, ...ok });
    expect(gate).toEqual({ kind: 'proceed', request: noTicket });
  });
});

describe('resolveGetEntityReactionsRequest', () => {
  const GET = { requestId: 'r2', entityType: 'image', ids: [1, 2, 2], tickets: { '1': 't1' } };

  it('dedupes ids and keeps only tickets for requested ids', () => {
    expect(
      resolveGetEntityReactionsRequest({
        raw: { ...GET, tickets: { '1': 't1', '99': 'noise' } },
        ...ok,
      })
    ).toEqual({
      kind: 'proceed',
      request: { requestId: 'r2', entityType: 'image', ids: [1, 2], tickets: { '1': 't1' } },
    });
  });

  it.each([
    ['empty ids', { ids: [] }],
    ['tickets given as an array', { tickets: ['t1'] }],
    ['a non-string ticket for a requested id', { tickets: { '1': 5 } }],
  ])('refuses %s as invalid-request', (_l, change) => {
    expect(resolveGetEntityReactionsRequest({ raw: { ...GET, ...change }, ...ok })).toMatchObject({
      kind: 'refuse',
      error: 'invalid-request',
    });
  });

  it('refuses more than 100 ids, and needs consent like the write', () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    expect(resolveGetEntityReactionsRequest({ raw: { ...GET, ids }, ...ok })).toMatchObject({
      error: 'invalid-request',
    });
    expect(resolveGetEntityReactionsRequest({ raw: GET, ...ok, grantedScopes: [] })).toMatchObject({
      error: 'needs-consent',
    });
  });
});

describe('classifyEntityReactionError', () => {
  const trpcError = (code: string, message = 'x') => ({ message, data: { code } });

  it('maps the server refusals onto the closed set', () => {
    expect(classifyEntityReactionError(trpcError('TOO_MANY_REQUESTS'))).toBe('rate-limited');
    expect(classifyEntityReactionError(trpcError('UNAUTHORIZED'))).toBe('sign-in-required');
    expect(
      classifyEntityReactionError(trpcError('FORBIDDEN', APP_REACTION_SERVER_ERRORS.missingScope))
    ).toBe('needs-consent');
    expect(
      classifyEntityReactionError(
        trpcError('BAD_REQUEST', APP_REACTION_SERVER_ERRORS.reactionNotAllowed)
      )
    ).toBe('invalid-request');
    expect(
      classifyEntityReactionError(trpcError('FORBIDDEN', APP_REACTION_SERVER_ERRORS.ticket))
    ).toBe('entity-unavailable');
    expect(classifyEntityReactionError(new Error('network'))).toBe('entity-unavailable');
    expect(classifyEntityReactionError(undefined)).toBe('entity-unavailable');
  });
});

describe('createReactionReplyLatch', () => {
  it('emits exactly once', () => {
    const emit = vi.fn();
    const latch = createReactionReplyLatch({ requestId: 'r', emit });
    latch.reply({ result: 1 });
    latch.reply({ error: 'rate-limited' });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ requestId: 'r', result: 1 });
  });
});
