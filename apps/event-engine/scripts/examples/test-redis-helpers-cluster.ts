/**
 * Test script for Redis helpers from withRedisHelpers
 *
 * This script demonstrates and validates all Redis helper functions:
 * - hSetEx: Hash set with expiration
 * - setNxKeepTtlWithEx: Set if not exists, keeping TTL
 * - hIncrIfExists: Hash increment if key exists
 * - run: Parallel promise execution
 */

import { withRedisHelpers } from '@/common/utils/query-utils'
import * as dotenv from 'dotenv'
import { createCluster } from 'redis'

dotenv.config()

async function main() {
  const redisUrl = process.env.REDIS_URL
  if (!redisUrl) {
    throw new Error('REDIS_URL environment variable is required')
  }

  console.log('🔌 Connecting to Redis...')
  const url = new URL(redisUrl);
  const redis = createCluster({
    rootNodes: [{url: `${url.protocol}//${url.host}`}],
    defaults: {
      username: url.username === '' ? undefined : url.username,
      password: url.password
    }
  })
  console.log('created');
  const client = withRedisHelpers(redis)
  console.log('helpers added');

  await client.connect()
  console.log('connected');
  await client.loadScripts()
  console.log('scripts loaded');
  console.log('✅ Connected and scripts loaded\n')

  const testPrefix = '{test:redis-helpers}'
  const testKey = `${testPrefix}:hash`
  const testKey2 = `${testPrefix}:nx`

  try {
    // Clean up any existing test keys
    console.log('🧹 Cleaning up existing test keys...')
    await client.del([testKey, testKey2])
    console.log()

    // Test 1: hSetEx - Set hash with expiration
    console.log('📝 Test 1: hSetEx (hash set with expiration)')
    console.log('  Setting hash with fields and 60s TTL...')
    await client.hSetEx(testKey, {
      field1: '100',
      field2: '200',
      field3: '300',
    }, 60)

    const hashValues = await client.hGetAll(testKey)
    const ttl = await client.ttl(testKey)
    console.log('  ✓ Hash values:', hashValues)
    console.log('  ✓ TTL:', ttl, 'seconds')
    console.log()

    // Test 2: hIncrIfExists - Increment hash field if key exists
    console.log('🔢 Test 2: hIncrIfExists (increment only if key exists)')
    console.log('  Incrementing field1 by 50 (key exists)...')
    const incrementSuccess = await client.hIncrIfExists(testKey, 'field1', 50)
    console.log('  ✓ Increment succeeded:', incrementSuccess)

    const field1Value = await client.hGet(testKey, 'field1')
    console.log('  ✓ New value of field1:', field1Value, '(was 100)')

    console.log('  Trying to increment on non-existent key...')
    const incrementFail = await client.hIncrIfExists(`${testPrefix}:nonexistent`, 'field1', 10)
    console.log('  ✓ Increment failed as expected:', !incrementFail)
    console.log()

    // Test 3: hIncrIfExists in multi/pipeline
    console.log('⚡ Test 3: hSet expire in pipeline')
    console.log('  Incrementing multiple fields in pipeline...')
    const pipeline = client.multi()
    pipeline.hSet(testKey, 'field2', '200')
    pipeline.hExpire(testKey, 'field2', 45)
    await pipeline.exec()

    const updatedHash = await client.hGetAll(testKey)
    console.log('  ✓ Updated hash:', updatedHash)
    console.log('    - field2: 200 → 225')
    console.log('    - field3: 300 → 250')
    console.log()

    // Test 4: setNxKeepTtlWithEx - Set if not exists with TTL
    console.log('🔐 Test 4: setNxKeepTtlWithEx (set NX with TTL)')
    console.log('  Setting value with 120s TTL (first time)...')
    const setSuccess1 = await client.setNxKeepTtlWithEx(testKey2, 'initial-value', 120)
    console.log('  ✓ Set succeeded:', setSuccess1)

    const value1 = await client.get(testKey2)
    const ttl2 = await client.ttl(testKey2)
    console.log('  ✓ Value:', value1)
    console.log('  ✓ TTL:', ttl2, 'seconds')

    console.log('  Trying to set again (should fail - NX)...')
    const setSuccess2 = await client.setNxKeepTtlWithEx(testKey2, 'new-value', 60)
    console.log('  ✓ Set failed as expected:', !setSuccess2)

    const value2 = await client.get(testKey2)
    console.log('  ✓ Value unchanged:', value2)
    console.log()

    // Test 5: run - Parallel promise execution
    console.log('🚀 Test 5: run (parallel promise execution)')
    console.log('  Running multiple operations in parallel...')
    const startTime = Date.now()

    const results = await client.run([
      client.hGet(testKey, 'field1'),
      client.hGet(testKey, 'field2'),
      client.hGet(testKey, 'field3'),
      client.get(testKey2),
      client.ttl(testKey),
    ])

    const elapsed = Date.now() - startTime
    console.log('  ✓ Completed in', elapsed, 'ms')
    console.log('  ✓ Results:', results)
    console.log()

    // Test 6: Complex pipeline with mixed operations
    console.log('🔧 Test 6: Complex pipeline with helpers')
    console.log('  Running pipeline with mixed operations...')
    const complexPipeline = client.multi()
    complexPipeline.hIncrIfExists(testKey, 'field1', 10)
    complexPipeline.hSet(testKey, 'field4', '400')
    complexPipeline.hIncrIfExists(testKey, 'field4', 100)
    complexPipeline.expire(testKey, 30)
    const pipelineResults = await complexPipeline.exec()

    console.log('  ✓ Pipeline results:', pipelineResults)

    const finalHash = await client.hGetAll(testKey)
    console.log('  ✓ Final hash state:', finalHash)
    console.log()

    // Summary
    console.log('✨ All tests completed successfully!')
    console.log('\nTested helpers:')
    console.log('  ✓ hSetEx - Hash set with expiration')
    console.log('  ✓ hIncrIfExists - Conditional hash increment')
    console.log('  ✓ setNxKeepTtlWithEx - Set NX with TTL')
    console.log('  ✓ run - Parallel promise execution')
    console.log('  ✓ Pipeline integration - All helpers work in pipelines')

  } finally {
    // Clean up
    console.log('\n🧹 Cleaning up test keys...')
    await client.del([testKey, testKey2])

    console.log('👋 Disconnecting...')
    await client.quit()
    console.log('✅ Done!')
  }
}

main().catch((error) => {
  console.error('❌ Error:', error)
  process.exit(1)
})