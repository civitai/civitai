import { ModelFile, ModelFileType, Prisma, ScanResultCode } from '@prisma/client';
import { env } from '~/env/server.mjs';

const TARGET_MODEL: Prisma.ModelName = 'ModelFile';
const TARGET_ACTIONS: Prisma.PrismaAction[] = ['create', 'update'];

export const fileValidationMiddleware: Prisma.Middleware = async (params, next) => {
  if (params.model !== TARGET_MODEL || !TARGET_ACTIONS.includes(params.action)) return next(params);
  if (!params.args.data.url) return next(params);

  // Set file to unscanned state
  params.args.data = {
    ...params.args.data,
    ...unscannedFile,
  };

  try {
    // Request file scan
    const { modelVersionId, type, url } = params.args.data;
    await requestFileScan({ modelVersionId, type, url });
  } catch (err) {
    console.error(err);
  }

  // Continue with request
  return next(params);
};

const unscannedFile: Partial<ModelFile> = {
  scannedAt: null,
  rawScanResult: null,
  virusScanMessage: null,
  virusScanResult: ScanResultCode.Pending,
  pickleScanMessage: null,
  pickleScanResult: ScanResultCode.Pending,
};

type FileScanRequest = {
  modelVersionId: number;
  type: ModelFileType;
  url: string;
};

async function requestFileScan({ modelVersionId, type, url: fileUrl }: FileScanRequest) {
  const callbackUrl =
    `${env.NEXTAUTH_URL}/api/webhooks/scan-result` +
    new URLSearchParams({
      modelVersionId: modelVersionId.toString(),
      type: type.toString(),
    });

  const scanUrl =
    env.SCANNING_ENDPOINT +
    new URLSearchParams({
      fileUrl,
      callbackUrl,
    });

  const res = await fetch(scanUrl, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  return res.json();
}
