import { getApiAuthSession } from '~/server/auth/api-auth-session';
import { getFeatureFlagsLazy } from '~/server/services/feature-flags.service';
import { createCaseRoute } from '~/server/takedown-requests/case-route';

export default createCaseRoute({
  formsOpen: async (req, res) => {
    const session = await getApiAuthSession({ req, res }, { whenBanned: 'anonymous' });
    return !!getFeatureFlagsLazy({ user: session?.user, req }).takedownRequests;
  },
});
