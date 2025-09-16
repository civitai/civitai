import * as z from 'zod';
import { isValidDate } from '~/utils/date-helpers';

export function coerceStringArray<I extends z.ZodArray<z.ZodString>>(schema?: I) {
  return z.preprocess(
    (val: string | string[]) => (Array.isArray(val) ? val : [val]),
    schema ?? z.string().array()
  );
}

export function coerceNumberArray<I extends z.ZodArray<z.ZodNumber>>(schema?: I) {
  return z.preprocess(
    (val: number | number[]) => (Array.isArray(val) ? val : [val]),
    schema ?? z.number().array()
  );
}

// TODO - determine why I can't call .min on the output
export function stringToNumber<I extends z.ZodNumber>(schema?: I) {
  return z.preprocess((val: string | number, ctx) => {
    if (typeof val === 'string') {
      const parsed = Number(val);
      if (isNaN(parsed)) ctx.addIssue(`'${val}' cannot be converted to a number`);
      return parsed;
    }
    return val;
  }, schema ?? z.number());
}

export function stringToNumberArray<I extends z.ZodArray<z.ZodNumber>>(schema?: I) {
  // return stringToNumber().array()
  return z.preprocess((arr: string | number | string[] | number[], ctx) => {
    let fromString = arr;
    if (typeof arr === 'string') {
      try {
        fromString = JSON.parse(arr);
      } catch {}
    }
    return (Array.isArray(fromString) ? fromString : [fromString]).map((val) => {
      if (typeof val === 'string') {
        const parsed = Number(val);
        if (isNaN(parsed)) ctx.addIssue(`'${val}' cannot be converted to a number`);
        return parsed;
      }
      return val;
    });
  }, schema ?? z.number().array());
}

export function stringToDate<I extends z.ZodDate>(schema?: I) {
  return z.preprocess((val: string | number | Date, ctx) => {
    const date = new Date(val);
    if (!isValidDate(date)) {
      ctx.addIssue(`'${val.toString()}' cannot be converted to a date`);
    }
    return date;
  }, schema ?? z.date());
}

/** Converts a string to a number */
export function numericString<I extends z.ZodNumber>(schema?: I) {
  return stringToNumber(schema);
}

/** Converts an array of strings to an array of numbers */
export function numericStringArray<I extends z.ZodArray<z.ZodNumber>>(schema?: I) {
  return stringToNumberArray(schema);
}

/** Converts a comma delimited object (ex key:value,key 2:another value) */
export function commaDelimitedStringObject() {
  return z.preprocess((value) => {
    if (typeof value === 'string') {
      const obj: Record<string, string> = {};
      value.split(',').forEach((x) => {
        const [key, val] = x.split(':');
        obj[key] = val ?? key;
      });
      return obj;
    }
    return value;
  }, z.record(z.string(), z.string()));
}

export function stringToArray<T extends string = string>(value: unknown): T[] {
  if (!Array.isArray(value) && typeof value === 'string')
    return value.split(',').map((x) => x.trim()) as T[];
  return ((value ?? []) as unknown[]).map(String) as T[];
}

/** Converts a comma delimited string to an array of strings */
export function commaDelimitedStringArray<I extends z.ZodArray<z.ZodString>>(schema?: I) {
  return z.preprocess(
    (val: string | string[]) => (Array.isArray(val) ? val : stringToArray(val)),
    schema ?? z.string().array()
  );
}

// include=tags,category
export function commaDelimitedEnumArray<T extends string>(zodEnum: T[]) {
  return z.preprocess(
    (val: string | string[]) => (Array.isArray(val) ? val : stringToArray(val)),
    z.enum(zodEnum).array()
  );
}

/** Converts a comma delimited string to an array of numbers */
export function commaDelimitedNumberArray<I extends z.ZodArray<z.ZodNumber>>(schema?: I) {
  return z.preprocess(
    (val: string | number[]) => (Array.isArray(val) ? val : stringToArray(val)).map(Number),
    schema ?? z.number().array()
  );
}

/** Converts the string `true` to a boolean of true and everything else to false */
export function booleanString() {
  return z
    .boolean()
    .or(z.stringbool())
    .or(z.number().transform((val) => val === 1));
}

export function zodEnumFromObjKeys<K extends string>(obj: Record<K, unknown>) {
  const [firstKey, ...otherKeys] = Object.keys(obj) as K[];
  return z.enum([firstKey, ...otherKeys]);
}

// export function stripChecksAndEffects<TSchema extends ZodTypeAny>(schema: TSchema): TSchema {
//   if (schema instanceof ZodEffects) return stripChecksAndEffects(schema._def.schema);
//   if (schema instanceof ZodArray)
//     return z.array(stripChecksAndEffects(schema.element)) as unknown as TSchema;
//   if (schema instanceof ZodObject) {
//     let dictionary = z.object({});
//     for (const [key, value] of Object.entries(schema.shape)) {
//       dictionary = dictionary.extend({ [key]: stripChecksAndEffects(value as any) });
//     }
//     return dictionary as unknown as TSchema;
//   }
//   if (schema._def.innerType) {
//     schema._def.innerType = stripChecksAndEffects(schema._def.innerType);
//   }
//   if (schema._def.checks) schema._def.checks = [];
//   return schema;
// }

// export function getDeepPartialWithoutChecks<TSchema extends AnyZodObject>(schema: TSchema) {
//   return stripChecksAndEffects(schema).deepPartial();
// }

export function numberEnum<Num extends number, T extends Readonly<Num[]>>(
  args: T
): z.ZodSchema<T[number]> {
  return z.custom<T[number]>((val: any) => args.includes(val));
}

export type SchemaInputOutput<T extends z.ZodType<any, any, any>> = {
  Input: z.input<T>;
  Output: z.output<T>;
};

export function defaultCatch<ZodType extends z.ZodType<any, any>>(
  schema: ZodType,
  value: z.infer<ZodType>
) {
  return schema.default(value).catch(value) as unknown as z.ZodDefault<ZodType>;
}
