import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeRetractedRefusal, RETRACTED_REFUSED, retractedRefusalReason } from '../held-media';

describe('retractedRefusalReason', () => {
  it("shows the route's message on a 403 or a 503, which a moderator can act on", () => {
    expect(retractedRefusalReason(403, { message: 'Not signed in.' })).toBe('Not signed in.');
    expect(retractedRefusalReason(503, { message: 'Could not check this image; retry.' })).toBe(
      'Could not check this image; retry.'
    );
  });

  // Ruled: a refusal for a CSAM signal must read exactly like any other 404, so the line a moderator
  // without CSAM-queue access sees reveals nothing. Do not show a 404's own message here.
  it('shows one generic line for every 404, whatever the route said', () => {
    for (const message of ['Not available here.', 'Not found.', 'anything else'])
      expect(retractedRefusalReason(404, { message })).toBe(RETRACTED_REFUSED);
  });

  it('falls back to the generic line when a 403 or 503 carries no usable message', () => {
    expect(retractedRefusalReason(403, null)).toBe(RETRACTED_REFUSED);
    expect(retractedRefusalReason(503, { message: '' })).toBe(RETRACTED_REFUSED);
    expect(retractedRefusalReason(500, { message: 'boom' })).toBe(RETRACTED_REFUSED);
  });
});

describe('probeRetractedRefusal', () => {
  afterEach(() => vi.unstubAllGlobals());
  const answer = (status: number, body: string) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status }))
    );

  it("probes the image's route and reads the status and message it answers", async () => {
    answer(503, JSON.stringify({ message: 'Could not check this image; retry.' }));
    expect(await probeRetractedRefusal(7)).toBe('Could not check this image; retry.');
    expect(fetch).toHaveBeenCalledWith('/api/retracted-media/7?probe=1');
  });

  it('shows the generic line for a 404 and for a body that is not JSON', async () => {
    answer(404, JSON.stringify({ message: 'Not available here.' }));
    expect(await probeRetractedRefusal(7)).toBe(RETRACTED_REFUSED);
    answer(403, 'not json');
    expect(await probeRetractedRefusal(7)).toBe(RETRACTED_REFUSED);
  });
});
