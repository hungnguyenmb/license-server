/**
 * OmniMind API Routes
 * Tách riêng khỏi index.js để dễ bảo trì.
 * Import vào index.js bằng: require('./omnimind_routes')(app, db, authMiddleware);
 */

const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const logFile = path.join(__dirname, '../debug_omnimind.log');

module.exports = function (app, db, authMiddleware) {

    // ─────────────────────────────────────────────────────
    // PUBLIC: Xác thực License cho OmniMind Client
    // ─────────────────────────────────────────────────────
    app.post('/api/v1/omnimind/licenses/verify', async (req, res) => {
        const { license_key, hwid, os_name, os_version } = req.body;
        console.log('[OmniMind] Verify Request:', { license_key, hwid, os_name });

        if (!license_key || !hwid) {
            return res.status(400).json({ success: false, message: 'License key và HWID là bắt buộc.' });
        }

        try {
            // 1. Tìm license
            console.log('[OmniMind] Querying license...');
            const result = await db.query('SELECT * FROM licenses WHERE license_key = $1', [license_key]);
            const license = result.rows[0];

            if (!license) {
                console.log('[OmniMind] License not found:', license_key);
                return res.status(401).json({ success: false, message: 'License Key không tồn tại.' });
            }
            console.log('[OmniMind] Found license:', license.id, 'Status:', license.status);
            if (license.status !== 'active') {
                return res.status(403).json({ success: false, message: `License đã bị ${license.status}.` });
            }
            if (license.expires_at && new Date(license.expires_at) < new Date()) {
                return res.status(402).json({
                    success: false,
                    message: 'License Key đã hết hạn. Vui lòng gia hạn.',
                    expires_at: license.expires_at
                });
            }

            // 2. Kiểm tra HWID Binding
            console.log('[OmniMind] Checking device binding for license ID:', license.id);
            const deviceResult = await db.query(
                'SELECT * FROM license_devices WHERE license_id = $1', [license.id]
            );
            const existingDevice = deviceResult.rows[0];

            if (!existingDevice) {
                console.log('[OmniMind] No device bound. Binding new HWID:', hwid);
                // Lần đầu: Gắn HWID
                await db.query(
                    'INSERT INTO license_devices (license_id, hwid, os_name, os_version) VALUES ($1, $2, $3, $4)',
                    [license.id, hwid, os_name || '', os_version || '']
                );
            } else if (existingDevice.hwid !== hwid) {
                console.log('[OmniMind] HWID mismatch. Existing:', existingDevice.hwid, 'New:', hwid);
                // Đã gắn máy khác
                return res.status(403).json({
                    success: false,
                    message: 'License Key đã được kích hoạt trên thiết bị khác. Liên hệ hỗ trợ để chuyển máy.'
                });
            } else {
                console.log('[OmniMind] Correct device. Updating last_login.');
                // Đúng máy: Cập nhật last_login
                await db.query(
                    'UPDATE license_devices SET last_login = NOW(), os_version = $1 WHERE id = $2',
                    [os_version || existingDevice.os_version, existingDevice.id]
                );
            }

            // 3. Tạo JWT Token
            console.log('[OmniMind] Generating JWT token...');
            const token = jwt.sign(
                { license: license_key, plan: license.plan_id || 'Standard', hwid: hwid },
                process.env.API_ENCRYPTION_KEY,
                { expiresIn: '30d' }
            );

            res.json({
                success: true,
                message: 'Kích hoạt thành công!',
                token: token,
                plan: license.plan_id || 'Standard',
                expires_at: license.expires_at
            });

        } catch (err) {
            const errorMsg = `[${new Date().toISOString()}] License verify error: ${err.message}\nStack: ${err.stack}\n`;
            fs.appendFileSync(logFile, errorMsg);
            console.error('[OmniMind] License verify error:', err);
            res.status(500).json({ success: false, message: 'Lỗi máy chủ nội bộ.' });
        }
    });

    // ─────────────────────────────────────────────────────
    // PUBLIC: Kiểm tra phiên bản mới nhất & Changelog
    // ─────────────────────────────────────────────────────
    app.get('/api/v1/omnimind/app/version', async (req, res) => {
        try {
            // Lấy version mới nhất
            const versionResult = await db.query(
                'SELECT * FROM app_versions ORDER BY release_date DESC LIMIT 1'
            );
            if (versionResult.rows.length === 0) {
                return res.json({ latest_version: null, changelogs: [] });
            }

            const latestVersion = versionResult.rows[0];

            // Lấy changelogs của version đó
            const changelogResult = await db.query(
                'SELECT change_type, content FROM changelogs WHERE version_id = $1',
                [latestVersion.version_id]
            );

            res.json({
                latest_version: latestVersion.version_id,
                version_name: latestVersion.version_name,
                is_critical: latestVersion.is_critical,
                download_url: latestVersion.download_url || '',
                release_date: latestVersion.release_date,
                changelogs: changelogResult.rows
            });
        } catch (err) {
            console.error('[OmniMind] Version check error:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // ─────────────────────────────────────────────────────
    // PUBLIC: Lấy link tải Codex CLI & Yêu cầu môi trường
    // ─────────────────────────────────────────────────────
    app.get('/api/v1/omnimind/codex/releases', async (req, res) => {
        // Mock data: Trong thực tế sẽ lấy từ bảng cấu hình hoặc Github API
        res.json({
            version: '1.5.0',
            prerequisites: {
                python: '>=3.9',
                node: '>=18.0'
            },
            platforms: {
                darwin: {
                    url: 'https://github.com/Antigravity-AI/codex-cli/releases/download/v1.5.0/codex-macos-arm64.zip',
                    method: 'zip_extract'
                },
                win32: {
                    url: 'https://github.com/Antigravity-AI/codex-cli/releases/download/v1.5.0/codex-windows-x64.zip',
                    method: 'zip_extract'
                }
            }
        });
    });

    // ─────────────────────────────────────────────────────
    // PUBLIC: Danh mục Skill Marketplace
    // ─────────────────────────────────────────────────────
    app.get('/api/v1/omnimind/skills', async (req, res) => {
        const page = parseInt(req.query.page) || 1;
        const perPage = parseInt(req.query.per_page) || 20;
        const offset = (page - 1) * perPage;

        try {
            const countResult = await db.query('SELECT COUNT(*) FROM marketplace_skills');
            const total = parseInt(countResult.rows[0].count);

            const result = await db.query(
                'SELECT id, name, description, skill_type, price, author, version, is_vip FROM marketplace_skills ORDER BY created_at DESC LIMIT $1 OFFSET $2',
                [perPage, offset]
            );

            res.json({ total, page, per_page: perPage, skills: result.rows });
        } catch (err) {
            console.error('[OmniMind] Skills list error:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // ─────────────────────────────────────────────────────
    // PUBLIC: Manifest chi tiết của 1 Skill
    // ─────────────────────────────────────────────────────
    app.get('/api/v1/omnimind/skills/:id/manifest', async (req, res) => {
        try {
            const result = await db.query(
                'SELECT id, manifest_json FROM marketplace_skills WHERE id = $1',
                [req.params.id]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Skill not found' });
            }
            res.json({
                skill_id: result.rows[0].id,
                ...(result.rows[0].manifest_json || {})
            });
        } catch (err) {
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // ─────────────────────────────────────────────────────
    // ADMIN: Quản lý App Versions (CMS Dashboard)
    // ─────────────────────────────────────────────────────
    app.get('/api/v1/admin/omnimind/versions', authMiddleware, async (req, res) => {
        try {
            const result = await db.query('SELECT * FROM app_versions ORDER BY release_date DESC');
            res.json({ success: true, data: result.rows });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.post('/api/v1/admin/omnimind/versions', authMiddleware, async (req, res) => {
        const { version_id, version_name, is_critical, download_url, changelogs } = req.body;
        try {
            await db.query(
                'INSERT INTO app_versions (version_id, version_name, is_critical, download_url) VALUES ($1, $2, $3, $4) ON CONFLICT (version_id) DO UPDATE SET version_name=$2, is_critical=$3, download_url=$4',
                [version_id, version_name, is_critical || false, download_url || '']
            );

            // Insert changelogs
            if (changelogs && Array.isArray(changelogs)) {
                for (const log of changelogs) {
                    await db.query(
                        'INSERT INTO changelogs (version_id, change_type, content) VALUES ($1, $2, $3)',
                        [version_id, log.type || 'feat', log.content]
                    );
                }
            }

            res.json({ success: true, message: 'Version created' });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ─────────────────────────────────────────────────────
    // ADMIN: Quản lý Skills (CMS Dashboard)
    // ─────────────────────────────────────────────────────
    app.get('/api/v1/admin/omnimind/skills', authMiddleware, async (req, res) => {
        try {
            const result = await db.query('SELECT * FROM marketplace_skills ORDER BY created_at DESC');
            res.json({ success: true, data: result.rows });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.post('/api/v1/admin/omnimind/skills', authMiddleware, async (req, res) => {
        const { id, name, description, skill_type, price, author, version, manifest_json, is_vip } = req.body;
        try {
            await db.query(
                `INSERT INTO marketplace_skills (id, name, description, skill_type, price, author, version, manifest_json, is_vip)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (id) DO UPDATE SET name=$2, description=$3, skill_type=$4, price=$5, author=$6, version=$7, manifest_json=$8, is_vip=$9`,
                [id, name, description, skill_type || 'KNOWLEDGE', price || 0, author, version, manifest_json || {}, is_vip || false]
            );
            res.json({ success: true, message: 'Skill created/updated' });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ─────────────────────────────────────────────────────
    // ADMIN: Xem danh sách thiết bị đã kích hoạt
    // ─────────────────────────────────────────────────────
    app.get('/api/v1/admin/omnimind/devices', authMiddleware, async (req, res) => {
        try {
            const result = await db.query(`
                SELECT ld.*, l.license_key, l.plan_id
                FROM license_devices ld
                JOIN licenses l ON l.id = ld.license_id
                ORDER BY ld.last_login DESC
            `);
            res.json({ success: true, data: result.rows });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    console.log('[OmniMind] Routes loaded successfully.');
};
