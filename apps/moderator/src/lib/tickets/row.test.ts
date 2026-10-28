import { describe, expect, it } from 'vitest';
import { requesterLabel, rowChip, sentByText } from './row';

describe('requesterLabel', () => {
  it('prefers the requester name, then the linked account, then says none', () => {
    expect(requesterLabel({ requesterName: 'Ann', civitaiUserId: 5 })).toBe('Ann');
    expect(requesterLabel({ requesterName: null, civitaiUserId: 5 })).toBe('User #5');
    expect(requesterLabel({ requesterName: '  ', civitaiUserId: null })).toBe('No requester');
  });
});

describe('rowChip', () => {
  it('shows the feature, falling back to the router topic, marked as inferred', () => {
    expect(rowChip({ cfFeature: 'Moderation Decision', routerTopic: 'x' })).toEqual({
      label: 'Moderation Decision',
      inferred: false,
    });
    expect(rowChip({ cfFeature: null, routerTopic: 'nsfw-moderation' })).toEqual({
      label: 'nsfw-moderation',
      inferred: true,
    });
    expect(rowChip({ cfFeature: null, routerTopic: null })).toBeNull();
  });
});

describe('sentByText', () => {
  it('names the moderator who sent a ticket to support', () => {
    expect(sentByText({ sentToSupport: true, sentBy: { moderatorId: 4, username: 'alice' } })).toBe(
      'Sent by alice'
    );
    expect(sentByText({ sentToSupport: true, sentBy: { moderatorId: 4, username: null } })).toBe(
      'Sent by user 4'
    );
  });

  it('says only "Sent to support" when nobody is recorded, and nothing for other tickets', () => {
    expect(sentByText({ sentToSupport: true, sentBy: null })).toBe('Sent to support');
    expect(sentByText({ sentToSupport: false, sentBy: null })).toBeNull();
  });
});
