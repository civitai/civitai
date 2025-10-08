import type { NextApiRequest, NextApiResponse } from 'next';
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
      // Set up some test keys
      const testKeys = ['test:scan:1', 'test:scan:2', 'test:scan:3'];
      await Promise.all(testKeys.map((key) => testRedis.set(key, 'value', { EX: 60 })));

      const foundKeys: string[] = [];
      let iterationCount = 0;
      const stream = testRedis.scanIterator({ MATCH: 'test:scan:*', COUNT: 100 });

      for await (const keys of stream) {
        iterationCount++;
        // v5 behavior: keys should be an array
        if (!Array.isArray(keys)) {
          throw new Error(`Expected array, got ${typeof keys}`);
        }
        foundKeys.push(...keys);
      }

      // Clean up - delete one at a time to avoid CROSSSLOT errors
      await Promise.all(testKeys.map((key) => testRedis.del(key)));

      const allFound = testKeys.every((key) => foundKeys.includes(key));

      results.push({
        name: 'scanIterator returns arrays (v5)',
        passed: allFound && iterationCount > 0,
        details: {
          iterationCount,
          foundKeys: foundKeys.filter((k) => k.startsWith('test:scan:')),
          expected: testKeys,
        },
      });
    } catch (error: any) {
      results.push({
        name: 'scanIterator returns arrays (v5)',
        passed: false,
        error: error.message,
      });
    }

    // Test 4: scanIterator works across cluster nodes
    try {
      // Set keys that will likely hash to different slots
      const testKeys = [
        'test:cluster:node:a',
        'test:cluster:node:b',
        'test:cluster:node:c',
        'test:cluster:node:xyz123',
        'test:cluster:node:abc456',
      ];
      await Promise.all(testKeys.map((key) => testRedis.set(key, 'value', { EX: 60 })));

      const foundKeys: string[] = [];
      const stream = testRedis.scanIterator({ MATCH: 'test:cluster:node:*' });

      for await (const keys of stream) {
        foundKeys.push(...keys);
      }

      // Clean up - delete one at a time to avoid CROSSSLOT errors
      await Promise.all(testKeys.map((key) => testRedis.del(key)));

      const allFound = testKeys.every((key) => foundKeys.includes(key));

      results.push({
        name: 'scanIterator across cluster nodes',
        passed: allFound,
        details: {
          expected: testKeys.length,
          found: foundKeys.filter((k) => k.startsWith('test:cluster:node:')).length,
        },
      });
    } catch (error: any) {
      results.push({
        name: 'scanIterator across cluster nodes',
        passed: false,
        error: error.message,
      });
    }

    // Test 5: Scan with direct client (cache-helpers pattern)
    try {
      const { createClient } = await import('redis');
      const url = new URL(process.env.REDIS_URL!);

      const directClient = createClient({
        url: `${url.protocol}//${url.host}`,
        username: url.username === '' ? undefined : url.username,
        password: url.password,
        socket: {
          connectTimeout: 10000,
        },
      });

      await directClient.connect();

      // Test that cursor is handled correctly (string in, number out)
      let cursor: number | undefined;
      let keyCount = 0;

      while (cursor !== 0) {
        const reply = await directClient.scan((cursor ?? 0).toString(), {
          MATCH: 'test:*',
          COUNT: 100,
        });

        // reply should have { cursor: string, keys: string[] }
        cursor = Number(reply.cursor);
        keyCount += reply.keys.length;

        if (!reply.cursor || !Array.isArray(reply.keys)) {
          throw new Error('Scan reply structure incorrect');
        }
      }

      await directClient.quit();

      results.push({
        name: 'Direct scan with cursor handling',
        passed: true,
        details: { scannedKeys: keyCount, cursorType: 'string -> number' },
      });
    } catch (error: any) {
      results.push({
        name: 'Direct scan with cursor handling',
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

    // Test 7: Verify cluster client has masters property
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

    const allPassed = results.every((r) => r.passed);
    const summary = {
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
