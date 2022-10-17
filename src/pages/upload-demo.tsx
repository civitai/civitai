import { useState } from 'react';
import { useS3Upload } from '~/hooks/use-s3-upload';

export default function UploadTest() {
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const { FileInput, openFileDialog, uploadToS3, files } = useS3Upload();

  const handleFileChange = async (files: File[]) => {
    for (const file of files) {
      const { url } = await uploadToS3(file, 'image');
      setImageUrls((urls) => [...urls, url]);
    }
  };

  return (
    <div>
      <FileInput onChange={handleFileChange} multiple="true" accept="image/jpeg, image/png" />

      <button onClick={openFileDialog} type="button">
        Upload file
      </button>

      {imageUrls && imageUrls.map((url) => <img key={url} src={url} alt="Uploaded image" />)}

      <div>
        {files.map((file, index) => (
          <div key={index}>
            File #{index} progress: {file.progress}%
          </div>
        ))}
      </div>
    </div>
  );
}
