// Shaped like packages/civitai-redis: `'cluster'` as an ordinary value, which a too-broad spawn check
// once treated as the cluster module and refused every test in the repo.
export const redisOptions = { client: 'cluster' };
