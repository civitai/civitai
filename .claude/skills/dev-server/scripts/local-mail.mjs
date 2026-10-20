/**
 * Local dev mail goes to the Mailpit catcher in docker-compose.base.yml, never a real SMTP server.
 *
 * Two places apply it: the daemon overrides these keys in every env it spawns (main app, auth hub,
 * sibling apps), whatever the .env chain says; `wt new` / `wt env --refresh` rewrite them in every
 * .env they copy, so a bare `pnpm` command in a worktree is routed the same way.
 *
 * All six keys are always written. The mail clients connect only when HOST, PORT, USER, PASS and
 * FROM are all non-empty, and a worktree .env missing one would inherit the primary's through the
 * daemon's key-by-key chain. Mailpit accepts any credentials, so USER/PASS are placeholders.
 */

export const LOCAL_MAIL_ENV = Object.freeze({
  EMAIL_HOST: 'localhost',
  EMAIL_PORT: '1025',
  EMAIL_SECURE: 'false',
  EMAIL_USER: 'local',
  EMAIL_PASS: 'local',
  EMAIL_FROM: 'Civitai Dev <noreply@localhost>',
});

export const LOCAL_MAIL_LOG = `Email: routed to the local catcher (${LOCAL_MAIL_ENV.EMAIL_HOST}:${LOCAL_MAIL_ENV.EMAIL_PORT}); EMAIL_* from .env ignored`;

// Active and commented-out lines alike: a commented line is one edit away from live.
const EMAIL_LINE = /^\s*#?\s*EMAIL_[A-Z_]*\s*=/;

/**
 * Rewrite a .env file's text so every EMAIL_* line is replaced by the catcher values.
 * A file with no EMAIL_* line is returned unchanged: that app does not send mail.
 */
export function routeEnvTextToCatcher(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const kept = lines.filter((line) => !EMAIL_LINE.test(line));
  if (kept.length === lines.length) return text;
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  const block = Object.entries(LOCAL_MAIL_ENV).map(
    ([k, v]) => `${k}=${/\s/.test(v) ? `"${v}"` : v}`
  );
  return [
    ...kept,
    '',
    '# Email: local catcher (Mailpit, docker-compose.base.yml)',
    ...block,
    '',
  ].join(eol);
}
