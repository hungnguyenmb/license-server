CREATE TABLE IF NOT EXISTS licenses (
    id SERIAL PRIMARY KEY,
    license_key VARCHAR(255) UNIQUE NOT NULL,
    machine_id VARCHAR(255),
    status VARCHAR(50) DEFAULT 'active', -- active, suspended, expired
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,
    hardware_details JSONB,
    note TEXT
);

-- Seed an initial test key
INSERT INTO licenses (license_key, expires_at) 
VALUES ('ANTIG-TEST-12345', CURRENT_TIMESTAMP + INTERVAL '30 days')
ON CONFLICT (license_key) DO NOTHING;
