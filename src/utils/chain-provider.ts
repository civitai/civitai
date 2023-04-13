import { providers } from 'ethers';
import { env } from '~/env/server.mjs';

export function getDefaultProvider() {
  return new providers.JsonRpcProvider(env.CHAIN_RPC_URL);
}
