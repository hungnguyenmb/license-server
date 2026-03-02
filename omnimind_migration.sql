-- =====================================================
-- OmniMind Migration: Bổ sung bảng mới cho OmniMind
-- Chạy trên database: db_license (PostgreSQL)
-- KHÔNG ảnh hưởng bảng `licenses` hiện tại.
-- =====================================================

-- 1. app_versions: Quản lý phiên bản ứng dụng
CREATE TABLE IF NOT EXISTS app_versions (
    version_id VARCHAR(20) PRIMARY KEY,       -- VD: '1.2.0'
    version_name VARCHAR(100),                -- VD: 'Phoenix Update'
    release_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_critical BOOLEAN DEFAULT FALSE,
    download_url TEXT                          -- URL tải Payload ZIP
);

-- 2. changelogs: Chi tiết thay đổi của từng phiên bản
CREATE TABLE IF NOT EXISTS changelogs (
    id SERIAL PRIMARY KEY,
    version_id VARCHAR(20) REFERENCES app_versions(version_id) ON DELETE CASCADE,
    change_type VARCHAR(20) NOT NULL,         -- 'feat', 'fix', 'refactor'
    content TEXT NOT NULL
);

-- 3. license_devices: Quản lý HWID binding (chống cài nhiều máy)
CREATE TABLE IF NOT EXISTS license_devices (
    id SERIAL PRIMARY KEY,
    license_id INTEGER REFERENCES licenses(id) ON DELETE CASCADE,
    hwid VARCHAR(64) NOT NULL,                -- SHA-256 hash 32 chars
    os_name VARCHAR(100),                     -- 'Darwin', 'Windows'
    os_version VARCHAR(255),
    last_login TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(license_id, hwid)
);

-- 4. marketplace_skills: Danh mục kỹ năng (Master data)
CREATE TABLE IF NOT EXISTS marketplace_skills (
    id VARCHAR(100) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    skill_type VARCHAR(20) DEFAULT 'KNOWLEDGE', -- 'KNOWLEDGE' or 'TOOL'
    price REAL DEFAULT 0,
    author VARCHAR(100),
    version VARCHAR(20),
    manifest_json JSONB,
    is_vip BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. transactions: Lịch sử thanh toán
CREATE TABLE IF NOT EXISTS transactions (
    id VARCHAR(100) PRIMARY KEY,              -- 'txn_2025_xxx'
    type VARCHAR(20) NOT NULL,                -- 'SKILL' or 'LICENSE'
    item_id VARCHAR(100) NOT NULL,            -- skill_id or plan_id
    license_key VARCHAR(255),
    amount REAL DEFAULT 0,
    status VARCHAR(20) DEFAULT 'PENDING',     -- PENDING, SUCCESS, FAILED
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6. purchased_skills: Biên lai mua kỹ năng
CREATE TABLE IF NOT EXISTS purchased_skills (
    id SERIAL PRIMARY KEY,
    skill_id VARCHAR(100) REFERENCES marketplace_skills(id),
    license_key VARCHAR(255),
    purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. omnimind_codex_releases: Ma trận link tải Codex theo OS + Arch
CREATE TABLE IF NOT EXISTS omnimind_codex_releases (
    id SERIAL PRIMARY KEY,
    platform VARCHAR(20) NOT NULL,             -- darwin / win32 / linux
    arch VARCHAR(20) NOT NULL,                 -- arm64 / x64 / ...
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
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(platform, arch, channel)
);

INSERT INTO omnimind_codex_releases (platform, arch, channel, version, url, method, is_active, file_name)
VALUES
('darwin', 'arm64', 'stable', '1.5.0', 'https://github.com/Antigravity-AI/codex-cli/releases/download/v1.5.0/codex-macos-arm64.zip', 'zip_extract', TRUE, 'codex-macos-arm64.zip'),
('win32', 'x64', 'stable', '1.5.0', 'https://github.com/Antigravity-AI/codex-cli/releases/download/v1.5.0/codex-windows-x64.zip', 'zip_extract', TRUE, 'codex-windows-x64.zip')
ON CONFLICT (platform, arch, channel) DO NOTHING;

-- Thêm cột plan_id và issued_source vào bảng licenses hiện có (nếu chưa có)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='licenses' AND column_name='plan_id') THEN
        ALTER TABLE licenses ADD COLUMN plan_id VARCHAR(50) DEFAULT 'Standard';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='licenses' AND column_name='issued_source') THEN
        ALTER TABLE licenses ADD COLUMN issued_source VARCHAR(20) DEFAULT 'CMS';
    END IF;
END $$;

-- Seed: Phiên bản đầu tiên
INSERT INTO app_versions (version_id, version_name, is_critical, download_url)
VALUES ('1.0.0', 'Genesis', FALSE, '')
ON CONFLICT (version_id) DO NOTHING;

INSERT INTO changelogs (version_id, change_type, content)
VALUES ('1.0.0', 'feat', 'Phiên bản đầu tiên - Kích hoạt License, Dashboard, Memory Rules, Vault')
ON CONFLICT DO NOTHING;
