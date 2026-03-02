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
    const SUPPORTED_SKILL_TYPES = new Set(['KNOWLEDGE', 'TOOL']);
    const SUPPORTED_PLATFORMS = ['darwin', 'win32', 'linux'];
    const ALLOWED_CAPABILITIES = new Set([
        'screen_capture',
        'camera_access',
        'ui_automation',
        'system_restart',
    ]);

    const toNonEmptyString = (value) => {
        const text = String(value ?? '').trim();
        return text || '';
    };

    const normalizeStringArray = (input) => {
        if (Array.isArray(input)) {
            return [...new Set(input.map((x) => String(x || '').trim()).filter(Boolean))];
        }
        if (typeof input === 'string') {
            return [
                ...new Set(
                    input
                        .split(',')
                        .map((x) => x.trim())
                        .filter(Boolean)
                ),
            ];
        }
        return [];
    };

    const normalizeSkillType = (value) => {
        const normalized = String(value || 'KNOWLEDGE').trim().toUpperCase();
        return SUPPORTED_SKILL_TYPES.has(normalized) ? normalized : 'KNOWLEDGE';
    };

    const normalizePrice = (value) => {
        const num = Number(value || 0);
        return Number.isFinite(num) && num >= 0 ? num : 0;
    };

    const normalizeHexColor = (value, fallback = '#3B82F6') => {
        const raw = toNonEmptyString(value);
        if (!raw) return fallback;
        const m = raw.match(/^#?([0-9a-fA-F]{6})$/);
        if (!m) return fallback;
        return `#${m[1].toUpperCase()}`;
    };

    const parseManifest = (raw, { strict = false } = {}) => {
        if (!raw) return {};
        if (Array.isArray(raw)) {
            if (strict) throw new Error('manifest_json phải là object JSON, không phải array.');
            return {};
        }
        if (typeof raw === 'object') return raw;
        if (typeof raw === 'string') {
            try {
                return JSON.parse(raw);
            } catch (_) {
                if (strict) {
                    throw new Error('manifest_json phải là JSON hợp lệ.');
                }
                return {};
            }
        }
        if (strict) {
            throw new Error('manifest_json phải là object JSON.');
        }
        return {};
    };

    const normalizePlatform = (input = '') => {
        const value = String(input).toLowerCase();
        if (value.includes('darwin') || value.includes('mac')) return 'darwin';
        if (value.includes('win')) return 'win32';
        if (value.includes('linux')) return 'linux';
        return 'unknown';
    };

    const resolveDownloadInfo = (manifest, platformKey) => {
        const sources = [
            manifest?.downloads?.[platformKey],
            manifest?.platforms?.[platformKey],
            manifest?.download?.[platformKey],
            manifest?.download,
            manifest?.artifact,
        ].filter(Boolean);

        for (const src of sources) {
            if (typeof src === 'string' && src.trim()) {
                return { url: src.trim() };
            }
            if (src?.url) {
                return {
                    url: String(src.url).trim(),
                    checksum: src.checksum || src.sha256 || '',
                    size: src.size || null,
                    file_name: src.file_name || src.filename || '',
                };
            }
        }

        if (manifest?.download_url) {
            return { url: String(manifest.download_url).trim() };
        }
        return {};
    };

    const normalizeRequiredCapabilities = (raw) => {
        const values = normalizeStringArray(raw);
        return values.filter((cap) => ALLOWED_CAPABILITIES.has(cap));
    };

    const normalizeSkillManifest = ({
        manifest,
        name,
        description,
        skillType,
        author,
        version,
        isVip = false,
        price = 0,
    }) => {
        const raw = parseManifest(manifest);
        const skillTypeValue = normalizeSkillType(skillType);
        const tags = normalizeStringArray(raw.tags);
        const capabilities = normalizeRequiredCapabilities(
            raw.required_capabilities ?? raw.requiredCapabilities ?? []
        );

        const downloads = {};
        for (const platform of SUPPORTED_PLATFORMS) {
            const data = resolveDownloadInfo(raw, platform);
            if (!data.url) continue;
            downloads[platform] = {
                url: toNonEmptyString(data.url),
                checksum: toNonEmptyString(data.checksum),
                file_name: toNonEmptyString(data.file_name),
                size: Number.isFinite(Number(data.size)) ? Number(data.size) : null,
            };
        }

        const inferredBadge = isVip ? 'VIP' : (price <= 0 ? 'FREE' : (skillTypeValue === 'TOOL' ? 'TOOL' : 'PAID'));
        const inferredColor = isVip ? '#F59E0B' : (skillTypeValue === 'TOOL' ? '#2563EB' : '#3B82F6');

        return {
            metadata_version: toNonEmptyString(raw.metadata_version) || '1.0',
            icon: toNonEmptyString(raw.icon) || '🧩',
            badge: toNonEmptyString(raw.badge) || inferredBadge,
            color: normalizeHexColor(raw.color, inferredColor),
            category: toNonEmptyString(raw.category) || 'general',
            tags,
            short_description: toNonEmptyString(raw.short_description) || toNonEmptyString(description),
            detail_description:
                toNonEmptyString(raw.detail_description) ||
                toNonEmptyString(raw.description) ||
                toNonEmptyString(description),
            required_capabilities: capabilities,
            min_app_version: toNonEmptyString(raw.min_app_version),
            dependencies: normalizeStringArray(raw.dependencies),
            entrypoint: toNonEmptyString(raw.entrypoint),
            author: toNonEmptyString(raw.author) || toNonEmptyString(author),
            version: toNonEmptyString(raw.version) || toNonEmptyString(version),
            name: toNonEmptyString(raw.name) || toNonEmptyString(name),
            downloads,
        };
    };

    const validateSkillPayload = ({ id, name, skill_type, manifest_json }) => {
        const errors = [];
        const normalizedId = toNonEmptyString(id);
        const normalizedName = toNonEmptyString(name);
        const normalizedType = normalizeSkillType(skill_type);

        if (!normalizedId) {
            errors.push('Thiếu id của skill.');
        } else if (!/^[a-z0-9][a-z0-9-_]{1,99}$/i.test(normalizedId)) {
            errors.push('Skill ID chỉ được gồm chữ/số, dấu gạch ngang hoặc gạch dưới (2-100 ký tự).');
        }

        if (!normalizedName) {
            errors.push('Thiếu tên skill.');
        }

        if (!SUPPORTED_SKILL_TYPES.has(normalizedType)) {
            errors.push(`skill_type không hợp lệ. Hỗ trợ: ${[...SUPPORTED_SKILL_TYPES].join(', ')}`);
        }

        const downloads = manifest_json?.downloads || {};
        const downloadCount = SUPPORTED_PLATFORMS.filter((p) => toNonEmptyString(downloads?.[p]?.url)).length;
        if (downloadCount === 0) {
            errors.push('Manifest phải có ít nhất 1 download URL cho darwin/win32/linux.');
        }

        return {
            valid: errors.length === 0,
            errors,
            normalized: {
                id: normalizedId,
                name: normalizedName,
                skill_type: normalizedType,
            },
        };
    };

    const getLicenseRecord = async (licenseKey) => {
        if (!licenseKey) return null;
        const result = await db.query('SELECT * FROM licenses WHERE license_key = $1', [licenseKey]);
        return result.rows[0] || null;
    };

    const isLicenseActive = (license) => {
        if (!license) return false;
        if (license.status !== 'active') return false;
        if (license.expires_at && new Date(license.expires_at) < new Date()) return false;
        return true;
    };

    const canPlanAccessVip = (planId) => {
        const plan = String(planId || '').toLowerCase();
        return ['pro', 'vip', 'enterprise', 'business', 'premium'].some((k) => plan.includes(k));
    };

    const getPurchasedSkillIds = async (licenseKey) => {
        if (!licenseKey) return new Set();
        const result = await db.query(
            'SELECT skill_id FROM purchased_skills WHERE license_key = $1',
            [licenseKey]
        );
        return new Set(result.rows.map((r) => r.skill_id));
    };

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
                "SELECT * FROM app_versions WHERE COALESCE(download_url, '') <> '' ORDER BY release_date DESC LIMIT 1"
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
        const q = String(req.query.q || '').trim();
        const licenseKey = String(req.query.license_key || '').trim();
        const platformKey = normalizePlatform(req.query.os_name || req.query.platform || '');

        try {
            const where = [];
            const params = [];
            let i = 1;

            if (q) {
                where.push(`(name ILIKE $${i} OR description ILIKE $${i})`);
                params.push(`%${q}%`);
                i += 1;
            }

            const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
            const countResult = await db.query(`SELECT COUNT(*) FROM marketplace_skills ${whereSql}`, params);
            const total = parseInt(countResult.rows[0].count);

            params.push(perPage, offset);
            const result = await db.query(
                `SELECT id, name, description, skill_type, price, author, version, is_vip, manifest_json, created_at
                 FROM marketplace_skills
                 ${whereSql}
                 ORDER BY created_at DESC
                 LIMIT $${i} OFFSET $${i + 1}`,
                params
            );

            const license = await getLicenseRecord(licenseKey);
            const hasActiveLicense = isLicenseActive(license);
            const purchasedSet = hasActiveLicense ? await getPurchasedSkillIds(licenseKey) : new Set();

            const skills = result.rows.map((row) => {
                const manifest = normalizeSkillManifest({
                    manifest: row.manifest_json,
                    name: row.name,
                    description: row.description,
                    skillType: row.skill_type,
                    author: row.author,
                    version: row.version,
                    isVip: row.is_vip,
                    price: row.price,
                });
                const isFree = Number(row.price || 0) <= 0 && !row.is_vip;
                const purchased = purchasedSet.has(row.id);
                const vipByPlan = row.is_vip && hasActiveLicense && canPlanAccessVip(license?.plan_id);
                const owned = isFree || purchased || vipByPlan;
                const download = resolveDownloadInfo(manifest, platformKey);

                return {
                    id: row.id,
                    name: row.name,
                    description: row.description,
                    short: manifest.short_description || row.description || '',
                    detail: manifest.detail_description || manifest.description || row.description || '',
                    skill_type: row.skill_type,
                    price: row.price,
                    author: row.author,
                    version: row.version,
                    is_vip: row.is_vip,
                    icon: manifest.icon || '🧩',
                    badge: manifest.badge || (row.is_vip ? 'VIP' : (isFree ? 'FREE' : 'PAID')),
                    color: manifest.color || (row.is_vip ? '#F59E0B' : '#3B82F6'),
                    category: manifest.category || 'general',
                    tags: manifest.tags || [],
                    required_capabilities: manifest.required_capabilities || [],
                    metadata_version: manifest.metadata_version || '1.0',
                    downloads: manifest.downloads || {},
                    download_url: download.url || '',
                    checksum: download.checksum || '',
                    file_name: download.file_name || '',
                    size: download.size || null,
                    is_owned: owned,
                    requires_purchase: !owned,
                    created_at: row.created_at,
                    metadata: manifest,
                };
            });

            res.json({
                total,
                page,
                per_page: perPage,
                platform: platformKey,
                has_active_license: hasActiveLicense,
                skills,
            });
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
                'SELECT id, name, description, skill_type, author, version, manifest_json FROM marketplace_skills WHERE id = $1',
                [req.params.id]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Skill not found' });
            }
            const row = result.rows[0];
            const manifest = normalizeSkillManifest({
                manifest: row.manifest_json,
                name: row.name,
                description: row.description,
                skillType: row.skill_type,
                author: row.author,
                version: row.version,
            });
            res.json({
                skill_id: row.id,
                name: row.name,
                version: row.version,
                ...manifest
            });
        } catch (err) {
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // ─────────────────────────────────────────────────────
    // PUBLIC: Resolve link tải của 1 skill theo HĐH
    // ─────────────────────────────────────────────────────
    app.get('/api/v1/omnimind/skills/:id/download', async (req, res) => {
        const licenseKey = String(req.query.license_key || '').trim();
        const platformKey = normalizePlatform(req.query.os_name || req.query.platform || '');
        try {
            const result = await db.query(
                'SELECT id, name, description, skill_type, author, version, price, is_vip, manifest_json FROM marketplace_skills WHERE id = $1',
                [req.params.id]
            );
            const skill = result.rows[0];
            if (!skill) {
                return res.status(404).json({ success: false, message: 'Skill không tồn tại.' });
            }

            const manifest = normalizeSkillManifest({
                manifest: skill.manifest_json,
                name: skill.name,
                description: skill.description,
                skillType: skill.skill_type,
                author: skill.author,
                version: skill.version,
                isVip: skill.is_vip,
                price: skill.price,
            });
            const download = resolveDownloadInfo(manifest, platformKey);
            if (!download.url) {
                return res.status(400).json({ success: false, message: 'Skill chưa có link tải cho HĐH này.' });
            }

            const isFree = Number(skill.price || 0) <= 0 && !skill.is_vip;
            if (!isFree) {
                const license = await getLicenseRecord(licenseKey);
                if (!isLicenseActive(license)) {
                    return res.status(403).json({ success: false, message: 'Cần license hợp lệ để tải skill này.' });
                }

                const purchasedSet = await getPurchasedSkillIds(licenseKey);
                const vipByPlan = skill.is_vip && canPlanAccessVip(license.plan_id);
                if (!purchasedSet.has(skill.id) && !vipByPlan) {
                    return res.status(403).json({ success: false, message: 'Skill chưa được cấp quyền cho license này.' });
                }
            }

            res.json({
                success: true,
                skill_id: skill.id,
                name: skill.name,
                version: skill.version,
                platform: platformKey,
                url: download.url,
                checksum: download.checksum || '',
                file_name: download.file_name || '',
                size: download.size || null,
            });
        } catch (err) {
            console.error('[OmniMind] Skill download resolve error:', err);
            res.status(500).json({ success: false, message: 'Lỗi máy chủ nội bộ.' });
        }
    });

    // ─────────────────────────────────────────────────────
    // PUBLIC: Mua/Cấp quyền 1 skill cho license
    // ─────────────────────────────────────────────────────
    app.post('/api/v1/omnimind/skills/:id/purchase', async (req, res) => {
        const skillId = req.params.id;
        const { license_key } = req.body;
        if (!license_key) {
            return res.status(400).json({ success: false, message: 'Thiếu license_key.' });
        }
        try {
            const license = await getLicenseRecord(license_key);
            if (!isLicenseActive(license)) {
                return res.status(403).json({ success: false, message: 'License không hợp lệ hoặc đã hết hạn.' });
            }

            const skillResult = await db.query('SELECT id, price, is_vip FROM marketplace_skills WHERE id = $1', [skillId]);
            const skill = skillResult.rows[0];
            if (!skill) {
                return res.status(404).json({ success: false, message: 'Skill không tồn tại.' });
            }

            const existsResult = await db.query(
                'SELECT id FROM purchased_skills WHERE skill_id = $1 AND license_key = $2 LIMIT 1',
                [skillId, license_key]
            );
            if (existsResult.rows.length > 0) {
                return res.json({ success: true, message: 'Skill đã được cấp quyền trước đó.' });
            }

            const isFree = Number(skill.price || 0) <= 0 && !skill.is_vip;
            const vipByPlan = skill.is_vip && canPlanAccessVip(license.plan_id);
            if (!isFree && !vipByPlan) {
                await db.query(
                    'INSERT INTO purchased_skills (skill_id, license_key, purchased_at) VALUES ($1, $2, NOW())',
                    [skillId, license_key]
                );
            } else {
                // Miễn phí hoặc VIP theo plan vẫn lưu receipt để đồng bộ ownership.
                await db.query(
                    'INSERT INTO purchased_skills (skill_id, license_key, purchased_at) VALUES ($1, $2, NOW())',
                    [skillId, license_key]
                );
            }

            res.json({ success: true, message: 'Đã cấp quyền skill thành công.' });
        } catch (err) {
            console.error('[OmniMind] Skill purchase error:', err);
            res.status(500).json({ success: false, message: 'Lỗi máy chủ nội bộ.' });
        }
    });

    // ─────────────────────────────────────────────────────
    // PUBLIC: Danh sách skill đã cấp cho license
    // ─────────────────────────────────────────────────────
    app.get('/api/v1/omnimind/licenses/:license_key/skills', async (req, res) => {
        const licenseKey = req.params.license_key;
        try {
            const license = await getLicenseRecord(licenseKey);
            if (!isLicenseActive(license)) {
                return res.status(403).json({ success: false, message: 'License không hợp lệ hoặc đã hết hạn.' });
            }
            const result = await db.query(
                `SELECT ps.skill_id, ps.purchased_at, ms.name, ms.version
                 FROM purchased_skills ps
                 JOIN marketplace_skills ms ON ms.id = ps.skill_id
                 WHERE ps.license_key = $1
                 ORDER BY ps.purchased_at DESC`,
                [licenseKey]
            );
            res.json({ success: true, skills: result.rows });
        } catch (err) {
            console.error('[OmniMind] License skills error:', err);
            res.status(500).json({ success: false, message: 'Lỗi máy chủ nội bộ.' });
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
            const msg = String(err?.message || 'Internal server error');
            const statusCode = msg.toLowerCase().includes('manifest_json') ? 400 : 500;
            res.status(statusCode).json({ success: false, error: msg });
        }
    });

    app.get('/api/v1/admin/omnimind/versions/:id', authMiddleware, async (req, res) => {
        const versionId = req.params.id;
        try {
            const versionResult = await db.query(
                'SELECT * FROM app_versions WHERE version_id = $1 LIMIT 1',
                [versionId]
            );
            if (versionResult.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Version not found' });
            }
            const changelogResult = await db.query(
                'SELECT change_type, content FROM changelogs WHERE version_id = $1 ORDER BY id ASC',
                [versionId]
            );
            res.json({
                success: true,
                data: {
                    ...versionResult.rows[0],
                    changelogs: changelogResult.rows,
                },
            });
        } catch (err) {
            const msg = String(err?.message || 'Internal server error');
            const statusCode = msg.toLowerCase().includes('manifest_json') ? 400 : 500;
            res.status(statusCode).json({ success: false, error: msg });
        }
    });

    app.post('/api/v1/admin/omnimind/versions', authMiddleware, async (req, res) => {
        const { version_id, version_name, is_critical, download_url, changelogs } = req.body;
        try {
            await db.query(
                'INSERT INTO app_versions (version_id, version_name, is_critical, download_url) VALUES ($1, $2, $3, $4) ON CONFLICT (version_id) DO UPDATE SET version_name=$2, is_critical=$3, download_url=$4',
                [version_id, version_name, is_critical || false, download_url || '']
            );

            // Reset changelogs cũ để tránh duplicate mỗi lần update version.
            await db.query('DELETE FROM changelogs WHERE version_id = $1', [version_id]);

            // Insert changelogs mới
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

    app.delete('/api/v1/admin/omnimind/versions/:id', authMiddleware, async (req, res) => {
        const versionId = req.params.id;
        try {
            // ON DELETE CASCADE sẽ xoá changelogs liên quan.
            const result = await db.query('DELETE FROM app_versions WHERE version_id = $1 RETURNING version_id', [versionId]);
            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Version not found' });
            }
            res.json({ success: true, message: 'Version deleted' });
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
            const normalizedRows = result.rows.map((row) => {
                const manifest = normalizeSkillManifest({
                    manifest: row.manifest_json,
                    name: row.name,
                    description: row.description,
                    skillType: row.skill_type,
                    author: row.author,
                    version: row.version,
                    isVip: row.is_vip,
                    price: row.price,
                });
                return { ...row, manifest_json: manifest };
            });
            res.json({ success: true, data: normalizedRows });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.post('/api/v1/admin/omnimind/skills', authMiddleware, async (req, res) => {
        const { id, name, description, skill_type, price, author, version, manifest_json, is_vip } = req.body;
        try {
            const normalizedType = normalizeSkillType(skill_type || 'KNOWLEDGE');
            const normalizedPrice = normalizePrice(price);
            const normalizedVip = Boolean(is_vip);
            const parsedManifest = parseManifest(manifest_json, { strict: manifest_json !== undefined });
            const manifest = normalizeSkillManifest({
                manifest: parsedManifest,
                name,
                description,
                skillType: normalizedType,
                author,
                version,
                isVip: normalizedVip,
                price: normalizedPrice,
            });
            const validation = validateSkillPayload({
                id,
                name,
                skill_type: normalizedType,
                manifest_json: manifest,
            });
            if (!validation.valid) {
                return res.status(400).json({ success: false, error: validation.errors.join(' ') });
            }

            await db.query(
                `INSERT INTO marketplace_skills (id, name, description, skill_type, price, author, version, manifest_json, is_vip)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (id) DO UPDATE SET name=$2, description=$3, skill_type=$4, price=$5, author=$6, version=$7, manifest_json=$8, is_vip=$9`,
                [
                    validation.normalized.id,
                    validation.normalized.name,
                    toNonEmptyString(description),
                    validation.normalized.skill_type,
                    normalizedPrice,
                    toNonEmptyString(author),
                    toNonEmptyString(version),
                    manifest,
                    normalizedVip,
                ]
            );
            res.json({ success: true, message: 'Skill created/updated' });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.patch('/api/v1/admin/omnimind/skills/:id', authMiddleware, async (req, res) => {
        const skillId = req.params.id;
        try {
            if (!req.body || Object.keys(req.body).length === 0) {
                return res.status(400).json({ success: false, error: 'No fields provided' });
            }

            const existingResult = await db.query('SELECT * FROM marketplace_skills WHERE id = $1 LIMIT 1', [skillId]);
            if (existingResult.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Skill not found' });
            }
            const existing = existingResult.rows[0];
            const nextName = req.body.name !== undefined ? req.body.name : existing.name;
            const nextDescription = req.body.description !== undefined ? req.body.description : existing.description;
            const nextType = normalizeSkillType(req.body.skill_type !== undefined ? req.body.skill_type : existing.skill_type);
            const nextPrice = normalizePrice(req.body.price !== undefined ? req.body.price : existing.price);
            const nextAuthor = req.body.author !== undefined ? req.body.author : existing.author;
            const nextVersion = req.body.version !== undefined ? req.body.version : existing.version;
            const nextVip = req.body.is_vip !== undefined ? Boolean(req.body.is_vip) : Boolean(existing.is_vip);
            const parsedManifest = parseManifest(
                req.body.manifest_json !== undefined ? req.body.manifest_json : existing.manifest_json,
                { strict: req.body.manifest_json !== undefined }
            );
            const manifest = normalizeSkillManifest({
                manifest: parsedManifest,
                name: nextName,
                description: nextDescription,
                skillType: nextType,
                author: nextAuthor,
                version: nextVersion,
                isVip: nextVip,
                price: nextPrice,
            });
            const validation = validateSkillPayload({
                id: existing.id,
                name: nextName,
                skill_type: nextType,
                manifest_json: manifest,
            });
            if (!validation.valid) {
                return res.status(400).json({ success: false, error: validation.errors.join(' ') });
            }

            const result = await db.query(
                `UPDATE marketplace_skills
                 SET name = $1,
                     description = $2,
                     skill_type = $3,
                     price = $4,
                     author = $5,
                     version = $6,
                     manifest_json = $7,
                     is_vip = $8
                 WHERE id = $9
                 RETURNING *`,
                [
                    validation.normalized.name,
                    toNonEmptyString(nextDescription),
                    validation.normalized.skill_type,
                    nextPrice,
                    toNonEmptyString(nextAuthor),
                    toNonEmptyString(nextVersion),
                    manifest,
                    nextVip,
                    existing.id,
                ]
            );
            res.json({ success: true, data: result.rows[0] });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.delete('/api/v1/admin/omnimind/skills/:id', authMiddleware, async (req, res) => {
        const skillId = req.params.id;
        try {
            await db.query('DELETE FROM purchased_skills WHERE skill_id = $1', [skillId]);
            const result = await db.query('DELETE FROM marketplace_skills WHERE id = $1 RETURNING id', [skillId]);
            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Skill not found' });
            }
            res.json({ success: true, message: 'Skill deleted' });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.post('/api/v1/admin/omnimind/skills/:id/grant', authMiddleware, async (req, res) => {
        const skillId = req.params.id;
        const { license_key } = req.body;
        if (!license_key) {
            return res.status(400).json({ success: false, error: 'license_key is required' });
        }
        try {
            const skillResult = await db.query('SELECT id FROM marketplace_skills WHERE id = $1', [skillId]);
            if (skillResult.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Skill not found' });
            }
            const license = await getLicenseRecord(license_key);
            if (!isLicenseActive(license)) {
                return res.status(403).json({ success: false, error: 'License invalid/inactive' });
            }
            const exists = await db.query(
                'SELECT id FROM purchased_skills WHERE skill_id = $1 AND license_key = $2 LIMIT 1',
                [skillId, license_key]
            );
            if (exists.rows.length === 0) {
                await db.query(
                    'INSERT INTO purchased_skills (skill_id, license_key, purchased_at) VALUES ($1, $2, NOW())',
                    [skillId, license_key]
                );
            }
            res.json({ success: true, message: 'Granted successfully' });
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
