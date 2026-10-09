/**
 * Hard cap on the bytes of any image the App Blocks image-upload path materialises: a fetched
 * workflow output, a user upload read back out of the store, or a `bytes` upload the page host
 * accepts from a block. One constant so the host never accepts a file the server then refuses.
 */
export const BLOCK_IMAGE_MAX_BYTES = 40 * 1024 * 1024;
