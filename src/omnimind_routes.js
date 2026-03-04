/**
 * OmniMind API Routes
 * Tách riêng khỏi index.js để dễ bảo trì.
 * Import vào index.js bằng: require('./omnimind_routes')(app, db, authMiddleware);
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const logFile = path.join(__dirname, '../debug_omnimind.log');
const SKILL_ARTIFACTS_DIR = process.env.OMNIMIND_SKILL_ARTIFACTS_DIR
    ? path.resolve(process.env.OMNIMIND_SKILL_ARTIFACTS_DIR)
    : path.resolve(__dirname, '../skill-artifacts');

module.exports = function (app, db, authMiddleware) {
    const SUPPORTED_SKILL_TYPES = new Set(['KNOWLEDGE', 'TOOL']);
    const SUPPORTED_PLATFORMS = ['darwin', 'win32', 'linux'];
    const SUPPORTED_ARCH_BY_PLATFORM = {
        darwin: ['arm64', 'x64'],
        win32: ['x64', 'arm64'],
        linux: ['x64', 'arm64'],
    };
    const DEFAULT_CODEX_RELEASE_MATRIX = {
        darwin: {
            arm64: {
                version: '1.5.0',
                url: 'https://github.com/Antigravity-AI/codex-cli/releases/download/v1.5.0/codex-macos-arm64.zip',
                method: 'zip_extract',
                checksum: '',
                file_name: 'codex-macos-arm64.zip',
            },
        },
        win32: {
            x64: {
                version: '1.5.0',
                url: 'https://github.com/Antigravity-AI/codex-cli/releases/download/v1.5.0/codex-windows-x64.zip',
                method: 'zip_extract',
                checksum: '',
                file_name: 'codex-windows-x64.zip',
            },
        },
        linux: {},
    };
    const ALLOWED_CAPABILITIES = new Set([
        'screen_capture',
        'camera_access',
        'ui_automation',
        'system_restart',
    ]);
    const DEFAULT_LICENSE_PLANS = [
        {
            plan_id: 'standard_30d',
            display_name: 'Standard 30 ngày',
            duration_days: 30,
            price: 99000,
            is_active: true,
            note: 'Gói cơ bản cho người dùng cá nhân.',
        },
        {
            plan_id: 'pro_90d',
            display_name: 'Pro 90 ngày',
            duration_days: 90,
            price: 249000,
            is_active: true,
            note: 'Gói Pro hỗ trợ dùng skill VIP.',
        },
    ];

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

    const normalizeArch = (platformKey, input = '') => {
        const raw = String(input || '').trim().toLowerCase();
        const alias = {
            x86_64: 'x64',
            amd64: 'x64',
            x64: 'x64',
            i386: 'x86',
            i686: 'x86',
            aarch64: 'arm64',
            arm64: 'arm64',
            armv7l: 'armv7',
        };
        const normalized = alias[raw] || raw || 'unknown';
        const supported = SUPPORTED_ARCH_BY_PLATFORM[platformKey] || [];
        if (!supported.length) return normalized;
        if (supported.includes(normalized)) return normalized;
        return normalized;
    };

    const isSupportedReleaseTarget = (platformKey, arch) => {
        if (!SUPPORTED_PLATFORMS.includes(platformKey)) return false;
        const supported = SUPPORTED_ARCH_BY_PLATFORM[platformKey] || [];
        if (!supported.length) return true;
        return supported.includes(arch);
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

    const buildRequestBaseUrl = (req) => {
        const proto = toNonEmptyString(req.headers['x-forwarded-proto'] || req.protocol || 'https');
        const host = toNonEmptyString(req.headers['x-forwarded-host'] || req.get('host'));
        if (!host) return '';
        return `${proto}://${host}`;
    };

    const rewriteSkillArtifactUrlIfNeeded = (downloadUrl, req) => {
        const raw = toNonEmptyString(downloadUrl);
        if (!raw) return raw;
        const base = buildRequestBaseUrl(req);
        if (!base) return raw;

        let parsed = null;
        try {
            parsed = new URL(raw, base);
        } catch (_) {
            return raw;
        }

        const pathName = toNonEmptyString(parsed.pathname);
        const m = pathName.match(/^\/skills\/([A-Za-z0-9._\-]+\.(?:zip|tar|tgz|tar\.gz))$/i);
        if (!m) return raw;
        const fileName = m[1];
        return `${base}/api/v1/omnimind/skills/artifacts/${encodeURIComponent(fileName)}`;
    };

    const normalizeCodexReleaseRecord = (raw = {}) => {
        const platform = normalizePlatform(raw.platform || raw.os_name || '');
        const arch = normalizeArch(platform, raw.arch || raw.cpu_arch || '');
        const version = toNonEmptyString(raw.version);
        const url = toNonEmptyString(raw.url);
        const method = toNonEmptyString(raw.method) || 'zip_extract';
        const checksum = toNonEmptyString(raw.checksum);
        const fileName = toNonEmptyString(raw.file_name);
        const channel = toNonEmptyString(raw.channel) || 'stable';
        const notes = toNonEmptyString(raw.notes);

        const sizeVal = Number(raw.size_bytes ?? raw.size ?? null);
        const sizeBytes = Number.isFinite(sizeVal) && sizeVal > 0 ? Math.trunc(sizeVal) : null;
        const isActive = raw.is_active === undefined ? true : Boolean(raw.is_active);

        return {
            platform,
            arch,
            version,
            url,
            method,
            checksum,
            file_name: fileName,
            size_bytes: sizeBytes,
            channel,
            notes,
            is_active: isActive,
        };
    };

    let codexReleaseSchemaReady = false;
    const ensureCodexReleaseSchema = async () => {
        if (codexReleaseSchemaReady) return;
        await db.query(`
            CREATE TABLE IF NOT EXISTS omnimind_codex_releases (
                id SERIAL PRIMARY KEY,
                platform VARCHAR(20) NOT NULL,
                arch VARCHAR(20) NOT NULL,
                channel VARCHAR(20) NOT NULL DEFAULT 'stable',
                version VARCHAR(40) NOT NULL,
                url TEXT NOT NULL,
                checksum VARCHAR(128) DEFAULT '',
                file_name VARCHAR(255) DEFAULT '',
                size_bytes BIGINT,
                method VARCHAR(32) NOT NULL DEFAULT 'zip_extract',
                notes TEXT DEFAULT '',
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await db.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS ux_omnimind_codex_release_target
            ON omnimind_codex_releases (platform, arch, channel)
        `);
        codexReleaseSchemaReady = true;
    };

    let appVersionSchemaReady = false;
    const ensureAppVersionSchema = async () => {
        if (appVersionSchemaReady) return;
        const safeSchemaQuery = async (sql) => {
            try {
                await db.query(sql);
            } catch (err) {
                const code = String(err?.code || '');
                const msg = String(err?.message || '').toLowerCase();
                if (
                    code === '42701' || // duplicate_column
                    code === '42P07' || // duplicate_table
                    code === '42710' || // duplicate_object
                    msg.includes('already exists')
                ) {
                    return;
                }
                throw err;
            }
        };
        await safeSchemaQuery(`ALTER TABLE app_versions ADD COLUMN IF NOT EXISTS checksum_sha256 VARCHAR(128) DEFAULT ''`);
        await safeSchemaQuery(`ALTER TABLE app_versions ADD COLUMN IF NOT EXISTS package_size_bytes BIGINT`);
        appVersionSchemaReady = true;
    };

    const rowToCodexRelease = (row = {}) => ({
        id: row.id,
        platform: toNonEmptyString(row.platform),
        arch: toNonEmptyString(row.arch),
        channel: toNonEmptyString(row.channel) || 'stable',
        version: toNonEmptyString(row.version),
        url: toNonEmptyString(row.url),
        checksum: toNonEmptyString(row.checksum),
        file_name: toNonEmptyString(row.file_name),
        size_bytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
        method: toNonEmptyString(row.method) || 'zip_extract',
        notes: toNonEmptyString(row.notes),
        is_active: Boolean(row.is_active),
        created_at: row.created_at,
        updated_at: row.updated_at,
    });

    const buildCodexManifest = (releases, requestedPlatform, requestedArch) => {
        const matrix = {};
        for (const platformKey of SUPPORTED_PLATFORMS) {
            matrix[platformKey] = {};
        }

        const byTarget = new Map();
        for (const rel of releases || []) {
            const key = `${rel.platform}:${rel.arch}`;
            byTarget.set(key, rel);
            matrix[rel.platform] = matrix[rel.platform] || {};
            matrix[rel.platform][rel.arch] = {
                version: rel.version,
                url: rel.url,
                method: rel.method,
                checksum: rel.checksum,
                file_name: rel.file_name,
                size: rel.size_bytes,
            };
        }

        const fallbackToDefault = (platformKey, arch) => {
            const defaultMap = DEFAULT_CODEX_RELEASE_MATRIX[platformKey] || {};
            const item = defaultMap[arch];
            if (!item || !item.url) return null;
            return {
                platform: platformKey,
                arch,
                channel: 'stable',
                version: item.version || '1.5.0',
                url: item.url,
                checksum: item.checksum || '',
                file_name: item.file_name || '',
                size_bytes: item.size_bytes || null,
                method: item.method || 'zip_extract',
            };
        };

        let selected = byTarget.get(`${requestedPlatform}:${requestedArch}`) || null;
        if (!selected) {
            const platformRows = (releases || []).filter((x) => x.platform === requestedPlatform);
            selected = platformRows.find((x) => x.arch === 'x64')
                || platformRows.find((x) => x.arch === 'arm64')
                || platformRows[0]
                || null;
        }
        if (!selected) {
            selected = fallbackToDefault(requestedPlatform, requestedArch)
                || fallbackToDefault(requestedPlatform, 'x64')
                || fallbackToDefault(requestedPlatform, 'arm64');
        }

        // Bổ sung fallback mặc định vào matrix nếu DB chưa có record.
        for (const platformKey of Object.keys(DEFAULT_CODEX_RELEASE_MATRIX)) {
            for (const arch of Object.keys(DEFAULT_CODEX_RELEASE_MATRIX[platformKey] || {})) {
                const key = `${platformKey}:${arch}`;
                if (byTarget.has(key)) continue;
                const item = DEFAULT_CODEX_RELEASE_MATRIX[platformKey][arch];
                matrix[platformKey] = matrix[platformKey] || {};
                matrix[platformKey][arch] = {
                    version: item.version || '1.5.0',
                    url: item.url,
                    method: item.method || 'zip_extract',
                    checksum: item.checksum || '',
                    file_name: item.file_name || '',
                    size: item.size_bytes || null,
                };
            }
        }

        const legacyPlatforms = {};
        for (const platformKey of SUPPORTED_PLATFORMS) {
            const m = matrix[platformKey] || {};
            const candidate = m[requestedArch] || m.x64 || m.arm64 || Object.values(m)[0];
            if (candidate?.url) {
                legacyPlatforms[platformKey] = {
                    url: candidate.url,
                    method: candidate.method || 'zip_extract',
                    checksum: candidate.checksum || '',
                    file_name: candidate.file_name || '',
                    size: candidate.size ?? null,
                };
            }
        }

        return {
            version: selected?.version || '1.5.0',
            prerequisites: { python: '>=3.9', node: '>=18.0' },
            install_policy: {
                auto_install_runtime: true,
                windows: {
                    python_package_id: 'Python.Python.3.11',
                    node_package_id: 'OpenJS.NodeJS',
                },
                darwin: {
                    python_formula: 'python',
                    node_formula: 'node',
                },
            },
            platform: requestedPlatform,
            arch: requestedArch,
            selected: selected
                ? {
                    platform: selected.platform,
                    arch: selected.arch,
                    version: selected.version,
                    url: selected.url,
                    method: selected.method || 'zip_extract',
                    checksum: selected.checksum || '',
                    file_name: selected.file_name || '',
                    size: selected.size_bytes ?? null,
                }
                : {},
            matrix,
            platforms: legacyPlatforms,
        };
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

    const toMoneyNumber = (value) => {
        const num = Number(value || 0);
        if (!Number.isFinite(num) || num < 0) return 0;
        return Math.round(num * 100) / 100;
    };

    let paymentSchemaReady = false;
    const ensurePaymentSchema = async () => {
        if (paymentSchemaReady) return;
        const safeSchemaQuery = async (sql) => {
            try {
                await db.query(sql);
            } catch (err) {
                const code = String(err?.code || '');
                const msg = String(err?.message || '').toLowerCase();
                if (
                    code === '42P07' || // duplicate_table
                    code === '42710' || // duplicate_object
                    code === '23505' || // unique_violation (rare race condition on pg_type)
                    msg.includes('already exists') ||
                    msg.includes('pg_type_typname_nsp_index')
                ) {
                    return;
                }
                throw err;
            }
        };

        await safeSchemaQuery(`
            CREATE TABLE IF NOT EXISTS omnimind_payment_config (
                id SERIAL PRIMARY KEY,
                config_key VARCHAR(100) NOT NULL UNIQUE,
                config_value TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await safeSchemaQuery(`
            CREATE TABLE IF NOT EXISTS omnimind_skill_price_overrides (
                id SERIAL PRIMARY KEY,
                skill_id VARCHAR(100) NOT NULL REFERENCES marketplace_skills(id) ON DELETE CASCADE,
                override_price NUMERIC(12,2),
                discount_percent NUMERIC(5,2),
                starts_at TIMESTAMP,
                ends_at TIMESTAMP,
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                note TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CHECK (override_price IS NULL OR override_price >= 0),
                CHECK (discount_percent IS NULL OR (discount_percent >= 0 AND discount_percent <= 100))
            )
        `);
        await safeSchemaQuery(`
            CREATE INDEX IF NOT EXISTS idx_omnimind_skill_price_overrides_skill_active
            ON omnimind_skill_price_overrides(skill_id, is_active, starts_at, ends_at, created_at DESC)
        `);
        await safeSchemaQuery(`
            CREATE TABLE IF NOT EXISTS omnimind_license_plan_prices (
                plan_id VARCHAR(50) PRIMARY KEY,
                display_name VARCHAR(120) NOT NULL,
                duration_days INTEGER NOT NULL,
                price NUMERIC(12,2) NOT NULL DEFAULT 0,
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                note TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CHECK (duration_days > 0),
                CHECK (price >= 0)
            )
        `);
        await safeSchemaQuery(`
            CREATE INDEX IF NOT EXISTS idx_omnimind_license_plan_prices_active
            ON omnimind_license_plan_prices(is_active, price, duration_days)
        `);

        await safeSchemaQuery(`
            CREATE TABLE IF NOT EXISTS omnimind_sepay_transactions (
                id SERIAL PRIMARY KEY,
                sepay_id BIGINT NOT NULL UNIQUE,
                gateway VARCHAR(50),
                transaction_date TIMESTAMP,
                account_number VARCHAR(40),
                code VARCHAR(80),
                content VARCHAR(255),
                transfer_type VARCHAR(10),
                transfer_amount NUMERIC(12,2) NOT NULL,
                accumulated NUMERIC(14,2),
                sub_account VARCHAR(80),
                reference_code VARCHAR(120),
                description TEXT,
                raw_payload JSONB,
                status VARCHAR(20) NOT NULL DEFAULT 'received',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await safeSchemaQuery(`
            CREATE INDEX IF NOT EXISTS idx_omnimind_sepay_transactions_content
            ON omnimind_sepay_transactions(content)
        `);
        await safeSchemaQuery(`
            CREATE TABLE IF NOT EXISTS omnimind_payment_audit_logs (
                id SERIAL PRIMARY KEY,
                transaction_id VARCHAR(100),
                event_type VARCHAR(50) NOT NULL,
                detail_json JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await safeSchemaQuery(`
            CREATE INDEX IF NOT EXISTS idx_omnimind_payment_audit_logs_tx
            ON omnimind_payment_audit_logs(transaction_id, created_at DESC)
        `);

        await safeSchemaQuery(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS provider VARCHAR(20)`);
        await safeSchemaQuery(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS provider_order_code VARCHAR(80)`);
        await safeSchemaQuery(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS provider_transaction_id VARCHAR(120)`);
        await safeSchemaQuery(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_content VARCHAR(120)`);
        await safeSchemaQuery(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS currency VARCHAR(8) DEFAULT 'VND'`);
        await safeSchemaQuery(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS qr_url TEXT`);
        await safeSchemaQuery(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP`);
        await safeSchemaQuery(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP`);
        await safeSchemaQuery(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS raw_payload JSONB`);
        await safeSchemaQuery(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS failure_reason TEXT`);
        await safeSchemaQuery(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
        await safeSchemaQuery(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS price_snapshot JSONB`);
        await safeSchemaQuery(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS discount_snapshot JSONB`);
        await safeSchemaQuery(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS metadata_json JSONB`);

        await safeSchemaQuery(`
            CREATE UNIQUE INDEX IF NOT EXISTS ux_omnimind_transactions_provider_txid
            ON transactions(provider, provider_transaction_id)
            WHERE provider_transaction_id IS NOT NULL
        `);
        await safeSchemaQuery(`
            CREATE INDEX IF NOT EXISTS idx_omnimind_transactions_lookup
            ON transactions(type, item_id, license_key, status, created_at DESC)
        `);
        await safeSchemaQuery(`
            CREATE INDEX IF NOT EXISTS idx_omnimind_transactions_content
            ON transactions(payment_content)
        `);
        await safeSchemaQuery(`
            CREATE UNIQUE INDEX IF NOT EXISTS ux_omnimind_purchased_skills
            ON purchased_skills(skill_id, license_key)
        `);

        paymentSchemaReady = true;
    };

    let paymentConfigCache = null;
    let paymentConfigFetchedAt = 0;
    const PAYMENT_CONFIG_TTL_MS = 60 * 1000;

    const loadPaymentConfigMap = async () => {
        await ensurePaymentSchema();
        const nowTs = Date.now();
        if (paymentConfigCache && nowTs - paymentConfigFetchedAt < PAYMENT_CONFIG_TTL_MS) {
            return paymentConfigCache;
        }
        const result = await db.query('SELECT config_key, config_value FROM omnimind_payment_config');
        const map = new Map();
        for (const row of result.rows) {
            map.set(row.config_key, row.config_value);
        }
        paymentConfigCache = map;
        paymentConfigFetchedAt = nowTs;
        return map;
    };

    const getPaymentConfig = async () => {
        const map = await loadPaymentConfigMap();
        const get = (key, fallback = '') => toNonEmptyString(map.get(key) || fallback);
        const rawPrefix = get('payment_content_prefix', process.env.OMNIMIND_PAYMENT_CONTENT_PREFIX || 'OMNI');
        const paymentContentPrefix = rawPrefix.replace(/[^a-zA-Z0-9]/g, '').toUpperCase() || 'OMNI';
        return {
            bank_code: get('bank_code', process.env.OMNIMIND_BANK_CODE || ''),
            bank_account: get('bank_account', process.env.OMNIMIND_BANK_ACCOUNT || ''),
            bank_account_name: get('bank_account_name', process.env.OMNIMIND_BANK_ACCOUNT_NAME || ''),
            qr_base_url: get('qr_base_url', process.env.OMNIMIND_QR_BASE_URL || 'https://img.vietqr.io/image'),
            sepay_api_key: get('sepay_api_key', process.env.OMNIMIND_SEPAY_API_KEY || ''),
            payment_content_prefix: paymentContentPrefix,
        };
    };

    const getActiveSkillOverrideMap = async (skillIds = []) => {
        await ensurePaymentSchema();
        const uniqIds = [...new Set((skillIds || []).map((x) => toNonEmptyString(x)).filter(Boolean))];
        if (!uniqIds.length) return new Map();

        const result = await db.query(
            `
                SELECT DISTINCT ON (skill_id)
                    id, skill_id, override_price, discount_percent, starts_at, ends_at, is_active, note, created_at
                FROM omnimind_skill_price_overrides
                WHERE skill_id = ANY($1)
                  AND is_active = TRUE
                  AND (starts_at IS NULL OR starts_at <= NOW())
                  AND (ends_at IS NULL OR ends_at >= NOW())
                ORDER BY skill_id, created_at DESC, id DESC
            `,
            [uniqIds]
        );
        const out = new Map();
        for (const row of result.rows) {
            out.set(row.skill_id, row);
        }
        return out;
    };

    const resolveSkillPricing = (skillRow, overrideRow = null) => {
        const basePrice = toMoneyNumber(skillRow?.price || 0);
        let effectivePrice = basePrice;
        let source = 'base_price';
        let overridePrice = null;
        let discountPercent = null;

        if (overrideRow) {
            if (overrideRow.override_price !== null && overrideRow.override_price !== undefined) {
                overridePrice = toMoneyNumber(overrideRow.override_price);
                effectivePrice = overridePrice;
                source = 'override_price';
            } else if (overrideRow.discount_percent !== null && overrideRow.discount_percent !== undefined) {
                discountPercent = Number(overrideRow.discount_percent);
                if (!Number.isFinite(discountPercent) || discountPercent < 0) {
                    discountPercent = 0;
                }
                if (discountPercent > 100) discountPercent = 100;
                effectivePrice = toMoneyNumber(basePrice * (1 - discountPercent / 100));
                source = 'discount_percent';
            }
        }

        const discountAmount = toMoneyNumber(Math.max(0, basePrice - effectivePrice));
        return {
            currency: 'VND',
            base_price: basePrice,
            effective_price: effectivePrice,
            discount_amount: discountAmount,
            discount_percent: discountPercent,
            override_price: overridePrice,
            pricing_source: source,
            override_id: overrideRow?.id || null,
            override_note: toNonEmptyString(overrideRow?.note || ''),
        };
    };

    const rowToLicensePlan = (row = {}) => ({
        plan_id: toNonEmptyString(row.plan_id),
        display_name: toNonEmptyString(row.display_name),
        duration_days: Number(row.duration_days || 0),
        price: toMoneyNumber(row.price || 0),
        is_active: Boolean(row.is_active),
        note: toNonEmptyString(row.note),
        created_at: row.created_at,
        updated_at: row.updated_at,
    });

    const ensureDefaultLicensePlans = async () => {
        await ensurePaymentSchema();
        const countResult = await db.query('SELECT COUNT(1) AS total FROM omnimind_license_plan_prices');
        const total = Number(countResult.rows?.[0]?.total || 0);
        if (total > 0) return;

        for (const item of DEFAULT_LICENSE_PLANS) {
            await db.query(
                `INSERT INTO omnimind_license_plan_prices
                    (plan_id, display_name, duration_days, price, is_active, note, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
                 ON CONFLICT(plan_id) DO UPDATE SET
                    display_name = EXCLUDED.display_name,
                    duration_days = EXCLUDED.duration_days,
                    price = EXCLUDED.price,
                    is_active = EXCLUDED.is_active,
                    note = EXCLUDED.note,
                    updated_at = NOW()`,
                [
                    toNonEmptyString(item.plan_id),
                    toNonEmptyString(item.display_name),
                    Number(item.duration_days || 30),
                    toMoneyNumber(item.price || 0),
                    Boolean(item.is_active),
                    toNonEmptyString(item.note),
                ]
            );
        }
    };

    const getLicensePlanById = async (planId, { activeOnly = true } = {}) => {
        await ensureDefaultLicensePlans();
        const pid = toNonEmptyString(planId);
        if (!pid) return null;
        const clauses = activeOnly ? 'AND is_active = TRUE' : '';
        const result = await db.query(
            `SELECT * FROM omnimind_license_plan_prices WHERE plan_id = $1 ${clauses} LIMIT 1`,
            [pid]
        );
        return result.rows[0] || null;
    };

    const parseJsonObject = (input, fallback = {}) => {
        if (!input) return { ...fallback };
        if (typeof input === 'object' && !Array.isArray(input)) {
            return { ...fallback, ...input };
        }
        if (typeof input === 'string') {
            try {
                const parsed = JSON.parse(input);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return { ...fallback, ...parsed };
                }
            } catch (_) {
                return { ...fallback };
            }
        }
        return { ...fallback };
    };

    const addDays = (baseDate, days) => {
        const d = new Date(baseDate);
        d.setDate(d.getDate() + Number(days || 0));
        return d;
    };

    const generateLicenseKey = (planId = 'STANDARD') => {
        const prefix = String(planId || 'STANDARD')
            .replace(/[^a-zA-Z0-9]/g, '')
            .slice(0, 4)
            .toUpperCase() || 'OMNI';
        const segA = crypto.randomBytes(3).toString('hex').toUpperCase();
        const segB = crypto.randomBytes(3).toString('hex').toUpperCase();
        return `OM-${prefix}-${segA}-${segB}`;
    };

    const writePaymentAudit = async ({ transactionId = '', eventType = '', detail = {} }, client = null) => {
        try {
            await ensurePaymentSchema();
            const executor = client || db;
            await executor.query(
                `INSERT INTO omnimind_payment_audit_logs (transaction_id, event_type, detail_json, created_at)
                 VALUES ($1, $2, $3::jsonb, NOW())`,
                [toNonEmptyString(transactionId) || null, toNonEmptyString(eventType), JSON.stringify(detail || {})]
            );
        } catch (err) {
            console.warn('[OmniMind] writePaymentAudit failed:', err.message);
        }
    };

    const generateTransactionId = (prefix = 'txn') => {
        const suffix = crypto.randomBytes(4).toString('hex');
        return `${prefix}_${Date.now()}_${suffix}`;
    };

    const buildPaymentContent = ({ transactionId, itemId, prefix = 'OMNI' }) => {
        const safePrefix = toNonEmptyString(prefix).replace(/[^a-zA-Z0-9]/g, '').toUpperCase() || 'OMNI';
        const txTail = toNonEmptyString(transactionId).slice(-8).toUpperCase();
        const itemTail = toNonEmptyString(itemId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase();
        return `${safePrefix}${itemTail}SEVQR${txTail}`;
    };

    const hasSevqrMarker = (content = '') => {
        return toNonEmptyString(content).toUpperCase().includes('SEVQR');
    };

    const buildQrUrl = ({ baseUrl, bankCode, accountNumber, accountName, amount, content }) => {
        const encodedContent = encodeURIComponent(content);
        const encodedName = accountName ? encodeURIComponent(accountName) : '';
        const nameParam = accountName ? `&accountName=${encodedName}` : '';
        return `${baseUrl}/${bankCode}-${accountNumber}-qr_only.png?amount=${amount}&addInfo=${encodedContent}${nameParam}`;
    };

    const rowToPaymentOrder = (row = {}) => ({
        id: toNonEmptyString(row.id),
        type: toNonEmptyString(row.type),
        item_id: toNonEmptyString(row.item_id),
        license_key: toNonEmptyString(row.license_key),
        amount: toMoneyNumber(row.amount || 0),
        currency: toNonEmptyString(row.currency) || 'VND',
        status: toNonEmptyString(row.status).toUpperCase() || 'PENDING',
        provider: toNonEmptyString(row.provider),
        payment_content: toNonEmptyString(row.payment_content),
        qr_url: toNonEmptyString(row.qr_url),
        expires_at: row.expires_at,
        paid_at: row.paid_at,
        failure_reason: toNonEmptyString(row.failure_reason),
        price_snapshot: row.price_snapshot || null,
        discount_snapshot: row.discount_snapshot || null,
        metadata_json: row.metadata_json || null,
        issued_license_key: toNonEmptyString(parseJsonObject(row.metadata_json).issued_license_key),
        created_at: row.created_at,
        updated_at: row.updated_at,
    });

    const issueOrRenewLicenseForTransaction = async (client, tx) => {
        const txMeta = parseJsonObject(tx.metadata_json);
        const planId = toNonEmptyString(tx.item_id);
        const plan = await getLicensePlanById(planId, { activeOnly: false });
        const planDuration = Number(plan?.duration_days || txMeta?.plan_snapshot?.duration_days || 30);
        const normalizedDuration = Number.isFinite(planDuration) && planDuration > 0 ? planDuration : 30;

        const targetLicenseKey = toNonEmptyString(txMeta.target_license_key);
        if (targetLicenseKey) {
            const existingResult = await client.query(
                'SELECT * FROM licenses WHERE license_key = $1 LIMIT 1 FOR UPDATE',
                [targetLicenseKey]
            );
            const existing = existingResult.rows[0];
            if (existing) {
                const now = new Date();
                const base = existing.expires_at && new Date(existing.expires_at) > now ? new Date(existing.expires_at) : now;
                const nextExpiry = addDays(base, normalizedDuration);
                await client.query(
                    `UPDATE licenses
                     SET expires_at = $2,
                         status = 'active',
                         plan_id = $3,
                         issued_source = 'SEPAY'
                     WHERE id = $1`,
                    [existing.id, nextExpiry, planId || existing.plan_id || 'Standard']
                );
                return {
                    license_key: targetLicenseKey,
                    expires_at: nextExpiry,
                    issued_new: false,
                    duration_days: normalizedDuration,
                };
            }
        }

        let created = null;
        for (let i = 0; i < 8; i += 1) {
            const candidate = generateLicenseKey(planId || 'STANDARD');
            const expiresAt = addDays(new Date(), normalizedDuration);
            try {
                const inserted = await client.query(
                    `INSERT INTO licenses (license_key, status, expires_at, note, plan_id, issued_source)
                     VALUES ($1, 'active', $2, $3, $4, 'SEPAY')
                     RETURNING *`,
                    [
                        candidate,
                        expiresAt,
                        `Issued from SePay transaction ${toNonEmptyString(tx.id)}`,
                        planId || 'Standard',
                    ]
                );
                created = inserted.rows[0] || null;
                if (created) break;
            } catch (err) {
                if (String(err?.code) === '23505') {
                    continue;
                }
                throw err;
            }
        }
        if (!created) {
            throw new Error('Không thể tạo license mới từ giao dịch thanh toán.');
        }
        return {
            license_key: toNonEmptyString(created.license_key),
            expires_at: created.expires_at,
            issued_new: true,
            duration_days: normalizedDuration,
        };
    };

    const grantSkillOwnership = async ({ skillId, licenseKey }) => {
        const exists = await db.query(
            'SELECT id FROM purchased_skills WHERE skill_id = $1 AND license_key = $2 LIMIT 1',
            [skillId, licenseKey]
        );
        if (exists.rows.length) {
            return { granted: false, exists: true };
        }
        await db.query(
            'INSERT INTO purchased_skills (skill_id, license_key, purchased_at) VALUES ($1, $2, NOW())',
            [skillId, licenseKey]
        );
        return { granted: true, exists: false };
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
                await db.query(
                    'UPDATE licenses SET machine_id = $1 WHERE id = $2',
                    [hwid, license.id]
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
                await db.query(
                    'UPDATE licenses SET machine_id = $1 WHERE id = $2 AND COALESCE(machine_id, \'\') <> $1',
                    [hwid, license.id]
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
    // PUBLIC: Bảng giá License Plan (cho màn mua license)
    // ─────────────────────────────────────────────────────
    app.get('/api/v1/omnimind/licenses/plans', async (_req, res) => {
        try {
            await ensureDefaultLicensePlans();
            const result = await db.query(
                `SELECT *
                 FROM omnimind_license_plan_prices
                 WHERE is_active = TRUE
                 ORDER BY price ASC, duration_days ASC`
            );
            res.json({
                success: true,
                plans: result.rows.map(rowToLicensePlan),
            });
        } catch (err) {
            console.error('[OmniMind] License plans error:', err);
            res.status(500).json({ success: false, message: 'Lỗi máy chủ nội bộ.' });
        }
    });

    // ─────────────────────────────────────────────────────
    // PUBLIC: Tạo giao dịch SePay cho mua/gia hạn License
    // ─────────────────────────────────────────────────────
    app.post('/api/v1/omnimind/licenses/purchase', async (req, res) => {
        const body = req.body || {};
        const planId = toNonEmptyString(body.plan_id);
        const targetLicenseKey = toNonEmptyString(body.target_license_key || body.license_key);
        if (!planId) {
            return res.status(400).json({ success: false, message: 'Thiếu plan_id.' });
        }

        try {
            const plan = await getLicensePlanById(planId, { activeOnly: true });
            if (!plan) {
                return res.status(404).json({ success: false, message: 'Plan không tồn tại hoặc đang tắt.' });
            }

            if (targetLicenseKey) {
                const existing = await getLicenseRecord(targetLicenseKey);
                if (!existing) {
                    return res.status(404).json({ success: false, message: 'Không tìm thấy license để gia hạn.' });
                }
            }

            const requiredAmount = toMoneyNumber(plan.price);
            if (requiredAmount <= 0) {
                const txId = generateTransactionId('txn');
                const inserted = await db.query(
                    `INSERT INTO transactions
                        (
                            id, type, item_id, license_key, amount, status, created_at, updated_at,
                            provider, provider_order_code, payment_content, currency, paid_at, metadata_json
                        )
                     VALUES
                        (
                            $1, 'LICENSE', $2, $3, 0, 'SUCCESS', NOW(), NOW(),
                            'SEPAY', $4, $5, 'VND', NOW(), $6::jsonb
                        )
                     RETURNING *`,
                    [
                        txId,
                        plan.plan_id,
                        targetLicenseKey || null,
                        txId,
                        `FREE-${txId}`,
                        JSON.stringify({
                            plan_snapshot: rowToLicensePlan(plan),
                            target_license_key: targetLicenseKey || null,
                        }),
                    ]
                );
                const tx = inserted.rows[0];
                const client = await db.pool.connect();
                try {
                    await client.query('BEGIN');
                    const issued = await issueOrRenewLicenseForTransaction(client, tx);
                    const nextMeta = parseJsonObject(tx.metadata_json, {
                        plan_snapshot: rowToLicensePlan(plan),
                        target_license_key: targetLicenseKey || null,
                    });
                    nextMeta.issued_license_key = issued.license_key;
                    nextMeta.issued_expires_at = issued.expires_at;
                    nextMeta.issued_new = issued.issued_new;
                    await client.query(
                        `UPDATE transactions
                         SET metadata_json = $2::jsonb,
                             updated_at = NOW()
                         WHERE id = $1`,
                        [tx.id, JSON.stringify(nextMeta)]
                    );
                    await writePaymentAudit(
                        {
                            transactionId: tx.id,
                            eventType: 'license_free_issued',
                            detail: { issued_license_key: issued.license_key, plan_id: plan.plan_id },
                        },
                        client
                    );
                    await client.query('COMMIT');
                    return res.json({
                        success: true,
                        message: 'Đã cấp license thành công.',
                        transaction_id: tx.id,
                        issued_license_key: issued.license_key,
                        expires_at: issued.expires_at,
                        plan: rowToLicensePlan(plan),
                    });
                } catch (err) {
                    await client.query('ROLLBACK');
                    throw err;
                } finally {
                    client.release();
                }
            }

            const existingPending = await db.query(
                `SELECT *
                 FROM transactions
                 WHERE type = 'LICENSE'
                   AND item_id = $1
                   AND COALESCE(license_key, '') = COALESCE($2, '')
                   AND status = 'PENDING'
                   AND (expires_at IS NULL OR expires_at > NOW())
                 ORDER BY created_at DESC
                 LIMIT 1`,
                [plan.plan_id, targetLicenseKey || null]
            );
            const pendingTx = existingPending.rows[0] || null;
            if (
                pendingTx &&
                toMoneyNumber(pendingTx.amount) === requiredAmount &&
                hasSevqrMarker(pendingTx.payment_content)
            ) {
                await writePaymentAudit({
                    transactionId: pendingTx.id,
                    eventType: 'license_order_reused',
                    detail: { plan_id: plan.plan_id, target_license_key: targetLicenseKey || null },
                });
                return res.status(402).json({
                    success: false,
                    code: 'PAYMENT_REQUIRED',
                    message: 'Vui lòng thanh toán để hoàn tất mua license.',
                    payment: rowToPaymentOrder(pendingTx),
                    plan: rowToLicensePlan(plan),
                });
            }

            const payConfig = await getPaymentConfig();
            if (!payConfig.bank_code || !payConfig.bank_account) {
                return res.status(503).json({
                    success: false,
                    code: 'PAYMENT_CONFIG_MISSING',
                    message: 'Server chưa cấu hình tài khoản nhận thanh toán.',
                });
            }

            const txId = generateTransactionId('txn');
            const paymentContent = buildPaymentContent({
                transactionId: txId,
                itemId: plan.plan_id,
                prefix: payConfig.payment_content_prefix,
            });
            const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
            const qrUrl = buildQrUrl({
                baseUrl: payConfig.qr_base_url,
                bankCode: payConfig.bank_code,
                accountNumber: payConfig.bank_account,
                accountName: payConfig.bank_account_name,
                amount: requiredAmount,
                content: paymentContent,
            });

            const inserted = await db.query(
                `INSERT INTO transactions
                    (
                        id, type, item_id, license_key, amount, status, created_at,
                        provider, provider_order_code, payment_content, currency, qr_url, expires_at, updated_at,
                        price_snapshot, metadata_json
                    )
                 VALUES
                    (
                        $1, 'LICENSE', $2, $3, $4, 'PENDING', NOW(),
                        'SEPAY', $5, $6, 'VND', $7, $8, NOW(),
                        $9::jsonb, $10::jsonb
                    )
                 RETURNING *`,
                [
                    txId,
                    plan.plan_id,
                    targetLicenseKey || null,
                    requiredAmount,
                    txId,
                    paymentContent,
                    qrUrl,
                    expiresAt,
                    JSON.stringify({
                        base_price: requiredAmount,
                        effective_price: requiredAmount,
                        currency: 'VND',
                    }),
                    JSON.stringify({
                        plan_snapshot: rowToLicensePlan(plan),
                        target_license_key: targetLicenseKey || null,
                        bank_code: payConfig.bank_code,
                        bank_account: payConfig.bank_account,
                        bank_account_name: payConfig.bank_account_name || null,
                    }),
                ]
            );
            const createdTx = inserted.rows[0];
            await writePaymentAudit({
                transactionId: createdTx.id,
                eventType: 'license_order_created',
                detail: { plan_id: plan.plan_id, target_license_key: targetLicenseKey || null, amount: requiredAmount },
            });

            return res.status(402).json({
                success: false,
                code: 'PAYMENT_REQUIRED',
                message: 'Vui lòng thanh toán để hoàn tất mua license.',
                payment: rowToPaymentOrder(createdTx),
                plan: rowToLicensePlan(plan),
            });
        } catch (err) {
            console.error('[OmniMind] License purchase error:', err);
            res.status(500).json({ success: false, message: 'Lỗi máy chủ nội bộ.' });
        }
    });

    // ─────────────────────────────────────────────────────
    // PUBLIC: Snapshot quyền hiện tại của 1 license
    // ─────────────────────────────────────────────────────
    app.get('/api/v1/omnimind/licenses/:license_key/entitlements', async (req, res) => {
        const licenseKey = toNonEmptyString(req.params.license_key);
        if (!licenseKey) {
            return res.status(400).json({ success: false, message: 'Thiếu license_key.' });
        }
        try {
            const license = await getLicenseRecord(licenseKey);
            if (!license) {
                return res.status(404).json({ success: false, message: 'License không tồn tại.' });
            }

            const purchased = await db.query(
                `SELECT ps.skill_id, ps.purchased_at, ms.name, ms.version
                 FROM purchased_skills ps
                 LEFT JOIN marketplace_skills ms ON ms.id = ps.skill_id
                 WHERE ps.license_key = $1
                 ORDER BY ps.purchased_at DESC`,
                [licenseKey]
            );

            res.json({
                success: true,
                license: {
                    license_key: license.license_key,
                    status: license.status,
                    plan_id: license.plan_id || 'Standard',
                    issued_source: license.issued_source || 'CMS',
                    expires_at: license.expires_at,
                    is_active: isLicenseActive(license),
                },
                entitlements: {
                    can_access_vip: canPlanAccessVip(license.plan_id),
                    purchased_skill_ids: purchased.rows.map((r) => r.skill_id).filter(Boolean),
                    purchased_skills: purchased.rows,
                },
            });
        } catch (err) {
            console.error('[OmniMind] Entitlements error:', err);
            res.status(500).json({ success: false, message: 'Lỗi máy chủ nội bộ.' });
        }
    });

    // ─────────────────────────────────────────────────────
    // PUBLIC: Kiểm tra phiên bản mới nhất & Changelog
    // ─────────────────────────────────────────────────────
    app.get('/api/v1/omnimind/app/version', async (req, res) => {
        try {
            await ensureAppVersionSchema();
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
                checksum_sha256: toNonEmptyString(latestVersion.checksum_sha256).replace(/^sha256:/i, '').toLowerCase(),
                package_size_bytes: latestVersion.package_size_bytes ?? null,
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
        const requestedPlatform = normalizePlatform(req.query.os_name || req.query.platform || '');
        const requestedArch = normalizeArch(requestedPlatform, req.query.arch || req.query.cpu_arch || '');
        try {
            await ensureCodexReleaseSchema();
            const result = await db.query(
                `SELECT * FROM omnimind_codex_releases
                 WHERE channel = $1 AND is_active = TRUE
                 ORDER BY updated_at DESC, id DESC`,
                ['stable']
            );
            const rows = result.rows.map(rowToCodexRelease).filter((row) => row.url);
            const manifest = buildCodexManifest(rows, requestedPlatform, requestedArch);
            res.json(manifest);
        } catch (err) {
            console.error('[OmniMind] Codex release resolve error:', err);
            const fallback = buildCodexManifest([], requestedPlatform, requestedArch);
            res.json(fallback);
        }
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

            await ensurePaymentSchema();
            const overrideMap = await getActiveSkillOverrideMap(result.rows.map((row) => row.id));

            const license = await getLicenseRecord(licenseKey);
            const hasActiveLicense = isLicenseActive(license);
            const purchasedSet = hasActiveLicense ? await getPurchasedSkillIds(licenseKey) : new Set();

            const skills = result.rows.map((row) => {
                const pricing = resolveSkillPricing(row, overrideMap.get(row.id) || null);
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
                const isFree = Number(pricing.effective_price || 0) <= 0 && !row.is_vip;
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
                    effective_price: pricing.effective_price,
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
                    pricing,
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
            await ensurePaymentSchema();
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
            const finalDownloadUrl = rewriteSkillArtifactUrlIfNeeded(download.url, req);

            const overrideMap = await getActiveSkillOverrideMap([skill.id]);
            const pricing = resolveSkillPricing(skill, overrideMap.get(skill.id) || null);
            const isFree = Number(pricing.effective_price || 0) <= 0 && !skill.is_vip;
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
                url: finalDownloadUrl,
                checksum: download.checksum || '',
                file_name: download.file_name || '',
                size: download.size || null,
                pricing,
            });
        } catch (err) {
            console.error('[OmniMind] Skill download resolve error:', err);
            res.status(500).json({ success: false, message: 'Lỗi máy chủ nội bộ.' });
        }
    });

    // ─────────────────────────────────────────────────────
    // PUBLIC: Serve local skill artifact file (.zip/.tar)
    // ─────────────────────────────────────────────────────
    app.get('/api/v1/omnimind/skills/artifacts/:file', async (req, res) => {
        try {
            const fileName = toNonEmptyString(req.params.file || '');
            if (!/^[A-Za-z0-9._\-]+\.(zip|tar|tgz|tar\.gz)$/i.test(fileName)) {
                return res.status(400).json({ success: false, message: 'Tên file artifact không hợp lệ.' });
            }

            const fullPath = path.join(SKILL_ARTIFACTS_DIR, fileName);
            const normalized = path.normalize(fullPath);
            if (!normalized.startsWith(SKILL_ARTIFACTS_DIR)) {
                return res.status(400).json({ success: false, message: 'Đường dẫn artifact không hợp lệ.' });
            }
            if (!fs.existsSync(normalized) || !fs.statSync(normalized).isFile()) {
                return res.status(404).json({ success: false, message: 'Không tìm thấy artifact skill.' });
            }

            const lowered = fileName.toLowerCase();
            if (lowered.endsWith('.zip')) {
                res.setHeader('Content-Type', 'application/zip');
            } else {
                res.setHeader('Content-Type', 'application/octet-stream');
            }
            res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
            return res.sendFile(normalized);
        } catch (err) {
            console.error('[OmniMind] Skill artifact serve error:', err);
            return res.status(500).json({ success: false, message: 'Lỗi máy chủ nội bộ.' });
        }
    });

    // ─────────────────────────────────────────────────────
    // PUBLIC: Mua/Cấp quyền 1 skill cho license
    // ─────────────────────────────────────────────────────
    app.post('/api/v1/omnimind/skills/:id/purchase', async (req, res) => {
        const skillId = req.params.id;
        const { license_key, transaction_id } = req.body || {};
        if (!license_key) {
            return res.status(400).json({ success: false, message: 'Thiếu license_key.' });
        }
        try {
            await ensurePaymentSchema();
            const license = await getLicenseRecord(license_key);
            if (!isLicenseActive(license)) {
                return res.status(403).json({ success: false, message: 'License không hợp lệ hoặc đã hết hạn.' });
            }

            const skillResult = await db.query('SELECT id, name, price, is_vip FROM marketplace_skills WHERE id = $1', [skillId]);
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

            const overrideMap = await getActiveSkillOverrideMap([skill.id]);
            const pricing = resolveSkillPricing(skill, overrideMap.get(skill.id) || null);

            const isFree = Number(pricing.effective_price || 0) <= 0 && !skill.is_vip;
            const vipByPlan = skill.is_vip && canPlanAccessVip(license.plan_id);
            if (isFree || vipByPlan) {
                await grantSkillOwnership({ skillId, licenseKey: license_key });
                return res.json({
                    success: true,
                    message: 'Đã cấp quyền skill thành công.',
                    pricing,
                });
            }

            const requiredAmount = toMoneyNumber(pricing.effective_price);
            const loadTransaction = async (txId) => {
                if (!txId) return null;
                const txResult = await db.query(
                    `SELECT *
                     FROM transactions
                     WHERE id = $1
                       AND type = 'SKILL'
                       AND item_id = $2
                       AND license_key = $3
                     LIMIT 1`,
                    [txId, skillId, license_key]
                );
                return txResult.rows[0] || null;
            };

            let successTx = null;
            if (toNonEmptyString(transaction_id)) {
                const tx = await loadTransaction(toNonEmptyString(transaction_id));
                if (!tx) {
                    return res.status(404).json({
                        success: false,
                        code: 'TRANSACTION_NOT_FOUND',
                        message: 'Không tìm thấy giao dịch thanh toán tương ứng.',
                    });
                }
                if (String(tx.status || '').toUpperCase() !== 'SUCCESS') {
                    return res.status(402).json({
                        success: false,
                        code: 'PAYMENT_PENDING',
                        message: 'Giao dịch chưa hoàn tất thanh toán.',
                        payment: rowToPaymentOrder(tx),
                        pricing,
                    });
                }
                successTx = tx;
            } else {
                const latestSuccess = await db.query(
                    `SELECT *
                     FROM transactions
                     WHERE type = 'SKILL'
                       AND item_id = $1
                       AND license_key = $2
                       AND status = 'SUCCESS'
                     ORDER BY COALESCE(paid_at, created_at) DESC
                     LIMIT 1`,
                    [skillId, license_key]
                );
                const tx = latestSuccess.rows[0] || null;
                if (tx && toMoneyNumber(tx.amount) >= requiredAmount) {
                    successTx = tx;
                }
            }

            if (successTx) {
                await grantSkillOwnership({ skillId, licenseKey: license_key });
                return res.json({
                    success: true,
                    message: 'Đã xác nhận thanh toán và cấp quyền skill.',
                    transaction_id: successTx.id,
                    pricing,
                });
            }

            const pendingResult = await db.query(
                `SELECT *
                 FROM transactions
                 WHERE type = 'SKILL'
                   AND item_id = $1
                   AND license_key = $2
                   AND status = 'PENDING'
                   AND (expires_at IS NULL OR expires_at > NOW())
                 ORDER BY created_at DESC
                 LIMIT 1`,
                [skillId, license_key]
            );
            const pendingTx = pendingResult.rows[0] || null;
            if (
                pendingTx &&
                toMoneyNumber(pendingTx.amount) === requiredAmount &&
                hasSevqrMarker(pendingTx.payment_content)
            ) {
                await writePaymentAudit({
                    transactionId: pendingTx.id,
                    eventType: 'skill_order_reused',
                    detail: { skill_id: skillId, license_key, amount: requiredAmount },
                });
                return res.status(402).json({
                    success: false,
                    code: 'PAYMENT_REQUIRED',
                    message: 'Skill trả phí. Vui lòng thanh toán để tiếp tục.',
                    payment: rowToPaymentOrder(pendingTx),
                    pricing,
                });
            }

            const payConfig = await getPaymentConfig();
            if (!payConfig.bank_code || !payConfig.bank_account) {
                return res.status(503).json({
                    success: false,
                    code: 'PAYMENT_CONFIG_MISSING',
                    message: 'Chưa cấu hình tài khoản nhận thanh toán trên server.',
                });
            }

            const txId = generateTransactionId('txn');
            const paymentContent = buildPaymentContent({
                transactionId: txId,
                itemId: skillId,
                prefix: payConfig.payment_content_prefix,
            });
            const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
            const qrUrl = buildQrUrl({
                baseUrl: payConfig.qr_base_url,
                bankCode: payConfig.bank_code,
                accountNumber: payConfig.bank_account,
                accountName: payConfig.bank_account_name,
                amount: requiredAmount,
                content: paymentContent,
            });

            const inserted = await db.query(
                `INSERT INTO transactions
                    (
                        id, type, item_id, license_key, amount, status, created_at,
                        provider, provider_order_code, payment_content, currency, qr_url, expires_at, updated_at,
                        price_snapshot, discount_snapshot, metadata_json
                    )
                 VALUES
                    (
                        $1, 'SKILL', $2, $3, $4, 'PENDING', NOW(),
                        'SEPAY', $5, $6, 'VND', $7, $8, NOW(),
                        $9::jsonb, $10::jsonb, $11::jsonb
                    )
                 RETURNING *`,
                [
                    txId,
                    skillId,
                    license_key,
                    requiredAmount,
                    txId,
                    paymentContent,
                    qrUrl,
                    expiresAt,
                    JSON.stringify({
                        base_price: pricing.base_price,
                        effective_price: pricing.effective_price,
                        currency: pricing.currency,
                    }),
                    JSON.stringify({
                        discount_amount: pricing.discount_amount,
                        discount_percent: pricing.discount_percent,
                        override_price: pricing.override_price,
                        pricing_source: pricing.pricing_source,
                        override_id: pricing.override_id,
                    }),
                    JSON.stringify({
                        skill_name: skill.name || skillId,
                        bank_code: payConfig.bank_code,
                        bank_account: payConfig.bank_account,
                        bank_account_name: payConfig.bank_account_name || null,
                    }),
                ]
            );
            const createdTx = inserted.rows[0];
            await writePaymentAudit({
                transactionId: createdTx.id,
                eventType: 'skill_order_created',
                detail: { skill_id: skillId, license_key, amount: requiredAmount },
            });

            return res.status(402).json({
                success: false,
                code: 'PAYMENT_REQUIRED',
                message: 'Skill trả phí. Vui lòng thanh toán để tiếp tục.',
                payment: rowToPaymentOrder(createdTx),
                pricing,
            });
        } catch (err) {
            console.error('[OmniMind] Skill purchase error:', err);
            res.status(500).json({ success: false, message: 'Lỗi máy chủ nội bộ.' });
        }
    });

    // ─────────────────────────────────────────────────────
    // PUBLIC: Trạng thái giao dịch thanh toán
    // ─────────────────────────────────────────────────────
    app.get('/api/v1/omnimind/payments/orders/:id', async (req, res) => {
        const txId = toNonEmptyString(req.params.id);
        const licenseKey = toNonEmptyString(req.query.license_key || '');
        const orderCode = toNonEmptyString(req.query.order_code || '');
        if (!txId) {
            return res.status(400).json({ success: false, message: 'Thiếu transaction id.' });
        }

        try {
            await ensurePaymentSchema();
            const txResult = await db.query(
                `SELECT *
                 FROM transactions
                 WHERE id = $1
                 LIMIT 1`,
                [txId]
            );
            const tx = txResult.rows[0];
            if (!tx) {
                return res.status(404).json({ success: false, message: 'Không tìm thấy giao dịch.' });
            }

            const txType = toNonEmptyString(tx.type).toUpperCase();
            if (txType === 'LICENSE') {
                if (orderCode && orderCode !== toNonEmptyString(tx.payment_content)) {
                    return res.status(403).json({ success: false, message: 'Thông tin order không khớp.' });
                }
            } else {
                if (!licenseKey) {
                    return res.status(400).json({ success: false, message: 'Thiếu license_key.' });
                }
                if (toNonEmptyString(tx.license_key) !== licenseKey) {
                    return res.status(403).json({ success: false, message: 'Không có quyền xem giao dịch này.' });
                }
            }

            let finalTx = tx;
            const txStatus = toNonEmptyString(tx.status).toUpperCase();
            if (txStatus === 'PENDING' && tx.expires_at && new Date(tx.expires_at) <= new Date()) {
                const expiredResult = await db.query(
                    `UPDATE transactions
                     SET status = 'EXPIRED',
                         failure_reason = COALESCE(failure_reason, 'order_timeout'),
                         updated_at = NOW()
                     WHERE id = $1
                     RETURNING *`,
                    [tx.id]
                );
                finalTx = expiredResult.rows[0] || tx;
                await writePaymentAudit({
                    transactionId: tx.id,
                    eventType: 'order_expired',
                    detail: { type: txType, expires_at: tx.expires_at },
                });
            }

            res.json({
                success: true,
                order: rowToPaymentOrder(finalTx),
            });
        } catch (err) {
            console.error('[OmniMind] Payment order status error:', err);
            res.status(500).json({ success: false, message: 'Lỗi máy chủ nội bộ.' });
        }
    });

    // ─────────────────────────────────────────────────────
    // PUBLIC: Webhook SePay
    // ─────────────────────────────────────────────────────
    app.post('/api/v1/omnimind/payments/webhooks/sepay', async (req, res) => {
        const payload = req.body || {};
        try {
            await ensurePaymentSchema();

            const payConfig = await getPaymentConfig();
            const apiKey = toNonEmptyString(payConfig.sepay_api_key);
            if (!apiKey) {
                return res.status(503).json({ success: false, code: 'SEPAY_API_KEY_MISSING' });
            }

            const authHeader = toNonEmptyString(req.header('Authorization') || '');
            const authMatch = authHeader.match(/^Apikey\s+(.+)$/i);
            if (!authMatch || toNonEmptyString(authMatch[1]) !== apiKey) {
                return res.status(401).json({ success: false, code: 'UNAUTHORIZED' });
            }

            const sepayId = Number(payload.id);
            if (!Number.isFinite(sepayId) || sepayId <= 0) {
                return res.status(400).json({ success: false, code: 'INVALID_PAYLOAD' });
            }

            const transferAmount = toMoneyNumber(payload.transferAmount);
            if (!Number.isFinite(transferAmount) || transferAmount <= 0) {
                return res.status(400).json({ success: false, code: 'INVALID_AMOUNT' });
            }

            let sepayRecordId = null;
            try {
                const ins = await db.query(
                    `INSERT INTO omnimind_sepay_transactions
                        (
                            sepay_id, gateway, transaction_date, account_number, code, content, transfer_type,
                            transfer_amount, accumulated, sub_account, reference_code, description, raw_payload, status, created_at
                        )
                     VALUES
                        (
                            $1, $2, $3, $4, $5, $6, $7,
                            $8, $9, $10, $11, $12, $13::jsonb, 'received', NOW()
                        )
                     RETURNING id`,
                    [
                        sepayId,
                        toNonEmptyString(payload.gateway) || null,
                        payload.transactionDate || null,
                        toNonEmptyString(payload.accountNumber) || null,
                        toNonEmptyString(payload.code) || null,
                        toNonEmptyString(payload.content) || null,
                        toNonEmptyString(payload.transferType) || null,
                        transferAmount,
                        payload.accumulated ?? null,
                        toNonEmptyString(payload.subAccount) || null,
                        toNonEmptyString(payload.referenceCode) || null,
                        payload.description ?? null,
                        JSON.stringify(payload),
                    ]
                );
                sepayRecordId = ins.rows[0]?.id || null;
            } catch (insertErr) {
                if (String(insertErr.code) === '23505') {
                    await writePaymentAudit({
                        transactionId: '',
                        eventType: 'webhook_duplicate',
                        detail: { sepay_id: sepayId },
                    });
                    return res.json({ success: true, status: 'duplicate' });
                }
                throw insertErr;
            }

            if (toNonEmptyString(payload.transferType).toLowerCase() !== 'in') {
                await db.query('UPDATE omnimind_sepay_transactions SET status = $1 WHERE id = $2', ['ignored', sepayRecordId]);
                await writePaymentAudit({
                    transactionId: '',
                    eventType: 'webhook_ignored_transfer_type',
                    detail: { sepay_id: sepayId, transfer_type: payload.transferType || null },
                });
                return res.json({ success: true, status: 'ignored' });
            }

            const codeVal = toNonEmptyString(payload.code);
            const contentVal = toNonEmptyString(payload.content);
            const matchValue = codeVal || contentVal;
            if (!matchValue) {
                await db.query('UPDATE omnimind_sepay_transactions SET status = $1 WHERE id = $2', ['unmatched', sepayRecordId]);
                await writePaymentAudit({
                    transactionId: '',
                    eventType: 'webhook_unmatched_no_content',
                    detail: { sepay_id: sepayId },
                });
                return res.json({ success: true, status: 'unmatched' });
            }

            const client = await db.pool.connect();
            try {
                await client.query('BEGIN');
                const txResult = await client.query(
                    `SELECT *
                     FROM transactions
                     WHERE provider = 'SEPAY'
                       AND payment_content = $1
                       AND status = 'PENDING'
                       AND (expires_at IS NULL OR expires_at > NOW())
                     ORDER BY created_at DESC
                     LIMIT 1
                     FOR UPDATE`,
                    [matchValue]
                );
                const tx = txResult.rows[0];
                if (!tx) {
                    await client.query(
                        'UPDATE omnimind_sepay_transactions SET status = $1 WHERE id = $2',
                        ['unmatched', sepayRecordId]
                    );
                    await writePaymentAudit(
                        {
                            transactionId: '',
                            eventType: 'webhook_unmatched_payment_content',
                            detail: { sepay_id: sepayId, payment_content: matchValue },
                        },
                        client
                    );
                    await client.query('COMMIT');
                    return res.json({ success: true, status: 'unmatched' });
                }

                const expectedAmount = toMoneyNumber(tx.amount || 0);
                if (Math.abs(expectedAmount - transferAmount) > 0.01) {
                    await client.query(
                        'UPDATE omnimind_sepay_transactions SET status = $1 WHERE id = $2',
                        ['amount_mismatch', sepayRecordId]
                    );
                    await client.query(
                        `UPDATE transactions
                         SET status = 'FAILED',
                             failure_reason = 'amount_mismatch',
                             provider_transaction_id = $2,
                             raw_payload = $3::jsonb,
                             updated_at = NOW()
                         WHERE id = $1`,
                        [tx.id, String(sepayId), JSON.stringify(payload)]
                    );
                    await writePaymentAudit(
                        {
                            transactionId: tx.id,
                            eventType: 'webhook_amount_mismatch',
                            detail: { expected: expectedAmount, actual: transferAmount, sepay_id: sepayId },
                        },
                        client
                    );
                    await client.query('COMMIT');
                    return res.json({ success: true, status: 'amount_mismatch' });
                }

                await client.query(
                    `UPDATE transactions
                     SET status = 'SUCCESS',
                         paid_at = NOW(),
                         provider_transaction_id = $2,
                         raw_payload = $3::jsonb,
                         updated_at = NOW()
                     WHERE id = $1`,
                    [tx.id, String(sepayId), JSON.stringify(payload)]
                );

                if (toNonEmptyString(tx.type).toUpperCase() === 'SKILL') {
                    await client.query(
                        `INSERT INTO purchased_skills (skill_id, license_key, purchased_at)
                         SELECT $1::text, $2::text, NOW()
                         WHERE NOT EXISTS (
                             SELECT 1
                             FROM purchased_skills
                             WHERE skill_id = $1::text AND license_key = $2::text
                         )`,
                        [tx.item_id, tx.license_key]
                    );
                }
                if (toNonEmptyString(tx.type).toUpperCase() === 'LICENSE') {
                    const issued = await issueOrRenewLicenseForTransaction(client, tx);
                    const txMeta = parseJsonObject(tx.metadata_json);
                    txMeta.issued_license_key = issued.license_key;
                    txMeta.issued_expires_at = issued.expires_at;
                    txMeta.issued_new = issued.issued_new;
                    txMeta.issued_duration_days = issued.duration_days;
                    await client.query(
                        `UPDATE transactions
                         SET metadata_json = $2::jsonb,
                             updated_at = NOW()
                         WHERE id = $1`,
                        [tx.id, JSON.stringify(txMeta)]
                    );
                }

                await client.query(
                    'UPDATE omnimind_sepay_transactions SET status = $1 WHERE id = $2',
                    ['matched', sepayRecordId]
                );
                await writePaymentAudit(
                    {
                        transactionId: tx.id,
                        eventType: 'webhook_matched_success',
                        detail: { sepay_id: sepayId, type: tx.type, item_id: tx.item_id },
                    },
                    client
                );
                await client.query('COMMIT');
                return res.json({ success: true, status: 'matched', transaction_id: tx.id });
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        } catch (err) {
            console.error('[OmniMind] SePay webhook error:', err);
            res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
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
            await ensureAppVersionSchema();
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
            await ensureAppVersionSchema();
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
        const { version_id, version_name, is_critical, download_url, checksum_sha256, package_size_bytes, changelogs } = req.body;
        try {
            await ensureAppVersionSchema();
            const normalizedChecksum = toNonEmptyString(checksum_sha256).replace(/^sha256:/i, '').toLowerCase();
            const normalizedSize = Number(package_size_bytes);
            await db.query(
                `INSERT INTO app_versions
                    (version_id, version_name, is_critical, download_url, checksum_sha256, package_size_bytes)
                 VALUES
                    ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (version_id) DO UPDATE SET
                    version_name = $2,
                    is_critical = $3,
                    download_url = $4,
                    checksum_sha256 = $5,
                    package_size_bytes = $6`,
                [
                    version_id,
                    version_name,
                    is_critical || false,
                    download_url || '',
                    normalizedChecksum,
                    Number.isFinite(normalizedSize) && normalizedSize > 0 ? Math.trunc(normalizedSize) : null,
                ]
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
    // ADMIN: Quản lý Codex Release Matrix (OS + Arch)
    // ─────────────────────────────────────────────────────
    app.get('/api/v1/admin/omnimind/codex/releases', authMiddleware, async (req, res) => {
        const channel = toNonEmptyString(req.query.channel) || 'stable';
        try {
            await ensureCodexReleaseSchema();
            const result = await db.query(
                `SELECT * FROM omnimind_codex_releases
                 WHERE channel = $1
                 ORDER BY platform ASC, arch ASC, updated_at DESC, id DESC`,
                [channel]
            );
            res.json({ success: true, data: result.rows.map(rowToCodexRelease) });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.post('/api/v1/admin/omnimind/codex/releases', authMiddleware, async (req, res) => {
        try {
            await ensureCodexReleaseSchema();
            const record = normalizeCodexReleaseRecord(req.body || {});
            const errors = [];
            if (!record.platform || record.platform === 'unknown') {
                errors.push('platform không hợp lệ.');
            }
            if (!record.arch || record.arch === 'unknown') {
                errors.push('arch không hợp lệ.');
            }
            if (!record.version) {
                errors.push('Thiếu version.');
            }
            if (!record.url) {
                errors.push('Thiếu url.');
            }
            if (!isSupportedReleaseTarget(record.platform, record.arch)) {
                errors.push('Tổ hợp platform/arch chưa được hỗ trợ.');
            }
            if (errors.length) {
                return res.status(400).json({ success: false, error: errors.join(' ') });
            }

            const upsert = await db.query(
                `INSERT INTO omnimind_codex_releases
                    (platform, arch, channel, version, url, checksum, file_name, size_bytes, method, notes, is_active, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
                 ON CONFLICT (platform, arch, channel)
                 DO UPDATE SET
                    version = EXCLUDED.version,
                    url = EXCLUDED.url,
                    checksum = EXCLUDED.checksum,
                    file_name = EXCLUDED.file_name,
                    size_bytes = EXCLUDED.size_bytes,
                    method = EXCLUDED.method,
                    notes = EXCLUDED.notes,
                    is_active = EXCLUDED.is_active,
                    updated_at = NOW()
                 RETURNING *`,
                [
                    record.platform,
                    record.arch,
                    record.channel,
                    record.version,
                    record.url,
                    record.checksum,
                    record.file_name,
                    record.size_bytes,
                    record.method,
                    record.notes,
                    record.is_active,
                ]
            );
            res.json({ success: true, data: rowToCodexRelease(upsert.rows[0]) });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.delete('/api/v1/admin/omnimind/codex/releases/:id', authMiddleware, async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
            return res.status(400).json({ success: false, error: 'ID không hợp lệ.' });
        }
        try {
            await ensureCodexReleaseSchema();
            const result = await db.query(
                'DELETE FROM omnimind_codex_releases WHERE id = $1 RETURNING id',
                [id]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Release not found' });
            }
            res.json({ success: true, message: 'OmniMind CLI release deleted' });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ─────────────────────────────────────────────────────
    // ADMIN: Payment config + Pricing overrides
    // ─────────────────────────────────────────────────────
    app.get('/api/v1/admin/omnimind/payments/config', authMiddleware, async (req, res) => {
        try {
            const cfg = await getPaymentConfig();
            res.json({
                success: true,
                data: {
                    bank_code: cfg.bank_code,
                    bank_account: cfg.bank_account,
                    bank_account_name: cfg.bank_account_name,
                    qr_base_url: cfg.qr_base_url,
                    payment_content_prefix: cfg.payment_content_prefix || 'OMNI',
                    sepay_api_key: cfg.sepay_api_key ? '***' : '',
                },
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.put('/api/v1/admin/omnimind/payments/config', authMiddleware, async (req, res) => {
        const body = req.body || {};
        const allowedKeys = [
            'bank_code',
            'bank_account',
            'bank_account_name',
            'qr_base_url',
            'payment_content_prefix',
            'sepay_api_key',
        ];
        try {
            await ensurePaymentSchema();
            for (const key of allowedKeys) {
                if (body[key] === undefined) continue;
                await db.query(
                    `INSERT INTO omnimind_payment_config (config_key, config_value, updated_at)
                     VALUES ($1, $2, NOW())
                     ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = NOW()`,
                    [key, toNonEmptyString(body[key])]
                );
            }
            paymentConfigCache = null;
            paymentConfigFetchedAt = 0;
            res.json({ success: true, message: 'Đã cập nhật cấu hình thanh toán.' });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.get('/api/v1/admin/omnimind/licenses/plans', authMiddleware, async (_req, res) => {
        try {
            await ensureDefaultLicensePlans();
            const result = await db.query(
                `SELECT *
                 FROM omnimind_license_plan_prices
                 ORDER BY is_active DESC, price ASC, duration_days ASC`
            );
            res.json({ success: true, data: result.rows.map(rowToLicensePlan) });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.post('/api/v1/admin/omnimind/licenses/plans', authMiddleware, async (req, res) => {
        const body = req.body || {};
        const planId = toNonEmptyString(body.plan_id);
        const displayName = toNonEmptyString(body.display_name);
        const durationDays = Number(body.duration_days || 0);
        const price = toMoneyNumber(body.price || 0);
        const isActive = body.is_active === undefined ? true : Boolean(body.is_active);
        const note = toNonEmptyString(body.note);

        if (!planId) {
            return res.status(400).json({ success: false, error: 'plan_id là bắt buộc.' });
        }
        if (!displayName) {
            return res.status(400).json({ success: false, error: 'display_name là bắt buộc.' });
        }
        if (!Number.isFinite(durationDays) || durationDays <= 0) {
            return res.status(400).json({ success: false, error: 'duration_days phải > 0.' });
        }

        try {
            await ensurePaymentSchema();
            const upsert = await db.query(
                `INSERT INTO omnimind_license_plan_prices
                    (plan_id, display_name, duration_days, price, is_active, note, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
                 ON CONFLICT(plan_id) DO UPDATE SET
                    display_name = EXCLUDED.display_name,
                    duration_days = EXCLUDED.duration_days,
                    price = EXCLUDED.price,
                    is_active = EXCLUDED.is_active,
                    note = EXCLUDED.note,
                    updated_at = NOW()
                 RETURNING *`,
                [planId, displayName, Math.trunc(durationDays), price, isActive, note]
            );
            res.json({ success: true, data: rowToLicensePlan(upsert.rows[0]) });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.delete('/api/v1/admin/omnimind/licenses/plans/:id', authMiddleware, async (req, res) => {
        const planId = toNonEmptyString(req.params.id);
        if (!planId) {
            return res.status(400).json({ success: false, error: 'plan_id không hợp lệ.' });
        }
        try {
            await ensurePaymentSchema();
            const result = await db.query(
                `UPDATE omnimind_license_plan_prices
                 SET is_active = FALSE, updated_at = NOW()
                 WHERE plan_id = $1
                 RETURNING *`,
                [planId]
            );
            if (!result.rows[0]) {
                return res.status(404).json({ success: false, error: 'Plan không tồn tại.' });
            }
            res.json({ success: true, data: rowToLicensePlan(result.rows[0]) });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.get('/api/v1/admin/omnimind/pricing/overrides', authMiddleware, async (req, res) => {
        try {
            await ensurePaymentSchema();
            const result = await db.query(
                `SELECT o.*, s.name AS skill_name
                 FROM omnimind_skill_price_overrides o
                 LEFT JOIN marketplace_skills s ON s.id = o.skill_id
                 ORDER BY o.created_at DESC, o.id DESC`
            );
            res.json({ success: true, data: result.rows });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.post('/api/v1/admin/omnimind/pricing/overrides', authMiddleware, async (req, res) => {
        const {
            skill_id,
            override_price = null,
            discount_percent = null,
            starts_at = null,
            ends_at = null,
            is_active = true,
            note = '',
        } = req.body || {};
        if (!toNonEmptyString(skill_id)) {
            return res.status(400).json({ success: false, error: 'skill_id là bắt buộc.' });
        }
        if (override_price === null && discount_percent === null) {
            return res.status(400).json({ success: false, error: 'Cần override_price hoặc discount_percent.' });
        }
        try {
            await ensurePaymentSchema();
            const skillResult = await db.query('SELECT id FROM marketplace_skills WHERE id = $1 LIMIT 1', [skill_id]);
            if (!skillResult.rows[0]) {
                return res.status(404).json({ success: false, error: 'Skill không tồn tại.' });
            }

            const normalizedOverride = override_price === null ? null : toMoneyNumber(override_price);
            let normalizedPercent = null;
            if (discount_percent !== null) {
                normalizedPercent = Number(discount_percent);
                if (!Number.isFinite(normalizedPercent) || normalizedPercent < 0 || normalizedPercent > 100) {
                    return res.status(400).json({ success: false, error: 'discount_percent phải trong khoảng 0-100.' });
                }
            }

            const inserted = await db.query(
                `INSERT INTO omnimind_skill_price_overrides
                    (skill_id, override_price, discount_percent, starts_at, ends_at, is_active, note, created_at)
                 VALUES
                    ($1, $2, $3, $4, $5, $6, $7, NOW())
                 RETURNING *`,
                [
                    toNonEmptyString(skill_id),
                    normalizedOverride,
                    normalizedPercent,
                    starts_at || null,
                    ends_at || null,
                    Boolean(is_active),
                    toNonEmptyString(note),
                ]
            );
            res.json({ success: true, data: inserted.rows[0] });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.delete('/api/v1/admin/omnimind/pricing/overrides/:id', authMiddleware, async (req, res) => {
        const overrideId = Number(req.params.id);
        if (!Number.isFinite(overrideId) || overrideId <= 0) {
            return res.status(400).json({ success: false, error: 'ID không hợp lệ.' });
        }
        try {
            await ensurePaymentSchema();
            const result = await db.query(
                'DELETE FROM omnimind_skill_price_overrides WHERE id = $1 RETURNING id',
                [overrideId]
            );
            if (!result.rows[0]) {
                return res.status(404).json({ success: false, error: 'Override không tồn tại.' });
            }
            res.json({ success: true, message: 'Đã xoá pricing override.' });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.get('/api/v1/admin/omnimind/payments/transactions', authMiddleware, async (req, res) => {
        const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
        const txType = toNonEmptyString(req.query.type || '').toUpperCase();
        try {
            await ensurePaymentSchema();
            const params = [];
            let where = `WHERE provider = 'SEPAY'`;
            if (txType) {
                params.push(txType);
                where += ` AND type = $${params.length}`;
            }
            params.push(limit);
            const result = await db.query(
                `SELECT id, type, item_id, license_key, amount, currency, status,
                        provider, payment_content, provider_transaction_id, qr_url,
                        expires_at, paid_at, created_at, updated_at, failure_reason, metadata_json
                 FROM transactions
                 ${where}
                 ORDER BY created_at DESC
                 LIMIT $${params.length}`,
                params
            );
            res.json({ success: true, data: result.rows });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.get('/api/v1/admin/omnimind/payments/users/history', authMiddleware, async (req, res) => {
        const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
        const search = toNonEmptyString(req.query.search || '');
        try {
            await ensurePaymentSchema();
            const params = [];
            let where = `WHERE t.provider = 'SEPAY'`;
            if (search) {
                params.push(`%${search}%`);
                where += ` AND (
                    COALESCE(t.license_key, '') ILIKE $${params.length}
                    OR COALESCE(t.item_id, '') ILIKE $${params.length}
                    OR COALESCE(t.payment_content, '') ILIKE $${params.length}
                )`;
            }
            params.push(limit);

            const result = await db.query(
                `
                    SELECT
                        grouped.license_key,
                        grouped.total_transactions,
                        grouped.success_transactions,
                        grouped.pending_transactions,
                        grouped.failed_transactions,
                        grouped.total_success_amount,
                        grouped.first_transaction_at,
                        grouped.last_transaction_at,
                        grouped.last_transaction_id,
                        l.status AS license_status,
                        l.plan_id AS license_plan_id
                    FROM (
                        SELECT
                            COALESCE(NULLIF(t.license_key, ''), '__NO_LICENSE__') AS license_key,
                            COUNT(*)::int AS total_transactions,
                            SUM(CASE WHEN UPPER(COALESCE(t.status, '')) = 'SUCCESS' THEN 1 ELSE 0 END)::int AS success_transactions,
                            SUM(CASE WHEN UPPER(COALESCE(t.status, '')) = 'PENDING' THEN 1 ELSE 0 END)::int AS pending_transactions,
                            SUM(CASE WHEN UPPER(COALESCE(t.status, '')) IN ('FAILED', 'EXPIRED') THEN 1 ELSE 0 END)::int AS failed_transactions,
                            COALESCE(SUM(CASE WHEN UPPER(COALESCE(t.status, '')) = 'SUCCESS' THEN COALESCE(t.amount, 0) ELSE 0 END), 0)::numeric(14,2) AS total_success_amount,
                            MIN(t.created_at) AS first_transaction_at,
                            MAX(t.created_at) AS last_transaction_at,
                            (ARRAY_AGG(t.id ORDER BY t.created_at DESC))[1] AS last_transaction_id
                        FROM transactions t
                        ${where}
                        GROUP BY COALESCE(NULLIF(t.license_key, ''), '__NO_LICENSE__')
                    ) grouped
                    LEFT JOIN licenses l
                      ON grouped.license_key <> '__NO_LICENSE__'
                     AND l.license_key = grouped.license_key
                    ORDER BY grouped.last_transaction_at DESC
                    LIMIT $${params.length}
                `,
                params
            );

            const rows = result.rows.map((row) => ({
                license_key: row.license_key === '__NO_LICENSE__' ? '' : toNonEmptyString(row.license_key),
                label: row.license_key === '__NO_LICENSE__' ? 'Không gắn license' : toNonEmptyString(row.license_key),
                total_transactions: Number(row.total_transactions || 0),
                success_transactions: Number(row.success_transactions || 0),
                pending_transactions: Number(row.pending_transactions || 0),
                failed_transactions: Number(row.failed_transactions || 0),
                total_success_amount: toMoneyNumber(row.total_success_amount || 0),
                first_transaction_at: row.first_transaction_at,
                last_transaction_at: row.last_transaction_at,
                last_transaction_id: toNonEmptyString(row.last_transaction_id),
                license_status: toNonEmptyString(row.license_status),
                license_plan_id: toNonEmptyString(row.license_plan_id),
            }));
            res.json({ success: true, data: rows });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.get('/api/v1/admin/omnimind/payments/audits', authMiddleware, async (req, res) => {
        const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
        const transactionId = toNonEmptyString(req.query.transaction_id || '');
        try {
            await ensurePaymentSchema();
            if (transactionId) {
                const result = await db.query(
                    `SELECT id, transaction_id, event_type, detail_json, created_at
                     FROM omnimind_payment_audit_logs
                     WHERE transaction_id = $1
                     ORDER BY created_at DESC
                     LIMIT $2`,
                    [transactionId, limit]
                );
                return res.json({ success: true, data: result.rows });
            }

            const result = await db.query(
                `SELECT id, transaction_id, event_type, detail_json, created_at
                 FROM omnimind_payment_audit_logs
                 ORDER BY created_at DESC
                 LIMIT $1`,
                [limit]
            );
            res.json({ success: true, data: result.rows });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.get('/api/v1/admin/omnimind/monitoring/summary', authMiddleware, async (_req, res) => {
        try {
            await ensurePaymentSchema();

            const tx24h = await db.query(
                `
                    SELECT
                        COUNT(*)::int AS total,
                        SUM(CASE WHEN UPPER(COALESCE(status, '')) = 'SUCCESS' THEN 1 ELSE 0 END)::int AS success,
                        SUM(CASE WHEN UPPER(COALESCE(status, '')) = 'PENDING' THEN 1 ELSE 0 END)::int AS pending,
                        SUM(CASE WHEN UPPER(COALESCE(status, '')) IN ('FAILED', 'EXPIRED') THEN 1 ELSE 0 END)::int AS failed,
                        COALESCE(SUM(CASE WHEN UPPER(COALESCE(status, '')) = 'SUCCESS' THEN COALESCE(amount, 0) ELSE 0 END), 0)::numeric(14,2) AS success_amount
                    FROM transactions
                    WHERE provider = 'SEPAY'
                      AND created_at >= NOW() - INTERVAL '24 hours'
                `
            );
            const tx7d = await db.query(
                `
                    SELECT
                        COUNT(*)::int AS total,
                        SUM(CASE WHEN UPPER(COALESCE(status, '')) = 'SUCCESS' THEN 1 ELSE 0 END)::int AS success,
                        SUM(CASE WHEN UPPER(COALESCE(status, '')) = 'PENDING' THEN 1 ELSE 0 END)::int AS pending,
                        SUM(CASE WHEN UPPER(COALESCE(status, '')) IN ('FAILED', 'EXPIRED') THEN 1 ELSE 0 END)::int AS failed,
                        COALESCE(SUM(CASE WHEN UPPER(COALESCE(status, '')) = 'SUCCESS' THEN COALESCE(amount, 0) ELSE 0 END), 0)::numeric(14,2) AS success_amount
                    FROM transactions
                    WHERE provider = 'SEPAY'
                      AND created_at >= NOW() - INTERVAL '7 days'
                `
            );
            const overduePending = await db.query(
                `
                    SELECT COUNT(*)::int AS total
                    FROM transactions
                    WHERE provider = 'SEPAY'
                      AND UPPER(COALESCE(status, '')) = 'PENDING'
                      AND created_at <= NOW() - INTERVAL '30 minutes'
                `
            );
            const webhook24h = await db.query(
                `
                    SELECT
                        COUNT(*)::int AS total,
                        SUM(CASE WHEN status = 'matched' THEN 1 ELSE 0 END)::int AS matched,
                        SUM(CASE WHEN status = 'unmatched' THEN 1 ELSE 0 END)::int AS unmatched,
                        SUM(CASE WHEN status = 'amount_mismatch' THEN 1 ELSE 0 END)::int AS amount_mismatch,
                        SUM(CASE WHEN status = 'ignored' THEN 1 ELSE 0 END)::int AS ignored
                    FROM omnimind_sepay_transactions
                    WHERE created_at >= NOW() - INTERVAL '24 hours'
                `
            );
            const audit24h = await db.query(
                `
                    SELECT
                        COUNT(*)::int AS total,
                        SUM(CASE WHEN event_type IN (
                            'webhook_unmatched_no_content',
                            'webhook_unmatched_payment_content',
                            'webhook_amount_mismatch'
                        ) THEN 1 ELSE 0 END)::int AS error_events
                    FROM omnimind_payment_audit_logs
                    WHERE created_at >= NOW() - INTERVAL '24 hours'
                `
            );

            const mapTx = (row = {}) => ({
                total: Number(row.total || 0),
                success: Number(row.success || 0),
                pending: Number(row.pending || 0),
                failed: Number(row.failed || 0),
                success_amount: toMoneyNumber(row.success_amount || 0),
            });
            const mapWebhook = (row = {}) => ({
                total: Number(row.total || 0),
                matched: Number(row.matched || 0),
                unmatched: Number(row.unmatched || 0),
                amount_mismatch: Number(row.amount_mismatch || 0),
                ignored: Number(row.ignored || 0),
            });

            res.json({
                success: true,
                data: {
                    generated_at: new Date().toISOString(),
                    transactions_24h: mapTx(tx24h.rows?.[0] || {}),
                    transactions_7d: mapTx(tx7d.rows?.[0] || {}),
                    overdue_pending_count: Number(overduePending.rows?.[0]?.total || 0),
                    webhook_24h: mapWebhook(webhook24h.rows?.[0] || {}),
                    audits_24h: {
                        total: Number(audit24h.rows?.[0]?.total || 0),
                        error_events: Number(audit24h.rows?.[0]?.error_events || 0),
                    },
                },
            });
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
