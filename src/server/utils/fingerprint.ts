import { env } from '~/env/server';
import { decryptText } from '~/server/utils/key-generator';
import { isNumber } from '~/utils/type-guards';

interface CompositeFingerprint {
  value: string;
  userId: number;
  timestamp: number;
}

export function getDeviceFingerprint(hash: string): CompositeFingerprint {
  if (!env.FINGERPRINT_SECRET || !env.FINGERPRINT_IV || !hash)
    return { value: '', userId: 0, timestamp: 0 };

  const decrypted = decryptText({
    text: hash,
    key: env.FINGERPRINT_SECRET,
    iv: env.FINGERPRINT_IV,
  });
  const [fingerprint, userId, timestamp] = decrypted.split(':');

  return {
    value: fingerprint,
    userId: isNumber(userId) ? parseInt(userId, 10) : 0,
    timestamp: isNumber(timestamp) ? parseInt(timestamp, 10) : 0,
  };
}

export class Fingerprint {
  private hash: string;
  private _composite: CompositeFingerprint | undefined;

  public constructor(hash: string) {
    this.hash = hash;
  }

  get composite(): CompositeFingerprint {
    if (!this._composite) this._composite = getDeviceFingerprint(this.hash);
    return this._composite;
  }

  get userId(): number {
    return this.composite.userId;
  }

  get timestamp(): number {
    return this.composite.timestamp;
  }

  get value(): string {
    return this.composite.value;
  }
}
