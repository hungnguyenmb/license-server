const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const db = require('./db');
require('dotenv').config();

const app = express();
app.use(express.json());

// 1. Rate Limiting
const limiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later.' }
});
app.use(limiter);

// 2. CORS
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*';
app.use(cors({ origin: ALLOWED_ORIGINS }));

// 3. System Token Middleware
const API_KEY = process.env.API_KEY;
const authMiddleware = (req, res, next) => {
    const token = req.header('X-API-KEY');
    if (token !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    }
    next();
};

// --- ROUTES ---

app.get('/', (req, res) => {
    res.json({ message: 'License Server is live', status: 'secure' });
});

// Lớp 4: Key Handshake
app.get('/api/v1/auth/handshake', limiter, (req, res) => {
    const realKey = process.env.API_ENCRYPTION_KEY;
    const prefix = 'x'.repeat(35);
    const suffix = 'y'.repeat(10);
    const wrappedString = `${prefix}${realKey}${suffix}`;
    res.json({ handshake: wrappedString, hint: 'start_index:35, length:32' });
});

/**
 * Validate License Key
 */
app.post('/api/v1/license/validate', async (req, res) => {
    const { license_key, machine_id, hardware_details } = req.body;

    if (!license_key || !machine_id) {
        return res.status(400).json({ success: false, error: 'License key and Machine ID are required' });
    }

    try {
        const result = await db.query('SELECT * FROM licenses WHERE license_key = $1', [license_key]);
        const license = result.rows[0];

        if (!license) return res.status(404).json({ success: false, error: 'License key not found' });
        if (license.status !== 'active') return res.status(403).json({ success: false, error: `License is ${license.status}` });
        if (license.expires_at && new Date(license.expires_at) < new Date()) return res.status(403).json({ success: false, error: 'License has expired' });

        if (!license.machine_id) {
            await db.query(
                'UPDATE licenses SET machine_id = $1, hardware_details = $2 WHERE id = $3',
                [machine_id, hardware_details || {}, license.id]
            );
            return res.json({ success: true, message: 'First-time activation successful', expires_at: license.expires_at });
        }

        if (license.machine_id !== machine_id) {
            return res.status(403).json({ success: false, error: 'License bound to another machine' });
        }

        res.json({ success: true, message: 'License is valid', expires_at: license.expires_at });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// --- ADMIN API ---

app.get('/api/v1/admin/licenses', authMiddleware, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                l.*,
                COALESCE(NULLIF(TRIM(l.machine_id), ''), ld.hwid) AS resolved_machine_id
            FROM licenses l
            LEFT JOIN LATERAL (
                SELECT d.hwid
                FROM license_devices d
                WHERE d.license_id = l.id
                ORDER BY d.last_login DESC NULLS LAST, d.id DESC
                LIMIT 1
            ) ld ON TRUE
            ORDER BY l.created_at DESC, l.id DESC
        `);

        const normalized = result.rows.map((row) => ({
            ...row,
            machine_id: row.resolved_machine_id || null,
        }));
        res.json({ success: true, data: normalized });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/v1/admin/licenses', authMiddleware, async (req, res) => {
    const { license_key, expires_days, note, plan_id, issued_source } = req.body;
    try {
        const expires_at = expires_days ? new Date(Date.now() + expires_days * 24 * 60 * 60 * 1000) : null;
        const result = await db.query(
            'INSERT INTO licenses (license_key, expires_at, status, note, plan_id, issued_source) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [license_key, expires_at, 'active', note || '', plan_id || 'Standard', issued_source || 'CMS']
        );
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/v1/admin/licenses/reset', authMiddleware, async (req, res) => {
    const { id } = req.body;
    try {
        await db.query('DELETE FROM license_devices WHERE license_id = $1', [id]);
        await db.query('UPDATE licenses SET machine_id = NULL, hardware_details = NULL WHERE id = $1', [id]);
        res.json({ success: true, message: 'Binding reset successful' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.patch('/api/v1/admin/licenses/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { status, license_key, expires_at, note, plan_id, issued_source } = req.body;
    console.log(`[PATCH] Updating license ${id}:`, { status, license_key, expires_at, note, plan_id, issued_source });
    try {
        const fields = [];
        const values = [];
        let i = 1;

        if (status !== undefined) { fields.push(`status = $${i++}`); values.push(status); }
        if (license_key !== undefined) { fields.push(`license_key = $${i++}`); values.push(license_key); }
        if (expires_at !== undefined) { fields.push(`expires_at = $${i++}`); values.push(expires_at === null ? null : new Date(expires_at)); }
        if (note !== undefined) { fields.push(`note = $${i++}`); values.push(note); }
        if (plan_id !== undefined) { fields.push(`plan_id = $${i++}`); values.push(plan_id || 'Standard'); }
        if (issued_source !== undefined) { fields.push(`issued_source = $${i++}`); values.push(issued_source || 'CMS'); }

        if (fields.length === 0) return res.status(400).json({ success: false, error: 'No fields provided' });

        values.push(id);
        const query = `UPDATE licenses SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`;
        const result = await db.query(query, values);

        console.log(`[PATCH] Result for ${id}:`, result.rows[0]);
        res.json({ success: true, message: 'License updated successfully', data: result.rows[0] });
    } catch (err) {
        console.error(`[PATCH] Error updating ${id}:`, err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- OMNIMIND ROUTES (Tách riêng file, không ảnh hưởng API cũ) ---
require('./omnimind_routes')(app, db, authMiddleware);

const PORT = process.env.PORT || 8050;
app.listen(PORT, () => console.log(`License Server running on port ${PORT}`));
