# Generator messages

Mod-authored copy shown **above the Generate button**, for things a user should
read before spending Buzz: a pricing change, a maintenance window, a capacity
warning.

Authored in the **Generator messages** section of `/moderator/generation-config`,
below the gate rules.

## Why this is not a gate rule

They share a targeting shape, and nothing else. A gate answers "can this item be
used"; a message answers "what should you know before using it". Keeping them
apart is what lets each stay simple:

| | Gate rules | Generator messages |
| --- | --- | --- |
| Blocks generation | yes (`hidden` / `disabled`) | never |
| Affects `canGenerate` | yes (`hidden`) | never |
| No targets | a rule that does nothing | every generation |
| Audience | who keeps **access** | who **sees** it |
| Placement | at the item — picker badge, flask, alert under the model selector (top of the body in the 3D form, which has none) | the footer, above the submit row |

A message was briefly a fourth gate presentation (`notice`). It never gated, its
audience field had to be pinned to a dummy value, and the first real message
needed different placement — so it moved out before it shipped.

## Shape

```ts
type GeneratorMessage = {
  id: string;                  // stable; the dismissal key's base
  name: string;                // mod-facing
  kind: 'pricing' | 'maintenance' | 'info';
  message: string;             // the copy; a message without it is dropped
  dismissible: boolean;
  audiences: MessageAudience[];   // empty = everyone
  ecosystems: string[];
  workflows: string[];
  modelVersionIds: number[];      // all three empty = every generation
};
```

`kind` drives the icon, the tone, and the **default** for `dismissible`
(pricing → dismissible, maintenance → not), which the per-message switch
overrides. Each kind has to change behaviour or the list grows an entry per
wording preference.

`audiences` is a union: `members`, `nonMembers`, or any tier (`free`, `founder`,
`bronze`, `silver`, `gold`). The filter runs **server-side** in
`getGenerationConfig`, so copy aimed at one tier never ships in another tier's
payload.

Several messages matching one selection render in the order the moderator
arranged them — reorderable by hand, which a severity ranking is not.

## Dismissal

The stored key is `<id>#<fingerprint of the copy>`, so **editing a message
re-shows it** to everyone who dismissed the previous wording. Without that, a
corrected price or date would never reach the people who had dismissed it.

Dismissals live in one localStorage slot
(`src/store/generator-message-dismissal.store.ts`) and are pruned to the
messages that still exist, so the set stays bounded. It is deliberately not
`User.settings.dismissedAlerts`, which is for registry-declared notices and has
to stay enumerable.

## Storage

Redis hash field `generation:messages` (the gate rules are a separate field), read
by `getGeneratorMessages` and written by `setGeneratorMessages`. Entries are
parsed one at a time and unreadable ones are dropped, so a single bad entry
cannot silence the rest — and a build that predates this feature simply never
reads the field.
