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
import { extractColorPalette } from '../services/palette';

const router = express.Router();

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
    // Accept JPEG, PNG, HEIC formats
    const allowedTypes = ['image/jpeg', 'image/png', 'image/heic', 'image/heif'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, and HEIC files are allowed.'));
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

  // Save to database with pending palette status
  const image = await prisma.image.create({
    data: {
      originalName: originalName || file.originalname,
      newName: '', // Will be set later during processing
      filePath: filePath,
      thumbnailPath: thumbnailPath,
      fileSize: file.size,
      timestamp: captureDate,
      group: '', // Will be set later during processing
      paletteStatus: 'pending', // Mark as needing palette processing
      palette: null,
      paletteConfidence: 0,
      geminiStatus: 'pending',
      code: null,
      otherText: null,
      objectDesc: null,
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
    paletteStatus: image.paletteStatus,
    palette: image.palette,
    paletteConfidence: image.paletteConfidence,
    geminiStatus: image.geminiStatus,
    code: image.code,
    otherText: image.otherText,
    objectDesc: image.objectDesc,
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

    res.json({
      message: `Successfully uploaded ${uploadedImages.length} of ${req.files.length} files`,
      images: uploadedImages,
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload files' });
  }
});

// POST /api/upload/process-palettes - Process color palettes for uploaded images
router.post('/process-palettes', async (req, res) => {
  try {
    // Get all images that need palette processing
    const images = await prisma.image.findMany({
      where: {
        paletteStatus: 'pending'
      },
      orderBy: {
        timestamp: 'asc'
      }
    });

    if (images.length === 0) {
      return res.json({ message: 'No images need palette processing' });
    }

    console.log(`🎨 Starting palette processing for ${images.length} images...`);

    // Process in batches of 10 for optimal performance
    const batchSize = 10;
    let processedCount = 0;

    for (let i = 0; i < images.length; i += batchSize) {
      const batch = images.slice(i, i + batchSize);
      
      console.log(`🔄 Starting batch ${Math.floor(i/batchSize) + 1}: processing images ${i + 1}-${Math.min(i + batchSize, images.length)}`);
      
      // Process batch in parallel
      const batchPromises = batch.map(image => processPaletteForImage(image.id));
      await Promise.all(batchPromises);
      
      processedCount += batch.length;
      console.log(`✅ Completed batch ${Math.floor(i/batchSize) + 1}: ${processedCount}/${images.length} palettes done`);
      
      // Add a small delay between batches to allow UI updates
      if (i + batchSize < images.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    console.log(`✅ Completed palette processing for ${processedCount} images`);

    res.json({
      message: `Successfully processed palettes for ${processedCount} images`,
      processedCount
    });

  } catch (error) {
    console.error('Palette processing error:', error);
    res.status(500).json({ error: 'Failed to process palettes' });
  }
});

// Process palette for a specific image
async function processPaletteForImage(imageId: string): Promise<void> {
  try {
    // Get image from database
    const image = await prisma.image.findUnique({
      where: { id: imageId }
    });

    if (!image) {
      console.error(`Image ${imageId} not found`);
      return;
    }

    // Update status to processing
    await prisma.image.update({
      where: { id: imageId },
      data: { paletteStatus: 'processing' }
    });

    // Broadcast processing status update
    broadcastPaletteUpdate(imageId, { paletteStatus: 'processing' });

    console.log(`🎨 Extracting palette for ${image.originalName}...`);

    // Extract palette - read file from disk
    const fileBuffer = await fs.readFile(image.filePath);
    const paletteResult = await extractColorPalette(fileBuffer);

    // Update database with results
    const updatedImage = await prisma.image.update({
      where: { id: imageId },
      data: {
        paletteStatus: 'complete',
        palette: JSON.stringify(paletteResult.palette),
        paletteConfidence: paletteResult.confidence,
      }
    });

    // Broadcast completion update with palette data
    broadcastPaletteUpdate(imageId, {
      paletteStatus: 'complete',
      palette: JSON.stringify(paletteResult.palette),
      paletteConfidence: paletteResult.confidence,
    });

    console.log(`✅ Palette extracted for ${image.originalName}`);

  } catch (error) {
    console.error(`Failed to process palette for image ${imageId}:`, error);
    
    // Update status to error
    await prisma.image.update({
      where: { id: imageId },
      data: { paletteStatus: 'error' }
    });

    // Broadcast error update
    broadcastPaletteUpdate(imageId, { paletteStatus: 'error' });
  }
}

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

// POST /api/upload/cleanup - Manual cleanup endpoint
router.post('/cleanup', async (req, res) => {
  try {
    await cleanupOldData();
    res.json({ message: 'Cleanup completed successfully' });
  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({ error: 'Failed to cleanup data' });
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

    res.json({
      message: `Successfully uploaded ${uploadedImages.length} of ${req.files.length} files`,
      images: uploadedImages,
    });

  } catch (error) {
    console.error('Folder upload error:', error);
    res.status(500).json({ error: 'Failed to upload folder' });
  }
});

// GET /api/upload/palette-progress - Server-Sent Events for real-time palette updates
router.get('/palette-progress', (req, res) => {
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

// Store active SSE connections
const sseClients = new Map<number, any>();

// Function to broadcast palette updates to all connected clients
function broadcastPaletteUpdate(imageId: string, updates: any) {
  const data = JSON.stringify({
    type: 'palette_update',
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
          // Ignore flush errors (e.g., not supported)
        }
      }
    } catch (error) {
      // Client disconnected, will be cleaned up by event handlers
    }
  });
}

export default router; 