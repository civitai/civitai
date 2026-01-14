/**
 * Test endpoint for model feed filtering
 *
 * Tests that getModelsRaw correctly applies filters when using BOTH query paths:
 * - Standard ModelMetric path (feature flag off)
 * - ModelBaseModelMetric path (feature flag on)
 *
 * Call with: GET /api/internal/test-model-feed-filters?token=<JOB_TOKEN>
 *
 * Optional params:
 *   - username: Test with a specific username
 *   - baseModel: Test with a specific base model (e.g., "SDXL 1.0")
 *   - type: Test with a specific model type (e.g., "Checkpoint")
 *   - path: "standard" | "baseModelMetrics" | "both" (default: "both")
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { dbRead } from '~/server/db/client';
import { ModelSort } from '~/server/common/enums';
import { getModelsRaw } from '~/server/services/model.service';
import type { GetAllModelsOutput } from '~/server/schema/model.schema';
import { ModelStatus } from '~/shared/utils/prisma/enums';
import { JobEndpoint } from '~/server/utils/endpoint-helpers';

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
  itemCount?: number;
  queryPath: 'standard' | 'baseModelMetrics';
  sampleItems?: Array<{ name: string; userId: number; type: string; baseModels: string[] }>;
}

// Helper to create base input with required fields
function createInput(
  overrides: Partial<Omit<GetAllModelsOutput, 'limit' | 'page'>>
): Omit<GetAllModelsOutput, 'limit' | 'page'> & { take?: number } {
  return {
    sort: ModelSort.Newest,
    period: 'AllTime',
    periodMode: 'published',
    favorites: false,
    hidden: false,
    browsingLevel: 31,
    take: 20,
    ...overrides,
  };
}

export default JobEndpoint(async function testModelFeedFilters(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const results: TestResult[] = [];
  const { username, baseModel, type, userId: userIdParam, path: pathParam } = req.query;

  const testPath = (pathParam as string) || 'both';
  const testStandard = testPath === 'standard' || testPath === 'both';
  const testBaseModelMetrics = testPath === 'baseModelMetrics' || testPath === 'both';

  console.log('Starting model feed filter tests...');
  console.log(`Testing paths: ${testPath}`);

  // Find test data
  const testData = await findTestData();
  console.log('Test data found:', {
    userWithModels: testData.userWithModels?.username,
    baseModels: testData.baseModels.slice(0, 3),
    modelTypes: testData.modelTypes.slice(0, 3),
  });

  // Override with query params if provided
  const testUsername = (username as string) || testData.userWithModels?.username;
  const testBaseModel = (baseModel as string) || testData.baseModels[0];
  const testType = (type as string) || testData.modelTypes[0];
  const testUserId = userIdParam ? parseInt(userIdParam as string) : testData.userWithModels?.id;

  // Run tests for each query path
  const pathsToTest: Array<{ name: 'standard' | 'baseModelMetrics'; force: boolean }> = [];
  if (testStandard) pathsToTest.push({ name: 'standard', force: false });
  if (testBaseModelMetrics) pathsToTest.push({ name: 'baseModelMetrics', force: true });

  for (const queryPath of pathsToTest) {
    // Test 1: Base model filter only
    if (testBaseModel) {
      results.push(await testBaseModelOnlyFilter([testBaseModel], queryPath.name, queryPath.force));
    }

    // Test 2: Username filter without base model (only for standard path, no baseModel = no fork)
    if (testUsername && testUserId && queryPath.name === 'standard') {
      results.push(await testUsernameFilter(testUsername, testUserId, queryPath.name));
    }

    // Test 3: Username filter WITH base model (the bug scenario!)
    if (testUsername && testUserId && testBaseModel) {
      results.push(
        await testUsernameWithBaseModelFilter(
          testUsername,
          testUserId,
          [testBaseModel],
          queryPath.name,
          queryPath.force
        )
      );
    }

    // Test 4: Types filter without base model (only for standard path)
    if (testType && queryPath.name === 'standard') {
      results.push(await testTypesFilter([testType], queryPath.name));
    }

    // Test 5: Types filter WITH base model (category tabs bug!)
    if (testType && testBaseModel) {
      results.push(
        await testTypesWithBaseModelFilter(
          [testType],
          [testBaseModel],
          queryPath.name,
          queryPath.force
        )
      );
    }
  }

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  return res.status(200).json({
    summary: {
      total: results.length,
      passed,
      failed,
      allPassed: failed === 0,
    },
    testData: {
      username: testUsername,
      userId: testUserId,
      baseModel: testBaseModel,
      type: testType,
    },
    results,
  });
});

async function findTestData() {
  // Find a user who has models
  const userWithModels = await dbRead.user.findFirst({
    where: {
      models: {
        some: {
          status: ModelStatus.Published,
        },
      },
    },
    select: {
      id: true,
      username: true,
      _count: {
        select: { models: true },
      },
    },
    orderBy: {
      models: {
        _count: 'desc',
      },
    },
  });

  // Find base models that have models
  const baseModelsWithData = await dbRead.modelVersion.groupBy({
    by: ['baseModel'],
    where: {
      status: ModelStatus.Published,
      model: {
        status: ModelStatus.Published,
      },
    },
    _count: true,
    orderBy: {
      _count: {
        baseModel: 'desc',
      },
    },
    take: 10,
  });

  // Find model types with data
  const modelTypesWithData = await dbRead.model.groupBy({
    by: ['type'],
    where: {
      status: ModelStatus.Published,
    },
    _count: true,
    orderBy: {
      _count: {
        type: 'desc',
      },
    },
    take: 5,
  });

  return {
    userWithModels,
    baseModels: baseModelsWithData.map((b) => b.baseModel),
    modelTypes: modelTypesWithData.map((t) => t.type),
  };
}

async function testUsernameFilter(
  username: string,
  expectedUserId: number,
  queryPath: 'standard' | 'baseModelMetrics'
): Promise<TestResult> {
  try {
    const result = await getModelsRaw({
      input: createInput({ username }),
    });

    const wrongUserModels = result.items.filter((item) => item.user.id !== expectedUserId);
    const passed = wrongUserModels.length === 0;

    return {
      name: `[${queryPath}] Username filter (${username})`,
      passed,
      queryPath,
      details: passed
        ? 'All models belong to the specified user'
        : `Found ${wrongUserModels.length} models from other users`,
      itemCount: result.items.length,
      sampleItems: result.items.slice(0, 3).map((m) => ({
        name: m.name,
        userId: m.user.id,
        type: m.type,
        baseModels: m.modelVersions.map((mv) => mv.baseModel),
      })),
    };
  } catch (error) {
    return {
      name: `[${queryPath}] Username filter (${username})`,
      passed: false,
      queryPath,
      details: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function testUsernameWithBaseModelFilter(
  username: string,
  expectedUserId: number,
  baseModels: string[],
  queryPath: 'standard' | 'baseModelMetrics',
  forceBaseModelMetrics: boolean
): Promise<TestResult> {
  try {
    const result = await getModelsRaw({
      input: createInput({
        username,
        baseModels: baseModels as GetAllModelsOutput['baseModels'],
      }),
      _forceBaseModelMetrics: forceBaseModelMetrics,
    });

    const wrongUserModels = result.items.filter((item) => item.user.id !== expectedUserId);
    const wrongBaseModelModels = result.items.filter(
      (item) => !item.modelVersions.some((mv) => baseModels.includes(mv.baseModel))
    );

    const passed = wrongUserModels.length === 0 && wrongBaseModelModels.length === 0;

    return {
      name: `[${queryPath}] Username + BaseModel filter (${username}, ${baseModels.join('/')})`,
      passed,
      queryPath,
      details: passed
        ? 'All models belong to user and have correct base models'
        : wrongUserModels.length > 0
        ? `CRITICAL: Found ${wrongUserModels.length} models from OTHER users (user IDs: ${[
            ...new Set(wrongUserModels.map((m) => m.user.id)),
          ].join(', ')})`
        : `Found ${wrongBaseModelModels.length} models with incorrect base models`,
      itemCount: result.items.length,
      sampleItems: result.items.slice(0, 5).map((m) => ({
        name: m.name,
        userId: m.user.id,
        type: m.type,
        baseModels: m.modelVersions.map((mv) => mv.baseModel),
      })),
    };
  } catch (error) {
    return {
      name: `[${queryPath}] Username + BaseModel filter (${username}, ${baseModels.join('/')})`,
      passed: false,
      queryPath,
      details: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function testTypesFilter(
  types: string[],
  queryPath: 'standard' | 'baseModelMetrics'
): Promise<TestResult> {
  try {
    const result = await getModelsRaw({
      input: createInput({
        types: types as GetAllModelsOutput['types'],
      }),
    });

    const wrongTypeModels = result.items.filter((item) => !types.includes(item.type));
    const passed = wrongTypeModels.length === 0;

    return {
      name: `[${queryPath}] Types filter (${types.join(', ')})`,
      passed,
      queryPath,
      details: passed
        ? 'All models have correct type'
        : `Found ${wrongTypeModels.length} models with wrong types: ${[
            ...new Set(wrongTypeModels.map((m) => m.type)),
          ].join(', ')}`,
      itemCount: result.items.length,
      sampleItems: result.items.slice(0, 3).map((m) => ({
        name: m.name,
        userId: m.user.id,
        type: m.type,
        baseModels: m.modelVersions.map((mv) => mv.baseModel),
      })),
    };
  } catch (error) {
    return {
      name: `[${queryPath}] Types filter (${types.join(', ')})`,
      passed: false,
      queryPath,
      details: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function testTypesWithBaseModelFilter(
  types: string[],
  baseModels: string[],
  queryPath: 'standard' | 'baseModelMetrics',
  forceBaseModelMetrics: boolean
): Promise<TestResult> {
  try {
    const result = await getModelsRaw({
      input: createInput({
        types: types as GetAllModelsOutput['types'],
        baseModels: baseModels as GetAllModelsOutput['baseModels'],
      }),
      _forceBaseModelMetrics: forceBaseModelMetrics,
    });

    const wrongTypeModels = result.items.filter((item) => !types.includes(item.type));
    const wrongBaseModelModels = result.items.filter(
      (item) => !item.modelVersions.some((mv) => baseModels.includes(mv.baseModel))
    );

    const passed = wrongTypeModels.length === 0 && wrongBaseModelModels.length === 0;

    return {
      name: `[${queryPath}] Types + BaseModel filter (${types.join(', ')}, ${baseModels.join(
        '/'
      )})`,
      passed,
      queryPath,
      details: passed
        ? 'All models have correct type and base model'
        : wrongTypeModels.length > 0
        ? `CRITICAL: Found ${wrongTypeModels.length} models with wrong types: ${[
            ...new Set(wrongTypeModels.map((m) => m.type)),
          ].join(', ')}`
        : `Found ${wrongBaseModelModels.length} models with incorrect base models`,
      itemCount: result.items.length,
      sampleItems: result.items.slice(0, 5).map((m) => ({
        name: m.name,
        userId: m.user.id,
        type: m.type,
        baseModels: m.modelVersions.map((mv) => mv.baseModel),
      })),
    };
  } catch (error) {
    return {
      name: `[${queryPath}] Types + BaseModel filter`,
      passed: false,
      queryPath,
      details: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function testBaseModelOnlyFilter(
  baseModels: string[],
  queryPath: 'standard' | 'baseModelMetrics',
  forceBaseModelMetrics: boolean
): Promise<TestResult> {
  try {
    const result = await getModelsRaw({
      input: {
        ...createInput({
          baseModels: baseModels as GetAllModelsOutput['baseModels'],
        }),
        take: 50,
      },
      _forceBaseModelMetrics: forceBaseModelMetrics,
    });

    const wrongBaseModelModels = result.items.filter(
      (item) => !item.modelVersions.some((mv) => baseModels.includes(mv.baseModel))
    );
    const passed = wrongBaseModelModels.length === 0;

    return {
      name: `[${queryPath}] BaseModel only filter (${baseModels.join(', ')})`,
      passed,
      queryPath,
      details: passed
        ? 'All models have correct base models'
        : `Found ${wrongBaseModelModels.length} models with wrong base models`,
      itemCount: result.items.length,
      sampleItems: result.items.slice(0, 3).map((m) => ({
        name: m.name,
        userId: m.user.id,
        type: m.type,
        baseModels: m.modelVersions.map((mv) => mv.baseModel),
      })),
    };
  } catch (error) {
    return {
      name: `[${queryPath}] BaseModel only filter`,
      passed: false,
      queryPath,
      details: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
