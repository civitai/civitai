/**
 * Bump when the App Developer Terms text changes in a way developers must re-accept: every
 * developer is asked again at their next publish, and every submit path refuses until they do.
 */
export const APP_DEVELOPER_TERMS_VERSION = '1';

export const APP_DEVELOPER_TERMS_PATH = '/content/app-developer-terms';
/** Where a developer who publishes from the CLI or by git push can accept on the web. */
export const APP_DEVELOPER_TERMS_ACCEPT_PATH = '/apps/submit';

export function appOwnerTermsRefusalMessage(baseUrl: string) {
  return (
    "The app's owner has not accepted the current App Developer Terms yet. They accept them " +
    `(${baseUrl}${APP_DEVELOPER_TERMS_PATH}) on the web at ${baseUrl}${APP_DEVELOPER_TERMS_ACCEPT_PATH}.`
  );
}

export function appDeveloperTermsRefusalMessage(baseUrl: string) {
  return (
    `Accept the App Developer Terms (${baseUrl}${APP_DEVELOPER_TERMS_PATH}) on the web at ` +
    `${baseUrl}${APP_DEVELOPER_TERMS_ACCEPT_PATH}, then publish again.`
  );
}

export class AppDeveloperTermsNotAcceptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppDeveloperTermsNotAcceptedError';
  }
}

export type DeveloperRateCardRow =
  | 'goods'
  | 'publisher_all_my_models'
  | 'viewer_personal'
  | 'viewer_global'
  | 'platform_default';

/** Rows the developer rate card shows. Add a row only once its rate is signed off (see rate-card.ts). */
export const DEVELOPER_RATE_CARD_SHOWN_ROWS: readonly DeveloperRateCardRow[] = ['goods'];
