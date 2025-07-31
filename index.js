const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Create uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// Initialize SQLite database
const db = new sqlite3.Database('family_media.db');

// Create media table if it doesn't exist
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        original_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        type TEXT NOT NULL,
        tags TEXT,
        upload_date DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const timestamp = Date.now();
        const ext = path.extname(file.originalname);
        const name = path.basename(file.originalname, ext);
        cb(null, `${timestamp}_${name}${ext}`);
    }
});

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB limit
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|mp4|mov|avi|wmv/;
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
app.post('/api/upload', upload.array('media', 10), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
    }

    const tags = req.body.tags || '';
    const uploadedFiles = [];

    req.files.forEach(file => {
        const mediaType = file.mimetype.startsWith('image/') ? 'photo' : 'video';
        
        db.run(
            `INSERT INTO media (filename, original_name, file_path, type, tags) 
             VALUES (?, ?, ?, ?, ?)`,
            [file.filename, file.originalname, file.path, mediaType, tags],
            function(err) {
                if (err) {
                    console.error('Database error:', err);
                } else {
                    uploadedFiles.push({
                        id: this.lastID,
                        filename: file.filename,
                        originalName: file.originalname,
                        type: mediaType,
                        tags: tags.split(',').map(tag => tag.trim()).filter(tag => tag)
                    });
                }
            }
        );
    });

    res.json({ 
        message: 'Files uploaded successfully', 
        files: uploadedFiles 
    });
});

// Get all media
app.get('/api/media', (req, res) => {
    const { search, type } = req.query;
    let query = 'SELECT * FROM media';
    let params = [];

    if (search || type) {
        query += ' WHERE ';
        const conditions = [];
        
        if (search) {
            conditions.push('(tags LIKE ? OR original_name LIKE ?)');
            params.push(`%${search}%`, `%${search}%`);
        }
        
        if (type && type !== 'all') {
            conditions.push('type = ?');
            params.push(type);
        }
        
        query += conditions.join(' AND ');
    }
    
    query += ' ORDER BY upload_date DESC';

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('Database error:', err);
            res.status(500).json({ error: 'Database error' });
        } else {
            const media = rows.map(row => ({
                id: row.id,
                filename: row.filename,
                originalName: row.original_name,
                filePath: `/uploads/${row.filename}`,
                type: row.type,
                tags: row.tags ? row.tags.split(',').map(tag => tag.trim()).filter(tag => tag) : [],
                uploadDate: row.upload_date
            }));
            res.json(media);
        }
    });
});

// Delete media
app.delete('/api/media/:id', (req, res) => {
    const mediaId = req.params.id;
    
    // First get the file path to delete the actual file
    db.get('SELECT file_path FROM media WHERE id = ?', [mediaId], (err, row) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        if (row) {
            // Delete the file from filesystem
            fs.unlink(row.file_path, (unlinkErr) => {
                if (unlinkErr) {
                    console.error('File deletion error:', unlinkErr);
                }
            });
        }
        
        // Delete from database
        db.run('DELETE FROM media WHERE id = ?', [mediaId], function(err) {
            if (err) {
                console.error('Database error:', err);
                res.status(500).json({ error: 'Database error' });
            } else {
                res.json({ message: 'Media deleted successfully' });
            }
        });
    });
});

// Serve the main pages
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/upload', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'upload.html'));
});

// Health check endpoint for Vercel
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});