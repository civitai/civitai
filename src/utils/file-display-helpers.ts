/**
 * Helper functions for displaying model file information
 * Used by DownloadVariantDropdown, RequiredComponentsSection, and file upload UI
 */

import {
  IconAdjustments,
  IconArrowsMaximize,
  IconBrain,
  IconCube,
  IconEye,
  IconFile3d,
  IconFileSettings,
  IconFileZip,
  IconPackage,
  IconPhotoScan,
  IconSettings,
  IconTopologyRing,
  IconTypography,
} from '@tabler/icons-react';

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
 * Icon/color config for component types — shared between sidebar and file upload UI
 */
export const componentTypeConfig: Record<
  ModelFileComponentType,
  { name: string; icon: typeof IconPhotoScan; color: string }
> = {
  Checkpoint: { name: 'Checkpoint', icon: IconCube, color: 'red' },
  VAE: { name: 'VAE', icon: IconPhotoScan, color: 'purple' },
  TextEncoder: { name: 'Text Encoder', icon: IconTypography, color: 'blue' },
  UNet: { name: 'UNet', icon: IconBrain, color: 'orange' },
  CLIPVision: { name: 'CLIP Vision', icon: IconEye, color: 'green' },
  ControlNet: { name: 'ControlNet', icon: IconAdjustments, color: 'cyan' },
  Upscaler: { name: 'Upscale Model', icon: IconArrowsMaximize, color: 'teal' },
  Workflow: { name: 'Workflow', icon: IconTopologyRing, color: 'indigo' },
  Config: { name: 'Config', icon: IconSettings, color: 'gray' },
  Other: { name: 'Other', icon: IconPackage, color: 'gray' },
};

/**
 * ComfyUI-friendly display labels for model file types.
 * Maps internal type values to user-facing names aligned with ComfyUI subfolder conventions.
 */
export const comfyFileTypeLabels: Record<string, string> = {
  'Text Encoder': 'CLIP / Text Encoder',
  UNet: 'UNet / Diffusion Model',
  CLIPVision: 'CLIP Vision',
  Workflow: 'Workflow',
  Upscaler: 'Upscale Model',
};

/**
 * Icon/color config for model file formats
 */
export const fileFormatConfig: Record<string, { icon: typeof IconFile3d; color: string }> = {
  SafeTensor: { icon: IconFile3d, color: 'blue' },
  GGUF: { icon: IconFile3d, color: 'green' },
  PickleTensor: { icon: IconFile3d, color: 'yellow' },
  Other: { icon: IconFile3d, color: 'gray' },
};

/**
 * Get icon/color for a file based on its extension and metadata
 */
export function getFileIconConfig(
  fileName: string,
  metadata?: { format?: string | null } | null
): { icon: typeof IconFile3d; color: string } {
  // ZIP files
  if (fileName.endsWith('.zip')) {
    return { icon: IconFileZip, color: 'yellow' };
  }

  // Check format from metadata
  const format = metadata?.format;
  if (format && format in fileFormatConfig) {
    return fileFormatConfig[format];
  }

  // Infer from extension
  if (fileName.endsWith('.safetensors')) {
    return fileFormatConfig.SafeTensor;
  }
  if (fileName.endsWith('.gguf')) {
    return fileFormatConfig.GGUF;
  }

  // Optional/misc files
  if (fileName.endsWith('.json')) {
    return { icon: IconFileSettings, color: 'gray' };
  }
  if (fileName.endsWith('.yaml') || fileName.endsWith('.yml')) {
    return { icon: IconSettings, color: 'gray' };
  }

  return fileFormatConfig.Other;
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
    else if (fp === 'bf16') parts.push('BF16, good balance');
    else if (fp === 'fp8') parts.push('8-bit, smaller file');
    else if (fp === 'nf4') parts.push('4-bit normalized');
    else if (fp) parts.push(`${fp} precision`);
  }

  if (size === 'pruned') {
    parts.push(parts.length ? '(pruned)' : 'Pruned model');
  }

  return parts.join(' ') || 'Standard variant';
}
