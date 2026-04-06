/** Defines supported blockchain address families for crypto deposits. */

export type ChainConfig = {
  /** Address family identifier stored in DB */
  chain: string;
  /** Human-friendly name shown in the UI */
  displayName: string;
  /** NowPayments `network` field values that map to this chain */
  networks: string[];
  /** Currency code used when creating the NowPayments payment order */
  targetCurrency: string;
};

export const CHAIN_CONFIGS: ChainConfig[] = [
  {
    chain: 'evm',
    displayName: 'Ethereum',
    networks: ['base', 'eth', 'polygon', 'arb', 'bsc', 'op', 'matic'],
    targetCurrency: 'usdcbase',
  },
  { chain: 'sol', displayName: 'Solana', networks: ['sol'], targetCurrency: 'usdcsol' },
  { chain: 'trx', displayName: 'Tron', networks: ['trx'], targetCurrency: 'usdttrc20' },
  { chain: 'btc', displayName: 'Bitcoin', networks: ['btc'], targetCurrency: 'btc' },
  { chain: 'doge', displayName: 'Dogecoin', networks: ['doge'], targetCurrency: 'doge' },
  { chain: 'ltc', displayName: 'Litecoin', networks: ['ltc'], targetCurrency: 'ltc' },
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

/** Human-friendly network names for display (NowPayments network codes → pretty names). */
const NETWORK_DISPLAY_NAMES: Record<string, string> = {
  base: 'Base',
  eth: 'Ethereum',
  polygon: 'Polygon',
  arb: 'Arbitrum',
  bsc: 'BSC',
  op: 'Optimism',
  matic: 'Polygon',
  sol: 'Solana',
  trx: 'Tron',
  btc: 'Bitcoin',
  doge: 'Dogecoin',
  ltc: 'Litecoin',
};

/** Get a human-friendly display name for a chain (e.g., 'evm' -> 'Ethereum'). */
export function getChainDisplayName(chain: string): string {
  return getChainConfig(chain)?.displayName ?? chain.toUpperCase();
}

/** Get a human-friendly display name for a NowPayments network (e.g., 'bsc' -> 'BSC'). */
export function getNetworkDisplayName(network: string): string {
  return NETWORK_DISPLAY_NAMES[network.toLowerCase()] ?? network.toUpperCase();
}

/**
 * Convert a USDC outcome amount to Buzz.
 * 1 USDC = 1000 Buzz, fractional Buzz truncated.
 */
export function outcomeAmountToBuzz(outcomeAmount: number): number {
  return Math.floor(outcomeAmount * 1000);
}

/** Deposit statuses that mean buzz has been credited. */
const DEPOSIT_COMPLETED_STATUSES = new Set(['finished', 'partially_paid']);

/** Check if a deposit status means buzz has been credited. */
export function isDepositComplete(status: string): boolean {
  return DEPOSIT_COMPLETED_STATUSES.has(status);
}
