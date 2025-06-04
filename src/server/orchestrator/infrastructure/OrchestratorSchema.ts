import type { z } from 'zod';

interface IOrchestratorSchema<TSchema extends z.AnyZodObject> {
  schemas: TSchema[];
  validateInput: (args: z.input<TSchema>) => z.output<TSchema>;
}

export class OrchestratorSchema<TSchema extends z.AnyZodObject>
  implements IOrchestratorSchema<TSchema>
{
  schemas: TSchema[];
  validateInput: (args: z.input<TSchema>) => z.output<TSchema>;

  constructor({ validateInput, schemas }: IOrchestratorSchema<TSchema>) {
    this.schemas = schemas;
    this.validateInput = validateInput;
  }
}
