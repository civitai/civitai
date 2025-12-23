# Generation Support Schema Redesign

## Overview

This document outlines a redesigned schema for managing base model ecosystems, their capabilities, and configuration. The goal is to replace the current verbose `baseModelGenerationConfig` (~350 lines) with a normalized, inheritance-based system.

---

## Current Problems

1. **Massive duplication** - Same patterns repeated for every model in an ecosystem
2. **Hard to maintain** - Adding a new base model requires many explicit entries
3. **Mixed concerns** - Identity, support, and configuration are conflated
4. **No inheritance** - Child ecosystems (Pony, Illustrious) repeat parent (SDXL) definitions

---

## Proposed Schema

### 1. Ecosystem Identity & Hierarchy

Ecosystems define the family tree of base models. Child ecosystems inherit from parents.

```typescript
type EcosystemRecord = {
  id: number;
  name: string;
  parentEcosystemId?: number;
};
```

**Example:**
```typescript
const ecosystems: EcosystemRecord[] = [
  // Root ecosystems
  { id: 1, name: 'SD1' },
  { id: 2, name: 'SD2' },
  { id: 3, name: 'SDXL' },
  { id: 4, name: 'Flux' },
  { id: 5, name: 'Qwen' },
  { id: 6, name: 'NanoBanana' },
  { id: 7, name: 'HunyuanVideo' },
  { id: 8, name: 'WanVideo' },

  // Child ecosystems of SDXL
  { id: 10, name: 'Pony', parentEcosystemId: 3 },
  { id: 11, name: 'Illustrious', parentEcosystemId: 3 },
  { id: 12, name: 'NoobAI', parentEcosystemId: 3 },

  // Child ecosystem of Flux
  { id: 20, name: 'FluxKrea', parentEcosystemId: 4 },
];
```

**Hierarchy visualization:**
```
SD1
SD2
SDXL
  ├── Pony
  ├── Illustrious
  └── NoobAI
Flux
  └── FluxKrea
Qwen
NanoBanana
HunyuanVideo
WanVideo
```

---

### 2. Ecosystem Support (Capabilities)

Defines what each ecosystem supports for different support types. Inherits from parent if not explicitly defined.

```typescript
type SupportType = 'generation' | 'training' | 'auction';

type EcosystemSupport = {
  ecosystemId: number;
  supportType: SupportType;
  modelTypes: ModelType[];
  enabled: boolean;
};
```

**Example:**
```typescript
const ecosystemSupport: EcosystemSupport[] = [
  // SD1 - full addon support
  { ecosystemId: 1, supportType: 'generation', modelTypes: ['Checkpoint', 'LORA', 'DoRA', 'LoCon', 'VAE', 'TextualInversion'], enabled: true },
  { ecosystemId: 1, supportType: 'training', modelTypes: ['LORA'], enabled: true },

  // SDXL - full addon support (Pony, Illustrious, NoobAI inherit this)
  { ecosystemId: 3, supportType: 'generation', modelTypes: ['Checkpoint', 'LORA', 'DoRA', 'LoCon', 'VAE', 'TextualInversion'], enabled: true },
  { ecosystemId: 3, supportType: 'training', modelTypes: ['LORA'], enabled: true },
  { ecosystemId: 3, supportType: 'auction', modelTypes: ['Checkpoint', 'LORA'], enabled: true },

  // Flux - limited support
  { ecosystemId: 4, supportType: 'generation', modelTypes: ['Checkpoint', 'LORA'], enabled: true },
  { ecosystemId: 4, supportType: 'training', modelTypes: ['LORA'], enabled: true },

  // NanoBanana - checkpoint only
  { ecosystemId: 6, supportType: 'generation', modelTypes: ['Checkpoint'], enabled: true },
  { ecosystemId: 6, supportType: 'training', modelTypes: [], enabled: false },
  { ecosystemId: 6, supportType: 'auction', modelTypes: [], enabled: false },

  // HunyuanVideo - LORA only for generation
  { ecosystemId: 7, supportType: 'generation', modelTypes: ['LORA'], enabled: true },
];
```

---

### 3. Ecosystem Settings (Configuration)

Configuration values like default resources and generation parameters. Inherits from parent if not explicitly defined.

```typescript
type EcosystemSettings = {
  ecosystemId: number;
  defaults?: {
    checkpointVersionId?: number;
    vaeVersionId?: number;
    sampler?: string;
    steps?: number;
    cfg?: number;
    width?: number;
    height?: number;
  };
  // TODO: Input constraints - needs more iteration
  // Complexity: constraints may depend on external context (e.g., membership tier)
  // Example: free tier allows 9 additional resources, paid tiers allow 12
  // This may need to be a separate system that combines:
  //   - Ecosystem base constraints
  //   - Tier-based modifiers
  //   - Possibly other contextual factors
};
```

**Example:**
```typescript
const ecosystemSettings: EcosystemSettings[] = [
  {
    ecosystemId: 3, // SDXL
    defaults: {
      checkpointVersionId: 128713,
      width: 1024,
      height: 1024,
      cfg: 7,
      steps: 25,
      sampler: 'euler_a',
    },
  },
  {
    ecosystemId: 10, // Pony - inherits SDXL, overrides checkpoint
    defaults: {
      checkpointVersionId: 290640,
    },
  },
  {
    ecosystemId: 11, // Illustrious - inherits SDXL, overrides checkpoint
    defaults: {
      checkpointVersionId: 456123,
    },
  },
  {
    ecosystemId: 4, // Flux - different defaults
    defaults: {
      checkpointVersionId: 789012,
      steps: 4,
      cfg: 1,
      width: 1024,
      height: 1024,
    },
  },
];
```

---

### 4. Cross-Ecosystem Rules

Explicit rules for compatibility between unrelated ecosystems.

```typescript
type CrossEcosystemRule = {
  sourceEcosystemId: number;
  targetEcosystemId: number;
  supportType: SupportType;
  modelTypes?: ModelType[];  // If omitted, all supported types
  support: 'Partial';
};
```

**Example:**
```typescript
const crossEcosystemRules: CrossEcosystemRule[] = [
  // SD1 TextualInversion works in SDXL family
  { sourceEcosystemId: 1, targetEcosystemId: 3, supportType: 'generation', modelTypes: ['TextualInversion'], support: 'Partial' },
];
```

---

### 5. Support Overrides

Granular overrides at ecosystem, group, or model level.

```typescript
type SupportOverride = {
  ecosystemId?: number;
  groupId?: number;
  baseModelId?: number;
  supportType: SupportType;
  modelTypes?: ModelType[];
  enabled: boolean;
};
```

**Example:**
```typescript
const supportOverrides: SupportOverride[] = [
  // Disable auction for a deprecated model
  { baseModelId: BM.SDXLTurbo, supportType: 'auction', enabled: false },

  // Illustrious v1.5 - new model, not ready for training yet
  { baseModelId: BM.IllustriousV1_5, supportType: 'training', enabled: false },

  // Disable training for an entire group
  { groupId: GRP.SD3, supportType: 'training', enabled: false },
];
```

---

### 6. Groups & Base Models

Groups and base models remain largely the same, but ecosystemId moves to Group.

```typescript
type BaseModelGroupRecord = {
  id: number;
  name: string;
  ecosystemId: number;
  family?: string;
};

type BaseModelRecord = {
  id: number;
  name: string;
  type: MediaType;
  groupId: number;
  hidden?: boolean;
  deprecated?: boolean;
  canGenerate?: boolean;
  engine?: string;
  // NO ecosystemId - inherited from group
};
```

---

## Resolution Order

All lookups follow the same precedence (most specific wins):

```
1. BaseModel Override     →  Check if specific model has override
2. Group Override         →  Check if model's group has override
3. Ecosystem Override     →  Check if ecosystem has override
4. Ecosystem Definition   →  Check ecosystem's defined support/settings
5. Parent Ecosystem       →  Inherit from parent (recursive)
6. Default                →  No support / undefined
```

---

## Generation Support Derivation

```typescript
function getGenerationSupport(
  checkpointGroupId: number,
  addonGroupId: number,
  addonModelType: ModelType
): 'Full' | 'Partial' | 'None' {
  const checkpointEco = getEcosystemForGroup(checkpointGroupId);
  const addonEco = getEcosystemForGroup(addonGroupId);

  // Check if model type is supported for generation
  const support = getEcosystemSupport(checkpointEco.id, 'generation');
  if (!support.enabled || !support.modelTypes.includes(addonModelType)) {
    return 'None';
  }

  // Same group = Full
  if (checkpointGroupId === addonGroupId) return 'Full';

  // Same ecosystem = Full
  if (checkpointEco.id === addonEco.id) return 'Full';

  // Check if related (parent/child/sibling in same family tree)
  const checkpointRoot = getRootEcosystem(checkpointEco);
  const addonRoot = getRootEcosystem(addonEco);

  if (checkpointRoot.id === addonRoot.id) {
    // Same family tree = Partial
    return 'Partial';
  }

  // Cross-ecosystem = Check explicit rules
  const crossRule = findCrossEcosystemRule(addonEco.id, checkpointEco.id, 'generation', addonModelType);
  if (crossRule) return crossRule.support;

  // No relationship = None
  return 'None';
}
```

---

## Settings Lookup with Inheritance

```typescript
function getEcosystemSetting<K extends keyof EcosystemSettings['defaults']>(
  ecosystemId: number,
  key: K
): EcosystemSettings['defaults'][K] | undefined {
  const settings = ecosystemSettings.find(s => s.ecosystemId === ecosystemId);

  // Check if this ecosystem has the setting
  if (settings?.defaults?.[key] !== undefined) {
    return settings.defaults[key];
  }

  // Inherit from parent
  const ecosystem = getEcosystem(ecosystemId);
  if (ecosystem.parentEcosystemId) {
    return getEcosystemSetting(ecosystem.parentEcosystemId, key);
  }

  return undefined;
}

// Examples
getEcosystemSetting(ECO.Pony, 'checkpointVersionId');  // → 290640 (Pony's own)
getEcosystemSetting(ECO.Pony, 'width');                // → 1024 (inherited from SDXL)
getEcosystemSetting(ECO.Pony, 'cfg');                  // → 7 (inherited from SDXL)
```

---

## Example: Resolution Walkthrough

**"Is Illustrious v1.5 supported for training?"**

```
1. BaseModel Override: { baseModelId: IllustriousV1_5, supportType: 'training', enabled: false }
   → FOUND: enabled = false
   → Result: NOT SUPPORTED
```

**"Is Illustrious v1.0 supported for training?"**

```
1. BaseModel Override: None
2. Group Override: None
3. Ecosystem Override: None
4. Ecosystem Support (Illustrious): Not defined
5. Parent Ecosystem (SDXL): { supportType: 'training', modelTypes: ['LORA'], enabled: true }
   → FOUND: enabled = true
   → Result: SUPPORTED for LORA training
```

**"Can I use a Pony LORA with an Illustrious checkpoint?"**

```
1. Check Illustrious supports LORA for generation → Yes (inherited from SDXL)
2. Same group? No (Pony group ≠ Illustrious group)
3. Same ecosystem? No (Pony ecosystem ≠ Illustrious ecosystem)
4. Same family tree? Yes (both have SDXL as root)
   → Result: PARTIAL support
```

**"Can I use an SD1 TextualInversion with an SDXL checkpoint?"**

```
1. Check SDXL supports TextualInversion for generation → Yes
2. Same group? No
3. Same ecosystem? No
4. Same family tree? No (SD1 root ≠ SDXL root)
5. Cross-ecosystem rule? Yes: { source: SD1, target: SDXL, modelTypes: ['TextualInversion'], support: 'Partial' }
   → Result: PARTIAL support
```

---

## Migration Plan

1. Create `EcosystemRecord` entries with parent/child relationships
2. Create `EcosystemSupport` entries for each support type
3. Create `EcosystemSettings` entries for defaults and limits
4. Move `ecosystemId` from BaseModel to Group
5. Create `CrossEcosystemRule` entries (just SD1 TI → SDXL)
6. Create `SupportOverride` entries for exceptions
7. Replace `baseModelGenerationConfig` with derivation functions
8. Update consumers to use new APIs

---

## Result

**Before:** ~350 lines of explicit generation config with massive duplication

**After:**
- ~15 ecosystem records
- ~20 ecosystem support entries
- ~10 ecosystem settings entries
- ~1 cross-ecosystem rule
- ~5 support overrides
- Derivation functions that handle inheritance automatically

Total: ~50 data entries + reusable derivation logic

---

## Schema Summary

```typescript
// Identity + Hierarchy
type EcosystemRecord = {
  id: number;
  name: string;
  parentEcosystemId?: number;
};

// Capabilities (generation, training, auction)
type EcosystemSupport = {
  ecosystemId: number;
  supportType: SupportType;
  modelTypes: ModelType[];
  enabled: boolean;
};

// Configuration (defaults + TODO: input constraints)
type EcosystemSettings = {
  ecosystemId: number;
  defaults?: {
    checkpointVersionId?: number;
    vaeVersionId?: number;
    sampler?: string;
    steps?: number;
    cfg?: number;
    width?: number;
    height?: number;
  };
};

// Cross-ecosystem compatibility
type CrossEcosystemRule = {
  sourceEcosystemId: number;
  targetEcosystemId: number;
  supportType: SupportType;
  modelTypes?: ModelType[];
  support: 'Partial';
};

// Granular overrides
type SupportOverride = {
  ecosystemId?: number;
  groupId?: number;
  baseModelId?: number;
  supportType: SupportType;
  modelTypes?: ModelType[];
  enabled: boolean;
};

// Group (ecosystemId moved here)
type BaseModelGroupRecord = {
  id: number;
  name: string;
  ecosystemId: number;
  family?: string;
};

// BaseModel (no ecosystemId - inherited from group)
type BaseModelRecord = {
  id: number;
  name: string;
  type: MediaType;
  groupId: number;
  hidden?: boolean;
  deprecated?: boolean;
  canGenerate?: boolean;
  engine?: string;
};
```
