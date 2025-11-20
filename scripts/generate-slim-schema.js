/**
 * Generate slim Prisma schema by stripping @no-type models/enums and their relations
 *
 * This script reads schema.full.prisma and generates schema.prisma
 * by removing all models and enums marked with // @no-type,
 * as well as removing relation fields that reference @no-type models
 *
 * Usage: node scripts/generate-slim-schema.js
 */

const fs = require('fs');
const path = require('path');

const FULL_SCHEMA_PATH = path.join(__dirname, '../prisma/schema.full.prisma');
const SLIM_SCHEMA_PATH = path.join(__dirname, '../prisma/schema.prisma');

function generateSlimSchema() {
  console.log('📋 Reading full schema from:', FULL_SCHEMA_PATH);

  if (!fs.existsSync(FULL_SCHEMA_PATH)) {
    console.error('❌ Error: schema.full.prisma not found!');
    console.error('   Expected at:', FULL_SCHEMA_PATH);
    process.exit(1);
  }

  const fullSchema = fs.readFileSync(FULL_SCHEMA_PATH, 'utf8');
  const lines = fullSchema.split('\n');

  // First pass: collect all @no-type model and enum names
  const noTypeModels = new Set();
  const noTypeEnums = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (i > 0 && lines[i - 1].trim().includes('@no-type')) {
      if (trimmed.startsWith('model ')) {
        const match = trimmed.match(/^model\s+(\w+)/);
        if (match) noTypeModels.add(match[1]);
      } else if (trimmed.startsWith('enum ')) {
        const match = trimmed.match(/^enum\s+(\w+)/);
        if (match) noTypeEnums.add(match[1]);
      }
    }
  }

  console.log(`\n🔍 Found ${noTypeModels.size} @no-type models and ${noTypeEnums.size} @no-type enums`);

  // Second pass: build output, skipping @no-type blocks and relation fields
  const outputLines = [];
  let inNoTypeBlock = false;
  let noTypeBraceCount = 0;
  let inModelBlock = false;
  let modelBraceCount = 0;
  let skippedRelationFields = 0;
  let skipNextField = false;
  let skippedFieldLevelAnnotations = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check if previous line had @no-type comment
    if (i > 0 && lines[i - 1].trim().includes('@no-type')) {
      if (trimmed.startsWith('model ') || trimmed.startsWith('enum ')) {
        inNoTypeBlock = true;
        noTypeBraceCount = (line.match(/{/g) || []).length;

        // Don't output the @no-type comment
        if (outputLines.length > 0 && outputLines[outputLines.length - 1].trim().includes('@no-type')) {
          outputLines.pop();
        }
        continue;
      }
    }

    // If we're in a @no-type block, skip until it ends
    if (inNoTypeBlock) {
      if (line.includes('{')) noTypeBraceCount++;
      if (line.includes('}')) noTypeBraceCount--;

      if (noTypeBraceCount === 0 && line.includes('}')) {
        inNoTypeBlock = false;
        continue;
      }
      continue;
    }

    // Track if we're entering a regular model block
    if (trimmed.startsWith('model ') && line.includes('{')) {
      inModelBlock = true;
      modelBraceCount = 1;
      outputLines.push(line);
      continue;
    }

    // Track if we're inside a model block
    if (inModelBlock) {
      // Check for field-level @no-type annotation (line before)
      if (trimmed.startsWith('// @no-type')) {
        skipNextField = true;
        continue; // Don't output the @no-type comment
      }

      // Count braces
      if (line.includes('{')) modelBraceCount++;
      if (line.includes('}')) {
        modelBraceCount--;
        if (modelBraceCount === 0) {
          inModelBlock = false;
          outputLines.push(line); // Output the closing brace
          continue;
        }
      }

      // Check for inline @no-type annotation
      if (trimmed.includes('// @no-type')) {
        skippedFieldLevelAnnotations++;
        continue; // Skip this field entirely
      }

      // Skip field if flagged by @no-type
      if (skipNextField) {
        // Only skip if this is a field definition (not empty line or comment)
        if (trimmed && !trimmed.startsWith('//')) {
          skipNextField = false;
          skippedFieldLevelAnnotations++;
          continue;
        }
      }

      // Check if this line is a field definition referencing a @no-type model
      const fieldMatch = trimmed.match(/^(\w+)\s+(\w+)(\[\]|\?)?/);
      if (fieldMatch) {
        const fieldType = fieldMatch[2];
        // Check if the field type is a @no-type model
        if (noTypeModels.has(fieldType)) {
          skippedRelationFields++;
          continue; // Skip this relation field
        }
      }
    }

    // Output line if not skipped
    outputLines.push(line);
  }

  const slimSchema = outputLines.join('\n');

  // Add header comment
  const header = `// ⚠️  AUTO-GENERATED FILE - DO NOT EDIT DIRECTLY
// This file is generated from schema.full.prisma by scripts/generate-slim-schema.js
// Edit schema.full.prisma instead, then run: npm run db:generate
// Models/enums marked with // @no-type in schema.full.prisma are excluded
// Generated on: ${new Date().toISOString()}

`;

  console.log(`\n✂️  Stripped ${noTypeModels.size} models:`);
  if (noTypeModels.size > 0) {
    [...noTypeModels].forEach(name => console.log(`   - ${name}`));
  }

  console.log(`\n✂️  Stripped ${noTypeEnums.size} enums:`);
  if (noTypeEnums.size > 0) {
    [...noTypeEnums].forEach(name => console.log(`   - ${name}`));
  }

  console.log(`\n✂️  Removed ${skippedRelationFields} relation fields referencing @no-type models`);
  console.log(`\n✂️  Removed ${skippedFieldLevelAnnotations} fields marked with field-level @no-type`);

  console.log('\n💾 Writing slim schema to:', SLIM_SCHEMA_PATH);
  fs.writeFileSync(SLIM_SCHEMA_PATH, header + slimSchema);

  console.log('\n✅ Slim schema generated successfully!');
  console.log('\n📊 Summary:');
  console.log(`   Models removed: ${noTypeModels.size}`);
  console.log(`   Enums removed: ${noTypeEnums.size}`);
  console.log(`   Relation fields removed (references @no-type models): ${skippedRelationFields}`);
  console.log(`   Fields removed (marked with @no-type): ${skippedFieldLevelAnnotations}`);
  console.log(`   Total fields removed: ${skippedRelationFields + skippedFieldLevelAnnotations}`);
  console.log('\n🎯 Next: Prisma will generate types only for models in slim schema');
}

// Run the script
try {
  generateSlimSchema();
} catch (error) {
  console.error('\n❌ Error generating slim schema:', error.message);
  console.error(error.stack);
  process.exit(1);
}
