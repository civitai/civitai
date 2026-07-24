import crypto from "crypto";

interface PresignOptions {
  method?: "GET" | "PUT" | "DELETE";
  region?: string;
  host?: string; // e.g., "nyc3.digitaloceanspaces.com"
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresIn?: number; // seconds
}

/**
 * Generate a pre-signed URL for a DigitalOcean Space (S3-compatible)
 * without any external dependencies.
 */
export function getPresignedUrl({
  method = "GET",
  region = "us-east-1",
  host = "sfo3.digitaloceanspaces.com",
  bucket,
  key,
  accessKeyId,
  secretAccessKey,
  expiresIn = 300,
}: PresignOptions): string {
  const service = "s3";
  const algorithm = "AWS4-HMAC-SHA256";

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // e.g. 20251029T210355Z
  const dateStamp = amzDate.slice(0, 8); // YYYYMMDD

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const credential = `${accessKeyId}/${credentialScope}`;
  const hostHeader = `${bucket}.${host}`;
  const canonicalUri = `/${encodeURIComponent(key)}`;

  const queryParams = [
    `X-Amz-Algorithm=${algorithm}`,
    `X-Amz-Credential=${encodeURIComponent(credential)}`,
    `X-Amz-Date=${amzDate}`,
    `X-Amz-Expires=${expiresIn}`,
    `X-Amz-SignedHeaders=host`,
  ].join("&");

  const canonicalHeaders = `host:${hostHeader}\n`;
  const signedHeaders = "host";
  const payloadHash = "UNSIGNED-PAYLOAD";

  const canonicalRequest = [
    method,
    canonicalUri,
    queryParams,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const hashedRequest = crypto.createHash("sha256").update(canonicalRequest).digest("hex");
  const stringToSign = [algorithm, amzDate, credentialScope, hashedRequest].join("\n");

  // Derive signing key
  const kDate = crypto
    .createHmac("sha256", "AWS4" + secretAccessKey)
    .update(dateStamp)
    .digest();
  const kRegion = crypto.createHmac("sha256", kDate).update(region).digest();
  const kService = crypto.createHmac("sha256", kRegion).update(service).digest();
  const kSigning = crypto.createHmac("sha256", kService).update("aws4_request").digest();

  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  const url = `https://${hostHeader}${canonicalUri}?${queryParams}&X-Amz-Signature=${signature}`;
  return url;
}

// Example usage
  const url = getPresignedUrl({
    method: "GET",
    bucket: "civitai-media-uploads",
    key: "00000031-9449-4446-bde5-1bb624946aa9",
    accessKeyId: "DO801KQ497UZQQ6QQ4WL",
    secretAccessKey: "QHLd9wax61+cMcA9m+llDlRkhuddA9672k2r3GAmUZM",
    host: "sfo3.digitaloceanspaces.com",
  });

  console.log("Presigned URL:", url);
