import type * as z from 'zod/v4';

interface IOrchestratorSchema<TSchema extends z.ZodObject> {
  schemas: TSchema[];
  validateInput: (args: z.input<TSchema>) => z.output<TSchema>;
}

export class OrchestratorSchema<TSchema extends z.ZodObject>
  implements IOrchestratorSchema<TSchema>
{
  schemas: TSchema[];
  validateInput: (args: z.input<TSchema>) => z.output<TSchema>;

  constructor({ validateInput, schemas }: IOrchestratorSchema<TSchema>) {
    this.schemas = schemas;
    this.validateInput = validateInput;
  }
}
