import { Import, ImportStatus } from '@prisma/client';

type Importer = {
  canHandle: (source: string) => boolean;
  run: (input: ImportRunInput) => Promise<ImportResult>;
};

export type ImportRunInput = {
  id: number;
  source: string;
  userId?: number | null;
  data?: any;
};

export type ImportDependency = {
  source: string;
  data?: any;
};

type ImportResult = {
  status: ImportStatus;
  data?: any;
  dependencies?: ImportDependency[];
};

export function createImporter(canHandle: Importer['canHandle'], run: Importer['run']): Importer {
  return {
    canHandle,
    run,
  };
}
