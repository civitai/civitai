import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import type { TRPC_ERROR_CODE_KEY } from '@trpc/server/rpc';
import { isProd } from '~/env/other';
import { logToAxiom } from '../logging/client';
import type { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { parse as parseStackTrace } from 'stacktrace-parser';
import { SourceMapConsumer } from 'source-map';
import path from 'node:path';
import fs from 'node:fs';

const prismaErrorToTrpcCode: Record<string, TRPC_ERROR_CODE_KEY> = {
  P1008: 'TIMEOUT',
  P2000: 'BAD_REQUEST',
  P2001: 'NOT_FOUND',
  P2002: 'CONFLICT',
  P2003: 'CONFLICT',
  P2004: 'CONFLICT',
  P2005: 'BAD_REQUEST',
  P2006: 'BAD_REQUEST',
  P2007: 'BAD_REQUEST',
  P2008: 'INTERNAL_SERVER_ERROR',
  P2009: 'INTERNAL_SERVER_ERROR',
  P2010: 'INTERNAL_SERVER_ERROR',
  P2011: 'BAD_REQUEST',
  P2012: 'BAD_REQUEST',
  P2013: 'BAD_REQUEST',
  P2014: 'CONFLICT',
  P2015: 'NOT_FOUND',
  P2016: 'INTERNAL_SERVER_ERROR',
  P2017: 'INTERNAL_SERVER_ERROR',
  P2018: 'NOT_FOUND',
  P2019: 'BAD_REQUEST',
  P2020: 'BAD_REQUEST',
  P2021: 'INTERNAL_SERVER_ERROR',
  P2022: 'INTERNAL_SERVER_ERROR',
  P2023: 'INTERNAL_SERVER_ERROR',
  P2024: 'TIMEOUT',
  P2025: 'NOT_FOUND',
  P2026: 'INTERNAL_SERVER_ERROR',
  P2027: 'INTERNAL_SERVER_ERROR',
  P2028: 'INTERNAL_SERVER_ERROR',
  P2030: 'INTERNAL_SERVER_ERROR',
  P2033: 'INTERNAL_SERVER_ERROR',
  P2034: 'INTERNAL_SERVER_ERROR',
};

export function throwDbError(error: unknown) {
  // Always log to console
  if (error instanceof TRPCError) {
    throw error;
  } else if (error instanceof Prisma.PrismaClientKnownRequestError)
    throw new TRPCError({
      code: prismaErrorToTrpcCode[error.code] ?? 'INTERNAL_SERVER_ERROR',
      message: error.message,
      cause: error,
    });
  else if (error instanceof Prisma.PrismaClientValidationError)
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Database validation error',
      cause: error,
    });

  const e = error as Error;
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: e.message ?? 'An unexpected error ocurred, please try again later',
    cause: error,
  });
}

export function throwInternalServerError(error: unknown) {
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: (error as any).message ?? 'An unexpected error ocurred, please try again later',
    cause: error,
  });
}

export const handleTRPCError = (error: Error): TRPCError => {
  const isTrpcError = error instanceof TRPCError;
  if (!isTrpcError) {
    if (error instanceof Prisma.PrismaClientKnownRequestError)
      throw new TRPCError({
        code: prismaErrorToTrpcCode[error.code] ?? 'INTERNAL_SERVER_ERROR',
        message: error.message,
        cause: error,
      });
    else if (error instanceof Prisma.PrismaClientValidationError)
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Database validation error',
        cause: error,
      });
    else
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: error.message ?? 'An unexpected error ocurred, please try again later',
        cause: error,
      });
  } else {
    throw error;
  }
};

export function throwAuthorizationError(message: string | null = null) {
  message ??= 'You are not authorized to perform this action';
  throw new TRPCError({
    code: 'UNAUTHORIZED',
    message,
  });
}

export function throwBadRequestError(
  message: string | null = null,
  error?: unknown,
  overwriteMessage = true
) {
  message = overwriteMessage ? message ?? 'Your request is invalid' : message;
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: message ?? undefined,
    cause: error,
  });
}

export function throwNotFoundError(message: string | null = null) {
  message ??= 'Could not find entity';
  throw new TRPCError({
    code: 'NOT_FOUND',
    message,
  });
}

export function throwDbCustomError(message?: string) {
  return (error: PrismaClientKnownRequestError) => {
    throw new TRPCError({
      code: prismaErrorToTrpcCode[error.code] ?? 'INTERNAL_SERVER_ERROR',
      message: message ?? error.message,
      cause: error,
    });
  };
}

export function throwRateLimitError(message: string | null = null, error?: unknown) {
  message ??= `Slow down! You've made too many requests. Please take a breather`;
  throw new TRPCError({
    code: 'TOO_MANY_REQUESTS',
    message,
    cause: error,
  });
}

export function throwInsufficientFundsError(message: string | null = null, error?: unknown) {
  message ??= `Hey buddy, seems like you don't have enough funds to perform this action.`;
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message,
    cause: error,
  });
}

export function throwConflictError(message: string | null = null, error?: unknown) {
  message ??= 'There was a conflict with your request';
  throw new TRPCError({
    code: 'CONFLICT',
    message,
    cause: error,
  });
}

export function handleLogError(e: Error, name?: string) {
  const error = new Error(e.message ?? 'Unexpected error occurred', { cause: e });
  if (isProd)
    logToAxiom(
      {
        type: 'error',
        name: name ?? error.name,
        message: error.message,
        stack: error.stack,
        cause: error.cause,
      },
      'civitai-prod'
    ).catch();
  else console.error(error);
}

export async function sleep(timeout: number) {
  return new Promise((resolve) => setTimeout(resolve, timeout));
}

export function withRetries<T>(
  fn: () => Promise<T>,
  retries = 3,
  retryTimeout?: number
): Promise<T> {
  return fn().catch((error: Error) => {
    if (retries > 0) {
      if (retryTimeout) {
        return sleep(retryTimeout).then(() => {
          return withRetries(fn, retries - 1, retryTimeout);
        });
      }
      return withRetries(fn, retries - 1);
    } else {
      throw error;
    }
  });
}

/**
 * Extracts the relative path from a stack trace file path.
 * Handles both /app/.next/... and .../_next/... formats.
 */
function extractNextPath(filePath: string): string | null {
  // Handle /app/.next/server/chunks/123.js format
  const appNextMatch = filePath.match(/\.next\/(.+)$/);
  if (appNextMatch) return appNextMatch[1];

  // Handle /_next/... format (URLs)
  const underscoreNextMatch = filePath.match(/_next\/(.+)$/);
  if (underscoreNextMatch) return underscoreNextMatch[1];

  return null;
}

/**
 * Applies source maps to a minified stack trace to get original source locations.
 * Only works in production where source maps are available in the .next directory.
 * @param stack - The minified stack trace string
 * @returns The stack trace with original source locations
 */
export async function applySourceMaps(stack: string): Promise<string> {
  try {
    const parsedStack = parseStackTrace(stack);
    const lines = stack.split('\n');

    // Build a map of relative paths to their source map consumers
    const sourceMapConsumers = new Map<string, SourceMapConsumer>();
    const filesToProcess = [...new Set(parsedStack.map((x) => x.file).filter(Boolean))] as string[];

    for (const file of filesToProcess) {
      const relativePath = extractNextPath(file);
      if (!relativePath) continue;

      const sourceMapPath = path.join(process.cwd(), '.next', `${relativePath}.map`);

      if (!fs.existsSync(sourceMapPath)) continue;

      try {
        const sourceMapContent = fs.readFileSync(sourceMapPath, 'utf-8');
        if (sourceMapContent) {
          const smc = await new SourceMapConsumer(sourceMapContent);
          sourceMapConsumers.set(file, smc);
        }
      } catch {
        // Skip files where source map can't be read
      }
    }

    // Apply source maps to each stack frame
    for (const frame of parsedStack) {
      const { methodName, lineNumber, column, file } = frame;
      if (!file || lineNumber == null || column == null) continue;

      const smc = sourceMapConsumers.get(file);
      if (!smc) continue;

      const pos = smc.originalPositionFor({ line: lineNumber, column });
      if (pos && pos.line != null && pos.source != null) {
        const name = pos.name || methodName || '<anonymous>';
        const lineIndex = lines.findIndex((x) => x.includes(file) && x.includes(`:${lineNumber}:`));
        if (lineIndex > -1) {
          const displayName = name !== '<unknown>' ? name : '';
          lines[lineIndex] = `    at ${displayName} (${pos.source}:${pos.line}:${pos.column ?? 0})`;
        }
      }
    }

    // Clean up source map consumers
    for (const smc of sourceMapConsumers.values()) {
      smc.destroy();
    }

    return lines.join('\n');
  } catch {
    // If source map parsing fails, return the original stack
    return stack;
  }
}
