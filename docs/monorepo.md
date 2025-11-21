# Monorepo Migration Analysis

## Executive Summary

Converting this project to a monorepo and extracting the orchestrator into a separate package is **moderately complex** but **definitely achievable**. The main challenges stem from deep integration with the main application's infrastructure (database, auth, payments) rather than technical monorepo setup.

**Estimated Effort**: 2-3 weeks for initial setup, 1-2 weeks for refinement
**Complexity Rating**: 6/10

---

## Current Orchestrator Structure

The orchestrator code is spread across multiple directories:

```
src/
├── server/
│   ├── orchestrator/              # Core orchestrator logic (schemas, providers)
│   │   ├── generation/
│   │   ├── haiper/
│   │   ├── hunyuan/
│   │   ├── image-upscaler/
│   │   ├── infrastructure/
│   │   ├── kling/
│   │   ├── lightricks/
│   │   ├── minimax/
│   │   ├── mochi/
│   │   ├── sora/
│   │   ├── veo3/
│   │   ├── video-enhancement/
│   │   ├── video-upscaler/
│   │   ├── vidu/
│   │   └── wan/
│   ├── services/orchestrator/     # Orchestrator services
│   ├── schema/orchestrator/       # tRPC schemas
│   └── http/orchestrator/         # HTTP handlers
├── components/Orchestrator/       # UI components
├── shared/orchestrator/           # Shared configs
└── pages/
    ├── api/orchestrator/          # API routes
    └── moderator/orchestrator/    # Moderator pages
```

**Total Files**: ~65+ files directly related to orchestrator functionality

---

## Key Dependencies from Orchestrator → Main App

The orchestrator currently depends heavily on the main application:

### Critical Dependencies
1. **Database (Prisma)**
   - Direct database access for workflows, jobs, user data
   - Shared models and schema

2. **Authentication**
   - `useCurrentUser` hook
   - Session management
   - User permissions

3. **Business Logic**
   - Buzz/payment system (transactions)
   - Resource management
   - User quotas and limits

4. **File/Media Management**
   - S3 upload utilities
   - Image processing (Sharp)
   - CDN/EdgeImage utilities

5. **UI Framework**
   - Mantine components
   - Shared hooks and utilities
   - Tailwind classes

6. **Infrastructure**
   - tRPC client/server
   - Logging (Axiom)
   - Redis caching
   - Environment configuration

---

## Recommended Monorepo Structure

```
civitai-monorepo/
├── package.json                   # Root package.json with workspaces
├── turbo.json                     # Turborepo configuration (recommended)
├── tsconfig.base.json             # Shared TypeScript config
├── .npmrc                         # Workspace configuration
│
├── apps/
│   └── web/                       # Current main application
│       ├── package.json
│       ├── next.config.mjs
│       ├── tsconfig.json
│       └── src/
│
├── packages/
│   ├── orchestrator/              # Orchestrator package
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── server/            # Server-side orchestrator code
│   │   │   ├── client/            # Client components & hooks
│   │   │   ├── shared/            # Shared schemas & configs
│   │   │   └── index.ts           # Main exports
│   │   └── README.md
│   │
│   ├── shared-utils/              # Shared utilities (optional)
│   │   ├── package.json
│   │   └── src/
│   │
│   └── ui/                        # Shared UI components (optional)
│       ├── package.json
│       └── src/
│
└── .github/
    └── workflows/                 # CI/CD workflows
```

---

## Migration Strategy

### Phase 1: Setup Monorepo Infrastructure (Week 1)

**Tasks:**
1. Convert root to use npm/pnpm workspaces
2. Install and configure Turborepo (recommended for Next.js monorepos)
3. Create base TypeScript configuration
4. Move existing app to `apps/web/`
5. Update import paths in main app
6. Ensure build still works

**Key Files to Create/Modify:**
```json
// Root package.json
{
  "name": "civitai-monorepo",
  "private": true,
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "typecheck": "turbo run typecheck",
    "lint": "turbo run lint"
  },
  "devDependencies": {
    "turbo": "^2.x.x"
  }
}
```

```json
// turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".next/**", "dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "lint": {},
    "typecheck": {
      "dependsOn": ["^build"]
    }
  }
}
```

### Phase 2: Extract Orchestrator Core (Week 2)

**Tasks:**
1. Create `packages/orchestrator/` package structure
2. Move orchestrator schemas and configs (least dependent code first)
3. Move server-side orchestrator services
4. Move client components
5. Create proper package exports
6. Update imports in main app to use the package

**Migration Order (Least → Most Dependent):**
1. Schemas (`src/server/orchestrator/*/**.schema.ts`)
2. Infrastructure (`src/server/orchestrator/infrastructure/`)
3. Provider-specific code (`src/server/orchestrator/haiper/`, etc.)
4. Services (`src/server/services/orchestrator/`)
5. UI Components (`src/components/Orchestrator/`)
6. API routes (`src/pages/api/orchestrator/`)

### Phase 3: Handle Shared Dependencies (Week 3)

**Two Approaches:**

#### Option A: Dependency Injection (Recommended)
Keep orchestrator package independent by injecting dependencies:

```typescript
// packages/orchestrator/src/server/index.ts
export interface OrchestratorDependencies {
  database: PrismaClient;
  auth: {
    getCurrentUser: () => Promise<User | null>;
    requireAuth: () => Promise<User>;
  };
  storage: {
    uploadToS3: (file: File) => Promise<string>;
    getImageUrl: (key: string) => string;
  };
  payments: {
    chargeBuzz: (userId: number, amount: number) => Promise<void>;
    getUserBuzz: (userId: number) => Promise<number>;
  };
  logger: {
    log: (data: any) => void;
    error: (error: Error) => void;
  };
}

export function createOrchestratorService(deps: OrchestratorDependencies) {
  // Return orchestrator functions with injected deps
  return {
    createWorkflow: (args) => createWorkflowImpl(args, deps),
    processJob: (jobId) => processJobImpl(jobId, deps),
    // ... more functions
  };
}
```

```typescript
// apps/web/src/server/orchestrator.ts
import { createOrchestratorService } from '@civitai/orchestrator/server';
import { prisma } from './db';
import { getCurrentUser } from './auth';
import { uploadToS3, getImageUrl } from './s3';
import { chargeBuzz, getUserBuzz } from './buzz';
import { logToAxiom } from './logging';

export const orchestrator = createOrchestratorService({
  database: prisma,
  auth: { getCurrentUser, requireAuth },
  storage: { uploadToS3, getImageUrl },
  payments: { chargeBuzz, getUserBuzz },
  logger: logToAxiom,
});
```

**Pros:**
- Orchestrator package is fully independent
- Can be tested in isolation with mocks
- Can be used in other projects
- Clear separation of concerns

**Cons:**
- More boilerplate
- Requires defining interfaces
- More initial setup work

#### Option B: Shared Packages
Extract common dependencies into shared packages:

```
packages/
├── orchestrator/
├── database/              # Shared Prisma client & models
├── auth/                  # Auth utilities
├── storage/               # S3 utilities
└── payments/              # Buzz/payment logic
```

**Pros:**
- Simpler migration
- Can reuse existing code structure
- Less refactoring needed

**Cons:**
- Packages still tightly coupled
- Harder to test independently
- More packages to manage

### Phase 4: Update Build & Deploy (Week 3-4)

**Tasks:**
1. Update CI/CD pipelines to build monorepo
2. Configure package versioning strategy
3. Update deployment scripts
4. Set up changeset or similar for version management
5. Update documentation

---

## Technical Challenges & Solutions

### Challenge 1: TypeScript Path Aliases
**Problem**: Current code uses `~/*` aliases everywhere

**Solution**:
```json
// tsconfig.base.json
{
  "compilerOptions": {
    "paths": {
      "@civitai/orchestrator": ["./packages/orchestrator/src"],
      "@civitai/orchestrator/*": ["./packages/orchestrator/src/*"]
    }
  }
}
```

Update imports:
```typescript
// Before
import { createWorkflow } from '~/server/orchestrator/...';

// After
import { createWorkflow } from '@civitai/orchestrator/server';
```

### Challenge 2: Prisma Schema Sharing
**Problem**: Orchestrator needs database access but schema is in main app

**Solutions**:
1. Keep Prisma in main app, export client to orchestrator (simplest)
2. Move Prisma to separate package both apps depend on
3. Use Prisma schema extension/splitting (experimental)

**Recommended**: Option 1 initially, migrate to Option 2 later if needed

### Challenge 3: Next.js API Routes
**Problem**: Current orchestrator has Next.js API routes

**Solution**: Keep API routes in main app, have them call orchestrator package functions:
```typescript
// apps/web/src/pages/api/orchestrator/uploadImage.ts
import { handleImageUpload } from '@civitai/orchestrator/server';

export default async function handler(req, res) {
  return handleImageUpload(req, res, {
    database: prisma,
    storage: s3Utils,
    // ... inject dependencies
  });
}
```

### Challenge 4: Environment Variables
**Problem**: Orchestrator needs access to env vars

**Solution**:
- Define interface for required config
- Pass config when initializing orchestrator
- Or use env vars directly in orchestrator (less portable)

### Challenge 5: UI Components Dependencies
**Problem**: Orchestrator components use Mantine, Tailwind, shared hooks

**Options**:
1. Keep components in main app (simplest)
2. Move UI components to separate UI package
3. Have orchestrator package peer-depend on Mantine/React

**Recommended**: Start with Option 1, components are less critical to extract

---

## Testing Strategy

### Independent Testing
With dependency injection, you can test orchestrator independently:

```typescript
// packages/orchestrator/src/server/workflows.test.ts
import { createWorkflow } from './workflows';

const mockDeps = {
  database: createMockPrisma(),
  auth: { getCurrentUser: jest.fn() },
  storage: { uploadToS3: jest.fn() },
  payments: { chargeBuzz: jest.fn() },
  logger: { log: jest.fn(), error: jest.fn() },
};

describe('createWorkflow', () => {
  it('should create workflow with correct parameters', async () => {
    const result = await createWorkflow(args, mockDeps);
    expect(result).toBeDefined();
    expect(mockDeps.payments.chargeBuzz).toHaveBeenCalled();
  });
});
```

### Integration Testing
Test orchestrator integration in main app:

```typescript
// apps/web/tests/orchestrator-integration.test.ts
import { orchestrator } from '~/server/orchestrator';

describe('Orchestrator Integration', () => {
  it('should create workflow end-to-end', async () => {
    const workflow = await orchestrator.createWorkflow({
      // ... test data
    });
    // Verify in database, etc.
  });
});
```

---

## Build Configuration

### Package.json for Orchestrator
```json
{
  "name": "@civitai/orchestrator",
  "version": "1.0.0",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./server": {
      "types": "./dist/server/index.d.ts",
      "default": "./dist/server/index.js"
    },
    "./client": {
      "types": "./dist/client/index.d.ts",
      "default": "./dist/client/index.js"
    },
    "./shared": {
      "types": "./dist/shared/index.d.ts",
      "default": "./dist/shared/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "typecheck": "tsc --noEmit",
    "test": "jest"
  },
  "dependencies": {
    "@civitai/client": "^0.2.0-beta.14",
    "zod": "^4.0.17"
  },
  "peerDependencies": {
    "@prisma/client": "^6.3.0",
    "react": "^18.3.1"
  },
  "devDependencies": {
    "typescript": "^5.9.2",
    "@types/node": "18.11.0"
  }
}
```

### TypeScript Config for Orchestrator
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true,
    "declaration": true,
    "declarationMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

---

## Migration Checklist

### Pre-Migration
- [ ] Audit all orchestrator dependencies
- [ ] Document current orchestrator API surface
- [ ] Set up feature flags for gradual migration
- [ ] Create test suite for orchestrator functionality
- [ ] Backup database and code

### Phase 1: Setup
- [ ] Initialize workspace configuration
- [ ] Install Turborepo
- [ ] Create base TypeScript config
- [ ] Move app to `apps/web/`
- [ ] Verify existing app still works
- [ ] Update CI/CD for monorepo structure

### Phase 2: Extract Orchestrator
- [ ] Create orchestrator package structure
- [ ] Move schemas and types
- [ ] Move core orchestrator logic
- [ ] Move services
- [ ] Update imports in main app
- [ ] Verify orchestrator functions work

### Phase 3: Decouple Dependencies
- [ ] Define dependency interfaces
- [ ] Implement dependency injection
- [ ] Update orchestrator to use injected deps
- [ ] Update main app to provide deps
- [ ] Test with mocked dependencies

### Phase 4: Testing & Documentation
- [ ] Write unit tests for orchestrator
- [ ] Write integration tests
- [ ] Update documentation
- [ ] Create migration guide for team
- [ ] Document new import patterns

### Phase 5: Deploy
- [ ] Test in development environment
- [ ] Test in staging
- [ ] Deploy to production
- [ ] Monitor for issues
- [ ] Clean up old code

---

## Recommended Tools

1. **Turborepo** - Build system optimized for monorepos, caching, parallel execution
2. **pnpm** - Faster, more efficient package manager with great workspace support
3. **Changesets** - Version management and changelog generation for monorepos
4. **tsup** - Fast TypeScript bundler for libraries (alternative to tsc)
5. **Manypkg** - Monorepo linting and validation

---

## Potential Risks

### High Risk
1. **Breaking existing functionality** during migration
   - *Mitigation*: Feature flags, gradual migration, extensive testing

2. **Circular dependencies** between packages
   - *Mitigation*: Clear dependency direction, architectural planning

3. **Build time increases**
   - *Mitigation*: Turborepo caching, incremental builds

### Medium Risk
1. **Developer onboarding complexity**
   - *Mitigation*: Good documentation, clear examples

2. **CI/CD pipeline complexity**
   - *Mitigation*: Use Turborepo's CI helpers, cache build artifacts

3. **Deployment coordination** (if packages need to deploy together)
   - *Mitigation*: Versioning strategy, deployment scripts

### Low Risk
1. **Package versioning confusion**
   - *Mitigation*: Use changesets or similar tool

2. **TypeScript config conflicts**
   - *Mitigation*: Well-structured base configs

---

## Alternative: Soft Separation (Lower Risk)

If full monorepo seems too risky, consider a "soft separation" approach:

1. **Reorganize within single repo** first:
   ```
   src/
   ├── _orchestrator/          # Prefix to visually separate
   │   ├── server/
   │   ├── client/
   │   └── shared/
   └── ...rest of app
   ```

2. **Create barrel exports**:
   ```typescript
   // src/_orchestrator/index.ts
   export * from './server';
   export * from './client';
   ```

3. **Use strict import rules**:
   - Orchestrator can only import from itself and explicit dependencies
   - Main app imports orchestrator through barrel exports
   - Enforce with ESLint rules

4. **Later migrate to true monorepo** once patterns are established

**Benefits:**
- Lower risk
- Faster to implement
- Easier to reverse
- Still gets most organizational benefits

---

## Conclusion

### Difficulty Assessment

| Aspect | Difficulty | Notes |
|--------|-----------|-------|
| **Monorepo Setup** | Low | Well-documented, standard tooling |
| **Code Extraction** | Medium | Straightforward but time-consuming |
| **Dependency Decoupling** | High | Deep integration with auth, payments, DB |
| **Testing** | Medium | Need comprehensive test coverage |
| **Deployment** | Medium | CI/CD updates needed |
| **Overall** | **6/10** | Achievable but requires careful planning |

### Recommendations

1. **Start with soft separation** to understand dependencies better
2. **Use dependency injection pattern** for true independence
3. **Migrate incrementally** - don't try to move everything at once
4. **Prioritize testing** - have good test coverage before and after
5. **Document extensively** - this will help team adoption
6. **Use Turborepo** - it's designed for exactly this use case

### Timeline Estimate

- **Soft Separation**: 1 week
- **Full Monorepo Migration**: 3-4 weeks
- **Dependency Decoupling**: 2-3 weeks
- **Testing & Refinement**: 1-2 weeks

**Total**: 7-10 weeks for complete migration with full decoupling

### Is It Worth It?

**Yes, if:**
- You need to test orchestrator independently
- You plan to reuse orchestrator in other projects
- Team is growing and needs better code organization
- You want to improve build times with incremental builds

**No, if:**
- Orchestrator is deeply coupled and won't be reused
- Team is small and current structure works
- Timeline is tight
- Risk of breaking changes is too high

---

## Next Steps

1. Review this document with team
2. Decide on approach (full monorepo vs soft separation)
3. Create proof-of-concept with small subset of orchestrator code
4. Estimate actual effort based on PoC
5. Create detailed implementation plan
6. Execute migration in phases

---

## Additional Resources

- [Turborepo Handbook](https://turbo.build/repo/docs/handbook)
- [Monorepos in Git](https://www.atlassian.com/git/tutorials/monorepos)
- [pnpm Workspaces](https://pnpm.io/workspaces)
- [TypeScript Project References](https://www.typescriptlang.org/docs/handbook/project-references.html)
