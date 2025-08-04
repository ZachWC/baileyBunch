const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const multerS3 = require('multer-s3');

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
app.use(express.json());
app.use(express.static('public'));

// Configure multer for B2 uploads
const upload = multer({
    storage: multerS3({
        s3: s3Client,
        bucket: b2BucketName,
        key: function (req, file, cb) {
            const timestamp = Date.now();
            const ext = path.extname(file.originalname);
            const name = path.basename(file.originalname, ext);
            cb(null, `uploads/${timestamp}_${name}${ext}`);
        },
        contentType: multerS3.AUTO_CONTENT_TYPE,
    }),
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB limit
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

// Upload media files
app.post('/api/upload', upload.array('media', 10), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }

        const tags = req.body.tags || '';
        const uploadedFiles = [];

        for (const file of req.files) {
            const mediaType = file.mimetype.startsWith('image/') ? 'photo' : 'video';
            
            // Save metadata to Supabase
            const { data, error } = await supabase
                .from('media')
                .insert([
                    {
                        filename: file.key.split('/').pop(),
                        original_name: file.originalname,
                        file_url: file.location,
                        file_key: file.key,
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
                url: file.location,
                tags: tags.split(',').map(tag => tag.trim()).filter(tag => tag)
            });
        }

        res.json({ 
            message: 'Files uploaded successfully', 
            files: uploadedFiles 
        });

    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed' });
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