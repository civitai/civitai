---
name: ux-design
description: UX design methodology and external consultation. Use when creating user flows, wireframes, interaction patterns, or getting UX feedback. Provides structured frameworks for user-centered design.
---

# UX Design Skill

A comprehensive UX design methodology for creating user-centered products. Use this skill when designing user experiences, creating flows, evaluating usability, or getting external UX feedback.

## Core UX Principles

### 1. Jobs-to-be-Done (JTBD)
Focus on what users are trying to accomplish, not features.

```
Template:
When [situation], I want to [motivation], so I can [expected outcome].

Example:
When I have a character I love, I want to generate comic panels with them,
so I can tell stories without learning to draw.
```

### 2. Progressive Disclosure
Show only what's needed at each step. Complexity emerges as users need it.

```
Level 1: Core action (upload, generate)
Level 2: Basic options (style, description)
Level 3: Advanced controls (parameters, fine-tuning)
Level 4: Expert features (custom LoRAs, composition)
```

### 3. Recognition Over Recall
Users should recognize options, not remember commands.

```
Bad: "Enter LoRA weight (0.0-1.0)"
Good: [Slider with preview] "Style strength: Subtle ←→ Strong"
```

### 4. Error Prevention > Error Recovery
Design to prevent errors, not just handle them gracefully.

```
Example: Disable "Generate" until character is locked, not "Error: No character"
```

### 5. Immediate Feedback
Every action should have visible response within 100ms.

```
- Button press → visual state change
- Upload → progress indicator
- Generation → status updates ("Analyzing face...", "Applying style...")
```

## UX Design Process

### Phase 1: Research & Discovery

```
1. User Interviews
   - Who are the target users?
   - What are they trying to accomplish?
   - What do they currently use? What's frustrating?
   - What would "magic" look like?

2. Competitive Analysis
   - What do competitors do well?
   - Where do they fail?
   - What's the table stakes?
   - What's the differentiation opportunity?

3. Jobs-to-be-Done Mapping
   - List all user jobs
   - Prioritize by frequency × importance
   - Identify underserved jobs

4. User Personas
   - 2-3 primary personas
   - Goals, frustrations, context
   - Technical proficiency level
```

### Phase 2: Information Architecture

```
1. Content Inventory
   - What content/features exist?
   - How do they relate?

2. Site/App Map
   - Hierarchy of screens/pages
   - Navigation structure

3. User Flows
   - Primary task flows (happy path)
   - Error/edge case flows
   - Entry and exit points
```

### Phase 3: Interaction Design

```
1. Wireframes
   - Low-fidelity layouts
   - Component placement
   - Information hierarchy

2. Interaction Patterns
   - How does each element behave?
   - State transitions
   - Micro-interactions

3. Responsive Considerations
   - Desktop, tablet, mobile breakpoints
   - Touch vs mouse interactions
```

### Phase 4: Visual Design

```
1. Design System
   - Typography
   - Color palette
   - Spacing/grid
   - Component library

2. High-Fidelity Mockups
   - Pixel-perfect designs
   - All states (empty, loading, error, success)
   - Dark/light mode if applicable

3. Prototypes
   - Interactive clickable prototypes
   - Animation/transition specs
```

### Phase 5: Validation

```
1. Usability Testing
   - Task completion rates
   - Time on task
   - Error rates
   - User satisfaction

2. A/B Testing
   - Hypothesis-driven experiments
   - Statistical significance

3. Analytics
   - Funnel analysis
   - Drop-off points
   - Feature usage
```

## UX Deliverables

### User Flow Diagram Format

```
[Entry Point] → (Decision) → [Screen/State] → [Exit/Success]
                    ↓
              [Alternative Path]

Legend:
[ ] = Screen or state
( ) = Decision point
→  = Flow direction
--- = Optional path
```

### Wireframe Annotation Format

```
┌─────────────────────────────────────────┐
│  [Component Name]                        │
│  ┌─────────────────────────────────────┐│
│  │                                     ││
│  │  ① Element description              ││
│  │  ② Interaction behavior             ││
│  │                                     ││
│  └─────────────────────────────────────┘│
│                                          │
│  Notes:                                  │
│  - Accessibility considerations          │
│  - Edge cases                            │
│  - Mobile behavior                       │
└─────────────────────────────────────────┘

① Numbered annotations reference specific elements
② Describe behavior, not just appearance
```

### State Diagram Format

```
State Machine: [Component Name]

States:
- idle: Default state
- loading: Async operation in progress
- success: Operation completed
- error: Operation failed

Transitions:
idle → loading: [trigger: user action]
loading → success: [trigger: operation complete]
loading → error: [trigger: operation failed]
error → idle: [trigger: dismiss/retry]
```

## Running UX Reviews

Use the agent-review skill with UX-focused prompts:

```bash
# Get UX feedback on a flow
node .claude/skills/agent-review/query.mjs -m opus \
  -s "You are a senior UX designer with 15 years of experience in consumer products. Focus on usability, accessibility, and emotional design." \
  -f docs/ux-flow.md \
  "Review this user flow for usability issues and opportunities"

# Evaluate information architecture
node .claude/skills/agent-review/query.mjs -m opus \
  -s "You are an information architect specializing in complex creative tools. Prioritize discoverability and progressive complexity." \
  -f docs/site-map.md \
  "Evaluate this information architecture for a comic creation tool"

# Get feedback on wireframes
node .claude/skills/agent-review/query.mjs -m opus \
  -s "You are a UX designer who specializes in creative tools like Figma, Canva, and Adobe products. Focus on efficiency for power users while maintaining approachability." \
  -f docs/wireframes.md \
  "Critique these wireframes for a comic panel generator"
```

## UX Heuristics Checklist

Use this checklist to evaluate designs:

### Nielsen's 10 Usability Heuristics

- [ ] **Visibility of system status**: User always knows what's happening
- [ ] **Match with real world**: Uses familiar language and concepts
- [ ] **User control and freedom**: Easy to undo, escape, go back
- [ ] **Consistency and standards**: Same actions work the same way
- [ ] **Error prevention**: Design prevents errors before they occur
- [ ] **Recognition over recall**: Options visible, not memorized
- [ ] **Flexibility and efficiency**: Shortcuts for experts, simplicity for novices
- [ ] **Aesthetic and minimal**: No irrelevant information
- [ ] **Help users with errors**: Clear error messages with solutions
- [ ] **Help and documentation**: Available when needed

### Accessibility (WCAG)

- [ ] **Perceivable**: Content available to all senses
- [ ] **Operable**: All functionality via keyboard
- [ ] **Understandable**: Clear language, predictable behavior
- [ ] **Robust**: Works with assistive technologies

### Emotional Design

- [ ] **Visceral**: First impression is positive
- [ ] **Behavioral**: Feels good to use, efficient
- [ ] **Reflective**: Users feel proud/satisfied after use

## UX Writing Guidelines

### Microcopy Principles

```
1. Be concise: "Upload" not "Click here to upload your files"
2. Be specific: "3 images required" not "Upload images"
3. Be helpful: "Try a front-facing photo" not "Invalid image"
4. Be human: "Almost there!" not "Processing: 80%"
```

### Button Labels

```
Good: [Create Comic] [Save Draft] [Generate Panel]
Bad: [Submit] [OK] [Go]

Action verbs that describe what happens
```

### Error Messages

```
Format: What happened + Why + How to fix

Example:
"Character not recognized. We couldn't detect a face in your images.
Try uploading photos with a clear, front-facing view."
```

### Loading States

```
Informative progress, not just spinners:

"Analyzing your character..." (0-30%)
"Learning facial features..." (30-50%)
"Creating style profile..." (50-70%)
"Almost ready..." (70-100%)
```

## Output Templates

When creating UX documentation, use these templates:

### User Story Template

```markdown
## User Story: [Title]

**As a** [user type]
**I want to** [action]
**So that** [benefit]

### Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2

### UX Notes
- Key interaction details
- Edge cases to handle
- Accessibility considerations
```

### Screen Specification Template

```markdown
## Screen: [Name]

**Purpose:** What this screen accomplishes
**Entry Points:** How users arrive here
**Exit Points:** Where users can go from here

### Layout
[ASCII wireframe or description]

### Components
| Component | Behavior | States |
|-----------|----------|--------|
| Component 1 | Description | idle, hover, active, disabled |

### Interactions
1. When user does X, Y happens
2. ...

### Edge Cases
- Empty state: What shows when no data?
- Error state: What shows on failure?
- Loading state: What shows during async?

### Accessibility
- Keyboard navigation
- Screen reader considerations
- Color contrast
```

### User Flow Template

```markdown
## Flow: [Name]

**Goal:** What the user accomplishes
**Trigger:** What initiates this flow
**Actors:** Who is involved

### Happy Path
1. Step 1 → [Screen/State]
2. Step 2 → [Screen/State]
3. Success!

### Alternative Paths
- If [condition], then [alternative flow]

### Error Paths
- If [error], show [error state], user can [recovery action]

### Flow Diagram
[ASCII or mermaid diagram]
```

## When to Use This Skill

- **New Feature Design**: Before writing code, design the experience
- **UX Review**: Evaluate existing designs for usability issues
- **User Flow Mapping**: Document how users accomplish tasks
- **Wireframing**: Create low-fidelity layouts
- **Interaction Design**: Define how elements behave
- **Usability Evaluation**: Heuristic analysis of designs
- **UX Writing**: Craft microcopy, error messages, onboarding text
