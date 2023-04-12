import { providers } from "ethers";
import { env } from '~/env/client.mjs';

export function getDefaultProvider() {
  return new providers.JsonRpcProvider(env.NEXT_PUBLIC_CHAIN_RPC_URL);
}