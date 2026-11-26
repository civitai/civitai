---
paths:
  - "src/components/form-graph/generation/**"
  - "src/components/generation_v2/**"
  - "src/shared/form-graph/generation/**"
---

# Generation form

## The graph owns a field's rules
Whether a field is required, whether the user can remove it, and which options it offers are set
in the form-graph graph that defines the field, in its `meta`. The form components only render that
`meta`; they never hard-code the rule. Otherwise the form and the graph each hold half of the logic.

```ts
// the graph (src/shared/form-graph/generation/**)
meta: () => ({ required: true, options: { ... } }),

// the form
<ResourceSelectInput options={meta?.options} allowRemove={!meta?.required} />
```

The upscaler (`workflows/image-upscale.graph.ts`) and the prompt fields follow this.

The one exception is the `model` field. Every workflow that has one requires it, so the forms keep
`allowRemove={false}` on it rather than each graph repeating it. Leave that as it is.
