import { isProd } from '~/env/other';

export function ServerSingleton<T>(name: string, instance: T) {
  if (isProd) return instance;
  const globalForInstance = global as unknown as Record<string, unknown>;
  const key = `civitai-${name}`;
  if (!globalForInstance[key]) {
    globalForInstance[key] = instance;
  }
  return globalForInstance[key] as T;
}
