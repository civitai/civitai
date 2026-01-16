# Proposal: Model File Variants & Components UI

## The Problem

Our users are struggling with models that have multiple file options and required components. The current UI was designed for simple "one model, one file" scenarios, but modern AI models are more complex.

### What Users Experience Today

**Confusing download options:**
- A model might have 6+ file variants (fp16, fp8, GGUF Q4_K_M, GGUF Q8_0, etc.)
- Users don't know which file they need
- File variants are presented as a flat list with no guidance

**Hidden dependencies:**
- Some models require additional components to work (VAE, Text Encoder, UNet)
- These components are buried in the UI or uploaded as separate "versions"
- Users download the model, try to run it, and only then discover they're missing pieces

**Version abuse:**
- Creators work around UI limitations by uploading components as "versions"
- Example: Wan Video 2.1 has 7 "versions" - but only 1 is the actual model; the rest are VAE, text encoder, vision encoder, etc.
- This makes the version selector confusing and cluttered

### Example: The Wan Video 2.1 Problem

| What Appears as "Version" | What It Actually Is |
|---------------------------|---------------------|
| wan2.1_t2v_1.3B_fp16 | Main model file |
| Wan 2.1 VAE | Required component |
| umt5_xxl_fp8_e4m3fn_scale | Required text encoder |
| Clip Vision h | Required vision encoder |
| wan2.1_i2v_480p_14B_fp8 | Resolution variant |
| wan2.1_i2v_720p_14B_fp8 | Resolution variant |

A user looking at this has no idea what to download. They might grab just the main model, then wonder why it doesn't work.

---

## The Solution

### 1. Smart Download Selection

**Before:** Flat list of files, user guesses which one they need.

**After:** Single download button that shows the best file for each user based on their preferences.

- User preferences (already in account settings) automatically select the best match
- Dropdown reveals all variants, grouped by format (SafeTensor vs GGUF)
- Clear size and format labels help users make informed choices if they want to override

**User experience:** "I click Download and get the right file for my setup. I can see other options if I want, but I don't have to think about it."

### 2. Required Components Section

**Before:** Components hidden as versions, no indication they're needed.

**After:** Dedicated "Required Components" section with clear labels.

- Components (VAE, Text Encoder, UNet, etc.) are displayed separately from file variants
- Visual indicator (yellow/warning styling) shows these are required
- Components can also have variants (e.g., Text Encoder in fp16 or fp8)
- "Download All Components" button grabs everything needed in one click
- Auto-selects the best variant of each component based on user preferences

**User experience:** "I immediately see that this model needs a VAE and Text Encoder. I can download everything with one click, or pick specific variants."

### 3. Improved Upload Experience

**Before:** All files uploaded to one bucket, no way to indicate purpose.

**After:** Three clear sections during upload.

| Section | Purpose | Example Files |
|---------|---------|---------------|
| **Model Files** | The actual model weights you created | checkpoint.safetensors (fp16, fp8, GGUF variants) |
| **Required Components** | Dependencies needed to run | VAE, Text Encoder, UNet, CLIP Vision |
| **Optional Files** | Helpful extras | Workflows, configs, examples |

**Note on modular pipelines:** For fully modular models (like Flux/Wan) where there is no single bundled checkpoint, the Model Files section may be empty. In this case, all parts (UNet, Text Encoder, VAE) go in Required Components as peers - there's no artificial hierarchy. See "Component-Only Models" below.

Creators can:
- Upload multiple variants of the same model (fp16 + fp8 + GGUF)
- Mark components as required
- Link to existing components on Civitai instead of re-uploading
- Specify component types (VAE, Text Encoder, UNet, etc.)

**Creator experience:** "I can properly organize my model with all its parts. Users will know exactly what they need."

### 4. Component Linking

For common components that already exist on Civitai (like popular VAEs):

- Creators can link to existing models instead of re-uploading
- Search is filtered by component type (search for VAEs only, or Text Encoders only)
- Users see the linked component and can download it from the original source

**User experience:** "The model links to the official VAE. I click through and download it from the VAE's page, where I can also see other models that use it."

---

## Visual Preview

### Model Detail Page (Sidebar)

Interactive mockup: [v9-components-grouped.html](./model-ui-overhaul-mockups/model-sidebar.html)

Key elements:
- **Generate** as primary action (unchanged)
- **Download** button with variant dropdown
- **Required Components** accordion with grouped variants
- **Optional Files** accordion
- All existing version details preserved

### File Upload UI

Interactive mockup: [v4-components-with-precision.html](./model-ui-overhaul-mockups/file-upload.html)

Key elements:
- Three upload zones: Model Files, Required Components, Optional Files
- Component type selector
- Precision/Quant/Format dropdowns for each file
- "Link to Existing Model" option for components

### 5. Component-Only Models

For modular pipelines where there is no single "main" file (e.g., Flux, Wan Video), all parts are treated as Required Components:

- **No download button** - instead, "Download All Components" is the primary action
- **Clear messaging** - "This is a modular model - download components below"
- **All components are peers** - UNet, Text Encoder, VAE are equal; no false hierarchy
- **Upload validation** - if no Model Files, must have at least 2 Required Components

**User experience:** "I see this model has three parts I need. I click 'Download All' and get everything, or pick specific variants of each."

---

## What This Solves

| Problem | Solution |
|---------|----------|
| Users don't know which file to download | Auto-selection based on preferences + clear dropdown |
| Hidden required components | Dedicated "Required Components" section |
| Version abuse for components | Proper component linking and upload sections |
| GGUF quants flooding the UI | Grouped in dropdown, not separate versions |
| No guidance during upload | Sectioned upload with component type selection |
| Modular pipelines don't fit | Component-only models with "Download All" |

---

## What Doesn't Change

- **Generate workflow** - Generate remains the primary action
- **Version concept** - True versions (v1, v2, v3) stay the same
- **Recommended Resources** - Existing feature unchanged
- **Existing models** - All current models continue to work

---

## Implementation Approach

We're taking a lightweight approach focused on UI improvements:

- **No database migrations required** - uses existing JSON metadata fields
- **Backwards compatible** - existing models work without changes
- **Incremental** - can ship improvements piece by piece

### Key Changes

1. **Frontend:** New sidebar layout, new upload flow
2. **Metadata:** Extended file metadata for `quantType` and `componentType`
3. **User Settings:** Add quant preference for GGUF users
4. **Component Linking:** Expand beyond just VAE to support all component types

---

## Known Limitations & Future Considerations

This proposal solves the immediate pain points but doesn't address everything. Here's what we're consciously deferring:

### Not Addressed in Phase 1

| Limitation | Description | Future Solution |
|------------|-------------|-----------------|
| **Alternative components** | Some models work with multiple VAE options (user's choice). Current design assumes one specific component is required. | Add `componentAlternatives` relationship type |
| **Collections** | "100 Senators LoRA" - 100 subjects as versions. Still no proper "collection" concept. | Consider Collection model type |
| **Multi-role components** | Model needs two UNets (high-res + low-res pass). No way to distinguish roles. | Add `componentRole` metadata field |
| **Linked component deletion** | If a linked component is deleted, dependent models show broken link. | Show "Component Unavailable" - creator re-links |

### Future Metadata Fields

We're using JSON metadata to avoid migrations. These fields may be needed later:

```typescript
// ModelFile.metadata - potential future fields
{
  // Phase 1 (implementing now)
  quantType: string,      // "Q4_K_M", "Q8_0" for GGUF
  componentType: string,  // "VAE", "TextEncoder", "UNet"

  // Future consideration
  componentRole: string,  // "high-res", "low-res", "base", "refiner"
  isAlternative: boolean, // true = "works with this" vs "requires this"
  pipelinePosition: number, // ordering hint for multi-component pipelines
}
```

---

## Questions?

The full technical planning document with database analysis, mockup iterations, and implementation details is available at: [model-ui-overhaul.md](./model-ui-overhaul.md)
