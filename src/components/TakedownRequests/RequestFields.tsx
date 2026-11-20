import { Checkbox, Select, Stack, Textarea, TextInput } from '@mantine/core';
import type { RequestField } from '~/server/services/takedown-requests.service';

export type FieldValue = string | string[] | boolean;
export type FieldValues = Record<string, FieldValue>;

/** What a form sends: empty answers left out, a URL list one entry per non-blank line. */
export function cleanValues(fields: RequestField[], values: FieldValues): FieldValues {
  const out: FieldValues = {};
  for (const f of fields) {
    const v = values[f.id];
    if (f.kind === 'checkbox') {
      if (v === true) out[f.id] = true;
    } else if (f.kind === 'urlList') {
      const lines = String(v ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length) out[f.id] = lines;
    } else if (typeof v === 'string' && v.trim()) out[f.id] = v.trim();
  }
  return out;
}

export function RequestFields({
  fields,
  values,
  errors,
  onChange,
  disabled,
}: {
  fields: RequestField[];
  values: FieldValues;
  errors?: Record<string, string>;
  onChange: (id: string, value: FieldValue) => void;
  disabled?: boolean;
}) {
  return (
    <Stack gap="md">
      {fields.map((f) => {
        const common = {
          label: f.label,
          description: f.help,
          required: f.required,
          error: errors?.[f.id],
          disabled,
        };
        const text = typeof values[f.id] === 'string' ? (values[f.id] as string) : '';
        switch (f.kind) {
          case 'checkbox':
            return (
              <Checkbox
                key={f.id}
                {...common}
                checked={values[f.id] === true}
                onChange={(e) => onChange(f.id, e.currentTarget.checked)}
              />
            );
          case 'textarea':
          case 'urlList':
            return (
              <Textarea
                key={f.id}
                {...common}
                autosize
                minRows={f.kind === 'urlList' ? 3 : 4}
                placeholder={f.kind === 'urlList' ? 'One web address per line' : undefined}
                value={text}
                onChange={(e) => onChange(f.id, e.currentTarget.value)}
              />
            );
          case 'select':
            return (
              <Select
                key={f.id}
                {...common}
                data={f.options ?? []}
                value={text || null}
                onChange={(v) => onChange(f.id, v ?? '')}
              />
            );
          default:
            return (
              <TextInput
                key={f.id}
                {...common}
                type={f.kind === 'email' ? 'email' : f.kind === 'url' ? 'url' : 'text'}
                value={text}
                onChange={(e) => onChange(f.id, e.currentTarget.value)}
              />
            );
        }
      })}
    </Stack>
  );
}
