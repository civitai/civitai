import { Import, ImportStatus } from '@prisma/client';

type Importer = {
  canHandle: (source: string) => boolean;
  run: (id: number, source: string, userId?: number | null) => Promise<ImportResult>;
};

type ImportResult = {
  status: ImportStatus;
  data?: any;
  dependencies?: Import[];
};

export function createImporter(canHandle: Importer['canHandle'], run: Importer['run']): Importer {
  return {
    canHandle,
    run,
  };
}
