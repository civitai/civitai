import type { SessionScope } from '~/server/auth/session-scope';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/** Model reads that show an owner or moderator more than the public sees. */
export const MODEL_VIEW_SCOPES = [TokenScope.ModelsRead, TokenScope.AIServicesRead];
export const MODEL_VIEW_SCOPE: SessionScope = { anyOf: MODEL_VIEW_SCOPES };

/** `/api/upload/*` serves model files, media and training data. */
export const UPLOAD_SCOPE: SessionScope = {
  anyOf: [TokenScope.ModelsWrite, TokenScope.MediaWrite, TokenScope.AIServicesWrite],
};
