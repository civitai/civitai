import { handleAudioModerationCallback } from '~/server/services/audio-moderation.service';
import { handleEndpointError, WebhookEndpoint } from '~/server/utils/endpoint-helpers';

export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  try {
    await handleAudioModerationCallback(req.body);
    return res.status(200).json({ ok: true });
  } catch (error) {
    return handleEndpointError(res, error);
  }
});
