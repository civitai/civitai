# Civitai Generator System Documentation

@dev: We'd like this document to be focused on how to add or modify supported base models and engines. The goal is to make it so that agents can add them with minimal additional direction. This should include file paths and structure that need to be implemented when adding new base models and engines. The end to end approach would include everything from form updates to the point where we submit the workflow to the orchestrator. The goal is to provide a workflow that can be followed by agents to add different base models and engines, and to have those workflows divided where appropriate based on the type of thing that they're trying to add. The document should include the architecture for context and critical components/files, but should mostly be kept high-level.

## Overview
The Civitai generator system is a comprehensive platform for AI content generation supporting multiple model types (image, video) through a modular orchestrator architecture. The system integrates various generation engines, manages model resources, and provides a unified interface for users to generate content.

## System Architecture

### Frontend Components

#### Main Generation Pages
- **Primary Interface**: `src/pages/generate/index.tsx` - Main entry point for generation features
- **Image Generation**: `src/components/ImageGeneration/` directory contains all image generation components
- **Video Generation**: `src/components/Generation/Video/` directory for video-specific generation

#### Core Frontend Components
- **GenerationForm2.tsx** (`src/components/ImageGeneration/GenerationForm2.tsx`) - Main form for image generation
- **VideoGenerationForm.tsx** (`src/components/Generation/Video/VideoGenerationForm.tsx`) - Video generation interface
- **GenerationProvider.tsx** (`src/components/ImageGeneration/GenerationProvider.tsx`) - Context provider managing generation state
- **Queue.tsx** (`src/components/ImageGeneration/Queue.tsx`) - Manages generation queue and status
- **Feed.tsx** (`src/components/ImageGeneration/Feed.tsx`) - Displays generated content

### Backend Services

#### API Routers
- **Generation Router**: `src/server/routers/generation.router.ts` - Primary API endpoints for generation
- **Orchestrator Router**: `src/server/routers/orchestrator.router.ts` - Manages orchestrator operations

#### Core Services
- **Generation Service**: `src/server/services/generation/generation.service.ts` - Core business logic
- **Orchestrator Controller**: `src/server/controllers/orchestrator.controller.ts` - Handles generation requests
- **Orchestrator Services**: `src/server/services/orchestrator/` - Engine-specific implementations

## Model Type Integration

### Image Generation Engines

Located in `src/shared/orchestrator/ImageGen/`:

1. **OpenAI (DALL-E)**
   - Configuration: `openAI.ts`
   - Integration with OpenAI's DALL-E API

2. **Google Imagen**
   - Configuration: `google.ts`
   - Google's Imagen model integration

3. **Flux1-Kontext**
   - Configuration: `flux1-kontext.ts`
   - Flux model with context awareness

4. **Gemini**
   - Configuration: `gemini.ts`
   - Google's Gemini model for images

5. **Seedream**
   - Configuration: `seedream.ts`
   - Specialized image generation engine

**Unified Configuration**: `src/shared/orchestrator/ImageGen/imageGen.config.ts`
@dev: note that for each imageGen config, there is an associated engine, and each engine will work with one or more specific models.

### Video Generation Engines

Located in `src/server/orchestrator/`:

1. **Veo3** (`veo3.ts`) - Google's video generation
2. **Vidu** (`vidu.ts`) - Video generation platform
3. **Minimax** (`minimax.ts`) - Minimax video models
4. **Kling** (`kling.ts`) - Kling video generation
5. **Lightricks** (`lightricks.ts`) - Lightricks' video tools
6. **Haiper** (`haiper.ts`) - Haiper video generation
7. **Mochi** (`mochi.ts`) - Mochi video models
8. **Hunyuan** (`hunyuan.ts`) - Tencent's Hunyuan
9. **Wan Series** - Multiple versions:
   - `wan21.ts` - Wan 2.1
   - `wan22.ts` - Wan 2.2
   - `wan225b.ts` - Wan 2.25b

**Unified Configuration**: `src/server/orchestrator/generation/generation.config.ts`
@dev: these configs work similarly to the imageGen configs. One of the main differences is that each of these take a schema that have different defaults. These schemas are used to ensure that the default form values use the best defaults for the selected model.

## Model Addition Methods

### Method 1: User Upload System

**Entry Points:**
- **Model Upload Form**: `src/components/Resource/Forms/ModelUpsertForm.tsx`
- **Version Management**: `src/components/Resource/Forms/ModelVersionUpsertForm.tsx`

**Process:**
1. User fills model information form
2. Uploads model files (safetensors, ckpt, etc.)
3. Sets metadata (base model, trigger words, etc.)
4. System processes and validates model
5. Model becomes available for generation

**Supported Model Types (from Prisma schema):**
- Checkpoint - Full SD models
- LORA/LoCon/DoRA - Lightweight adaptations
- TextualInversion - Embedding models
- Hypernetwork - Network modifications
- Controlnet - Control models for guided generation
- VAE - Variational autoencoders
- MotionModule - Animation/motion models
- Upscaler - Image upscaling models
- Poses - Pose control models
- Wildcards - Prompt wildcards
- Workflows - ComfyUI/A1111 workflows
- Detection - Object detection models
@dev: Of these user upload options, only Checkpoints, LORA/LoCon/DoRA/VAE and TextualInversions are supported. It'd be good for you to find the place where this support is defined in case you need to change those in the future. This is partial covered in the section below about Coverage Table, so maybe it should be documented there?

### Method 2: Training System Integration

**Training to Model Pipeline:**
- Training interface: `src/components/Training/`
- Training service: `src/server/services/training.service.ts`
- Auto-conversion from training outputs to usable models

**Process:**
1. User initiates training job
2. Training completes and produces model files
3. System automatically creates model entry
4. Model immediately available for generation
@dev: Can you clarify how these make it into the generator before they're published? Once they're published they're treated the same as Method 1.

### Method 3: External Engine Integration

**For Image Models:**
1. Add engine configuration in `src/shared/orchestrator/ImageGen/`
2. Implement engine-specific schema and validation
3. Add to `imageGen.config.ts` configuration
4. Update `ResourceSelect` components if custom UI needed
@dev: we don't update the ResourceSelect component for this. We add a bunch of conditional logic to specify what form fields to use in GenerationForm2.tsx. Honestly, the whole generation form needs to be reworked to more easily configure what form fields and default values to use for each baseModel/baseModel group.

**For Video Models:**
1. Add engine implementation in `src/server/orchestrator/`
2. Define engine-specific parameters in configuration
3. Add to `generation.config.ts`
4. Update video form components if needed
@dev: Something to consider is making this a part of the main generation form, but we would need to do some work to make the generation form more easily configured.

### Method 4: API Integration

**Direct API Model Addition:**
- Model router: `src/server/routers/model.router.ts`
- Supports programmatic model creation
- Used for bulk imports and migrations
@dev: This isn't necessary for the documentation here... This is essentially the same as Method 1...

## Resource Management System

### Resource Selection
- **ResourceSelect Components**: `src/components/ImageGeneration/ResourceSelect/`
- **ResourceSelectCard**: Visual model selection
- **ResourceSelectDropdown**: Dropdown model selection
- **Search Integration**: Meilisearch indices for fast model discovery

@dev: Can you dig into what needs to be added to Meilisearch when new models are added via methods other than Method 1? Method 1 is covered by the model publishing system.

### Generation Coverage
- **Coverage Table**: Tracks which models support generation
- **Coverage Service**: `src/server/services/generation/generation.service.ts`
- **Availability Checking**: Real-time model availability status
@dev: When we add a new baseModel, we typically add a default checkpoint to the "EcosystemCheckpoints" table, with the modelVersionId and a name. To enable generation for loras/doras/etc, we have to update the "GenerationBaseModel" table with the new baseModel.

### Model File Management
- **File Storage**: S3/CloudFlare R2 integration
- **File Types**: safetensors, ckpt, pt, bin, zip
- **Metadata Storage**: Model cards, configs, sample images
@dev: This isn't necessary for the documentation here...

## Database Architecture

### Core Tables
- **Model** - Base model information and metadata
- **ModelVersion** - Versioned releases of models
- **ModelFile** - Physical files associated with versions
- **GenerationCoverage** - Tracks generation availability
- **GenerationBaseModel** - Supported base models (SD1.5, SDXL, etc.)
@dev: you're missing a core table, "EcosystemCheckpoints"

### Key Enums
- **ModelStatus**: Draft, Published, Scheduled, etc.
- **ModelModifier**: Archived, TakenDown, etc.
- **ImageGenerationProcess**: txt2img, img2img, inpainting, etc.
- **GenerationSchedulers**: Various sampling methods
@dev: the generation schedulers may have an enum, but they also have some mappings that are important too.

## State Management

### Frontend Stores (Zustand)
- **Generation Store**: `src/store/generation.store.ts`
- **Training Store**: `src/store/training.store.ts`
- **Resource Store**: Manages selected resources
@dev: Training should be treated as essentially a completely separate service and doesn't need to be documented here. Is there a reason you referenced it here? Does generating with previewed training results/epochs reference the training store?

### Form Persistence
- Uses `usePersistForm` hook for form state persistence
- LocalStorage backing for user preferences
- Session management for generation parameters

## Integration Points
@dev: This section should just be removed.

### Cost Management
- **Buzz System**: Virtual currency for generation
- **Cost Calculation**: `src/server/services/buzz.service.ts`
- **Tier-based Pricing**: Different costs for different models/engines
@dev: Actually cost calculation comes from the orchestrator api as a "whatIf" request

### Content Moderation
- **NSFW Detection**: Automatic content classification
- **Blocking System**: `src/server/services/blocked-generation.service.ts`
- **User Preferences**: Configurable content filters
@dev: It might make more sense to have this focus on how we limit NSFW level of requests and handle the resulting NSFW level of images and show/hide based on that and where that happens.

### Real-time Updates
- **Queue Status**: WebSocket-like updates for generation progress
- **Notification System**: Real-time notifications for completed generations
- **Feed Updates**: Live feed of community generations
@dev: The user will never see community generations. They only see their own generations.

## Workflow System
@dev: this section should be removed

### ComfyUI Integration
- **Workflow Storage**: Database support for workflow JSONs
- **Workflow Execution**: Through orchestrator system
- **Parameter Mapping**: Dynamic parameter injection
@dev: this is a legacy approach. We won't be building more of this.

### A1111 Integration
- **API Compatibility**: Support for A1111 API format
- **Extension Support**: Compatible with A1111 extensions
- **Model Format**: Native support for A1111 model formats

## Adding New Model Types - Step by Step

### For New Image Model Type:
1. Define model type in Prisma schema if needed
2. Create engine implementation in `src/shared/orchestrator/ImageGen/`
3. Add configuration to `imageGen.config.ts`
4. Update `ModelUpsertForm.tsx` for UI support
5. Add validation schemas
6. Update resource selection components
7. Test generation pipeline end-to-end
@dev: No need to modify ModelUpsertForm.tsx or resource selection components. Instead, the current implementation has us adding logic to GenerationForm2.tsx to determine what fields to display to the user.

### For New Video Model Type:
1. Create orchestrator implementation in `src/server/orchestrator/`
2. Define configuration in `generation.config.ts`
3. Update `VideoGenerationForm.tsx` for UI
4. Add model-specific parameters
5. Implement cost calculation
6. Add to generation router endpoints
7. Test video generation workflow
@dev: a new engine would get its own form/config files. Drop the cost calculation. No need to create additional endpoints.

### For New Model Category:
1. Extend Prisma ModelType enum
2. Create dedicated UI components in `src/components/`
3. Add router endpoints in `src/server/routers/`
4. Implement service layer in `src/server/services/`
5. Create orchestrator integration
6. Add state management
7. Update search indices
8. Implement moderation rules
@dev: drop this section

@ai: This documentation provides a comprehensive overview of the Civitai generator system. I've organized it to show:
1. How frontend and backend connect through the orchestrator pattern
2. Multiple methods for adding models (user upload, training, external engines, API)
3. Clear separation between image and video model integration
4. File references throughout for easy navigation
5. Step-by-step guides for adding new model types

Would you like me to dive deeper into any specific area or add more details about particular integration methods?

@dev: Please review the contents of these files to refine your understanding. These are critical files to the generation process and are typically updated when adding support for new base model types and generation engines:
- src/shared/constants/base-model.constants.ts
- src/shared/constants/generation.constants.ts
- src/server/common/constants.ts
- src/components/ImageGeneration/GenerationForm/GenerationForm2.tsx
- src/server/services/orchestrator/common.ts - occasional updates
- src/server/services/generation/generation.service.ts - occasional updates

