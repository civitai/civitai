// Regenerates the video fixtures: `node generate.mjs` from this directory (needs ffmpeg on PATH).
// Each file mirrors one ComfyUI save path:
//   vhs.mp4            VideoHelperSuite Video Combine: FFMETADATA file + use_metadata_tags (moov at end)
//   core-faststart.mp4 core SaveVideo mp4: PyAV metadata + use_metadata_tags+faststart
//   core.webm          core SaveWEBM / SaveVideo webm: Matroska global tags
//   core.mkv           core SaveVideo mkv
//   live-prompt.webm   streamed (unknown-size segment) with `prompt` only, as an API-queued run has
//   plain.mp4/.webm    no tags at all (encoder only)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const prompt = JSON.stringify(JSON.parse(readFileSync('prompt.json', 'utf8')));
const workflow = JSON.stringify(JSON.parse(readFileSync('workflow.json', 'utf8')));

const escapeFfmetadata = (value) => value.replace(/[\\;#=\n]/g, (c) => `\\${c}`);
writeFileSync(
  'ffmeta.txt',
  `;FFMETADATA1\nprompt=${escapeFfmetadata(prompt)}\nworkflow=${escapeFfmetadata(workflow)}\n`
);

const src = ['-f', 'lavfi', '-i', 'testsrc=size=16x16:rate=4:duration=0.75'];
const h264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'];
const tags = ['-metadata', `prompt=${prompt}`, '-metadata', `workflow=${workflow}`];
const ffmpeg = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);

ffmpeg(...src, '-i', 'ffmeta.txt', '-map', '0', '-map_metadata', '1', ...h264,
  '-movflags', 'use_metadata_tags', 'vhs.mp4');
ffmpeg(...src, ...h264, ...tags, '-movflags', 'use_metadata_tags+faststart', 'core-faststart.mp4');
ffmpeg(...src, '-c:v', 'libvpx-vp9', ...tags, 'core.webm');
ffmpeg(...src, ...h264, ...tags, 'core.mkv');
ffmpeg(...src, '-c:v', 'libvpx-vp9', '-metadata', `prompt=${prompt}`, '-live', '1', '-f', 'webm', 'live-prompt.webm');
ffmpeg(...src, ...h264, 'plain.mp4');
ffmpeg(...src, '-c:v', 'libvpx-vp9', 'plain.webm');
