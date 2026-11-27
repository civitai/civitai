const WEIGHT_EXTENSIONS = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx)$/i;

/** Whether `path` names a model weights file, by extension. */
export function isWeightFile(path: string) {
  return WEIGHT_EXTENSIONS.test(path);
}
