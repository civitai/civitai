export const civTokenEndpoint = '/api/auth/civ-token';
export const impersonateEndpoint = '/api/auth/impersonate';

/** Header sent by server when session was refreshed or invalidated and client should update its cookie */
export const SESSION_REFRESH_HEADER = 'x-session-refresh';
