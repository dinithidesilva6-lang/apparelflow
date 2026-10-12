const express = require('express');
const pool = require('./db');
const { authenticate, requireRole } = require('./auth');

const router = express.Router();
router.use(authenticate);
router.use(requireRole('sewing_supervisor'));

function toInt(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

router.get('/queue', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.id, o.order_no, o.target_qty, o.fabric_roll_id, o.actual_fabric_yds, o.status,
              r.recipe_code, r.name AS recipe_name,
              l.verifier_id, u.full_name AS verifier_name,
              l.timestamp AS verified_at, l.wastage_pct
       FROM cutting_orders o
       JOIN recipes r ON r.id = o.recipe_id
       JOIN verification_logs l ON l.order_id = o.id AND l.decision = 'APPROVED'
       JOIN users u ON u.id = l.verifier_id
       WHERE o.status = 'VERIFIED'
       ORDER BY l.timestamp ASC`
    );
    return res.json({ orders: result.rows });
  } catch (err) {
    console.error('Sewing queue error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.get('/started', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.id, o.order_no, o.target_qty, o.status, o.sewing_started_at,
              r.recipe_code, r.name AS recipe_name
       FROM cutting_orders o
       JOIN recipes r ON r.id = o.recipe_id
       WHERE o.status = 'SEWING_STARTED'
       ORDER BY o.sewing_started_at DESC`
    );
    return res.json({ orders: result.rows });
  } catch (err) {
    console.error('Sewing started error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:id', async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid order id' });

  try {
    const orderRes = await pool.query(
      `SELECT o.id, o.order_no, o.target_qty, o.fabric_roll_id, o.actual_fabric_yds, o.status,
              r.recipe_code, r.name AS recipe_name,
              l.verifier_id, u.full_name AS verifier_name,
              l.timestamp AS verified_at, l.wastage_pct, l.variance_snapshot
       FROM cutting_orders o
       JOIN recipes r ON r.id = o.recipe_id
       JOIN verification_logs l ON l.order_id = o.id AND l.decision = 'APPROVED'
       JOIN users u ON u.id = l.verifier_id
       WHERE o.id = $1 AND o.status IN ('VERIFIED', 'SEWING_STARTED')`,
      [id]
    );
    const order = orderRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    return res.json({ order });
  } catch (err) {
    console.error('Sewing detail error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:id/start', async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid order id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const found = await client.query('SELECT id, status FROM cutting_orders WHERE id = $1 FOR UPDATE', [id]);
    const order = found.rows[0];

    if (!order || !['VERIFIED', 'SEWING_STARTED'].includes(order.status)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.status !== 'VERIFIED') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Sewing already started for this order' });
    }

    await client.query(
      `UPDATE cutting_orders
       SET status = 'SEWING_STARTED', sewing_started_by = $1, sewing_started_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [req.user.id, id]
    );

    await client.query('COMMIT');
    return res.json({ message: 'Sewing assembly started', order_id: id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Start sewing error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

module.exports = router;