import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_RESTRICTION_FEATURE } from '$lib/tickets/routing';

const { getTicketDetail, resolveTicketView, linkedCivitaiUserId } = vi.hoisted(() => ({
  getTicketDetail: vi.fn(),
  resolveTicketView: vi.fn(),
  linkedCivitaiUserId: vi.fn(),
}));

vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('../access', () => ({ canAccess: () => true }));
vi.mock('../account-actions', () => ({ accountEnforcementActions: {} }));
vi.mock('../freshdesk-write.service', () => ({ addPrivateNote: vi.fn() }));
vi.mock('../freshdesk.service', () => ({
  getTicketDetail,
  isFreshdeskId: (id: string) => /^\d+$/.test(id),
}));
vi.mock('../user-actions.service', () => ({
  revokeTimedMute: vi.fn(),
  resolveRestriction: vi.fn(),
}));
vi.mock('../tickets/detail', () => ({ resolveTicketView, linkedCivitaiUserId }));

const { linkedUser, linkedUserFor } = await import('../tickets/account-actions');
const { appealsPanelFor } = await import('$lib/tickets/appeals-panel');

const ticket = { cfFeature: ACCOUNT_RESTRICTION_FEATURE };

beforeEach(() => {
  getTicketDetail.mockReset().mockResolvedValue({ status: 'found', ticket });
  resolveTicketView.mockReset().mockResolvedValue({ routesTo: 'moderation', routed: null });
  linkedCivitaiUserId.mockReset().mockResolvedValue(7);
});

describe('linkedUser', () => {
  it('is the user linked to an account ticket in the moderation view', async () => {
    expect(await linkedUser('5')).toEqual({ status: 'ok', userId: 7 });
    expect(linkedCivitaiUserId).toHaveBeenCalledWith(ticket, null);
  });

  it('carries no user when the ticket links none, so the action refuses it', async () => {
    linkedCivitaiUserId.mockResolvedValue(null);
    expect(await linkedUser('5')).toEqual({ status: 'ok', userId: null });
  });

  it('refuses a ticket that now belongs to the support view', async () => {
    resolveTicketView.mockResolvedValue({ routesTo: 'support', routed: null });
    expect(await linkedUser('5')).toMatchObject({ status: 'refused', code: 409 });
    expect(linkedCivitaiUserId).not.toHaveBeenCalled();
  });

  it('refuses a moderation ticket that is not about an account', async () => {
    getTicketDetail.mockResolvedValue({ status: 'found', ticket: { cfFeature: 'Something else' } });
    expect(await linkedUser('5')).toMatchObject({ status: 'refused', code: 409 });
  });

  it('refuses an id that is not a ticket, and a ticket that cannot be read', async () => {
    expect(await linkedUser('abc')).toMatchObject({ status: 'refused', code: 404 });
    expect(getTicketDetail).not.toHaveBeenCalled();
    getTicketDetail.mockResolvedValue({ status: 'unavailable', reason: 'timeout' });
    expect(await linkedUser('5')).toMatchObject({ status: 'refused', code: 503 });
  });
});

describe('linkedUserFor the appeals panel', () => {
  const forAppeals = linkedUserFor(appealsPanelFor, 'not an appeals ticket');

  it('accepts a Moderation Decision ticket, which the account panel does not', async () => {
    getTicketDetail.mockResolvedValue({
      status: 'found',
      ticket: { cfFeature: 'Moderation Decision' },
    });
    expect(await forAppeals('5')).toEqual({ status: 'ok', userId: 7 });
    expect(await linkedUser('5')).toMatchObject({ status: 'refused', code: 409 });
  });

  it('accepts a featureless ticket routed by an appeal topic, and refuses another topic', async () => {
    getTicketDetail.mockResolvedValue({ status: 'found', ticket: { cfFeature: null } });
    resolveTicketView.mockResolvedValue({
      routesTo: 'moderation',
      routed: { topic: 'image-moderation-appeal' },
    });
    expect(await forAppeals('5')).toEqual({ status: 'ok', userId: 7 });
    resolveTicketView.mockResolvedValue({ routesTo: 'moderation', routed: { topic: 'billing' } });
    expect(await forAppeals('5')).toMatchObject({ status: 'refused', code: 409 });
  });

  it('refuses a ticket of any other feature with the message it was given', async () => {
    getTicketDetail.mockResolvedValue({ status: 'found', ticket: { cfFeature: 'Billing' } });
    expect(await forAppeals('5')).toEqual({
      status: 'refused',
      code: 409,
      message: 'not an appeals ticket',
    });
  });
});
