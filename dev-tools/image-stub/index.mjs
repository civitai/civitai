import { createServer } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const hostname = '127.0.0.1';
const port = 3000;
// Path to the folder containing your images
const imageDirectory = path.resolve('images');

const server = createServer(async (req, res) => {
  const widthMatch = req.url.match(/width=(\d+)/);
  if (!widthMatch) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Invalid URL format');
    return;
  }

  const width = widthMatch[1];

  try {
    // Get a random image from the directory  
    const imageId = extractImageId(req.url);
    const imagePath = getRandomImage(imageId);
    const resizedImage = await resizeImage(imagePath, width);

    res.setHeader('Content-Type', 'image/jpeg');
    res.end(resizedImage);
  }
  catch (error) {
    console.error('Error:', error);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Error generating image');
  }
});

server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});

// Helper function to extract the record ID from the URL path
function extractImageId(url) {
  const segments = url.split('/');
  if (segments.length < 3) {
    throw new Error(`Invalid URL format. Got ${segments}`);
  }

  return segments[1];
}

// Function to get a random image from the directory
function getRandomImage(imageId) {
  const imageIdHash = hashString(imageId);
  const files = readdirSync(imageDirectory);
  if (files.length === 0) {
    throw new Error('No images found in the directory');
  }
  // Map the hash to one of the images
  const index = imageIdHash % files.length;

  return path.join(imageDirectory, files[index]);
}

// Function to resize the image
async function resizeImage(imagePath, width) {
  // Read the image file as a buffer
  const imageBuffer = readFileSync(imagePath);

  // Resize the image using sharp
  const resizedImage = await sharp(imageBuffer)
    .resize({ width: parseInt(width, 10) })
    .toFormat('jpeg')
    .toBuffer();

  return resizedImage;
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash + str.charCodeAt(i)) % 10000; // Sum of character codes mod 10000
  }
  return hash;
}

