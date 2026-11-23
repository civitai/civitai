import { renderEmailShell, type EmailShellInput } from '@civitai/email';
import { getBaseUrl } from '~/server/utils/url-helpers';

// The shell lives in @civitai/email so apps/auth and apps/moderator render the same layout. The main
// app loads the logo from its own origin (getBaseUrl), so staging and dev emails point at themselves.
export {
  emailTheme,
  emailAccents,
  renderEmailSummary,
  renderEmailCallout,
  EMAIL_PREHEADER_CLASS,
  EMAIL_MUTED_CLASS,
  EMAIL_DECORATION_CLASSES,
  EMAIL_ROW_CLASS,
} from '@civitai/email';
export type { EmailAccent } from '@civitai/email';

/**
 * The shared transactional email layout (see `renderEmailShell` in @civitai/email). Every value is
 * inserted as HTML, so callers escape anything user-supplied.
 */
export const simpleEmailWithTemplate = (input: Omit<EmailShellInput, 'baseUrl'>) =>
  renderEmailShell({ ...input, baseUrl: getBaseUrl() });
