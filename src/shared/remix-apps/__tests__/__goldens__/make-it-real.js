// remix-app-creator template v1
const SPEC = {"icon":"camera","engine":{"safe":{"ecosystem":"NanoBanana","versionId":3086021},"mature":{"ecosystem":"Qwen","versionId":2558804}},"asks":[],"steps":[{"kind":"image","prompt":"Turn this image into a live-action photograph of the real person (or the real animal or object) shown, in the same outfit, pose and setting, as if shot on a DSLR in natural light: real skin, hair, fabric and materials, and real surroundings. Nothing may look drawn, painted or rendered, with no line art, no cel shading and no glossy anime eyes. Keep the pose, outfit and composition. Don't add any text or lettering.","aspectRatio":"source","quantity":1,"input":"source"}]};
export default defineRemixApp({
  async run(ctx) {
    let images = [];
    ({ images } = await ctx.workflow({ kind: "image", prompt: "Turn this image into a live-action photograph of the real person (or the real animal or object) shown, in the same outfit, pose and setting, as if shot on a DSLR in natural light: real skin, hair, fabric and materials, and real surroundings. Nothing may look drawn, painted or rendered, with no line art, no cel shading and no glossy anime eyes. Keep the pose, outfit and composition. Don't add any text or lettering.", images: [ctx.source], aspectRatio: "source", quantity: 1 }));
    return images;
  },
});
