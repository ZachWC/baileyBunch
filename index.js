const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables (you'll set these in Vercel)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const b2KeyId = process.env.B2_KEY_ID;
const b2ApplicationKey = process.env.B2_APPLICATION_KEY;
const b2BucketName = process.env.B2_BUCKET_NAME;
const b2Endpoint = process.env.B2_ENDPOINT;

// Initialize Supabase client
const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize Backblaze B2 (S3-compatible) client
const s3Client = new S3Client({
    endpoint: `https://${b2Endpoint}`,
    region: 'us-west-004', // Backblaze region
    credentials: {
        accessKeyId: b2KeyId,
        secretAccessKey: b2ApplicationKey,
    },
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(express.static('public'));

// Configure multer for memory storage (with increased limits for large files)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 500 * 1024 * 1024 // 500MB limit for server uploads
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|mp4|mov|avi|wmv|webm/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only images and videos are allowed!'));
        }
    }
});

// API Routes

// Get presigned URL for direct B2 upload (simplified for better CORS compatibility)
app.post('/api/get-upload-url', async (req, res) => {
    try {
        const { filename, contentType, fileSize } = req.body;
        
        // Generate unique filename
        const timestamp = Date.now();
        const ext = path.extname(filename);
        const name = path.basename(filename, ext);
        const fileKey = `uploads/${timestamp}_${name}${ext}`;
        
        // Create presigned URL with minimal headers for better B2 compatibility
        const command = new PutObjectCommand({
            Bucket: b2BucketName,
            Key: fileKey,
            ContentType: contentType,
        });
        
        const signedUrl = await getSignedUrl(s3Client, command, { 
            expiresIn: 3600, // 1 hour to complete upload
            unhoistableHeaders: new Set(['x-amz-checksum-crc32']), // Remove problematic headers
        });
        
        // Construct the final file URL
        const fileUrl = `https://${b2Endpoint}/${b2BucketName}/${fileKey}`;
        
        res.json({
            uploadUrl: signedUrl,
            fileKey: fileKey,
            fileUrl: fileUrl,
            filename: `${timestamp}_${name}${ext}`
        });
        
    } catch (error) {
        console.error('Presigned URL error:', error);
        res.status(500).json({ error: 'Failed to generate upload URL' });
    }
});

// Sync manually uploaded files from B2 to database
app.post('/api/sync-b2-files', async (req, res) => {
    try {
        const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
        
        // Get all files from B2 bucket
        const listCommand = new ListObjectsV2Command({
            Bucket: b2BucketName,
            Prefix: 'uploads/'
        });
        
        const b2Response = await s3Client.send(listCommand);
        const b2Files = b2Response.Contents || [];
        
        // Get existing files from database  
        const { data: existingFiles, error: dbError } = await supabase
            .from('media')
            .select('file_key');
            
        if (dbError) {
            throw new Error('Database error: ' + dbError.message);
        }
        
        const existingKeys = new Set(existingFiles.map(f => f.file_key));
        
        // Find files in B2 that aren't in database
        const newFiles = b2Files.filter(file => !existingKeys.has(file.Key));
        
        const addedFiles = [];
        
        // Add new files to database
        for (const file of newFiles) {
            const filename = file.Key.split('/').pop();
            const originalName = filename.replace(/^\d+_/, ''); // Remove timestamp prefix
            const ext = path.extname(originalName).toLowerCase();
            const mediaType = ['.jpg', '.jpeg', '.png', '.gif'].includes(ext) ? 'photo' : 'video';
            const fileUrl = `https://${b2Endpoint}/${b2BucketName}/${file.Key}`;
            
            const { data, error } = await supabase
                .from('media')
                .insert([
                    {
                        filename: filename,
                        original_name: originalName,
                        file_url: fileUrl,
                        file_key: file.Key,
                        type: mediaType,
                        tags: 'Manual Upload', // Default tag for manual uploads
                        file_size: file.Size
                    }
                ])
                .select();
                
            if (!error && data) {
                addedFiles.push({
                    filename: originalName,
                    type: mediaType,
                    size: file.Size
                });
            }
        }
        
        res.json({
            message: `Found and added ${addedFiles.length} new files`,
            addedFiles: addedFiles
        });
        
    } catch (error) {
        console.error('Sync error:', error);
        res.status(500).json({ error: 'Sync failed: ' + error.message });
    }
});
app.post('/api/confirm-upload', async (req, res) => {
    try {
        const { fileKey, originalName, fileUrl, filename, contentType, fileSize, tags } = req.body;
        
        const mediaType = contentType.startsWith('image/') ? 'photo' : 'video';
        
        // Save metadata to Supabase
        const { data, error } = await supabase
            .from('media')
            .insert([
                {
                    filename: filename,
                    original_name: originalName,
                    file_url: fileUrl,
                    file_key: fileKey,
                    type: mediaType,
                    tags: tags || '',
                    file_size: fileSize
                }
            ])
            .select();

        if (error) {
            console.error('Database error:', error);
            return res.status(500).json({ error: 'Database error' });
        }

        res.json({
            message: 'Upload confirmed successfully',
            media: {
                id: data[0].id,
                filename: originalName,
                type: mediaType,
                url: fileUrl,
                tags: tags ? tags.split(',').map(tag => tag.trim()).filter(tag => tag) : []
            }
        });
        
    } catch (error) {
        console.error('Confirm upload error:', error);
        res.status(500).json({ error: 'Failed to confirm upload' });
    }
});

// Upload large files through server (fallback for CORS issues)
app.post('/api/upload-large', upload.array('media', 5), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }

        const tags = req.body.tags || '';
        const uploadedFiles = [];

        for (const file of req.files) {
            const mediaType = file.mimetype.startsWith('image/') ? 'photo' : 'video';
            
            // Generate unique filename
            const timestamp = Date.now();
            const ext = path.extname(file.originalname);
            const name = path.basename(file.originalname, ext);
            const fileKey = `uploads/${timestamp}_${name}${ext}`;
            
            // Upload to Backblaze B2
            const uploadParams = {
                Bucket: b2BucketName,
                Key: fileKey,
                Body: file.buffer,
                ContentType: file.mimetype,
            };

            await s3Client.send(new PutObjectCommand(uploadParams));
            
            // Construct file URL
            const fileUrl = `https://${b2Endpoint}/${b2BucketName}/${fileKey}`;
            
            // Save metadata to Supabase
            const { data, error } = await supabase
                .from('media')
                .insert([
                    {
                        filename: `${timestamp}_${name}${ext}`,
                        original_name: file.originalname,
                        file_url: fileUrl,
                        file_key: fileKey,
                        type: mediaType,
                        tags: tags,
                        file_size: file.size
                    }
                ])
                .select();

            if (error) {
                console.error('Database error:', error);
                return res.status(500).json({ error: 'Database error' });
            }

            uploadedFiles.push({
                id: data[0].id,
                filename: file.originalname,
                type: mediaType,
                url: fileUrl,
                tags: tags.split(',').map(tag => tag.trim()).filter(tag => tag)
            });
        }

        res.json({ 
            message: 'Files uploaded successfully', 
            files: uploadedFiles 
        });

    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed: ' + error.message });
    }
});
app.post('/api/upload', upload.array('media', 10), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }

        const tags = req.body.tags || '';
        const uploadedFiles = [];

        for (const file of req.files) {
            const mediaType = file.mimetype.startsWith('image/') ? 'photo' : 'video';
            
            // Generate unique filename
            const timestamp = Date.now();
            const ext = path.extname(file.originalname);
            const name = path.basename(file.originalname, ext);
            const fileKey = `uploads/${timestamp}_${name}${ext}`;
            
            // Upload to Backblaze B2
            const uploadParams = {
                Bucket: b2BucketName,
                Key: fileKey,
                Body: file.buffer,
                ContentType: file.mimetype,
            };

            const uploadResult = await s3Client.send(new PutObjectCommand(uploadParams));
            
            // Construct file URL
            const fileUrl = `https://${b2Endpoint}/${b2BucketName}/${fileKey}`;
            
            // Save metadata to Supabase
            const { data, error } = await supabase
                .from('media')
                .insert([
                    {
                        filename: `${timestamp}_${name}${ext}`,
                        original_name: file.originalname,
                        file_url: fileUrl,
                        file_key: fileKey,
                        type: mediaType,
                        tags: tags,
                        file_size: file.size
                    }
                ])
                .select();

            if (error) {
                console.error('Database error:', error);
                return res.status(500).json({ error: 'Database error' });
            }

            uploadedFiles.push({
                id: data[0].id,
                filename: file.originalname,
                type: mediaType,
                url: fileUrl,
                tags: tags.split(',').map(tag => tag.trim()).filter(tag => tag)
            });
        }

        res.json({ 
            message: 'Files uploaded successfully', 
            files: uploadedFiles 
        });

    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed: ' + error.message });
    }
});

// Get all media
app.get('/api/media', async (req, res) => {
    try {
        const { search, type } = req.query;
        
        let query = supabase.from('media').select('*');
        
        if (search) {
            query = query.or(`tags.ilike.%${search}%,original_name.ilike.%${search}%`);
        }
        
        if (type && type !== 'all') {
            query = query.eq('type', type);
        }
        
        query = query.order('created_at', { ascending: false });
        
        const { data, error } = await query;
        
        if (error) {
            console.error('Database error:', error);
            return res.status(500).json({ error: 'Database error' });
        }

        const media = data.map(row => ({
            id: row.id,
            filename: row.filename,
            originalName: row.original_name,
            filePath: row.file_url, // Direct URL to B2
            type: row.type,
            tags: row.tags ? row.tags.split(',').map(tag => tag.trim()).filter(tag => tag) : [],
            uploadDate: row.created_at,
            fileSize: row.file_size
        }));

        res.json(media);

    } catch (error) {
        console.error('Error fetching media:', error);
        res.status(500).json({ error: 'Failed to fetch media' });
    }
});

// Delete media
app.delete('/api/media/:id', async (req, res) => {
    try {
        const mediaId = req.params.id;
        
        // Get file info from database
        const { data: mediaData, error: fetchError } = await supabase
            .from('media')
            .select('file_key')
            .eq('id', mediaId)
            .single();

        if (fetchError || !mediaData) {
            return res.status(404).json({ error: 'Media not found' });
        }

        // Delete file from B2
        const deleteParams = {
            Bucket: b2BucketName,
            Key: mediaData.file_key,
        };

        try {
            await s3Client.send(new DeleteObjectCommand(deleteParams));
        } catch (s3Error) {
            console.error('S3 deletion error:', s3Error);
            // Continue with database deletion even if file deletion fails
        }

        // Delete from database
        const { error: deleteError } = await supabase
            .from('media')
            .delete()
            .eq('id', mediaId);

        if (deleteError) {
            console.error('Database deletion error:', deleteError);
            return res.status(500).json({ error: 'Database deletion failed' });
        }

        res.json({ message: 'Media deleted successfully' });

    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ error: 'Delete failed' });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        services: {
            supabase: !!supabaseUrl,
            backblaze: !!b2KeyId
        }
    });
});

// Serve the main pages
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/upload', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'upload.html'));
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Global error handler:', error);
    res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('Environment check:', {
        supabase: !!supabaseUrl,
        backblaze: !!b2KeyId
    });
});