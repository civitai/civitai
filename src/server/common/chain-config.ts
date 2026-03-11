/** Defines supported blockchain address families for crypto deposits. */

export type ChainConfig = {
  /** Address family identifier stored in DB */
  chain: string;
  /** NowPayments `network` field values that map to this chain */
  networks: string[];
  /** Currency code used when creating the NowPayments payment order */
  targetCurrency: string;
};

export const CHAIN_CONFIGS: ChainConfig[] = [
  { chain: 'evm', networks: ['base', 'eth', 'polygon', 'arb', 'bsc', 'op', 'matic'], targetCurrency: 'usdcbase' },
  { chain: 'sol', networks: ['sol'], targetCurrency: 'usdcsol' },
  { chain: 'trx', networks: ['trx'], targetCurrency: 'usdttrc20' },
  { chain: 'btc', networks: ['btc'], targetCurrency: 'btc' },
  { chain: 'doge', networks: ['doge'], targetCurrency: 'doge' },
  { chain: 'ltc', networks: ['ltc'], targetCurrency: 'ltc' },
];

/** Lookup: NowPayments network → chain config */
const NETWORK_TO_CHAIN = new Map<string, ChainConfig>();
for (const config of CHAIN_CONFIGS) {
  for (const network of config.networks) {
    NETWORK_TO_CHAIN.set(network, config);
  }
}

/** Get the chain config for a NowPayments network value. Returns undefined for unsupported networks. */
export function getChainForNetwork(network: string): ChainConfig | undefined {
  return NETWORK_TO_CHAIN.get(network.toLowerCase());
}

/** Get the chain config by chain identifier (e.g., 'evm', 'btc'). */
export function getChainConfig(chain: string): ChainConfig | undefined {
  return CHAIN_CONFIGS.find((c) => c.chain === chain);
}
