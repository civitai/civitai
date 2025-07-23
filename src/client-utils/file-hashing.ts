import jsSHA from 'jssha';

const SIZE_1_GB = 1000 * 1024 * 1024; // 1 GB

const computeSHA256 = async (file: File, onProgress?: (progress: number) => void) => {
  // Read the file as an ArrayBuffer
  const fileBuffer = await file.arrayBuffer();

  // Compute the hash
  const hashArrayBuffer = await crypto.subtle.digest('SHA-256', fileBuffer);

  // Convert hash to hexadecimal
  const hashArray = Array.from(new Uint8Array(hashArrayBuffer));
  const hashHex = hashArray.map((byte) => byte.toString(16).padStart(2, '0')).join('');

  if (onProgress) onProgress(100); // Call progress callback with 100% when done

  return hashHex;
};

const computeSHA256jsSHA = async (file: File, onProgress?: (progress: number) => void) => {
  const reader = file.stream().getReader();
  const shaObj = new jsSHA('SHA-256', 'ARRAYBUFFER');

  try {
    let totalBytesRead = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // value is a Uint8Array containing the actual data read
      if (value && value.byteLength > 0) {
        shaObj.update(value);
        totalBytesRead += value.byteLength;

        // Call progress callback if provided
        if (onProgress) {
          const progress = Math.round((totalBytesRead / file.size) * 100);
          onProgress(progress);
        }

        // Allow other tasks to run by yielding control
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    return shaObj.getHash('HEX');
  } catch (error) {
    throw error;
  } finally {
    reader.releaseLock();
  }
};

export const getFilesHash = (
  files: File[],
  onProgress?: (fileIndex: number, progress: number) => void
) => {
  return Promise.all(
    files.map((file, index) => {
      const progressCallback = onProgress
        ? (progress: number) => onProgress(index, progress)
        : undefined;

      const hashFn = file.size < SIZE_1_GB ? computeSHA256 : computeSHA256jsSHA;
      return hashFn(file, progressCallback);
    })
  );
};
