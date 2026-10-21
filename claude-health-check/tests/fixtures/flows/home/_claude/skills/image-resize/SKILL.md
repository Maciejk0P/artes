---
name: image-resize
description: Resizes the images of a folder to the widths a page needs. Use when the user asks to resize or optimise images.
---

# Image resize

1. Ask which folder holds the images.
2. If the folder holds no images, say so and stop.
3. Read the widths from `sizes.json`.
   - If the file is missing, ask the user for the widths.
   - Otherwise use the widths it lists.
4. When an image is narrower than the smallest width, skip it. Otherwise resize it to every width.
5. Unless the user asked for a dry run, write the resized files next to the originals.
6. Check the result.
   - If a file is larger than its original, keep the original and report it.
   - When every file is smaller, continue.
   - Note the total saved in the summary.
7. Print the summary.
