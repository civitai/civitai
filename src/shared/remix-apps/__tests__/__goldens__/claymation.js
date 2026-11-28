// remix-app-creator template v1
const SPEC = {"icon":"clay","engine":{"safe":{"ecosystem":"NanoBanana","versionId":3086021},"mature":{"ecosystem":"Qwen","versionId":2558804}},"asks":[],"steps":[{"kind":"image","prompt":"Recreate this image as a stop-motion claymation scene with plasticine figures. Don't add any text or lettering.","aspectRatio":"source","quantity":1,"input":"source"}]};
export default defineRemixApp({
  async run(ctx) {
    let images = [];
    ({ images } = await ctx.workflow({ kind: "image", prompt: "Recreate this image as a stop-motion claymation scene with plasticine figures. Don't add any text or lettering.", images: [ctx.source], aspectRatio: "source", quantity: 1 }));
    return images;
  },
});
