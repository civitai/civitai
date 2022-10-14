import { useState } from 'react';
import { useS3Upload } from '~/hooks/use-s3-upload';

export default function UploadTest() {
  const [imageUrl, setImageUrl] = useState<string>();
  const { FileInput, openFileDialog, uploadToS3 } = useS3Upload();

  const handleFileChange = async (file: File) => {
    const { url } = await uploadToS3(file);
    setImageUrl(url);
  };

  return (
    <div>
      <FileInput onChange={handleFileChange} />

      <button onClick={openFileDialog} type="button">
        Upload file
      </button>

      {imageUrl && <img src={imageUrl} />}
    </div>
  );
}
