const express = require('express');
const pool = require('./db');
const { authenticate, requireRole } = require('./auth');

const router = express.Router();
router.use(authenticate);
router.use(requireRole('cutting_verifier'));

function toInt(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

function flagFor(actual, expected) {
  if (actual === expected) return 'GREEN';
  if (actual > expected) return 'YELLOW';
  return 'RED';
}

function buildSnapshot(items) {
  return items.map((i) => ({
    component_id: i.component_id,
    component_name: i.component_name,
    expected_qty: i.expected_qty,
    actual_qty: i.actual_qty,
    variance: i.actual_qty === null ? null : i.actual_qty - i.expected_qty,
    status: i.actual_qty === null ? null : flagFor(i.actual_qty, i.expected_qty),
  }));
}

async function lockPendingOrder(client, orderId) {
  const r = await client.query(
    `SELECT o.id, o.status, o.target_qty, o.actual_fabric_yds, r.std_fabric_yards
     FROM cutting_orders o
     JOIN recipes r ON r.id = o.recipe_id
     WHERE o.id = $1
     FOR UPDATE OF o`,
    [orderId]
  );
  return r.rows[0] || null;
}

async function loadItems(client, orderId) {
  const r = await client.query(
    `SELECT vi.id, vi.component_id, rc.component_name, vi.expected_qty, vi.actual_qty
     FROM verification_items vi
     JOIN recipe_components rc ON rc.id = vi.component_id
     WHERE vi.order_id = $1
     ORDER BY vi.component_id`,
    [orderId]
  );
  return r.rows;
}

function computeWastage(order) {
  const expected = Number(order.std_fabric_yards) * order.target_qty;
  const actual = Number(order.actual_fabric_yds);
  return Math.round(((actual - expected) / expected) * 10000) / 100;
}

router.post('/:id/count', async (req, res) => {
  const orderId = toInt(req.params.id);
  if (!orderId) return res.status(400).json({ error: 'Invalid order id' });

  const counts = req.body && req.body.counts;
  if (!Array.isArray(counts) || counts.length === 0) {
    return res.status(400).json({ error: 'counts array is required' });
  }

  const parsed = [];
  const seen = new Set();
  for (const c of counts) {
    const componentId = toInt(c && c.component_id);
    const qty = toInt(c && c.actual_qty);
    if (!componentId || qty === null || qty > 10000000) {
      return res.status(400).json({
        error: 'Each count needs a valid component_id and a whole-number actual_qty (0 or more)',
      });
    }
    if (seen.has(componentId)) {
      return res.status(400).json({ error: 'Duplicate component in counts' });
    }
    seen.add(componentId);
    parsed.push({ componentId, qty });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const order = await lockPendingOrder(client, orderId);
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.status !== 'PENDING_VERIFICATION') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Order is not awaiting verification' });
    }

    const items = await loadItems(client, orderId);
    const byComponent = new Map(items.map((i) => [i.component_id, i]));

    for (const p of parsed) {
      const item = byComponent.get(p.componentId);
      if (!item) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Component ' + p.componentId + ' does not belong to this order' });
      }
      await client.query(
        'UPDATE verification_items SET actual_qty = $1, status = $2 WHERE id = $3',
        [p.qty, flagFor(p.qty, item.expected_qty), item.id]
      );
    }

    await client.query('COMMIT');

    const fresh = await loadItems(pool, orderId);
    const snapshot = buildSnapshot(fresh);
    const canApprove = snapshot.length > 0 && snapshot.every((s) => s.status === 'GREEN' || s.status === 'YELLOW');
    return res.json({ items: snapshot, can_approve: canApprove });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Count error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

router.post('/:id/approve', async (req, res) => {
  const orderId = toInt(req.params.id);
  if (!orderId) return res.status(400).json({ error: 'Invalid order id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const order = await lockPendingOrder(client, orderId);
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.status !== 'PENDING_VERIFICATION') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Order is not awaiting verification' });
    }

    const items = await loadItems(client, orderId);
    const snapshot = buildSnapshot(items);

    const uncounted = snapshot.filter((s) => s.actual_qty === null);
    if (items.length === 0 || uncounted.length > 0) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        error: 'Approval blocked: every component must be counted',
        uncounted: uncounted.map((s) => s.component_name),
      });
    }

    const red = snapshot.filter((s) => s.status === 'RED');
    if (red.length > 0) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        error: 'Approval blocked: shortage detected',
        shortages: red.map((s) => ({
          component: s.component_name,
          expected: s.expected_qty,
          actual: s.actual_qty,
        })),
      });
    }

    for (const s of snapshot) {
      await client.query('UPDATE verification_items SET status = $1 WHERE order_id = $2 AND component_id = $3', [
        s.status,
        orderId,
        s.component_id,
      ]);
    }

    const wastage = computeWastage(order);

    await client.query("UPDATE cutting_orders SET status = 'VERIFIED', updated_at = NOW() WHERE id = $1", [orderId]);

    const log = await client.query(
      `INSERT INTO verification_logs (order_id, verifier_id, decision, wastage_pct, variance_snapshot)
       VALUES ($1, $2, 'APPROVED', $3, $4)
       RETURNING id, verifier_id, decision, wastage_pct, timestamp`,
      [orderId, req.user.id, wastage, JSON.stringify(snapshot)]
    );

    await client.query('COMMIT');
    return res.json({ message: 'Batch verified and released to sewing queue', log: log.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Approve error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

router.post('/:id/reject', async (req, res) => {
  const orderId = toInt(req.params.id);
  if (!orderId) return res.status(400).json({ error: 'Invalid order id' });

  const note = req.body && typeof req.body.rejection_note === 'string' ? req.body.rejection_note.trim() : '';
  if (!note) {
    return res.status(400).json({ error: 'A rejection reason is required' });
  }
  if (note.length > 1000) {
    return res.status(400).json({ error: 'Rejection reason is too long (max 1000 characters)' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const order = await lockPendingOrder(client, orderId);
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.status !== 'PENDING_VERIFICATION') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Order is not awaiting verification' });
    }

    const items = await loadItems(client, orderId);
    const snapshot = buildSnapshot(items);

    await client.query("UPDATE cutting_orders SET status = 'REJECTED', updated_at = NOW() WHERE id = $1", [orderId]);

    const log = await client.query(
      `INSERT INTO verification_logs (order_id, verifier_id, decision, rejection_note, wastage_pct, variance_snapshot)
       VALUES ($1, $2, 'REJECTED', $3, $4, $5)
       RETURNING id, verifier_id, decision, rejection_note, timestamp`,
      [orderId, req.user.id, note, computeWastage(order), JSON.stringify(snapshot)]
    );

    await client.query('COMMIT');
    return res.json({ message: 'Batch rejected and returned to supervisor', log: log.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Reject error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

module.exports = router;