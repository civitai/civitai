import type { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server';
import { redis, sysRedis } from '~/server/redis/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

type TestResult = {
  name: string;
  passed: boolean;
  error?: string;
  details?: any;
};

export default WebhookEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const results: TestResult[] = [];
  const isCluster = env.REDIS_CLUSTER;

  // Cast to bypass key template restrictions for testing
  const testRedis = redis as any;
  const testSysRedis = sysRedis as any;

  try {
    // Test 1: Basic connection and set/get
    try {
      const testKey = 'test:redis-cluster:basic';
      await testRedis.set(testKey, 'hello-world', { EX: 60 });
      const value = await testRedis.get(testKey);
      await testRedis.del(testKey);

      results.push({
        name: 'Basic set/get',
        passed: value === 'hello-world',
        details: { expected: 'hello-world', actual: value },
      });
    } catch (error: any) {
      results.push({
        name: 'Basic set/get',
        passed: false,
        error: error.message,
      });
    }

    // Test 2: Packed data (msgpack with Buffers)
    try {
      const testKey = 'test:redis-cluster:packed';
      const testData = { foo: 'bar', num: 42, arr: [1, 2, 3] };
      await testRedis.packed.set(testKey, testData, { EX: 60 });
      const retrieved = await testRedis.packed.get(testKey);
      await testRedis.del(testKey);

      const matches =
        retrieved &&
        retrieved.foo === 'bar' &&
        retrieved.num === 42 &&
        JSON.stringify(retrieved.arr) === '[1,2,3]';

      results.push({
        name: 'Packed data (msgpack with Buffers)',
        passed: matches,
        details: { expected: testData, actual: retrieved },
      });
    } catch (error: any) {
      results.push({
        name: 'Packed data (msgpack with Buffers)',
        passed: false,
        error: error.message,
      });
    }

    // Test 3: scanIterator returns arrays (v5 behavior)
    try {
      let iterationCount = 0;
      let keysCount = 0;
      let arrayCheckPassed = true;

      // Just scan a few iterations to verify it works - don't try to find all keys
      const stream = testRedis.scanIterator({ COUNT: 100 });

      for await (const keys of stream) {
        iterationCount++;
        keysCount += keys.length;

        // v5 behavior: keys should be an array
        if (!Array.isArray(keys)) {
          arrayCheckPassed = false;
          throw new Error(`Expected array, got ${typeof keys}`);
        }

        // Stop after a few iterations to avoid long scan times
        if (iterationCount >= 3) break;
      }

      results.push({
        name: 'scanIterator returns arrays (v5)',
        passed: arrayCheckPassed && iterationCount > 0,
        details: {
          iterationCount,
          totalKeysScanned: keysCount,
          note: 'Limited to 3 iterations for performance',
        },
      });
    } catch (error: any) {
      results.push({
        name: 'scanIterator returns arrays (v5)',
        passed: false,
        error: error.message,
      });
    }

    // Test 4: scanIterator works (basic functionality check)
    try {
      let canIterate = false;
      let isArray = false;

      // Just verify we can create and iterate a scanner - don't scan everything
      const stream = testRedis.scanIterator({ COUNT: 10 });

      for await (const keys of stream) {
        canIterate = true;
        isArray = Array.isArray(keys);
        // Exit after first iteration
        break;
      }

      results.push({
        name: isCluster ? 'scanIterator works on cluster' : 'scanIterator works on single node',
        passed: canIterate && isArray,
        details: {
          canIterate,
          yieldsArrays: isArray,
        },
      });
    } catch (error: any) {
      results.push({
        name: isCluster ? 'scanIterator works on cluster' : 'scanIterator works on single node',
        passed: false,
        error: error.message,
      });
    }

    // Test 6: Sys redis works the same way
    try {
      const testKey = 'test:sysredis:basic';
      await testSysRedis.set(testKey, 'sysredis-value', { EX: 60 });
      const value = await testSysRedis.get(testKey);
      await testSysRedis.del(testKey);

      results.push({
        name: 'Sys redis basic operations',
        passed: value === 'sysredis-value',
        details: { expected: 'sysredis-value', actual: value },
      });
    } catch (error: any) {
      results.push({
        name: 'Sys redis basic operations',
        passed: false,
        error: error.message,
      });
    }

    // Test 7: Verify cluster client structure (cluster mode only)
    if (isCluster) {
      try {
        const baseClient = redis as any;
        const hasMasters = 'masters' in baseClient || typeof baseClient.masters !== 'undefined';

        results.push({
          name: 'Cluster client structure check',
          passed: hasMasters,
          details: {
            hasMasters,
            hasNodeClient: typeof baseClient.nodeClient === 'function',
          },
        });
      } catch (error: any) {
        results.push({
          name: 'Cluster client structure check',
          passed: false,
          error: error.message,
        });
      }
    }

    const allPassed = results.every((r) => r.passed);
    const summary = {
      mode: isCluster ? 'cluster' : 'single-node',
      totalTests: results.length,
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      allPassed,
    };

    return res.status(allPassed ? 200 : 500).json({
      summary,
      results,
    });
  } catch (error: any) {
    return res.status(500).json({
      error: 'Test suite failed',
      message: error.message,
      stack: error.stack,
    });
  }
});
