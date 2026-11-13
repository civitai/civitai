/**
 * Local dev mail goes to the Mailpit catcher in docker-compose.base.yml, never a real SMTP server.
 *
 * Applied by the daemon (`spawnEnvFor`) and by `routeEnvTextToCatcher` on every copied .env.
 *
 * All six keys are always written: the mail clients connect only when HOST, PORT, USER, PASS and
 * FROM are all non-empty, and a bare `pnpm` run reads only the copied file. Mailpit accepts any
 * credentials, so USER/PASS are placeholders.
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

/** A file with no EMAIL_* line is returned unchanged rather than gaining a mail block. */
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
