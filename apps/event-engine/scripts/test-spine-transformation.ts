/**
 * Test script for Spine workflow transformation
 * Tests the conversion of ergonomic function-based steps to raw API format
 */

import { spineService, withKafka } from '../src/services/spine';
import { SpineWorkflowRequest } from '../src/types/spine';

console.log('=== Testing Spine Step Transformation ===\n');

// Test 1: Function-based steps with step references
console.log('Test 1: Function-based steps with name references');
console.log('---');

const test1Request: SpineWorkflowRequest = {
  metadata: { imageId: 123 },
  arguments: {
    mediaUrl: 'https://example.com/image.jpg'
  },
  steps: ({ args, output }) => [
    {
      $type: 'wdTagging',
      name: 'tagging',
      input: {
        mediaUrl: args.mediaUrl
      }
    },
    {
      $type: 'rating',
      name: 'rating',
      input: {
        imageUrl: output.tagging.blob.url
      }
    },
    {
      $type: 'hash',
      input: {
        imageUrl: args.mediaUrl,
        hashTypes: output.rating.hashTypes
      }
    }
  ]
};

// @ts-expect-error - accessing private method for testing
const transformed1 = spineService['transformRequest'](test1Request);
console.log('Input (function-based):');
console.log('  steps: (ctx) => [...]');
console.log('\nOutput (raw API format):');
console.log(JSON.stringify(transformed1.steps, null, 2));
console.log('\n');

// Test 2: Raw array steps (should pass through unchanged)
console.log('Test 2: Raw array steps (passthrough)');
console.log('---');

const test2Request: SpineWorkflowRequest = {
  arguments: { url: 'https://example.com/image.jpg' },
  steps: [
    {
      $type: 'wdTagging',
      input: {
        mediaUrl: { $ref: '$arguments', path: 'url' }
      }
    }
  ]
};

// @ts-expect-error - accessing private method for testing
const transformed2 = spineService['transformRequest'](test2Request);
console.log('Input (array):');
console.log(JSON.stringify(test2Request.steps, null, 2));
console.log('\nOutput (should be identical):');
console.log(JSON.stringify(transformed2.steps, null, 2));
console.log('\n');

// Test 3: withKafka helper
console.log('Test 3: withKafka helper');
console.log('---');

const kafkaConfig = withKafka({
  topic: 'orchestrator.imageScanned',
  metadata: { imageId: 456 },
  arguments: {
    url: 'https://example.com/test.jpg'
  },
  steps: ({ args }) => [
    {
      $type: 'wdTagging',
      input: { mediaUrl: args.url },
      output: false
    },
    {
      $type: 'rating',
      input: { imageUrl: args.url },
      output: true
    },
    {
      $type: 'hash',
      input: { imageUrl: args.url },
      output: true
    }
  ]
});

console.log('Input config:');
console.log('  topic: orchestrator.imageScanned');
console.log('  steps: [wdTagging (output:false), rating (output:true), hash (output:true)]');
console.log('\nGenerated request:');
console.log(`  tags: ${JSON.stringify(kafkaConfig.tags)}`);
console.log(`  callbacks[0].url: ${kafkaConfig.callbacks?.[0].url}`);
console.log(`  callbacks[0].type: ${JSON.stringify(kafkaConfig.callbacks?.[0].type)}`);

// @ts-expect-error - accessing private method for testing
const transformedKafka = spineService['transformRequest'](kafkaConfig);
console.log('\nTransformed steps:');
console.log(JSON.stringify(transformedKafka.steps, null, 2));
console.log('\n');

// Test 4: Complex nested property access
console.log('Test 4: Complex nested property access');
console.log('---');

const test4Request: SpineWorkflowRequest = {
  arguments: {
    config: {
      image: {
        url: 'https://example.com/nested.jpg'
      }
    }
  },
  steps: ({ args, output }) => [
    {
      $type: 'process',
      name: 'proc',
      input: {
        deepUrl: args.config.image.url
      }
    },
    {
      $type: 'analyze',
      input: {
        result: output.proc.data.results.score
      }
    }
  ]
};

// @ts-expect-error - accessing private method for testing
const transformed4 = spineService['transformRequest'](test4Request);
console.log('Input:');
console.log('  args.config.image.url');
console.log('  output.proc.data.results.score');
console.log('\nOutput:');
console.log(JSON.stringify(transformed4.steps, null, 2));
console.log('\n');

console.log('=== All Tests Complete ===');
