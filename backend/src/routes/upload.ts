import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import mime from 'mime-types';
import ExifReader from 'exifreader';
import { prisma } from '../index';

import { extractTextFromImage, isValidSampleCode } from '../services/gemini';
import { extractImagesFromZip, isValidZipFile, getExtractionEstimate } from '../services/zipExtractor';
import { autoGroupImages } from '../services/grouping';
import pLimit from 'p-limit';

const router = express.Router();

// Rate limiting for parallel processing - reduced to prevent API rate limits
const geminiLimit = pLimit(20); // 3 concurrent Gemini requests (conservative)

// Use OS temp directory + app-specific folder to avoid bloating codebase
const TEMP_DIR = path.join(os.tmpdir(), 'ocr-auto-label');
const UPLOADS_DIR = path.join(TEMP_DIR, 'uploads');
const THUMBNAILS_DIR = path.join(TEMP_DIR, 'thumbnails');

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept JPEG, PNG, HEIC formats and ZIP files
    const allowedTypes = ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'application/zip', 'application/x-zip-compressed'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, HEIC, and ZIP files are allowed.'));
    }
  },
});

// Ensure directories exist
async function ensureDirectories() {
  const dirs = [TEMP_DIR, UPLOADS_DIR, THUMBNAILS_DIR];

  for (const dir of dirs) {
    try {
      await fs.access(dir);
    } catch {
      await fs.mkdir(dir, { recursive: true });
    }
  }
  
  console.log(`📁 Files will be stored in: ${TEMP_DIR}`);
}

// Generate high-quality thumbnail using Sharp
async function generateThumbnail(buffer: Buffer, filename: string): Promise<string> {
  const fileExtension = path.extname(filename).toLowerCase();
  const baseName = filename.replace(/\.[^/.]+$/, '');
  
  // Use original format when possible, fallback to high-quality JPEG
  const isJpeg = ['.jpg', '.jpeg'].includes(fileExtension);
  const isPng = fileExtension === '.png';
  
  const thumbnailFilename = isPng 
    ? `thumb_${baseName}.png`
    : `thumb_${baseName}.jpg`;
    
  const thumbnailPath = path.join(THUMBNAILS_DIR, thumbnailFilename);

  const sharpInstance = sharp(buffer)
    .resize(400, 400, { 
      fit: 'inside', // Maintain aspect ratio, don't crop
      withoutEnlargement: true // Don't upscale small images
    });

  if (isPng) {
    // Keep PNG format with high quality
    await sharpInstance
      .png({ quality: 95, compressionLevel: 6 })
      .toFile(thumbnailPath);
  } else {
    // Use high-quality JPEG
    await sharpInstance
      .jpeg({ quality: 95, progressive: true })
      .toFile(thumbnailPath);
  }

  return `/thumbnails/${thumbnailFilename}`;
}

// Save file only (fast upload without processing)
async function saveFileOnly(file: Express.Multer.File, originalName?: string, originalTimestamp?: number): Promise<any> {
  const fileExtension = mime.extension(file.mimetype) || 'jpg';
  const uniqueFilename = `${uuidv4()}.${fileExtension}`;
  const filePath = path.join(UPLOADS_DIR, uniqueFilename);

  // Save original file first
  await fs.writeFile(filePath, file.buffer);

  // Get the actual file creation date
  let captureDate = new Date(); // fallback to current time
  let dateSource = 'fallback';
  
  try {
    // First try to use the original timestamp from the browser (File.lastModified)
    if (originalTimestamp && originalTimestamp > 0) {
      captureDate = new Date(originalTimestamp);
      dateSource = 'browser_lastModified';
      console.log(`📅 Using browser original timestamp: ${captureDate.toISOString()}`);
    } else {
      // Fallback to file system metadata
      const stats = await fs.stat(filePath);
      
      if (stats.birthtime && stats.birthtime.getTime() > 0) {
        captureDate = stats.birthtime;
        dateSource = 'file_birthtime';
        console.log(`📅 Using file creation time: ${captureDate.toISOString()}`);
      } else if (stats.mtime) {
        captureDate = stats.mtime;
        dateSource = 'file_mtime';
        console.log(`📅 Using file modification time: ${captureDate.toISOString()}`);
      }
    }
    
    // Also try EXIF as secondary source for camera photos
    try {
      const tags = ExifReader.load(file.buffer);
      
      const dateFields = ['DateTimeOriginal', 'DateTime', 'DateTimeDigitized', 'CreateDate'];
      
      for (const field of dateFields) {
        if (tags[field] && tags[field].description) {
          const dateString = tags[field].description;
          const standardDateString = dateString.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
          const exifDate = new Date(standardDateString);
          
          const now = new Date();
          const minDate = new Date('1990-01-01');
          
          if (!isNaN(exifDate.getTime()) && exifDate <= now && exifDate >= minDate) {
            // Only use EXIF date if it's significantly different from current date (more than 1 hour)
            const timeDiff = Math.abs(exifDate.getTime() - captureDate.getTime());
            if (timeDiff > 3600000) { // 1 hour in milliseconds
              captureDate = exifDate;
              dateSource = `exif_${field}`;
              console.log(`📅 Using EXIF ${field} instead: ${captureDate.toISOString()}`);
            }
            break;
          }
        }
      }
    } catch (exifError) {
      // EXIF parsing failed, but we already have a date
      console.log(`⚠️ EXIF parsing failed, using ${dateSource} date`);
    }
    
    console.log(`📅 Final capture date for ${originalName || file.originalname}: ${captureDate.toISOString()} (source: ${dateSource})`);
    
  } catch (error) {
    console.warn(`⚠️ Could not extract date for ${originalName || file.originalname}:`, error);
    console.log(`📅 Using fallback date: ${captureDate.toISOString()}`);
  }

  // Create thumbnail quickly
  const thumbnailFilename = `thumb_${uniqueFilename}`;
  const thumbnailPath = path.join(THUMBNAILS_DIR, thumbnailFilename);

  try {
    await sharp(file.buffer)
      .resize(400, 400, { 
        fit: 'inside',
        withoutEnlargement: true 
      })
      .jpeg({ quality: 95 })
      .toFile(thumbnailPath);
  } catch (error) {
    console.error(`Failed to create thumbnail for ${file.originalname}:`, error);
  }

  // Save to database with pending Gemini status
  const image = await prisma.image.create({
    data: {
      originalName: originalName || file.originalname,
      newName: '', // Will be set later during processing
      filePath: filePath,
      thumbnailPath: thumbnailPath,
      fileSize: file.size,
      timestamp: captureDate,
      group: '', // Will be set later during processing
      geminiStatus: 'pending',
      code: null,
      otherText: null,
      objectDesc: null,
      objectColors: null,
      geminiConfidence: 0,
      groupingStatus: 'pending',
      groupingConfidence: 0,
    },
  });

  return {
    id: image.id,
    originalName: image.originalName,
    newName: image.newName,
    group: image.group,
    filePath: image.filePath,
    thumbnailPath: image.thumbnailPath,
    fileSize: image.fileSize,
    timestamp: image.timestamp,
    geminiStatus: image.geminiStatus,
    code: image.code,
    otherText: image.otherText,
    objectDesc: image.objectDesc,
    objectColors: image.objectColors,
    geminiConfidence: image.geminiConfidence,
    groupingStatus: image.groupingStatus,
    groupingConfidence: image.groupingConfidence,
    createdAt: image.createdAt,
    updatedAt: image.updatedAt,
  };
}

// POST /api/upload - Handle multiple file uploads (fast upload, no processing)
router.post('/', upload.array('files'), async (req, res) => {
  try {
    await ensureDirectories();

    if (!req.files || !Array.isArray(req.files) || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    // Clean up old data before processing new uploads
    console.log('🧹 Cleaning up old data...');
    await cleanupOldData();

    console.log(`📤 Processing ${req.files.length} files...`);
    
    // Get original file timestamps from form data if available
    const originalTimestamps = req.body.originalTimestamps ? JSON.parse(req.body.originalTimestamps) : [];
    
    // Process files quickly - just save and create records
    const uploadPromises = req.files.map((file, index) => 
      saveFileOnly(file, undefined, originalTimestamps[index])
    );

    const uploadedImages = await Promise.all(uploadPromises);

    console.log(`✅ Successfully uploaded ${uploadedImages.length} files`);

    // Start Gemini processing after successful upload
    console.log('🚀 Starting Gemini processing...');
    startGeminiProcessing(uploadedImages.map(img => img.id));

    return res.json({
      message: `Successfully uploaded ${uploadedImages.length} of ${req.files.length} files`,
      images: uploadedImages,
    });

  } catch (error) {
    console.error('Upload error:', error);
    return res.status(500).json({ error: 'Failed to upload files' });
  }
});



// Function to clean up old data and files
async function cleanupOldData() {
  try {
    // Delete all records from database
    await prisma.image.deleteMany({});
    
    // Clean up physical files
    try {
      const uploadFiles = await fs.readdir(UPLOADS_DIR);
      for (const file of uploadFiles) {
        await fs.unlink(path.join(UPLOADS_DIR, file));
      }
    } catch (error) {
      // Directory might not exist or be empty
    }
    
    try {
      const thumbnailFiles = await fs.readdir(THUMBNAILS_DIR);
      for (const file of thumbnailFiles) {
        await fs.unlink(path.join(THUMBNAILS_DIR, file));
      }
    } catch (error) {
      // Directory might not exist or be empty
    }
    
    console.log('✅ Old data cleaned up successfully');
  } catch (error) {
    console.error('❌ Cleanup failed:', error);
    // Don't throw - continue with upload even if cleanup fails
  }
}

// Sanitize filename to be filesystem-safe
function sanitizeFileName(name: string): string {
  return name
    .trim()
    // Replace spaces with underscores
    .replace(/\s+/g, '_')
    // Remove or replace problematic characters
    .replace(/[<>:"/\\|?*]/g, '')
    // Replace multiple consecutive underscores with single underscore
    .replace(/_+/g, '_')
    // Remove leading/trailing underscores
    .replace(/^_+|_+$/g, '')
    // Ensure we don't end up with an empty string
    || 'untitled';
}

// Generate smart filename based on group and existing files
export async function generateSmartFilename(group: string, currentImageId: string, originalName: string): Promise<string> {
  const fileExtension = path.extname(originalName);
  
  // Sanitize the group name for filesystem safety
  const sanitizedGroup = sanitizeFileName(group);
  
  // Get all images in this group (excluding current image)
  const existingImages = await prisma.image.findMany({
    where: { 
      group: group, // Keep original group for database query
      id: { not: currentImageId }
    },
    orderBy: { createdAt: 'asc' }
  });
  
  // Check if there's already an image with extracted code in this group
  const hasImageWithCode = existingImages.some(img => !!img.code);
  
  let baseName: string;
  
  if (existingImages.length === 0) {
    // First image in group - use SANITIZED_GROUP.ext
    baseName = `${sanitizedGroup}${fileExtension}`;
  } else if (hasImageWithCode) {
    // Group already has an image with extracted code - use SANITIZED_GROUP_X.ext
    baseName = `${sanitizedGroup}_${existingImages.length + 1}${fileExtension}`;
  } else {
    // Current image would be first with extracted code - use SANITIZED_GROUP.ext
    baseName = `${sanitizedGroup}${fileExtension}`;
  }
  
  // Ensure global uniqueness - check if this name already exists across ALL images
  let finalName = baseName;
  let counter = 1;
  
  while (true) {
    const existingImageWithName = await prisma.image.findFirst({
      where: {
        newName: finalName,
        id: { not: currentImageId }
      }
    });
    
    if (!existingImageWithName) {
      // Name is unique, we can use it
      break;
    }
    
    // Name exists, increment counter and try again
    counter++;
    const nameWithoutExt = baseName.replace(fileExtension, '');
    
    // If baseName already has a suffix (e.g., "test_2"), replace it with the new counter
    if (nameWithoutExt.includes('_')) {
      const baseWithoutSuffix = nameWithoutExt.substring(0, nameWithoutExt.lastIndexOf('_'));
      finalName = `${baseWithoutSuffix}_${counter}${fileExtension}`;
    } else {
      finalName = `${nameWithoutExt}_${counter}${fileExtension}`;
    }
  }
  
  return finalName;
}

// Start Gemini processing for uploaded images
async function startGeminiProcessing(imageIds: string[]) {
  console.log(`🚀 Starting Gemini processing for ${imageIds.length} images...`);
  
  // Process all images in parallel with Gemini
  const processingPromises = imageIds.map(imageId => {
    return geminiLimit(() => processGeminiForImage(imageId));
  });

  try {
    await Promise.all(processingPromises);
    console.log('✅ All Gemini processing completed');
    
    // Start auto-grouping for images without codes
    console.log('🔗 Starting auto-grouping process...');
    await autoGroupImages();
    console.log('✅ Auto-grouping completed');
    
  } catch (error) {
    console.error('❌ Error in Gemini processing:', error);
  }
}

// Process Gemini OCR for a specific image
export async function processGeminiForImage(imageId: string): Promise<void> {
  try {
    // Get image from database
    const image = await prisma.image.findUnique({
      where: { id: imageId }
    });

    if (!image) {
      console.error(`Image ${imageId} not found`);
      return;
    }

    // Update status to extracting
    await prisma.image.update({
      where: { id: imageId },
      data: { 
        geminiStatus: 'processing',
        status: 'extracting'
      }
    });

    // Broadcast processing status update
    broadcastGeminiUpdate(imageId, { 
      geminiStatus: 'processing',
      status: 'extracting'
    });

    console.log(`🧠 Processing Gemini OCR for ${image.originalName}...`);

    // Extract text using Gemini
    const geminiResult = await extractTextFromImage(image.filePath);

    // Determine appropriate status and data based on results
    let newStatus: string;
    let newName = image.newName || ''; // Keep blank if no name was previously set
    let group = image.group || ''; // Keep existing group if it exists
    let groupingStatus = image.groupingStatus;
    let groupingConfidence = image.groupingConfidence;

    if (geminiResult.code) {
      // Code was found - check if it's valid
      if (isValidSampleCode(geminiResult.code)) {
        // Valid code found
        newStatus = 'extracted';
        group = geminiResult.code;
        groupingStatus = 'complete';
        groupingConfidence = 1.0;
        newName = await generateSmartFilename(group, imageId, image.originalName);
        console.log(`✅ Valid code extracted: ${geminiResult.code}`);
      } else {
        // Invalid code found
        newStatus = 'invalid_group';
        group = geminiResult.code;
        newName = await generateSmartFilename(group, imageId, image.originalName);
        console.log(`⚠️ Invalid code structure: ${geminiResult.code}`);
      }
    } else {
      // No code found - will need grouping
      newStatus = 'pending_grouping';
      console.log(`🔍 No code found, will need grouping`);
    }

    // Update database with results
    await prisma.image.update({
      where: { id: imageId },
      data: {
        geminiStatus: 'complete',
        status: newStatus,
        code: geminiResult.code,
        otherText: geminiResult.otherText,
        objectDesc: geminiResult.objectDesc,
        objectColors: geminiResult.objectColors ? JSON.stringify(geminiResult.objectColors) : null,
        geminiConfidence: geminiResult.confidence,
        newName: newName,
        group: group,
        groupingStatus: groupingStatus,
        groupingConfidence: groupingConfidence,
      }
    });

    // Broadcast completion update
    broadcastGeminiUpdate(imageId, {
      geminiStatus: 'complete',
      status: newStatus,
      code: geminiResult.code,
      otherText: geminiResult.otherText,
      objectDesc: geminiResult.objectDesc,
      objectColors: geminiResult.objectColors ? JSON.stringify(geminiResult.objectColors) : null,
      geminiConfidence: geminiResult.confidence,
      newName: newName,
      group: group,
      groupingStatus: groupingStatus,
      groupingConfidence: groupingConfidence,
    });

    console.log(`✅ Gemini OCR completed for ${image.originalName} - Status: ${newStatus}`);

  } catch (error) {
    console.error(`Failed to process Gemini OCR for image ${imageId}:`, error);
    
    // Update status to error/pending
    await prisma.image.update({
      where: { id: imageId },
      data: { 
        geminiStatus: 'error',
        status: 'pending'
      }
    });

    // Broadcast error update
    broadcastGeminiUpdate(imageId, { 
      geminiStatus: 'error',
      status: 'pending'
    });
  }
}

// Function to broadcast Gemini updates to all connected clients
export function broadcastGeminiUpdate(imageId: string, updates: any) {
  const data = JSON.stringify({
    type: 'gemini_update',
    imageId,
    updates
  });

  sseClients.forEach((client) => {
    try {
      client.write(`data: ${data}\n\n`);
      if (client.flush) {
        try {
          client.flush();
        } catch (_) {
          // Ignore flush errors
        }
      }
    } catch (error) {
      // Client disconnected, will be cleaned up by event handlers
    }
  });
}

// POST /api/upload/cleanup - Manual cleanup endpoint
router.post('/cleanup', async (req, res) => {
  try {
    await cleanupOldData();
    return res.json({ message: 'Cleanup completed successfully' });
  } catch (error) {
    console.error('Cleanup error:', error);
    return res.status(500).json({ error: 'Failed to cleanup data' });
  }
});

// POST /api/upload/folder - Handle folder upload (files with path info)
router.post('/folder', upload.array('files'), async (req, res) => {
  try {
    await ensureDirectories();

    if (!req.files || !Array.isArray(req.files) || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    // Get file paths from form data if available
    const filePaths = req.body.filePaths ? JSON.parse(req.body.filePaths) : [];

    console.log(`📤 Processing ${req.files.length} files from folder...`);

    // Process files quickly - just save and create records
    const uploadPromises = req.files.map((file, index) => {
      const relativePath = filePaths[index] || file.originalname;
      return saveFileOnly(file, relativePath);
    });

    const uploadedImages = await Promise.all(uploadPromises);

    // Sort by timestamp for chronological order
    uploadedImages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    console.log(`✅ Successfully processed ${uploadedImages.length} files from folder`);

    // Start Gemini processing after successful upload
    console.log('🚀 Starting Gemini processing...');
    startGeminiProcessing(uploadedImages.map(img => img.id));

    return res.json({
      message: `Successfully uploaded ${uploadedImages.length} of ${req.files.length} files`,
      images: uploadedImages,
    });

  } catch (error) {
    console.error('Folder upload error:', error);
    return res.status(500).json({ error: 'Failed to upload folder' });
  }
});

// GET /api/upload/progress - Server-Sent Events for real-time Gemini processing updates
router.get('/progress', (req, res) => {
  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  // Send initial connection message
  res.write('data: {"type":"connected"}\n\n');

  // Store this connection for sending updates
  const clientId = Date.now();
  sseClients.set(clientId, res);

  // Clean up when client disconnects
  req.on('close', () => {
    sseClients.delete(clientId);
  });

  req.on('aborted', () => {
    sseClients.delete(clientId);
  });
});

// POST /api/upload/zip - Handle ZIP file upload and extract images
router.post('/zip', upload.single('file'), async (req, res) => {
  try {
    await ensureDirectories();

    if (!req.file) {
      return res.status(400).json({ error: 'No ZIP file uploaded' });
    }

    console.log(`📦 Processing ZIP file: ${req.file.originalname} (${req.file.size} bytes)`);

    // Validate that it's actually a ZIP file
    if (!isValidZipFile(req.file.buffer)) {
      return res.status(400).json({ error: 'Invalid ZIP file format' });
    }

    // Clean up old data before processing new uploads
    console.log('🧹 Cleaning up old data...');
    await cleanupOldData();

    // Get extraction time estimate
    const estimatedSeconds = getExtractionEstimate(req.file.size);
    console.log(`📊 Estimated extraction time: ${estimatedSeconds} seconds`);

    // Extract images from ZIP
    console.log('📦 Extracting images from ZIP file...');
    const extractedFiles = await extractImagesFromZip(req.file.buffer);

    if (extractedFiles.length === 0) {
      return res.status(400).json({ error: 'No supported image files found in ZIP archive' });
    }

    console.log(`📸 Found ${extractedFiles.length} images in ZIP file`);

    // Process extracted images - create mock Express.Multer.File objects
    const uploadPromises = extractedFiles.map(async (extractedFile) => {
      // Create a mock multer file object from the extracted data
      const mockFile: Express.Multer.File = {
        fieldname: 'files',
        originalname: extractedFile.filename,
        encoding: '7bit',
        mimetype: 'image/jpeg', // Will be corrected by mime detection
        size: extractedFile.buffer.length,
        buffer: extractedFile.buffer,
        destination: '',
        filename: '',
        path: '',
        stream: null as any
      };

      // Use the existing saveFileOnly function but pass the relative path for organization
      return await saveFileOnly(
        mockFile, 
        extractedFile.relativePath, // Use full relative path from ZIP
        extractedFile.lastModified.getTime()
      );
    });

    const uploadedImages = await Promise.all(uploadPromises);

    // Sort by timestamp for chronological order
    uploadedImages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    console.log(`✅ Successfully extracted and processed ${uploadedImages.length} images from ZIP`);

    // Start Gemini processing after successful upload
    console.log('🚀 Starting Gemini processing...');
    startGeminiProcessing(uploadedImages.map(img => img.id));

    return res.json({
      message: `Successfully extracted ${uploadedImages.length} images from ZIP file`,
      images: uploadedImages,
      extractionTime: estimatedSeconds
    });

  } catch (error) {
    console.error('ZIP upload error:', error);
    
    // Provide more specific error messages
    let errorMessage = 'Failed to process ZIP file';
    if (error instanceof Error) {
      if (error.message.includes('Invalid ZIP file')) {
        errorMessage = 'Invalid or corrupted ZIP file';
      } else if (error.message.includes('No images found')) {
        errorMessage = 'No supported image files found in ZIP archive';
      } else {
        errorMessage = `ZIP processing failed: ${error.message}`;
      }
    }
    
    return res.status(500).json({ error: errorMessage });
  }
});

// Store active SSE connections
const sseClients = new Map<number, any>();



export default router; 