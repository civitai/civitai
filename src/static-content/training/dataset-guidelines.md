---
title: Civitai Dataset and Training Guidelines
description: In this document, we provide you with information about how to prepare and upload a dataset to us for the purpose of model training. 
---

In this document, we provide you with information about how to prepare and upload a dataset to us for the purpose of model training.

## Uploading an Existing Dataset (as a Zip file)
This section assumes that you have already created a dataset outside Civitai and are ready to use it for training a model.

### Accepted Files and Formats
If you elect to upload an existing dataset, then we ask that you provide the data in a zipped file (`.zip extension`). The file may include only images, or it may include images and text files which include captions. 

### Filename Convention
A directory should contain an image file with a name that matches the caption text file. These will be interpreted as a pair in training.

|          | Image File Name | Caption Text File Name |
|----------|-----------------|------------------------|
| Pair One | 1.jpg           | 1.txt                  |
| Pair Two | 2.jpg           | 2.txt                  |

**Accepted File Extensions**
For images, we accept any of the following image file extensions: `.png, .jpg, .jpeg`

For caption files, we only accept `.txt` file extensions. 

If you do not provide captions with your images, you would simply have images in your dataset's directory.

### Zipping Your Data
Important! If this step is not done correctly, we will not be able to parse your files correctly.

Typically, when you have a dataset created, you will have a directory structure that looks like the below:

![](https://hackmd.io/_uploads/r1iu09Tn3.png)

When you zip this data up, you should ***only select*** your image/caption file pairs. Do not include the parent folder when preparing the zip file.

![](https://hackmd.io/_uploads/SyCpo-ea2.png)



## Creating a New Dataset on Civitai
This section provides information on how to create a dataset on civitai.com

### Adding/Uploading Images
Images can be dragged and dropped to our uploader. These images can later be given captions (see "Providing Captions" below).

![](https://hackmd.io/_uploads/ByQwai8Th.png)


### Providing Captions
Captions are an important component of training a successful model. You can train models without them; however, your model will be more flexible and better overall when you do provide them. 

Great captions describe the content of the image on which they are written. There is a wealth of knowledge on the subject. See [this post](https://www.reddit.com/r/StableDiffusion/comments/118spz6/captioning_datasets_for_training_purposes) for in-depth info on captioning. 
