import { REDIS_KEYS, redis } from '~/server/redis/client';

export class UserBuzzCache {
  private _amount?: number;
  private _hash: string;

  constructor(args: { userId: number; deviceId: string; type: string }) {
    this._hash = getKey(args);
  }

  get amount() {
    return new Promise<number>((resolve) => {
      if (this._amount) resolve(this._amount as number);
      else
        redis.hGet(REDIS_KEYS.BUZZ_EVENTS, this._hash).then((value) => {
          const amount = !!value ? Number(value) : 0;
          this._amount = amount;
          resolve(amount);
        });
    });
  }

  async incrBy(amount: number) {
    this._amount = amount;
    await redis.hIncrBy(REDIS_KEYS.BUZZ_EVENTS, this._hash, amount);
    await setExpiresAt();
  }

  static async getMany(args: { userId: number; deviceId: string; type: string }[]) {
    return await redis.mGet(args.map((x) => getKey(x)));
  }

  static async incrManyBy(
    args: { userId: number; deviceId: string; type: string; amount: number }[]
  ) {
    await Promise.all(args.map((x) => redis.hIncrBy(REDIS_KEYS.BUZZ_EVENTS, getKey(x), x.amount)));
    await setExpiresAt();
  }
}

function getKey(args: { userId: number; deviceId: string; type: string }) {
  return `${args.userId}:${args.deviceId}:${args.type}`;
}

async function setExpiresAt() {
  const end = new Date().setUTCHours(23, 59, 59, 999);
  await redis.expireAt(REDIS_KEYS.BUZZ_EVENTS, Math.floor(end / 1000));
}
