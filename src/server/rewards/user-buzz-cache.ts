import { REDIS_KEYS, redis } from '~/server/redis/client';

class UserBuzzCache {
  private _amount?: number;
  private _key: string;

  constructor(args: { userId: number; deviceId: string; type: string }) {
    this._key = getKey(args);
  }

  get amount() {
    return new Promise<number>((resolve) => {
      if (this._amount) resolve(this._amount as number);
      else
        redis.hGet(REDIS_KEYS.BUZZ_EVENTS, this._key).then((value) => {
          const amount = !!value ? Number(value) : 0;
          this._amount = amount;
          resolve(amount);
        });
    });
  }

  async update(amount: number) {
    this._amount = amount;
    await redis.packed.hSet(REDIS_KEYS.BUZZ_EVENTS, this._key, String(amount));
    await setExpiresAt();
  }

  static async getMany(args: { userId: number; deviceId: string; type: string }[]) {
    return await redis.packed.mGet(args.map((x) => getKey(x)));
  }

  static async setMany(args: { userId: number; deviceId: string; type: string; amount: number }[]) {
    await Promise.all(
      args.map((x) => redis.packed.hSet(REDIS_KEYS.BUZZ_EVENTS, getKey(x), x.amount))
    );
    await setExpiresAt();
  }
}

function getKey(args: { userId: number; deviceId: string; type: string }) {
  return `${args.userId}:${args.deviceId}:${args.type}`;
}

async function setExpiresAt() {
  const end = new Date().setUTCHours(24, 0, 0, 0);
  await redis.expireAt(REDIS_KEYS.BUZZ_EVENTS, Math.floor(end / 1000));
}
