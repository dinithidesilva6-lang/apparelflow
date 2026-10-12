require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(150) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(30) NOT NULL
    CHECK (role IN ('cutting_supervisor','cutting_verifier','sewing_supervisor')),
  full_name VARCHAR(150) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recipes (
  id SERIAL PRIMARY KEY,
  recipe_code VARCHAR(30) UNIQUE NOT NULL,
  name VARCHAR(150) NOT NULL,
  category VARCHAR(80) NOT NULL,
  std_fabric_yards NUMERIC(8,2) NOT NULL CHECK (std_fabric_yards > 0),
  wastage_cap NUMERIC(5,2) NOT NULL CHECK (wastage_cap >= 0)
);

CREATE TABLE IF NOT EXISTS recipe_components (
  id SERIAL PRIMARY KEY,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  component_name VARCHAR(150) NOT NULL,
  pieces_per_garment INTEGER NOT NULL CHECK (pieces_per_garment > 0),
  image_url TEXT
);

CREATE TABLE IF NOT EXISTS cutting_orders (
  id SERIAL PRIMARY KEY,
  order_no VARCHAR(40) UNIQUE NOT NULL,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id),
  target_qty INTEGER NOT NULL CHECK (target_qty > 0),
  fabric_roll_id VARCHAR(60) NOT NULL,
  actual_fabric_yds NUMERIC(10,2) NOT NULL CHECK (actual_fabric_yds > 0),
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING_VERIFICATION'
    CHECK (status IN ('CUTTING_IN_PROGRESS','PENDING_VERIFICATION','REJECTED','VERIFIED','SEWING_STARTED')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  sewing_started_by INTEGER REFERENCES users(id),
  sewing_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS verification_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES cutting_orders(id) ON DELETE CASCADE,
  component_id INTEGER NOT NULL REFERENCES recipe_components(id),
  expected_qty INTEGER NOT NULL CHECK (expected_qty >= 0),
  actual_qty INTEGER CHECK (actual_qty >= 0),
  status VARCHAR(10) CHECK (status IN ('GREEN','YELLOW','RED')),
  UNIQUE (order_id, component_id)
);

CREATE TABLE IF NOT EXISTS verification_logs (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES cutting_orders(id),
  verifier_id INTEGER NOT NULL REFERENCES users(id),
  decision VARCHAR(10) NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  rejection_note TEXT,
  wastage_pct NUMERIC(8,2),
  variance_snapshot JSONB,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (decision <> 'REJECTED' OR (rejection_note IS NOT NULL AND LENGTH(TRIM(rejection_note)) > 0))
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON cutting_orders(status);

CREATE OR REPLACE FUNCTION block_log_changes() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'verification_logs is immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_logs_immutable ON verification_logs;
CREATE TRIGGER trg_logs_immutable
  BEFORE UPDATE OR DELETE ON verification_logs
  FOR EACH ROW EXECUTE FUNCTION block_log_changes();
`;

pool
  .query(schema)
  .then(() => pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"))
  .then((res) => {
    console.log('TABLES CREATED:');
    res.rows.forEach((r) => console.log(' -', r.table_name));
    return pool.end();
  })
  .catch((err) => {
    console.error('SETUP FAILED:', err.message);
    return pool.end();
  });