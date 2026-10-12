const express = require('express');
const pool = require('./db');
const { authenticate, requireRole } = require('./auth');

const ordersRouter = express.Router();
const recipesRouter = express.Router();

ordersRouter.use(authenticate);
recipesRouter.use(authenticate);

function toInt(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

function toYards(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return /^\d+(\.\d{1,2})?$/.test(String(v)) ? v : null;
  }
  if (typeof v === 'string' && /^\d+(\.\d{1,2})?$/.test(v.trim())) return Number(v.trim());
  return null;
}

recipesRouter.get('/', requireRole('cutting_supervisor', 'cutting_verifier'), async (req, res) => {
  try {
    const recipes = await pool.query(
      'SELECT id, recipe_code, name, category, std_fabric_yards, wastage_cap FROM recipes ORDER BY id'
    );
    const comps = await pool.query(
      'SELECT id, recipe_id, component_name, pieces_per_garment FROM recipe_components ORDER BY id'
    );
    const data = recipes.rows.map((r) => ({
      ...r,
      components: comps.rows.filter((c) => c.recipe_id === r.id),
    }));
    return res.json({ recipes: data });
  } catch (err) {
    console.error('Recipes error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

ordersRouter.post('/', requireRole('cutting_supervisor'), async (req, res) => {
  const body = req.body || {};
  const errors = {};

  const recipeId = toInt(body.recipe_id);
  const qty = toInt(body.target_qty);
  const yards = toYards(body.actual_fabric_yds);
  const roll = typeof body.fabric_roll_id === 'string' ? body.fabric_roll_id.trim() : '';

  if (!recipeId || recipeId < 1) errors.recipe_id = 'Select a valid recipe';
  if (!qty || qty < 1 || qty > 100000) errors.target_qty = 'Whole number between 1 and 100000 required';
  if (!roll || roll.length > 60) errors.fabric_roll_id = 'Fabric roll ID is required (max 60 characters)';
  if (yards === null || yards <= 0 || yards > 1000000) {
    errors.actual_fabric_yds = 'Positive number with up to 2 decimals required';
  }

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ error: 'Validation failed', fields: errors });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const recipe = await client.query('SELECT id FROM recipes WHERE id = $1', [recipeId]);
    if (recipe.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Recipe not found' });
    }

    const tmpNo = 'TMP-' + Date.now() + '-' + Math.floor(Math.random() * 100000);
    const ins = await client.query(
      `INSERT INTO cutting_orders
         (order_no, recipe_id, target_qty, fabric_roll_id, actual_fabric_yds, status, created_by)
       VALUES ($1, $2, $3, $4, $5, 'PENDING_VERIFICATION', $6)
       RETURNING id`,
      [tmpNo, recipeId, qty, roll, yards, req.user.id]
    );
    const orderId = ins.rows[0].id;

    await client.query(
      "UPDATE cutting_orders SET order_no = 'CO-' || LPAD(id::text, 5, '0') WHERE id = $1",
      [orderId]
    );

    await client.query(
      `INSERT INTO verification_items (order_id, component_id, expected_qty)
       SELECT $1, id, pieces_per_garment * $2
       FROM recipe_components WHERE recipe_id = $3`,
      [orderId, qty, recipeId]
    );

    await client.query('COMMIT');

    const created = await pool.query(
      'SELECT id, order_no, recipe_id, target_qty, fabric_roll_id, actual_fabric_yds, status, created_at FROM cutting_orders WHERE id = $1',
      [orderId]
    );
    return res.status(201).json({ order: created.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create order error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

ordersRouter.get('/', requireRole('cutting_supervisor', 'cutting_verifier'), async (req, res) => {
  try {
    const verifierOnly = req.user.role === 'cutting_verifier';
    const where = verifierOnly ? "WHERE o.status = 'PENDING_VERIFICATION'" : '';
    const result = await pool.query(
      `SELECT o.id, o.order_no, o.target_qty, o.fabric_roll_id, o.actual_fabric_yds,
              o.status, o.created_at, r.recipe_code, r.name AS recipe_name
       FROM cutting_orders o
       JOIN recipes r ON r.id = o.recipe_id
       ${where}
       ORDER BY o.created_at DESC`
    );
    return res.json({ orders: result.rows });
  } catch (err) {
    console.error('List orders error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

ordersRouter.get('/:id', requireRole('cutting_supervisor', 'cutting_verifier'), async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid order id' });

  try {
    const orderRes = await pool.query(
      `SELECT o.id, o.order_no, o.target_qty, o.fabric_roll_id, o.actual_fabric_yds, o.status,
              o.created_at, r.recipe_code, r.name AS recipe_name,
              r.std_fabric_yards, r.wastage_cap,
              (r.std_fabric_yards * o.target_qty) AS expected_fabric_yds
       FROM cutting_orders o
       JOIN recipes r ON r.id = o.recipe_id
       WHERE o.id = $1`,
      [id]
    );
    const order = orderRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (req.user.role === 'cutting_verifier' && order.status !== 'PENDING_VERIFICATION') {
      return res.status(404).json({ error: 'Order not found' });
    }

    const items = await pool.query(
      `SELECT vi.id, vi.component_id, rc.component_name, vi.expected_qty, vi.actual_qty, vi.status
       FROM verification_items vi
       JOIN recipe_components rc ON rc.id = vi.component_id
       WHERE vi.order_id = $1
       ORDER BY vi.component_id`,
      [id]
    );

    const rejection = await pool.query(
      `SELECT rejection_note, timestamp FROM verification_logs
       WHERE order_id = $1 AND decision = 'REJECTED'
       ORDER BY timestamp DESC LIMIT 1`,
      [id]
    );

    return res.json({
      order,
      items: items.rows,
      last_rejection: rejection.rows[0] || null,
    });
  } catch (err) {
    console.error('Get order error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = { ordersRouter, recipesRouter };