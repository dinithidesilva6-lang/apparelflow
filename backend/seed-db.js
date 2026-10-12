require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});

const recipes = [
  {
    code: 'REC-BL01',
    name: 'Casual Blouse',
    category: 'Blouse',
    yards: 1.8,
    cap: 5.0,
    components: [
      ['Front Body Panel', 1],
      ['Back Body Panel', 1],
      ['Sleeves (Left & Right)', 2],
      ['Collar & Stand', 1],
      ['Sleeve Cuffs', 2],
    ],
  },
  {
    code: 'REC-CT02',
    name: 'Crop Top',
    category: 'Crop Top',
    yards: 1.1,
    cap: 8.0,
    components: [
      ['Front Chest Panel', 1],
      ['Back Support Panel', 1],
      ['Neck Binding Strip', 1],
      ['Hem Elastic Casing', 1],
      ['Side Strap Accents', 2],
    ],
  },
];

const users = [
  ['supervisor@apparelflow.com', 'Supervisor@123', 'cutting_supervisor', 'Cutting Supervisor'],
  ['verifier@apparelflow.com', 'Verifier@123', 'cutting_verifier', 'Cutting Verifier'],
  ['sewing@apparelflow.com', 'Sewing@123', 'sewing_supervisor', 'Sewing Supervisor'],
];

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const r of recipes) {
      const existing = await client.query('SELECT id FROM recipes WHERE recipe_code = $1', [r.code]);
      if (existing.rows.length > 0) continue;

      const ins = await client.query(
        'INSERT INTO recipes (recipe_code, name, category, std_fabric_yards, wastage_cap) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [r.code, r.name, r.category, r.yards, r.cap]
      );
      const recipeId = ins.rows[0].id;
      for (const [name, pieces] of r.components) {
        await client.query(
          'INSERT INTO recipe_components (recipe_id, component_name, pieces_per_garment) VALUES ($1,$2,$3)',
          [recipeId, name, pieces]
        );
      }
    }

    for (const [email, password, role, fullName] of users) {
      const hash = await bcrypt.hash(password, 10);
      await client.query(
        `INSERT INTO users (email, password_hash, role, full_name)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (email) DO NOTHING`,
        [email, hash, role, fullName]
      );
    }

    await client.query('COMMIT');

    const rc = await pool.query('SELECT COUNT(*) FROM recipes');
    const cc = await pool.query('SELECT COUNT(*) FROM recipe_components');
    const uc = await pool.query('SELECT COUNT(*) FROM users');
    console.log('SEED OK');
    console.log(' recipes:', rc.rows[0].count);
    console.log(' recipe_components:', cc.rows[0].count);
    console.log(' users:', uc.rows[0].count);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('SEED FAILED:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();