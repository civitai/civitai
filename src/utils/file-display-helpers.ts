/**
 * Helper functions for displaying model file information
 * Used by DownloadVariantDropdown and RequiredComponentsSection
 */

/**
 * Metadata shape expected for file display functions
 */
interface FileMetadata {
  fp?: string | null;
  quantType?: string | null;
  format?: string | null;
  size?: string | null;
}

/**
 * Minimal file shape for display functions
 */
export interface FileForDisplay {
  metadata?: FileMetadata | null;
}

/**
 * Get a short label for a file variant (e.g., "fp16", "Q4_K_M", "Pruned")
 */
export function getFileLabel(file: FileForDisplay): string {
  const { fp, quantType, format, size } = file.metadata ?? {};

  // For GGUF files, show quant type
  if (format === 'GGUF' && quantType) {
    return quantType;
  }

  // For SafeTensor and others, show fp precision
  if (fp) {
    return fp;
  }

  // Fallback to size
  if (size) {
    return size === 'pruned' ? 'Pruned' : 'Full';
  }

  return 'Standard';
}

/**
 * Get a human-readable description for a file variant
 */
export function getFileDescription(file: FileForDisplay): string {
  const { fp, quantType, format, size } = file.metadata ?? {};

  const parts: string[] = [];

  if (format === 'GGUF') {
    if (quantType === 'Q8_0') parts.push('8-bit GGUF, highest quality');
    else if (quantType === 'Q6_K') parts.push('6-bit GGUF, high quality');
    else if (quantType === 'Q5_K_M') parts.push('5-bit GGUF, balanced');
    else if (quantType === 'Q4_K_M') parts.push('4-bit GGUF, smaller file');
    else if (quantType === 'Q4_K_S') parts.push('4-bit small GGUF');
    else if (quantType === 'Q3_K_M') parts.push('3-bit GGUF, compact');
    else if (quantType === 'Q2_K') parts.push('2-bit GGUF, smallest');
    else if (quantType) parts.push(`${quantType} quantization`);
  } else {
    if (fp === 'fp32') parts.push('Full precision, largest file');
    else if (fp === 'fp16') parts.push('Half precision, best balance');
    else if (fp === 'bf16') parts.push('Brain float, good balance');
    else if (fp === 'fp8') parts.push('8-bit, smaller file');
    else if (fp === 'nf4') parts.push('4-bit normalized');
    else if (fp) parts.push(`${fp} precision`);
  }

  if (size === 'pruned') {
    parts.push(parts.length ? '(pruned)' : 'Pruned model');
  }

  return parts.join(' ') || 'Standard variant';
}
