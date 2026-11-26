import { REDIS_KEYS, type RedisKeyTemplateCache } from '@civitai/redis';

// The cache-Redis key that marks an OAuth client a BAN disabled (main app
// src/server/services/oauth-ban-marker.ts). Built here because two apps touch it: the main app sets,
// reads and spends it, and the auth hub's access page clears it when staff set a client's mode.
export const banDisabledMarkKey = (clientId: string): RedisKeyTemplateCache =>
  `${REDIS_KEYS.OAUTH.BAN_DISABLED}:${clientId}`;
