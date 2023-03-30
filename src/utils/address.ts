import { utils } from 'ethers';
import { shortenString } from './string-helpers';

/**
 * Copied from useDapp
 */
export function shortenAddress(address: string): string {
  try {
    const formattedAddress = utils.getAddress(address);
    return shortenString(formattedAddress);
  } catch {
    throw new TypeError("Invalid input, address can't be parsed");
  }
}

/**
 * Copied from useDapp
 */
export function shortenIfAddress(address: string): string {
  if (utils.isAddress(address)) {
    return shortenAddress(address);
  }
  return '';
}
