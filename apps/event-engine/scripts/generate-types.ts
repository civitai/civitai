import { EventHandler, ManualHandler, OutboxHandler } from '../src/types/handlers'
import { eventHandlers } from '../src/handlers'
import { Operation } from '../src/types/events'
import { faker } from '@faker-js/faker'

interface MetricOutput {
  handler: string
  operation: Operation
  entityType: string
  metricType: string
  userId?: number
  value?: number
}

interface HandlerReport {
  handler: string
  tables: string[]
  operations: Operation[]
  metrics: Set<string>
  errors: string[]
  coverage: {
    iterations: number
    operations: Record<Operation, number>
  }
}

interface StructuredReport {
  metrics: {
    handlers: number
    handlersWithDebug: number
    metrics: number
  }
  entityTypes: Record<string, Record<string, string>>
  tables: Record<string, string[]>
}

/**
 * Debug action collector that captures all metric emissions
 */
class DebugActions {
  private results: MetricOutput[] = []

  constructor(private handlerName: string, private operation: Operation) {}

  addMetricEvent = ({entityType, metricType, userId, metricValue}: any) => {
    this.results.push({
      handler: this.handlerName,
      operation: this.operation,
      entityType,
      metricType,
      userId,
      value: metricValue
    })
  }

  incMetricCache = (update: any) => {
    // We don't use this in our handlers typically
  }

  feedUpdate = (entityType: string, entityId: number | null | undefined, type: string = 'update') => {
    // Feed updates don't generate metrics, just track that it was called
  }

  feedDelete = (entityType: string, entityId: number | null | undefined) => this.feedUpdate(entityType, entityId, 'delete')

  feedMetricUpdate = (entityType: string, entityId: number | null | undefined) => this.feedUpdate(entityType, entityId, 'metricUpdate')

  forMetric = (entityType: string, entityId: number | null | undefined) => {
    return {
      as: (userId?: number | null) => ({
        add: (metricType: string, value: number = 1) => {
          if (entityId != null) {
            this.results.push({
              handler: this.handlerName,
              operation: this.operation,
              entityType,
              metricType,
              userId: userId ?? undefined,
              value
            })
          }
        },
        remove: (metricType: string, value: number = 1) => {
          if (entityId != null) {
            this.results.push({
              handler: this.handlerName,
              operation: this.operation,
              entityType,
              metricType,
              userId: userId ?? undefined,
              value: -value
            })
          }
        }
      })
    }
  }

  getResults() {
    return this.results
  }
}

/**
 * Create mock database proxies using handler's debug configuration
 */
const createMockDatabases = (debugConfig: any) => ({
  pg: {
    query: async <T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }> => {
      if (debugConfig?.pg) {
        const result = debugConfig.pg(sql, params)
        return { rows: result ? [result] : [] }
      }
      return { rows: [] }
    },
    queryOne: async <T = any>(sql: string, params?: any[]): Promise<T | null> => {
      if (debugConfig?.pg) {
        return debugConfig.pg(sql, params) as T
      }
      return null
    },
    exec: async (sql: string, params?: any[]): Promise<number> => {
      // Mock exec - return 1 row affected
      return 1
    }
  },
  ch: {
    query: async <T = any>(sql: string): Promise<T[]> => {
      if (debugConfig?.ch) {
        return debugConfig.ch(sql) as T[]
      }
      return []
    },
    insert: async (table: string, data: any[]): Promise<void> => {
      // Mock insert
    }
  }
})

/**
 * Fuzz a single handler with multiple iterations
 */
async function fuzzHandler(
  handlerName: string,
  handler: EventHandler,
  iterations: number = 10
): Promise<{ outputs: MetricOutput[], capabilities: { tables: string[], operations: Operation[] } }> {
  const results: MetricOutput[] = []

  // Get capabilities from handler directly
  const capabilities = {
    tables: handler.tables || [],
    operations: handler.operations || []
  }

  // Skip if no debug configuration
  if (!handler.debug) {
    console.log(`    ⚠️  No debug configuration for ${handlerName}`)
    return { outputs: results, capabilities }
  }

  // Generate debug config by passing faker
  const debugConfig = handler.debug(faker)

  for (let i = 0; i < iterations; i++) {
    for (const operation of capabilities.operations) {
      const sampleRecord = debugConfig.sample()
      const actions = new DebugActions(handlerName, operation)
      const databases = createMockDatabases(debugConfig)

      try {
        await handler.process({
          old: operation === 'delete' ? sampleRecord : (operation === 'update' ? sampleRecord : null),
          current: operation === 'delete' ? null : sampleRecord,
          record: sampleRecord,
          operation,
          actions,
          ...databases
        })

        results.push(...actions.getResults())
      } catch (error) {
        // Silently continue - some handlers might fail with mock data
      }
    }
  }

  return { outputs: results, capabilities }
}

/**
 * Generate report of all handler metric outputs
 */
async function generateHandlerReport(): Promise<Map<string, HandlerReport>> {
  const reports = new Map<string, HandlerReport>()

  console.log('🔍 Fuzzing all handlers to discover metric outputs...\n')

  // Import manual handlers
  const { updateCompensation } = await import('../src/handlers/manual/update-compensation')
  const manualHandlers = {
    updateCompensation
  }

  // Combine all handlers
  const allHandlers = {
    ...eventHandlers,
    ...manualHandlers
  }

  for (const [handlerName, handler] of Object.entries(allHandlers)) {
    process.stdout.write(`  Processing ${handlerName}...`)

    const { outputs, capabilities } = await fuzzHandler(handlerName, handler, 20)

    // Collect unique metric combinations
    const uniqueMetrics = new Set<string>()
    const operationCounts: Record<Operation, number> = {
      create: 0,
      update: 0,
      delete: 0
    }

    for (const output of outputs) {
      uniqueMetrics.add(`${output.entityType}.${output.metricType}`)
      operationCounts[output.operation]++
    }

    // Also collect metrics from handler.metrics property if present
    if (handler.metrics) {
      for (const [entityType, metricTypes] of Object.entries(handler.metrics)) {
        for (const metricType of metricTypes) {
          uniqueMetrics.add(`${entityType}.${metricType}`)
        }
      }
    }

    reports.set(handlerName, {
      handler: handlerName,
      tables: capabilities.tables,
      operations: capabilities.operations,
      metrics: uniqueMetrics,
      errors: [],
      coverage: {
        iterations: 20,
        operations: operationCounts
      }
    })

    if (handler.debug || handler.metrics) {
      process.stdout.write(` ✓ (found ${uniqueMetrics.size} metric combinations)\n`)
    } else {
      process.stdout.write(` ⚠️ (no debug config or metrics)\n`)
    }
  }

  return reports
}

/**
 * Generate structured JSON report
 */
function generateStructuredReport(reports: Map<string, HandlerReport>): StructuredReport {
  const structured: StructuredReport = {
    metrics: {
      handlers: reports.size,
      handlersWithDebug: 0,
      metrics: 0
    },
    entityTypes: {},
    tables: {}
  }

  // Count totals and build entity/table mappings
  for (const [handlerName, report] of reports) {
    if (report.metrics.size > 0) {
      structured.metrics.handlersWithDebug++
    }

    // Process each metric
    for (const metric of report.metrics) {
      structured.metrics.metrics++
      const [entityType, metricType] = metric.split('.')

      // Build entityTypes mapping
      if (!structured.entityTypes[entityType]) {
        structured.entityTypes[entityType] = {}
      }
      structured.entityTypes[entityType][metricType] = handlerName

      // Build tables mapping
      for (const table of report.tables) {
        if (!structured.tables[table]) {
          structured.tables[table] = []
        }
        if (!structured.tables[table].includes(metric)) {
          structured.tables[table].push(metric)
        }
      }
    }
  }

  // Sort entityTypes keys to ensure consistent ordering
  const sortedEntityTypes: Record<string, Record<string, string>> = {}
  const entityNames = Object.keys(structured.entityTypes).sort()

  for (const entityName of entityNames) {
    const metrics = structured.entityTypes[entityName]
    const sortedMetrics: Record<string, string> = {}
    const metricNames = Object.keys(metrics).sort()

    for (const metricName of metricNames) {
      sortedMetrics[metricName] = metrics[metricName]
    }

    sortedEntityTypes[entityName] = sortedMetrics
  }

  structured.entityTypes = sortedEntityTypes

  // Sort table metrics
  for (const table in structured.tables) {
    structured.tables[table].sort()
  }

  return structured
}

/**
 * Generate TypeScript types file
 */
function generateTypeScriptTypes(structured: StructuredReport): string {
  let typescript = `/* GENERATED FILE
 * This file is automatically generated by the generate-types script.
 * Do not edit it manually.
 * Generated: ${new Date().toISOString()}
 *
 * Run 'npm run generate-types' to update this file.
 */

`

  // Generate a type for each entity
  const entityNames = Object.keys(structured.entityTypes).sort()

  for (const entityName of entityNames) {
    const metrics = structured.entityTypes[entityName]
    const metricNames = Object.keys(metrics).sort()

    typescript += `export type ${entityName}Metrics = {\n`

    for (const metricName of metricNames) {
      typescript += `  ${metricName}: number\n`
    }

    typescript += `}\n\n`
  }

  // Generate a union type of all entity types
  typescript += `export type EntityMetrics = \n`
  for (let i = 0; i < entityNames.length; i++) {
    const prefix = i === 0 ? '  ' : '  | '
    typescript += `${prefix}{ type: '${entityNames[i]}', metrics: ${entityNames[i]}Metrics }\n`
  }
  typescript += '\n'

  // Generate a mapping of entity types to their metrics
  typescript += `export const ENTITY_METRIC_TYPES = {\n`
  for (const entityName of entityNames) {
    const metrics = structured.entityTypes[entityName]
    const metricNames = Object.keys(metrics).sort()
    typescript += `  ${entityName}: [${metricNames.map(m => `'${m}'`).join(', ')}],\n`
  }
  typescript += `} as const\n\n`

  // Derive EntityType from the const
  typescript += `export type EntityType = keyof typeof ENTITY_METRIC_TYPES\n\n`

  // Generate entity to metrics type mapping
  typescript += `// Type mapping from entity type to metric type\n`
  typescript += `export type EntityMetricMap = {\n`
  for (const entityName of entityNames) {
    typescript += `  ${entityName}: ${entityName}Metrics\n`
  }
  typescript += `}\n\n`

  // Generate EntityMetricTypes from ENTITY_METRIC_TYPES
  typescript += `export type EntityMetricTypes = typeof ENTITY_METRIC_TYPES\n\n`

  // Generate EntityMetricEvent type
  typescript += `export type EntityMetricEvent = {\n`
  typescript += `  [K in keyof EntityMetricTypes]: {\n`
  typescript += `    entityType: K;\n`
  typescript += `    entityId: number;\n`
  typescript += `    userId: number;\n`
  typescript += `    metricType: EntityMetricTypes[K][number];\n`
  typescript += `    metricValue: number;\n`
  typescript += `    createdAt: Date;\n`
  typescript += `  }\n`
  typescript += `}[keyof EntityMetricTypes];\n`

  return typescript
}

/**
 * Format report as markdown
 */
function formatReportAsMarkdown(reports: Map<string, HandlerReport>): string {
  let markdown = '# Handler Metric Output Report\n\n'
  markdown += `Generated: ${new Date().toISOString()}\n\n`
  markdown += '## Summary\n\n'

  const totalHandlers = reports.size
  const handlersWithDebug = Array.from(reports.values()).filter(r => r.metrics.size > 0).length
  const totalMetrics = Array.from(reports.values())
    .reduce((sum, r) => sum + r.metrics.size, 0)

  markdown += `- **Total Handlers**: ${totalHandlers}\n`
  markdown += `- **Handlers with Debug Config**: ${handlersWithDebug}\n`
  markdown += `- **Total Unique Metric Combinations**: ${totalMetrics}\n\n`

  markdown += '## Handler Details\n\n'

  for (const [handlerName, report] of reports) {
    markdown += `### ${handlerName}\n\n`
    markdown += `**Tables**: ${report.tables.join(', ') || 'Unknown'}\n`
    markdown += `**Operations**: ${report.operations.join(', ') || 'Unknown'}\n\n`

    if (report.metrics.size > 0) {
      markdown += '**Metric Outputs**:\n'
      const sortedMetrics = Array.from(report.metrics).sort()
      for (const metric of sortedMetrics) {
        markdown += `- \`${metric}\`\n`
      }
    } else {
      markdown += '*No debug configuration or no metrics detected*\n'
    }

    markdown += '\n'
  }

  markdown += '## All Unique Metrics\n\n'
  const allMetrics = new Set<string>()
  for (const report of reports.values()) {
    for (const metric of report.metrics) {
      allMetrics.add(metric)
    }
  }

  const sortedAllMetrics = Array.from(allMetrics).sort()
  for (const metric of sortedAllMetrics) {
    markdown += `- \`${metric}\`\n`
  }

  return markdown
}

/**
 * Main execution
 */
async function main() {
  console.log('='.repeat(60))
  console.log('  Metric Types Generation Tool')
  console.log('='.repeat(60))
  console.log()

  const reports = await generateHandlerReport()

  console.log('\n📊 Generating report...\n')

  // Display summary
  console.log('Summary:')
  console.log('--------')
  for (const [handlerName, report] of reports) {
    const status = report.metrics.size > 0 ? `${report.metrics.size} metric combinations` : 'no debug config'
    console.log(`  ${handlerName}: ${status}`)
  }

  // Generate markdown report
  const markdown = formatReportAsMarkdown(reports)

  // Generate structured JSON report
  const structured = generateStructuredReport(reports)

  // Generate TypeScript types
  const typescript = generateTypeScriptTypes(structured)

  // Save files
  const fs = await import('fs/promises')
  const path = await import('path')

  const markdownPath = './docs/generated-metrics.md'
  const jsonPath = './docs/generated-metrics.json'
  const typesPath = './src/common/types/metric-types.ts'

  // Ensure directories exist
  await fs.mkdir(path.dirname(typesPath), { recursive: true })

  await fs.writeFile(markdownPath, markdown)
  await fs.writeFile(jsonPath, JSON.stringify(structured, null, 2))
  await fs.writeFile(typesPath, typescript)

  console.log(`\n✅ Markdown report saved to ${markdownPath}`)
  console.log(`✅ JSON report saved to ${jsonPath}`)
  console.log(`✅ TypeScript types saved to ${typesPath}`)

  // Display summary of structured data
  console.log('\nStructured Summary:')
  console.log(`  Entity Types: ${Object.keys(structured.entityTypes).length}`)
  console.log(`  Tables Tracked: ${Object.keys(structured.tables).length}`)
  console.log(`  Total Metrics: ${structured.metrics.metrics}`)

  // Display all unique entity.metric combinations
  console.log('\nAll Unique Metric Combinations:')
  console.log('-------------------------------')
  const allMetrics = new Set<string>()
  for (const report of reports.values()) {
    for (const metric of report.metrics) {
      allMetrics.add(metric)
    }
  }

  const sortedMetrics = Array.from(allMetrics).sort()
  for (const metric of sortedMetrics) {
    console.log(`  ${metric}`)
  }

  console.log(`\nTotal: ${sortedMetrics.length} unique metric combinations`)
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error)
}

export { fuzzHandler, generateHandlerReport, DebugActions }