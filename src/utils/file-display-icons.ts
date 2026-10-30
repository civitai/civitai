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

// Split out of `file-display-helpers` because these three exports are the only ones carrying icon
// COMPONENTS, and the rest of that file is pure file-type data that eight server modules import.

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
  DiffusionModel: { name: 'Diffusion Model', icon: IconBrain, color: 'orange' },
  CLIPVision: { name: 'CLIP Vision', icon: IconEye, color: 'green' },
  CLIP: { name: 'CLIP', icon: IconTypography, color: 'violet' },
  VisionLanguage: { name: 'VLM', icon: IconEye, color: 'grape' },
  ControlNet: { name: 'ControlNet', icon: IconAdjustments, color: 'cyan' },
  Upscaler: { name: 'Upscale Model', icon: IconArrowsMaximize, color: 'teal' },
  Workflow: { name: 'Workflow', icon: IconTopologyRing, color: 'indigo' },
  Config: { name: 'Config', icon: IconSettings, color: 'gray' },
  Other: { name: 'Other', icon: IconPackage, color: 'gray' },
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
