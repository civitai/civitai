/**
 * Stub for `@civitai/orchestration-client`, for tests that drive `generateFromGraph` / `whatIfFromGraph` to the
 * orchestrator submit. Use as `vi.mock('@civitai/orchestration-client', async () => (await import('./civitai-client.stub')).civitaiClientStub())`.
 */
export function civitaiClientStub() {
  // 🔴 EVERY name this repo imports from the package, stubbed.
  //
  // vitest validates each NAMED import against the mock and refuses the module
  // if one is missing — including names used only as types, which esbuild does
  // not always elide. A missing one DOES fail the run (`Test Files 1 failed`,
  // non-zero exit) — an earlier version of this comment wrongly said it did
  // not — but the `Tests` line reads `no tests`, which is uninformative: it is
  // a collection error, not an assertion failure, so nothing tells you WHICH
  // symbol is missing until you read the error above it. Hence an exhaustive
  // list rather than discovering them one error at a time.
  //
  // Regenerate with:
  //   grep -rhoP "import\s+(type\s+)?\{\K[^}]*(?=\}\s+from\s+'@civitai/orchestration-client')" src \
  //     | tr ',' '\n' | sed 's/type //; s/ as .*//' | tr -d ' ' | sort -u
  //
  // 🔴 A PROXY WAS TRIED FIRST AND HUNG collection indefinitely (a
  // self-referential `get` trap plus `has: () => true` defeats vitest's ESM
  // interop probing). Explicit is uglier and terminates.
  const stub = (() => undefined) as never;
  const names = `
    AceStepAudioInput AceStepAudioStepTemplate AiToolkitTrainingInput Air AssistantMessage
    AudioBlob AudioCaptioningStepTemplate BasicAnimationsBlobs Blob BuzzClientAccount
    ChatCompletionChoice ChatCompletionInput ChatCompletionOutput ChatCompletionStep
    ChatCompletionStepTemplate ComfyAnimaCreateImageGenInput
    ComfyBooguBaseCreateImageGenInput ComfyBooguEditImageInput ComfyBooguEditTurboImageInput
    ComfyBooguTurboCreateImageGenInput ComfyErnieStandardCreateImageGenInput
    ComfyErnieTurboCreateImageGenInput ComfyHiDreamO1CreateImageGenInput
    ComfyHiDreamO1DevCreateImageGenInput ComfyHiDreamO1DevEditImageGenInput
    ComfyHiDreamO1EditImageGenInput ComfyKrea2RawCreateImageGenInput
    ComfyKrea2TurboCreateImageGenInput ComfyLensNormalCreateImageGenInput
    ComfyLensTurboCreateImageGenInput ComfyLtx23CreateVideoInput ComfyLtx23EditVideoInput
    ComfyLtx23ExtendVideoInput ComfyLtx23FirstLastFrameToVideoInput
    ComfyLtx2CreateVideoInput ComfyLtx2FirstLastFrameToVideoInput
    ComfyMageFlow4bCreateImageGenInput ComfyMageFlow4bEditImageInput
    ComfyMageFlow4bEditTurboImageInput ComfyMageFlow4bTurboCreateImageGenInput ComfySampler
    ComfyScheduler ComfyStepTemplate ConsumerBlobPresignResponse ConvertImageOutput
    ConvertImageStep ConvertImageStepTemplate CustomComfyStepTemplate
    Flux1KontextMaxImageGenInput Flux1KontextProImageGenInput Flux2DevImageGenInput
    Flux2FlexImageGenInput Flux2KleinCreateImageInput Flux2KleinEditImageInput
    Flux2MaxImageGenInput Flux2ProImageGenInput FluxDevFastImageResourceTrainingInput
    Gemini25FlashCreateImageGenInput Gemini25FlashEditImageGenInput GetWorkflowData
    GetWorkflowStepData GrokCreateImageGenInput GrokEditImageGenInput GrokEditVideoInput
    GrokImageToVideoInput GrokTextToVideoInput GrokV15ImageToVideoInput
    GrokV15ReferenceToVideoInput GrokV15TextToVideoInput HappyHorseV11ImageToVideoInput
    HappyHorseV11ReferenceToVideoInput HappyHorseV11TextToVideoInput
    HappyHorseV1ImageToVideoInput HappyHorseV1ReferenceToVideoInput
    HappyHorseV1TextToVideoInput HappyHorseV1VideoEditInput
    Hunyuan3dImageTo3dComfyPolyGenInput HunyuanVdeoGenInput ImageBlob ImageGenInput
    ImageGenStepTemplate ImageJobControlNet ImageJobNetworkParams
    ImageResourceTrainingOutput ImageResourceTrainingStep ImageResourceTrainingStepTemplate
    ImageTransformer Imagen4ImageGenInput JsonPatchFactory KlingModel KlingV3VideoGenInput
    KlingVideoGenInput KohyaImageResourceTrainingInput Krea2FalImageGenInput
    Krea2StyleReference MaiImageCreateFalImageGenInput MaiImageEditFalImageGenInput
    MediaCaptioningStepTemplate MediaHashStep MediaHashStepTemplate MediaRatingOutput
    MeshyImageTo3dFalPolyGenInput MeshyTextTo3dFalPolyGenInput
    MeshyV7ImageTo3dFalPolyGenInput MeshyV7MultiImageTo3dFalPolyGenInput MiniMaxH3VideoGenInput
    MochiVideoGenInput Model3dBlob MusubiImageResourceTrainingInput NanoBanana2ImageGenInput
    NanoBanana2LiteImageGenInput NanoBananaProImageGenInput NsfwLevel
    OpenAiGpt15CreateImageInput OpenAiGpt15EditImageInput OpenAiGpt1CreateImageInput
    OpenAiGpt1EditImageInput OpenAiGpt1ImageGenInput OpenAiGpt2CreateImageInput
    OpenAiGpt2EditImageInput Options PolyGenOutput PolyGenStep PolyGenStepTemplate
    PreprocessImageInput PreprocessImageStepTemplate Priority PromptEnhancementInput
    PromptEnhancementOutput PromptEnhancementStep PromptEnhancementStepTemplate
    Qwen20bCreateImageGenInput Qwen20bEditImageGenInput Qwen2CreateFalImageGenInput
    Qwen2EditFalImageGenInput ResizeTransform ResourceInfo ReveCreateFalImageGenInput
    ReveEditFalImageGenInput Scheduler Sd1AiToolkitTrainingInput SdCppSampleMethod
    SdCppSchedule SdxlAiToolkitTrainingInput SeedanceVideoGenInput SeedreamImageGenInput
    SeedreamVersion Sora2ImageToVideoInput Sora2TextToVideoInput SubmitWorkflowData
    TextToImageStep TextToImageStepTemplate TrainingOutput TrainingStep TrainingStepTemplate
    TransactionInfo TransactionType Trellis2ImageTo3dComfyPolyGenInput
    TripoFalPolyGenInput UpdateWorkflowRequest
    Veo3VideoGenInput VideoBlob VideoEnhancementInput VideoEnhancementStepTemplate
    VideoGenStepTemplate VideoInterpolationStepTemplate VideoUpscalerStepTemplate
    ViduQ3VideoGenInput ViduVideoGenInput Wan21CivitaiVideoGenInput
    Wan225bFalImageToVideoInput Wan225bFalTextToVideoInput Wan22ComfyVideoGenInput
    Wan22FalImageToVideoInput Wan22FalTextToVideoInput Wan25FalImageToVideoInput
    Wan25FalTextToVideoInput Wan27FalEditVideoInput Wan27FalImageEditInput
    Wan27FalImageToVideoInput Wan27FalReferenceToVideoInput Wan27FalTextToImageInput
    Wan27FalTextToVideoInput WdTaggingStepTemplate Workflow WorkflowCallback WorkflowCost
    WorkflowEvent WorkflowStatus WorkflowStep WorkflowStepEvent WorkflowStepJobQueuePosition
    WorkflowStepTemplate WorkflowTemplate XGuardLabelResult XGuardModerationOutput
    XGuardModerationStep XGuardModerationStepTemplate ZImageBaseCreateImageGenInput
    ZImageTurboCreateImageGenInput ZipTrainingData addWorkflowTag applyPatch
    createCivitaiClient deleteWorkflow getConsumerBlobUploadUrl getResource getWorkflow
    getWorkflowStep handleError invokeImageUploadStepTemplate
    invokeVideoEnhancementStepTemplate invokeVideoMetadataStepTemplate patchWorkflow
    patchWorkflowStep queryWorkflows refreshBlob removeWorkflowTag submitWorkflow
    updateWorkflow updateWorkflowStep
  `
    .split(/\s+/)
    .filter(Boolean);
  const mod: Record<string, unknown> = Object.fromEntries(names.map((n) => [n, stub]));
  // The only export actually CONSTRUCTED by the code under test:
  // `new TimeSpan(0, 20, 0)` then `.addMinutes(n)` then `.toString([...])`,
  // used to compute a submit timeout. Nothing here asserts on the value.
  mod.TimeSpan = class {
    constructor(public h = 0, public m = 0, public s = 0) {}
    addMinutes(n: number) {
      this.m += n;
      return this;
    }
    toString() {
      return `${this.h}:${this.m}:${this.s}`;
    }
  };
  return mod;
}
