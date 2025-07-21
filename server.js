const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { v4: uuidv4 } = require('uuid');
const swaggerUi = require('swagger-ui-express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3005;

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Create temp directory
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fsSync.existsSync(TEMP_DIR)) {
    fsSync.mkdirSync(TEMP_DIR, { recursive: true });
}

// Serve static files from temp directory
app.use('/temp', express.static(TEMP_DIR));

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB per file
        files: 50 // Max 50 files per batch
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 
            'image/gif', 'image/bmp', 'image/tiff', 'image/svg+xml',
            'image/x-icon', 'image/vnd.microsoft.icon', 'image/avif'
        ];
        
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error(`Unsupported file type: ${file.mimetype}`), false);
        }
    }
});

// Cleanup function for temp files
const cleanupTempFiles = () => {
    const now = Date.now();
    const TEN_MINUTES = 10 * 60 * 1000; // 10 minutes in milliseconds
    
    try {
        const files = fsSync.readdirSync(TEMP_DIR);
        files.forEach(file => {
            const filePath = path.join(TEMP_DIR, file);
            const stats = fsSync.statSync(filePath);
            
            if (now - stats.mtime.getTime() > TEN_MINUTES) {
                fsSync.unlinkSync(filePath);
                console.log(`🗑️  Cleaned up expired temp file: ${file}`);
            }
        });
    } catch (error) {
        console.error('❌ Error during cleanup:', error.message);
    }
};

// Run cleanup every 5 minutes
setInterval(cleanupTempFiles, 5 * 60 * 1000);

// Utility functions
const getImageInfo = async (buffer) => {
    try {
        const metadata = await sharp(buffer).metadata();
        return {
            width: metadata.width,
            height: metadata.height,
            format: metadata.format,
            size: buffer.length,
            hasAlpha: metadata.hasAlpha || false,
            aspectRatio: metadata.width / metadata.height
        };
    } catch (error) {
        throw new Error(`Failed to get image info: ${error.message}`);
    }
};

const analyzeImageColors = async (buffer) => {
    try {
        const { dominant } = await sharp(buffer).stats();
        
        // Extract dominant colors (simplified approach)
        const colors = [
            `rgb(${Math.round(dominant.r)}, ${Math.round(dominant.g)}, ${Math.round(dominant.b)})`,
            // Generate some variations for demo purposes
            `rgb(${Math.max(0, Math.round(dominant.r) - 30)}, ${Math.round(dominant.g)}, ${Math.round(dominant.b)})`,
            `rgb(${Math.round(dominant.r)}, ${Math.max(0, Math.round(dominant.g) - 30)}, ${Math.round(dominant.b)})`
        ];
        
        return colors.slice(0, 5); // Return up to 5 colors
    } catch (error) {
        console.warn('⚠️  Color analysis failed:', error.message);
        return ['#888888', '#666666', '#444444']; // Default colors
    }
};

const recommendFormat = (info, hasTransparency) => {
    if (hasTransparency) return 'png';
    if (info.format === 'gif') return 'gif';
    if (info.width * info.height > 1000000) return 'jpeg'; // Large images
    return 'webp'; // Modern format for smaller images
};

const estimateQuality = (size, width, height) => {
    const pixelDensity = size / (width * height);
    if (pixelDensity > 3) return 95;
    if (pixelDensity > 2) return 85;
    if (pixelDensity > 1) return 75;
    return 65;
};

const convertImage = async (inputBuffer, options) => {
    try {
        let processor = sharp(inputBuffer);
        
        // Apply resizing if specified
        if (options.width || options.height) {
            const resizeOptions = {
                width: options.width,
                height: options.height,
                fit: options.maintainAspectRatio !== false ? 'inside' : 'fill',
                withoutEnlargement: true
            };
            processor = processor.resize(resizeOptions);
        }
        
        // Apply format conversion and quality
        let outputBuffer;
        switch (options.outputFormat.toLowerCase()) {
            case 'jpeg':
            case 'jpg':
                outputBuffer = await processor
                    .jpeg({ quality: options.quality || 80, progressive: true })
                    .toBuffer();
                break;
            case 'png':
                outputBuffer = await processor
                    .png({ quality: options.quality || 80, progressive: true })
                    .toBuffer();
                break;
            case 'webp':
                outputBuffer = await processor
                    .webp({ quality: options.quality || 80 })
                    .toBuffer();
                break;
            case 'avif':
                outputBuffer = await processor
                    .avif({ quality: options.quality || 80 })
                    .toBuffer();
                break;
            case 'tiff':
                outputBuffer = await processor
                    .tiff({ quality: options.quality || 80 })
                    .toBuffer();
                break;
            default:
                throw new Error(`Unsupported output format: ${options.outputFormat}`);
        }
        
        // If target size is specified, iteratively reduce quality
        if (options.targetSizeKB && outputBuffer.length > options.targetSizeKB * 1024) {
            let quality = options.quality || 80;
            let attempts = 0;
            const maxAttempts = 5;
            
            while (outputBuffer.length > options.targetSizeKB * 1024 && quality > 10 && attempts < maxAttempts) {
                quality -= 15;
                attempts++;
                
                switch (options.outputFormat.toLowerCase()) {
                    case 'jpeg':
                    case 'jpg':
                        outputBuffer = await processor.jpeg({ quality }).toBuffer();
                        break;
                    case 'png':
                        outputBuffer = await processor.png({ quality }).toBuffer();
                        break;
                    case 'webp':
                        outputBuffer = await processor.webp({ quality }).toBuffer();
                        break;
                    case 'avif':
                        outputBuffer = await processor.avif({ quality }).toBuffer();
                        break;
                }
            }
        }
        
        return outputBuffer;
    } catch (error) {
        throw new Error(`Image conversion failed: ${error.message}`);
    }
};

const saveToTemp = async (buffer, filename) => {
    const filePath = path.join(TEMP_DIR, filename);
    await fs.writeFile(filePath, buffer);
    return filePath;
};

// Preset sizes
const PRESET_SIZES = {
    'square-small': { width: 512, height: 512 },
    'square-large': { width: 1024, height: 1024 },
    'portrait-small': { width: 512, height: 768 },
    'portrait-large': { width: 768, height: 1024 },
    'landscape-small': { width: 768, height: 512 },
    'landscape-large': { width: 1024, height: 768 },
    'facebook': { width: 1200, height: 630 },
    'instagram': { width: 1080, height: 1080 },
    'twitter': { width: 1200, height: 675 },
    'linkedin': { width: 1200, height: 627 }
};

// API Routes

// 1. Image Analysis
app.post('/api/analyze-image', upload.single('file'), async (req, res) => {
    console.log('🔍 Starting image analysis...');
    
    try {
        if (!req.file) {
            console.log('❌ No file provided');
            return res.status(400).json({ error: 'No file provided' });
        }
        
        console.log(`📁 Analyzing file: ${req.file.originalname} (${req.file.size} bytes)`);
        
        const info = await getImageInfo(req.file.buffer);
        const colors = await analyzeImageColors(req.file.buffer);
        const hasTransparency = info.hasAlpha;
        const recommendedFormat = recommendFormat(info, hasTransparency);
        const estimatedQuality = estimateQuality(info.size, info.width, info.height);
        
        const result = {
            colors,
            hasTransparency,
            aspectRatio: Number(info.aspectRatio.toFixed(2)),
            recommendedFormat,
            estimatedQuality,
            metadata: {
                width: info.width,
                height: info.height,
                format: info.format,
                size: info.size
            }
        };
        
        console.log('✅ Analysis completed successfully');
        res.json(result);
        
    } catch (error) {
        console.error('❌ Analysis failed:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 2. Single Image Conversion
app.post('/api/convert-image', upload.single('file'), async (req, res) => {
    console.log('🔄 Starting single image conversion...');
    
    try {
        if (!req.file) {
            console.log('❌ No file provided');
            return res.status(400).json({ error: 'No file provided' });
        }
        
        const { outputFormat, quality, width, height, maintainAspectRatio, targetSizeKB } = req.body;
        
        if (!outputFormat) {
            return res.status(400).json({ error: 'Output format is required' });
        }
        
        console.log(`📁 Converting: ${req.file.originalname} to ${outputFormat}`);
        
        const originalInfo = await getImageInfo(req.file.buffer);
        
        // Apply preset if specified
        let convertOptions = {
            outputFormat: outputFormat.toLowerCase(),
            quality: quality ? parseInt(quality) : 80,
            width: width ? parseInt(width) : undefined,
            height: height ? parseInt(height) : undefined,
            maintainAspectRatio: maintainAspectRatio !== 'false',
            targetSizeKB: targetSizeKB ? parseInt(targetSizeKB) : undefined
        };
        
        // Check for preset sizes
        if (req.body.preset && PRESET_SIZES[req.body.preset]) {
            const preset = PRESET_SIZES[req.body.preset];
            convertOptions.width = preset.width;
            convertOptions.height = preset.height;
        }
        
        const convertedBuffer = await convertImage(req.file.buffer, convertOptions);
        const convertedInfo = await getImageInfo(convertedBuffer);
        
        // Save to temp directory
        const filename = `${uuidv4()}.${outputFormat.toLowerCase()}`;
        const filePath = await saveToTemp(convertedBuffer, filename);
        const fileUrl = `${req.protocol}://${req.get('host')}/temp/${filename}`;
        
        const result = {
            originalFile: {
                name: req.file.originalname,
                size: originalInfo.size,
                type: req.file.mimetype,
                width: originalInfo.width,
                height: originalInfo.height
            },
            convertedFile: {
                name: filename,
                size: convertedInfo.size,
                type: `image/${outputFormat.toLowerCase()}`,
                width: convertedInfo.width,
                height: convertedInfo.height,
                url: fileUrl
            },
            compressionRatio: Number((originalInfo.size / convertedInfo.size).toFixed(2)),
            finalQuality: convertOptions.quality
        };
        
        console.log(`✅ Conversion completed: ${originalInfo.size} bytes → ${convertedInfo.size} bytes`);
        res.json(result);
        
    } catch (error) {
        console.error('❌ Conversion failed:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 3. Batch Image Conversion
app.post('/api/convert-batch', upload.array('files', 50), async (req, res) => {
    console.log('🔄 Starting batch image conversion...');
    
    try {
        if (!req.files || req.files.length === 0) {
            console.log('❌ No files provided');
            return res.status(400).json({ error: 'No files provided' });
        }
        
        // Parse settings - handle both JSON string and direct form fields
        let settings;
        if (req.body.settings) {
            try {
                settings = JSON.parse(req.body.settings);
            } catch (e) {
                return res.status(400).json({ error: 'Invalid settings JSON format' });
            }
        } else {
            // Extract settings from individual form fields
            settings = {
            outputFormat: req.body.outputFormat,
            quality: req.body.quality ? parseInt(req.body.quality) : 80,
            width: req.body.width ? parseInt(req.body.width) : undefined,
            height: req.body.height ? parseInt(req.body.height) : undefined,
            maintainAspectRatio: req.body.maintainAspectRatio !== 'false',
            targetSizeKB: req.body.targetSizeKB ? parseInt(req.body.targetSizeKB) : undefined,
            preset: req.body.preset
        };
        }
        
        if (!settings || !settings.outputFormat) {
            return res.status(400).json({ error: 'Settings with outputFormat are required' });
        }
        
        console.log(`📁 Processing ${req.files.length} files with settings:`, settings);
        
        const results = [];
        const errors = [];
        let totalProcessed = 0;
        
        for (const file of req.files) {
            try {
                console.log(`🔄 Processing: ${file.originalname}`);
                
                const originalInfo = await getImageInfo(file.buffer);
                
                const convertOptions = {
                    outputFormat: settings.outputFormat.toLowerCase(),
                    quality: settings.quality || 80,
                    width: settings.width,
                    height: settings.height,
                    maintainAspectRatio: settings.maintainAspectRatio !== false,
                    targetSizeKB: settings.targetSizeKB
                };
                
                // Apply preset if specified
                if (settings.preset && PRESET_SIZES[settings.preset]) {
                    const preset = PRESET_SIZES[settings.preset];
                    convertOptions.width = preset.width;
                    convertOptions.height = preset.height;
                    console.log(`📐 Using preset: ${settings.preset} (${preset.width}x${preset.height})`);
                }
                
                const convertedBuffer = await convertImage(file.buffer, convertOptions);
                const convertedInfo = await getImageInfo(convertedBuffer);
                
                // Save to temp directory
                const filename = `${uuidv4()}.${settings.outputFormat.toLowerCase()}`;
                await saveToTemp(convertedBuffer, filename);
                const fileUrl = `${req.protocol}://${req.get('host')}/temp/${filename}`;
                
                const result = {
                    originalFile: {
                        name: file.originalname,
                        size: originalInfo.size,
                        type: file.mimetype,
                        width: originalInfo.width,
                        height: originalInfo.height
                    },
                    convertedFile: {
                        name: filename,
                        size: convertedInfo.size,
                        type: `image/${settings.outputFormat.toLowerCase()}`,
                        width: convertedInfo.width,
                        height: convertedInfo.height,
                        url: fileUrl
                    },
                    compressionRatio: Number((originalInfo.size / convertedInfo.size).toFixed(2)),
                    finalQuality: convertOptions.quality,
                    status: 'success'
                };
                
                results.push(result);
                totalProcessed++;
                console.log(`✅ Processed: ${file.originalname} (${originalInfo.size} → ${convertedInfo.size} bytes)`);
                
            } catch (error) {
                console.error(`❌ Failed to process ${file.originalname}:`, error.message);
                errors.push(`${file.originalname}: ${error.message}`);
                
                results.push({
                    originalFile: {
                        name: file.originalname,
                        size: file.size,
                        type: file.mimetype
                    },
                    status: 'failed',
                    error: error.message
                });
            }
        }
        
        const response = {
            results,
            totalProcessed,
            totalErrors: errors.length,
            errors: errors.length > 0 ? errors : undefined
        };
        
        console.log(`✅ Batch processing completed: ${totalProcessed} successful, ${errors.length} errors`);
        res.json(response);
        
    } catch (error) {
        console.error('❌ Batch conversion failed:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 4. AI-Powered Image Enhancement
app.post('/api/enhance-image', upload.single('file'), async (req, res) => {
    console.log('🤖 Starting AI image enhancement...');
    
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file provided' });
        }
        
        const { enhancement } = req.body;
        const originalInfo = await getImageInfo(req.file.buffer);
        
        let processor = sharp(req.file.buffer);
        
        // Apply AI-like enhancements
        switch (enhancement) {
            case 'sharpen':
                processor = processor.sharpen(2, 1, 2);
                break;
            case 'denoise':
                processor = processor.median(3);
                break;
            case 'brighten':
                processor = processor.modulate({ brightness: 1.2 });
                break;
            case 'contrast':
                processor = processor.modulate({ brightness: 1, saturation: 1.1 }).sharpen();
                break;
            case 'auto':
                processor = processor.normalize().sharpen(1.5, 1, 1.5);
                break;
            default:
                processor = processor.normalize();
        }
        
        const enhancedBuffer = await processor.png({ quality: 90 }).toBuffer();
        const enhancedInfo = await getImageInfo(enhancedBuffer);
        
        const filename = `enhanced_${uuidv4()}.png`;
        await saveToTemp(enhancedBuffer, filename);
        const fileUrl = `${req.protocol}://${req.get('host')}/temp/${filename}`;
        
        console.log(`✅ Enhancement completed: ${enhancement}`);
        res.json({
            originalFile: {
                name: req.file.originalname,
                size: originalInfo.size,
                width: originalInfo.width,
                height: originalInfo.height
            },
            enhancedFile: {
                name: filename,
                size: enhancedInfo.size,
                width: enhancedInfo.width,
                height: enhancedInfo.height,
                url: fileUrl
            },
            enhancement: enhancement || 'auto'
        });
        
    } catch (error) {
        console.error('❌ Enhancement failed:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 5. Get Image Metadata
app.post('/api/metadata', upload.single('file'), async (req, res) => {
    console.log('📊 Extracting metadata...');
    
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file provided' });
        }
        
        const metadata = await sharp(req.file.buffer).metadata();
        const stats = await sharp(req.file.buffer).stats();
        
        console.log(`✅ Metadata extracted for: ${req.file.originalname}`);
        res.json({
            filename: req.file.originalname,
            filesize: req.file.size,
            mimetype: req.file.mimetype,
            dimensions: {
                width: metadata.width,
                height: metadata.height
            },
            format: metadata.format,
            space: metadata.space,
            channels: metadata.channels,
            depth: metadata.depth,
            density: metadata.density,
            hasProfile: metadata.hasProfile,
            hasAlpha: metadata.hasAlpha,
            orientation: metadata.orientation,
            statistics: {
                channels: stats.channels,
                isOpaque: stats.isOpaque,
                dominant: stats.dominant
            }
        });
        
    } catch (error) {
        console.error('❌ Metadata extraction failed:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Add the new /api/convert-from-url endpoint after existing routes
app.post('/api/convert-from-url', async (req, res) => {
    console.log('🌐 Starting URL-based image conversion...');
    
    try {
        const { imageUrl, outputFormat, quality, width, height, maintainAspectRatio, targetSizeKB, preset } = req.body;
        
        if (!imageUrl) {
            return res.status(400).json({ error: 'imageUrl is required' });
        }
        
        if (!outputFormat) {
            return res.status(400).json({ error: 'outputFormat is required' });
        }
        
        console.log(`🔗 Downloading image from: ${imageUrl}`);
        
        // Download image from URL
        let response;
        try {
            response = await axios.get(imageUrl, {
                responseType: 'arraybuffer',
                timeout: 30000, // 30 seconds timeout
                maxContentLength: 10 * 1024 * 1024, // 10MB limit
                headers: {
                    'User-Agent': 'Image-Processing-API/1.0'
                }
            });
        } catch (error) {
            console.error('❌ Failed to download image:', error.message);
            return res.status(400).json({ 
                error: `Failed to download image from URL: ${error.message}` 
            });
        }
        
        const imageBuffer = Buffer.from(response.data);
        const originalInfo = await getImageInfo(imageBuffer);
        
        console.log(`📁 Downloaded image: ${imageBuffer.length} bytes (${originalInfo.width}x${originalInfo.height})`);
        
        // Validate file type
        const allowedFormats = ['jpeg', 'jpg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'avif'];
        if (!allowedFormats.includes(originalInfo.format.toLowerCase())) {
            return res.status(400).json({ 
                error: `Unsupported image format: ${originalInfo.format}` 
            });
        }
        
        // Prepare conversion options
        const convertOptions = {
            outputFormat: outputFormat.toLowerCase(),
            quality: quality ? parseInt(quality) : 80,
            width: width ? parseInt(width) : undefined,
            height: height ? parseInt(height) : undefined,
            maintainAspectRatio: maintainAspectRatio !== false,
            targetSizeKB: targetSizeKB ? parseInt(targetSizeKB) : undefined
        };
        
        // Apply preset if specified
        if (preset && PRESET_SIZES[preset]) {
            const presetSize = PRESET_SIZES[preset];
            convertOptions.width = presetSize.width;
            convertOptions.height = presetSize.height;
            console.log(`📐 Using preset: ${preset} (${presetSize.width}x${presetSize.height})`);
        }
        
        // Convert image
        const convertedBuffer = await convertImage(imageBuffer, convertOptions);
        const convertedInfo = await getImageInfo(convertedBuffer);
        
        // Save to temp directory
        const filename = `url_${uuidv4()}.${outputFormat.toLowerCase()}`;
        const filePath = await saveToTemp(convertedBuffer, filename);
        const fileUrl = `${req.protocol}://${req.get('host')}/temp/${filename}`;
        
        const result = {
            sourceUrl: imageUrl,
            originalFile: {
                size: originalInfo.size,
                type: `image/${originalInfo.format}`,
                width: originalInfo.width,
                height: originalInfo.height
            },
            convertedFile: {
                name: filename,
                size: convertedInfo.size,
                type: `image/${outputFormat.toLowerCase()}`,
                width: convertedInfo.width,
                height: convertedInfo.height,
                url: fileUrl
            },
            compressionRatio: Number((originalInfo.size / convertedInfo.size).toFixed(2)),
            finalQuality: convertOptions.quality
        };
        
        console.log(`✅ URL conversion completed: ${originalInfo.size} bytes → ${convertedInfo.size} bytes`);
        res.json(result);
        
    } catch (error) {
        console.error('❌ URL conversion failed:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    const tempFiles = fsSync.existsSync(TEMP_DIR) ? fsSync.readdirSync(TEMP_DIR).length : 0;
    
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        tempFiles: tempFiles,
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

// Swagger Documentation
const swaggerDocument = {
    openapi: '3.0.0',
    info: {
        title: 'Professional Image Processing API',
        version: '1.0.0',
        description: 'High-performance image processing API with AI enhancements, batch processing, and comprehensive format support'
    },
    servers: [
        {
            url: `http://localhost:${PORT}`,
            description: 'Local development server'
        }
    ],
    paths: {
        '/api/analyze-image': {
            post: {
                summary: 'Analyze image properties and get AI recommendations',
                tags: ['Image Analysis'],
                requestBody: {
                    content: {
                        'multipart/form-data': {
                            schema: {
                                type: 'object',
                                properties: {
                                    file: {
                                        type: 'string',
                                        format: 'binary',
                                        description: 'Image file to analyze (max 10MB)'
                                    }
                                }
                            }
                        }
                    }
                },
                responses: {
                    200: {
                        description: 'Analysis completed successfully',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        colors: { type: 'array', items: { type: 'string' } },
                                        hasTransparency: { type: 'boolean' },
                                        aspectRatio: { type: 'number' },
                                        recommendedFormat: { type: 'string' },
                                        estimatedQuality: { type: 'number' },
                                        metadata: { type: 'object' }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        '/api/convert-image': {
            post: {
                summary: 'Convert single image with custom parameters',
                tags: ['Image Conversion'],
                requestBody: {
                    content: {
                        'multipart/form-data': {
                            schema: {
                                type: 'object',
                                properties: {
                                    file: { type: 'string', format: 'binary' },
                                    outputFormat: { type: 'string', enum: ['jpeg', 'png', 'webp', 'avif', 'tiff'] },
                                    quality: { type: 'integer', minimum: 1, maximum: 100 },
                                    width: { type: 'integer' },
                                    height: { type: 'integer' },
                                    maintainAspectRatio: { type: 'boolean' },
                                    targetSizeKB: { type: 'integer' },
                                    preset: { 
                                        type: 'string', 
                                        enum: ['square-small', 'square-large', 'portrait-small', 'portrait-large', 'landscape-small', 'landscape-large', 'facebook', 'instagram', 'twitter', 'linkedin']
                                    }
                                }
                            }
                        }
                    }
                },
                responses: {
                    200: {
                        description: 'Image converted successfully',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        originalFile: { type: 'object' },
                                        convertedFile: { 
                                            type: 'object',
                                            properties: {
                                                url: { type: 'string', description: 'Temporary download URL (expires in 10 minutes)' }
                                            }
                                        },
                                        compressionRatio: { type: 'number' },
                                        finalQuality: { type: 'number' }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        '/api/convert-batch': {
            post: {
                summary: 'Convert multiple images in batch (up to 50)',
                tags: ['Batch Processing'],
                requestBody: {
                    content: {
                        'multipart/form-data': {
                            schema: {
                                type: 'object',
                                properties: {
                                    files: {
                                        type: 'array',
                                        items: { type: 'string', format: 'binary' },
                                        maxItems: 50,
                                        description: 'Image files to convert (max 50 files, 10MB each)'
                                    },
                                    outputFormat: { 
                                        type: 'string', 
                                        enum: ['jpeg', 'png', 'webp', 'avif', 'tiff'],
                                        description: 'Output image format'
                                    },
                                    quality: { 
                                        type: 'integer', 
                                        minimum: 1, 
                                        maximum: 100,
                                        description: 'Image quality (1-100)'
                                    },
                                    width: { 
                                        type: 'integer',
                                        description: 'Target width in pixels'
                                    },
                                    height: { 
                                        type: 'integer',
                                        description: 'Target height in pixels'
                                    },
                                    maintainAspectRatio: { 
                                        type: 'boolean',
                                        description: 'Maintain original aspect ratio'
                                    },
                                    targetSizeKB: { 
                                        type: 'integer',
                                        description: 'Target file size in KB'
                                    },
                                    preset: { 
                                        type: 'string', 
                                        enum: ['square-small', 'square-large', 'portrait-small', 'portrait-large', 'landscape-small', 'landscape-large', 'facebook', 'instagram', 'twitter', 'linkedin'],
                                        description: 'Use preset dimensions'
                                    }
                                },
                                required: ['files', 'outputFormat']
                            }
                        }
                    }
                },
                responses: {
                    200: {
                        description: 'Batch processing completed',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        results: { 
                                            type: 'array',
                                            items: {
                                                type: 'object',
                                                properties: {
                                                    originalFile: { type: 'object' },
                                                    convertedFile: {
                                                        type: 'object',
                                                        properties: {
                                                            url: { type: 'string', description: 'Temporary download URL (expires in 10 minutes)' }
                                                        }
                                                    },
                                                    compressionRatio: { type: 'number' },
                                                    finalQuality: { type: 'number' },
                                                    status: { type: 'string' }
                                                }
                                            }
                                        },
                                        totalProcessed: { type: 'integer' },
                                        totalErrors: { type: 'integer' },
                                        errors: { type: 'array', items: { type: 'string' } }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        '/api/enhance-image': {
            post: {
                summary: 'AI-powered image enhancement',
                tags: ['AI Enhancement'],
                requestBody: {
                    content: {
                        'multipart/form-data': {
                            schema: {
                                type: 'object',
                                properties: {
                                    file: { type: 'string', format: 'binary' },
                                    enhancement: { 
                                        type: 'string', 
                                        enum: ['sharpen', 'denoise', 'brighten', 'contrast', 'auto'],
                                        default: 'auto'
                                    }
                                }
                            }
                        }
                    }
                },
                responses: {
                    200: { description: 'Enhancement completed successfully' }
                }
            }
        },
        '/api/metadata': {
            post: {
                summary: 'Extract comprehensive image metadata',
                tags: ['Metadata'],
                requestBody: {
                    content: {
                        'multipart/form-data': {
                            schema: {
                                type: 'object',
                                properties: {
                                    file: { type: 'string', format: 'binary' }
                                }
                            }
                        }
                    }
                },
                responses: {
                    200: { description: 'Metadata extracted successfully' }
                }
            }
        },
        '/api/health': {
            get: {
                summary: 'Health check endpoint',
                tags: ['System'],
                responses: {
                    200: {
                        description: 'System health status',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        status: { type: 'string' },
                                        timestamp: { type: 'string' },
                                        tempFiles: { type: 'integer' },
                                        uptime: { type: 'number' },
                                        memory: { type: 'object' }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        '/api/convert-from-url': {
            post: {
                summary: 'Convert image from URL',
                tags: ['Image Conversion'],
                requestBody: {
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    imageUrl: { 
                                        type: 'string', 
                                        format: 'uri',
                                        description: 'URL of the image to download and convert'
                                    },
                                    outputFormat: { 
                                        type: 'string', 
                                        enum: ['jpeg', 'png', 'webp', 'avif', 'tiff'],
                                        description: 'Output image format'
                                    },
                                    quality: { 
                                        type: 'integer', 
                                        minimum: 1, 
                                        maximum: 100,
                                        description: 'Image quality (1-100)'
                                    },
                                    width: { 
                                        type: 'integer',
                                        description: 'Target width in pixels'
                                    },
                                    height: { 
                                        type: 'integer',
                                        description: 'Target height in pixels'
                                    },
                                    maintainAspectRatio: { 
                                        type: 'boolean',
                                        description: 'Maintain original aspect ratio'
                                    },
                                    targetSizeKB: { 
                                        type: 'integer',
                                        description: 'Target file size in KB'
                                    },
                                    preset: { 
                                        type: 'string', 
                                        enum: ['square-small', 'square-large', 'portrait-small', 'portrait-large', 'landscape-small', 'landscape-large', 'facebook', 'instagram', 'twitter', 'linkedin'],
                                        description: 'Use preset dimensions'
                                    }
                                },
                                required: ['imageUrl', 'outputFormat']
                            }
                        }
                    }
                },
                responses: {
                    200: {
                        description: 'Image converted successfully',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        sourceUrl: { type: 'string' },
                                        originalFile: { type: 'object' },
                                        convertedFile: { 
                                            type: 'object',
                                            properties: {
                                                url: { type: 'string', description: 'Temporary download URL (expires in 10 minutes)' }
                                            }
                                        },
                                        compressionRatio: { type: 'number' },
                                        finalQuality: { type: 'number' }
                                    }
                                }
                            }
                        }
                    },
                    400: {
                        description: 'Bad request - invalid URL or parameters'
                    }
                }
            }
        }
    },
    components: {
        schemas: {
            Error: {
                type: 'object',
                properties: {
                    error: { type: 'string' }
                }
            }
        }
    }
};

// Setup Swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'Image Processing API Documentation'
}));

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('❌ Global error handler:', error);
    
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'File too large. Maximum size is 10MB per file.' });
        }
        if (error.code === 'LIMIT_FILE_COUNT') {
            return res.status(413).json({ error: 'Too many files. Maximum is 50 files per batch.' });
        }
        if (error.code === 'LIMIT_UNEXPECTED_FILE') {
            return res.status(400).json({ error: 'Unexpected file field.' });
        }
    }
    
    if (error.message.includes('Unsupported file type')) {
        return res.status(400).json({ error: error.message });
    }
    
    res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({ 
        error: 'Endpoint not found',
        availableEndpoints: [
            'GET /api-docs - API Documentation',
            'GET /api/health - Health Check',
            'POST /api/analyze-image - Image Analysis',
            'POST /api/convert-image - Single Conversion',
            'POST /api/convert-batch - Batch Conversion',
            'POST /api/enhance-image - AI Enhancement',
            'POST /api/metadata - Metadata Extraction'
        ]
    });
});

// Start server
app.listen(PORT, () => {
    console.log('🚀 =================================');
    console.log(`🚀 Image Processing API Server Started`);
    console.log('🚀 =================================');
    console.log(`📡 Server running on: http://localhost:${PORT}`);
    console.log(`📖 API Documentation: http://localhost:${PORT}/api-docs`);
    console.log(`🏥 Health Check: http://localhost:${PORT}/api/health`);
    console.log('🚀 =================================');
    console.log('📁 Features:');
    console.log('   ✅ Image Analysis with AI recommendations');
    console.log('   ✅ Single & Batch conversion (up to 50 files)');
    console.log('   ✅ AI-powered image enhancement');
    console.log('   ✅ Comprehensive metadata extraction');
    console.log('   ✅ Auto temp file cleanup (10 minutes)');
    console.log('   ✅ Complete error handling & logging');
    console.log('   ✅ Swagger UI documentation');
    console.log('🚀 =================================');
    console.log('🎨 Supported Formats:');
    console.log('   📥 Input: JPEG, PNG, WebP, AVIF, GIF, BMP, TIFF, SVG, ICO');
    console.log('   📤 Output: JPEG, PNG, WebP, AVIF, TIFF');
    console.log('🚀 =================================');
    console.log('🔧 Preset Sizes Available:');
    console.log('   📐 square-small (512x512), square-large (1024x1024)');
    console.log('   📐 portrait-small (512x768), portrait-large (768x1024)');
    console.log('   📐 landscape-small (768x512), landscape-large (1024x768)');
    console.log('   📱 Social: facebook, instagram, twitter, linkedin');
    console.log('🚀 =================================');
    console.log('💡 Usage Examples:');
    console.log('   curl -X POST -F "file=@image.jpg" http://localhost:' + PORT + '/api/analyze-image');
    console.log('   curl -X POST -F "file=@image.jpg" -F "outputFormat=webp" -F "quality=80" http://localhost:' + PORT + '/api/convert-image');
    console.log('   curl -X POST -F "files=@img1.jpg" -F "files=@img2.png" -F "outputFormat=avif" -F "quality=75" http://localhost:' + PORT + '/api/convert-batch');
    console.log('🚀 =================================');
    
    // Run initial cleanup
    cleanupTempFiles();
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received. Starting graceful shutdown...');
    cleanupTempFiles();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('\n🛑 SIGINT received. Starting graceful shutdown...');
    cleanupTempFiles();
    process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    cleanupTempFiles();
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});
