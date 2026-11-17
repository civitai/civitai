import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { getAccessToken } from '~/server/services/signals.service';

export default AuthedEndpoint(async function handler(req, res, user) {
  try {
    const { accessToken } = await getAccessToken({ id: user.id });
    // getAccessToken fails SOFT (returns {} on a transient signals outage). For the tRPC
    // client that's fine (it tolerates an absent token), but this REST endpoint's contract
    // is a token body — an empty 200 would make a caller connect with an empty token.
    // Surface the degrade as 503 so the caller backs off / retries, preserving the
    // "non-2xx on outage" contract it had before fail-soft.
    if (!accessToken) {
      res.status(503).send('signals access token temporarily unavailable');
      return;
    }
    res.status(200).send(accessToken);
  } catch (error: unknown) {
    res.status(500).send(error);
  }
});
