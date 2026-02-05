/**
 * Comprehensive test to compare outputs between base-model.constants.ts and basemodel.constants.ts
 *
 * This script validates that the compatibility layer in basemodel.constants.ts produces
 * identical outputs to the original base-model.constants.ts for all exported functions.
 */

import { ModelType } from '../src/shared/utils/prisma/enums';

// Import from OLD file
import * as OldConstants from '../src/shared/constants/base-model.constants';

// Import from NEW file
import * as NewConstants from '../src/shared/constants/basemodel.constants';

// Test results tracking
interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: any;
}

const results: TestResult[] = [];

function addResult(name: string, passed: boolean, error?: string, details?: any) {
  results.push({ name, passed, error, details });
  const status = passed ? '✓' : '✗';
  console.log(`${status} ${name}`);
  if (error) console.log(`  Error: ${error}`);
  if (details) console.log(`  Details:`, details);
}

function compareArrays(arr1: any[], arr2: any[], name: string) {
  const set1 = new Set(arr1);
  const set2 = new Set(arr2);

  const onlyInOld = arr1.filter(x => !set2.has(x));
  const onlyInNew = arr2.filter(x => !set1.has(x));

  if (onlyInOld.length > 0 || onlyInNew.length > 0) {
    addResult(name, false, 'Arrays differ', {
      onlyInOld: onlyInOld.length > 0 ? onlyInOld : undefined,
      onlyInNew: onlyInNew.length > 0 ? onlyInNew : undefined,
      oldLength: arr1.length,
      newLength: arr2.length,
    });
    return false;
  }

  addResult(name, true);
  return true;
}

function compareValues(val1: any, val2: any, name: string) {
  if (val1 === val2) {
    addResult(name, true);
    return true;
  }

  addResult(name, false, `Values differ: ${val1} !== ${val2}`);
  return false;
}

console.log('\n=== Testing Base Model Constants Migration ===\n');

// =============================================================================
// Test 1: Array Exports
// =============================================================================

console.log('\n--- Array Exports ---\n');

compareArrays(OldConstants.baseModels, NewConstants.baseModels, 'baseModels array');
compareArrays(OldConstants.baseModelGroups, NewConstants.baseModelGroups, 'baseModelGroups array');
compareArrays(OldConstants.activeBaseModels, NewConstants.activeBaseModels, 'activeBaseModels array');

// =============================================================================
// Test 2: Constants
// =============================================================================

console.log('\n--- Constants ---\n');

compareArrays(
  Array.from(OldConstants.DEPRECATED_BASE_MODELS),
  Array.from(NewConstants.DEPRECATED_BASE_MODELS),
  'DEPRECATED_BASE_MODELS'
);

// =============================================================================
// Test 3: Function Outputs (using sample base models)
// =============================================================================

console.log('\n--- Function Outputs ---\n');

const testBaseModels = [
  'SDXL 1.0',
  'Flux.1 D',
  'SD 1.5',
  'Pony',
  'Illustrious',
  'NoobAI',
  'Wan Video 14B t2v',
  'LTXV2',
  'Other',
];

// Test getBaseModelGroup
for (const baseModel of testBaseModels) {
  const oldResult = OldConstants.getBaseModelGroup(baseModel);
  const newResult = NewConstants.getBaseModelGroup(baseModel);
  compareValues(oldResult, newResult, `getBaseModelGroup("${baseModel}")`);
}

// Test getBaseModelEcosystem
for (const baseModel of testBaseModels) {
  const oldResult = OldConstants.getBaseModelEcosystem(baseModel);
  const newResult = NewConstants.getBaseModelEcosystem(baseModel);
  compareValues(oldResult, newResult, `getBaseModelEcosystem("${baseModel}")`);
}

// Test getBaseModelSeoName
for (const baseModel of testBaseModels) {
  const oldResult = OldConstants.getBaseModelSeoName(baseModel);
  const newResult = NewConstants.getBaseModelSeoName(baseModel);
  compareValues(oldResult, newResult, `getBaseModelSeoName("${baseModel}")`);
}

// Test getBaseModelEngine
for (const baseModel of testBaseModels) {
  const oldResult = OldConstants.getBaseModelEngine(baseModel);
  const newResult = NewConstants.getBaseModelEngine(baseModel);
  compareValues(oldResult, newResult, `getBaseModelEngine("${baseModel}")`);
}

// Test getBaseModelMediaType
for (const baseModel of testBaseModels) {
  const oldResult = OldConstants.getBaseModelMediaType(baseModel);
  const newResult = NewConstants.getBaseModelMediaType(baseModel);
  compareValues(oldResult, newResult, `getBaseModelMediaType("${baseModel}")`);
}

// Test getBaseModelsByGroup
const testGroups = ['SDXL', 'Flux1', 'SD1', 'Pony', 'WanVideo14B_T2V', 'Other'];
for (const group of testGroups) {
  const oldResult = OldConstants.getBaseModelsByGroup(group);
  const newResult = NewConstants.getBaseModelsByGroup(group);
  compareArrays(oldResult, newResult, `getBaseModelsByGroup("${group}")`);
}

// Test getBaseModelByMediaType
for (const type of ['image', 'video'] as const) {
  const oldResult = OldConstants.getBaseModelByMediaType(type);
  const newResult = NewConstants.getBaseModelByMediaType(type);
  compareArrays(oldResult, newResult, `getBaseModelByMediaType("${type}")`);
}

// Test getBaseModelGroupsByMediaType
for (const type of ['image', 'video'] as const) {
  const oldResult = OldConstants.getBaseModelGroupsByMediaType(type);
  const newResult = NewConstants.getBaseModelGroupsByMediaType(type);
  compareArrays(oldResult, newResult, `getBaseModelGroupsByMediaType("${type}")`);
}

// =============================================================================
// Test 4: Generation Support Functions
// =============================================================================

console.log('\n--- Generation Support Functions ---\n');

// Test getBaseModelGenerationConfig
const oldGenConfig = OldConstants.getBaseModelGenerationConfig();
const newGenConfig = NewConstants.getBaseModelGenerationConfig();

// Compare structure (both should return arrays with group and supportMap)
addResult(
  'getBaseModelGenerationConfig() - structure',
  Array.isArray(oldGenConfig) && Array.isArray(newGenConfig),
  Array.isArray(oldGenConfig) && Array.isArray(newGenConfig) ? undefined : 'Both should return arrays'
);

// Compare lengths
compareValues(
  oldGenConfig.length,
  newGenConfig.length,
  'getBaseModelGenerationConfig() - length'
);

// Test getGenerationBaseModelConfigs
const oldGenBaseModels = OldConstants.getGenerationBaseModelConfigs();
const newGenBaseModels = NewConstants.getGenerationBaseModelConfigs();
compareArrays(oldGenBaseModels, newGenBaseModels, 'getGenerationBaseModelConfigs()');

// Test getGenerationBaseModelConfigs with media type
for (const type of ['image', 'video'] as const) {
  const oldResult = OldConstants.getGenerationBaseModelConfigs(type);
  const newResult = NewConstants.getGenerationBaseModelConfigs(type);
  compareArrays(oldResult, newResult, `getGenerationBaseModelConfigs("${type}")`);
}

// Test getGenerationBaseModelsByMediaType
for (const type of ['image', 'video'] as const) {
  const oldResult = OldConstants.getGenerationBaseModelsByMediaType(type);
  const newResult = NewConstants.getGenerationBaseModelsByMediaType(type);
  compareArrays(oldResult, newResult, `getGenerationBaseModelsByMediaType("${type}")`);
}

// Test getBaseModelGenerationSupported
const testModelTypes = [ModelType.LORA, ModelType.Checkpoint, ModelType.TextualInversion];
for (const baseModel of testBaseModels.slice(0, 5)) {
  for (const modelType of testModelTypes) {
    const oldResult = OldConstants.getBaseModelGenerationSupported(baseModel, modelType);
    const newResult = NewConstants.getBaseModelGenerationSupported(baseModel, modelType);
    compareValues(
      oldResult,
      newResult,
      `getBaseModelGenerationSupported("${baseModel}", ${ModelType[modelType]})`
    );
  }
}

// Test getGenerationBaseModels
for (const group of testGroups.slice(0, 3)) {
  for (const modelType of testModelTypes) {
    const oldResult = OldConstants.getGenerationBaseModels(group, modelType);
    const newResult = NewConstants.getGenerationBaseModels(group, modelType);
    compareArrays(
      oldResult,
      newResult,
      `getGenerationBaseModels("${group}", ${ModelType[modelType]})`
    );
  }
}

// Test getGenerationBaseModelResourceOptions
for (const group of testGroups.slice(0, 3)) {
  const oldResult = OldConstants.getGenerationBaseModelResourceOptions(group);
  const newResult = NewConstants.getGenerationBaseModelResourceOptions(group);

  // Compare structure
  if (Array.isArray(oldResult) && Array.isArray(newResult)) {
    if (oldResult.length === newResult.length) {
      let allMatch = true;
      for (let i = 0; i < oldResult.length; i++) {
        const oldItem = oldResult[i];
        const newItem = newResult[i];

        // Find matching type in newResult
        const matchingNew = newResult.find(n => n.type === oldItem.type);
        if (!matchingNew) {
          allMatch = false;
          break;
        }

        // Compare baseModels and partialSupport
        const baseModelsMatch =
          new Set(oldItem.baseModels).size === new Set(matchingNew.baseModels).size &&
          oldItem.baseModels.every((x: string) => matchingNew.baseModels.includes(x));

        const partialMatch =
          new Set(oldItem.partialSupport).size === new Set(matchingNew.partialSupport).size &&
          oldItem.partialSupport.every((x: string) => matchingNew.partialSupport.includes(x));

        if (!baseModelsMatch || !partialMatch) {
          allMatch = false;
          break;
        }
      }

      addResult(
        `getGenerationBaseModelResourceOptions("${group}")`,
        allMatch,
        allMatch ? undefined : 'Resource options differ'
      );
    } else {
      addResult(
        `getGenerationBaseModelResourceOptions("${group}")`,
        false,
        `Different lengths: ${oldResult.length} vs ${newResult.length}`
      );
    }
  } else {
    addResult(
      `getGenerationBaseModelResourceOptions("${group}")`,
      false,
      'Both should return arrays'
    );
  }
}

// Test getCanAuctionForGeneration
for (const baseModel of testBaseModels) {
  const oldResult = OldConstants.getCanAuctionForGeneration(baseModel);
  const newResult = NewConstants.getCanAuctionForGeneration(baseModel);
  compareValues(oldResult, newResult, `getCanAuctionForGeneration("${baseModel}")`);
}

// Test getGenerationBaseModelAssociatedGroups
for (const group of testGroups.slice(0, 3)) {
  for (const modelType of testModelTypes.slice(0, 2)) {
    const oldResult = OldConstants.getGenerationBaseModelAssociatedGroups(group, modelType);
    const newResult = NewConstants.getGenerationBaseModelAssociatedGroups(group, modelType);
    compareArrays(
      oldResult,
      newResult,
      `getGenerationBaseModelAssociatedGroups("${group}", ${ModelType[modelType]})`
    );
  }
}

// Test getBaseModelsByModelType
const testArgs = [
  { modelType: ModelType.LORA, baseModel: 'SDXL 1.0' },
  { modelType: ModelType.LORA, baseModel: 'Flux.1 D' },
  { modelType: ModelType.Checkpoint, baseModel: 'SD 1.5' },
];
const oldByModelType = OldConstants.getBaseModelsByModelType(testArgs);
const newByModelType = NewConstants.getBaseModelsByModelType(testArgs);

// Compare each model type key
let byModelTypeMatch = true;
for (const modelType of Object.keys(oldByModelType)) {
  const oldModels = oldByModelType[modelType as any];
  const newModels = newByModelType[modelType as any];
  if (!newModels || oldModels.length !== newModels.length ||
      !oldModels.every((m: string) => newModels.includes(m))) {
    byModelTypeMatch = false;
    break;
  }
}
addResult(
  'getBaseModelsByModelType()',
  byModelTypeMatch,
  byModelTypeMatch ? undefined : 'Results differ'
);

// =============================================================================
// Summary
// =============================================================================

console.log('\n=== Test Summary ===\n');

const passed = results.filter(r => r.passed).length;
const failed = results.filter(r => !r.passed).length;
const total = results.length;

console.log(`Total tests: ${total}`);
console.log(`Passed: ${passed} (${((passed / total) * 100).toFixed(1)}%)`);
console.log(`Failed: ${failed} (${((failed / total) * 100).toFixed(1)}%)`);

if (failed > 0) {
  console.log('\n=== Failed Tests ===\n');
  results
    .filter(r => !r.passed)
    .forEach(r => {
      console.log(`✗ ${r.name}`);
      if (r.error) console.log(`  Error: ${r.error}`);
      if (r.details) console.log(`  Details:`, r.details);
    });

  process.exit(1);
} else {
  console.log('\n✓ All tests passed!\n');
  process.exit(0);
}
