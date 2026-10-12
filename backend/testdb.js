require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});

pool
  .query('SELECT NOW() AS time')
  .then((res) => {
    console.log('DB CONNECTED OK:', res.rows[0].time);
    return pool.end();
  })
  .catch((err) => {
    console.error('DB CONNECTION FAILED');
    console.error('code:', err.code);
    console.error('message:', err.message);
    if (err.errors) {
      err.errors.forEach((e) => console.error(' -', e.code, e.address, e.port));
    }
    return pool.end();
  });