/**
 * Whether a zod schema (v4, or v3 via the `zod/v3` compat entry) has a `blockToken` key in any
 * object shape reachable through wrappers: optional / nullable / default / readonly / catch,
 * pipes (transform, preprocess), intersections, unions, lazy. Returns `null` for a shape it cannot
 * read, so the caller can fail on it rather than treat it as token-free.
 */
export function hasBlockTokenKey(schema: unknown, seen = new Set<unknown>()): boolean | null {
  if (schema == null || typeof schema !== 'object') return null;
  if (seen.has(schema)) return false;
  seen.add(schema);
  const any = (parts: unknown[]): boolean | null => {
    let unreadable = false;
    for (const part of parts) {
      const r = hasBlockTokenKey(part, seen);
      if (r === true) return true;
      if (r === null) unreadable = true;
    }
    return unreadable ? null : false;
  };

  // zod v4: everything hangs off `_zod.def`, discriminated by `def.type`.
  const v4 = (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
  if (v4) {
    switch (v4.type) {
      case 'object': {
        const shape = v4.shape as Record<string, unknown>;
        return 'blockToken' in shape ? true : any(Object.values(shape));
      }
      case 'optional':
      case 'nullable':
      case 'default':
      case 'prefault':
      case 'readonly':
      case 'catch':
      case 'nonoptional':
      case 'success':
        return hasBlockTokenKey(v4.innerType, seen);
      case 'pipe':
        return any([v4.in, v4.out]);
      case 'intersection':
        return any([v4.left, v4.right]);
      case 'union':
        return any(v4.options as unknown[]);
      case 'array':
        return hasBlockTokenKey(v4.element, seen);
      case 'record':
        return hasBlockTokenKey(v4.valueType, seen);
      case 'tuple':
        return any([...(v4.items as unknown[]), ...(v4.rest ? [v4.rest] : [])]);
      case 'lazy':
        return hasBlockTokenKey((v4.getter as () => unknown)(), seen);
      default:
        // Leaves (string, number, enum, literal, date, any, unknown, transform, custom, …)
        // carry no object shape.
        return false;
    }
  }

  // zod v3 (`zod/v3`): `_def.typeName`.
  const v3 = (schema as { _def?: Record<string, unknown> })._def;
  if (v3 && typeof v3.typeName === 'string') {
    switch (v3.typeName) {
      case 'ZodObject': {
        const shape = (v3.shape as () => Record<string, unknown>)();
        return 'blockToken' in shape ? true : any(Object.values(shape));
      }
      case 'ZodOptional':
      case 'ZodNullable':
      case 'ZodDefault':
      case 'ZodReadonly':
      case 'ZodCatch':
      case 'ZodBranded':
        return hasBlockTokenKey(v3.innerType ?? v3.type, seen);
      case 'ZodEffects':
        return hasBlockTokenKey(v3.schema, seen);
      case 'ZodPipeline':
        return any([v3.in, v3.out]);
      case 'ZodIntersection':
        return any([v3.left, v3.right]);
      case 'ZodUnion':
      case 'ZodDiscriminatedUnion':
        return any(v3.options as unknown[]);
      case 'ZodArray':
        return hasBlockTokenKey(v3.type, seen);
      case 'ZodLazy':
        return hasBlockTokenKey((v3.getter as () => unknown)(), seen);
      default:
        return false;
    }
  }
  return null;
}
