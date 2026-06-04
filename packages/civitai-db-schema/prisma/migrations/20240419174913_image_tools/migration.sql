-- CreateEnum
CREATE TYPE "ToolType" AS ENUM ('Image', 'Video','MotionCapture', 'Upscalers', 'Audio', 'Compute', 'GameEngines');

-- CreateTable
CREATE TABLE "Tool" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" "ToolType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Tool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImageTool" (
    "imageId" INTEGER NOT NULL,
    "toolId" INTEGER NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImageTool_pkey" PRIMARY KEY ("imageId","toolId")
);

-- CreateIndex
CREATE INDEX "ImageTool_toolId_idx" ON "ImageTool"("toolId");

-- AddForeignKey
ALTER TABLE "ImageTool" ADD CONSTRAINT "ImageTool_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageTool" ADD CONSTRAINT "ImageTool_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- INSERT INTO "Tool" ("name", "type")
-- VALUES
--   ('Gemini', 'Image'),
--   ('KREA', 'Image'),
--   ('Leonardo', 'Image'),
--   ('Adobe Firefly', 'Image')
--   ('Fable', 'Video'),
--   ('Lensgo', 'Video'),
--   ('Deforum Studio', 'Video'),
--   ('Kaiber', 'Video'),
--   ('EBSynth', 'Video'),
--   ('Domo', 'Video'),
--   ('Viggle', 'Video'),
--   ('MOVE AI', 'MotionCapture'),
--   ('Deep Motion', 'MotionCapture'),
--   ('Wonder Dynamics', 'MotionCapture'),
--   ('Rokoko', 'MotionCapture'),
--   ('Topaz Labs', 'Upscalers'),
--   ('Magnific', 'Upscalers'),
--   ('Udio', 'Audio'),
--   ('Stable Audio', 'Audio'),
--   ('Suno', 'Audio'),
--   ('ElevenLabs', 'Audio'),
--   ('Adobe Podcast ', 'Audio'),
--   ('ThinkDiffusion', 'Compute'),
--   ('RunPod', 'Compute'),
--   ('RunDiffusion', 'Compute'),
--   ('Brev', 'Compute'),
--   ('Unity', 'GameEngines'),
--   ('Unreal', 'GameEngines'),
--   ('Godot', 'GameEngines')
