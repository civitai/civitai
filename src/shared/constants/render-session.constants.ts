/** Set on the request by `_app` when the settings bootstrap failed for a request with a session cookie. */
export const SESSION_UNRESOLVED_REQ_KEY = 'sessionUnresolved';

/**
 * Set to `true` on the request by `_app` when it renders the static shell instead of the full page.
 * Read by the page-render and SSR-CPU metrics (`authed="shell"`, `kind="shell"`). Nothing sets it
 * yet: the shell render lands separately.
 */
export const SHELL_REQ_KEY = 'shellRender';
