-- ==========================================================
-- OmniMind Database Full Backup (Schema & Seed Data)
-- Target Database: db_license (PostgreSQL)
-- Generated on: 2026-03-01
-- ==========================================================

-- 1. Table: licenses (Base table)
CREATE TABLE IF NOT EXISTS licenses (
    id SERIAL PRIMARY KEY,
    license_key VARCHAR(255) UNIQUE NOT NULL,
    machine_id VARCHAR(255),
    status VARCHAR(50) DEFAULT 'active', -- active, suspended, expired
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,
    hardware_details JSONB,
    note TEXT,
    plan_id VARCHAR(50) DEFAULT 'Standard',
    issued_source VARCHAR(20) DEFAULT 'CMS'
);

-- 2. Table: app_versions
CREATE TABLE IF NOT EXISTS app_versions (
    version_id VARCHAR(20) PRIMARY KEY,       -- VD: '1.2.0'
    version_name VARCHAR(100),                -- VD: 'Phoenix Update'
    release_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_critical BOOLEAN DEFAULT FALSE,
    download_url TEXT                          -- URL tải Payload ZIP
);

-- 3. Table: changelogs
CREATE TABLE IF NOT EXISTS changelogs (
    id SERIAL PRIMARY KEY,
    version_id VARCHAR(20) REFERENCES app_versions(version_id) ON DELETE CASCADE,
    change_type VARCHAR(20) NOT NULL,         -- 'feat', 'fix', 'refactor'
    content TEXT NOT NULL
);

-- 4. Table: license_devices (HWID binding)
CREATE TABLE IF NOT EXISTS license_devices (
    id SERIAL PRIMARY KEY,
    license_id INTEGER REFERENCES licenses(id) ON DELETE CASCADE,
    hwid VARCHAR(64) NOT NULL,                -- SHA-256 hash
    os_name VARCHAR(100),                     -- 'Darwin', 'Windows'
    os_version VARCHAR(255),
    last_login TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(license_id, hwid)
);

-- 5. Table: marketplace_skills
CREATE TABLE IF NOT EXISTS marketplace_skills (
    id VARCHAR(100) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    skill_type VARCHAR(20) DEFAULT 'KNOWLEDGE',
    price REAL DEFAULT 0,
    author VARCHAR(100),
    version VARCHAR(20),
    manifest_json JSONB,
    is_vip BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6. Table: transactions
CREATE TABLE IF NOT EXISTS transactions (
    id VARCHAR(100) PRIMARY KEY,
    type VARCHAR(20) NOT NULL,                -- 'SKILL' or 'LICENSE'
    item_id VARCHAR(100) NOT NULL,
    license_key VARCHAR(255),
    amount REAL DEFAULT 0,
    status VARCHAR(20) DEFAULT 'PENDING',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. Table: purchased_skills
CREATE TABLE IF NOT EXISTS purchased_skills (
    id SERIAL PRIMARY KEY,
    skill_id VARCHAR(100) REFERENCES marketplace_skills(id),
    license_key VARCHAR(255),
    purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================================
-- SEED DATA
-- ==========================================================

-- Seed Initial Test License
INSERT INTO licenses (license_key, expires_at, plan_id, issued_source) 
VALUES ('ANTIG-TEST-12345', CURRENT_TIMESTAMP + INTERVAL '30 days', 'Standard', 'CMS')
ON CONFLICT (license_key) DO NOTHING;

-- Seed Initial App Version
INSERT INTO app_versions (version_id, version_name, is_critical, download_url)
VALUES ('1.0.0', 'Genesis', FALSE, '')
ON CONFLICT (version_id) DO NOTHING;

-- Seed Initial Changelog
INSERT INTO changelogs (version_id, change_type, content)
VALUES ('1.0.0', 'feat', 'Phiên bản đầu tiên - Kích hoạt License, Dashboard, Memory Rules, Vault')
ON CONFLICT DO NOTHING;

-- ==========================================================
-- END OF BACKUP
-- ==========================================================
