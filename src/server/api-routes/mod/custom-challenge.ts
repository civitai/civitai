import {
  deleteCustomChallenge,
  setCustomChallenge,
} from '~/server/services/daily-challenge.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

export default WebhookEndpoint(async (req, res) => {
  try {
    if (req.method === 'POST') {
      await setCustomChallenge(req.body);
    }
    if (req.method === 'DELETE') {
      await deleteCustomChallenge();
    }
  } catch (e) {
    res.status(500).send(e);
  }

  res.send({ ok: true });
});
