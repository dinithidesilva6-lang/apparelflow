const request = require('supertest');
const app = require('../src/app');
const pool = require('../src/db');

jest.setTimeout(60000);

let supToken;
let verToken;
let sewToken;

async function login(email, password) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  return res.body.token;
}

function as(token) {
  return { Authorization: 'Bearer ' + token };
}

async function createOrder(qty = 10) {
  const res = await request(app)
    .post('/api/orders')
    .set(as(supToken))
    .send({
      recipe_id: 1,
      target_qty: qty,
      fabric_roll_id: 'TEST-ROLL-1',
      actual_fabric_yds: qty * 1.8,
    });
  return res.body.order.id;
}

async function countOrder(orderId, shortageIndex) {
  const detail = await request(app).get('/api/orders/' + orderId).set(as(verToken));
  const counts = detail.body.items.map((item, idx) => ({
    component_id: item.component_id,
    actual_qty: idx === shortageIndex ? item.expected_qty - 1 : item.expected_qty,
  }));
  return request(app)
    .post('/api/verification/' + orderId + '/count')
    .set(as(verToken))
    .send({ counts });
}

beforeAll(async () => {
  supToken = await login('supervisor@apparelflow.com', 'Supervisor@123');
  verToken = await login('verifier@apparelflow.com', 'Verifier@123');
  sewToken = await login('sewing@apparelflow.com', 'Sewing@123');
});

afterAll(async () => {
  await pool.end();
});

describe('Gatekeeper verification rules', () => {
  test('Test 1: order with all GREEN components can be approved by a verifier', async () => {
    const id = await createOrder(10);
    const counted = await countOrder(id, -1);
    expect(counted.status).toBe(200);
    expect(counted.body.can_approve).toBe(true);

    const res = await request(app).post('/api/verification/' + id + '/approve').set(as(verToken));
    expect(res.status).toBe(200);
    expect(res.body.log.decision).toBe('APPROVED');
  });

  test('Test 2: order with a RED (shortage) component blocks approval with 422', async () => {
    const id = await createOrder(10);
    const counted = await countOrder(id, 2);
    expect(counted.body.can_approve).toBe(false);

    const res = await request(app).post('/api/verification/' + id + '/approve').set(as(verToken));
    expect(res.status).toBe(422);

    const detail = await request(app).get('/api/orders/' + id).set(as(supToken));
    expect(detail.body.order.status).toBe('PENDING_VERIFICATION');
  });

  test('Test 2b: uncounted components also block approval with 422', async () => {
    const id = await createOrder(10);
    const res = await request(app).post('/api/verification/' + id + '/approve').set(as(verToken));
    expect(res.status).toBe(422);
  });

  test('Test 3: rejecting without a reason note fails backend validation', async () => {
    const id = await createOrder(10);

    const empty = await request(app)
      .post('/api/verification/' + id + '/reject')
      .set(as(verToken))
      .send({ rejection_note: '   ' });
    expect(empty.status).toBe(400);

    const missing = await request(app)
      .post('/api/verification/' + id + '/reject')
      .set(as(verToken))
      .send({});
    expect(missing.status).toBe(400);

    const ok = await request(app)
      .post('/api/verification/' + id + '/reject')
      .set(as(verToken))
      .send({ rejection_note: 'Shortage on sleeves, re-cut required' });
    expect(ok.status).toBe(200);
  });

  test('Test 4: non-verifier roles receive 403 when approving', async () => {
    const id = await createOrder(10);
    await countOrder(id, -1);

    const asSupervisor = await request(app).post('/api/verification/' + id + '/approve').set(as(supToken));
    expect(asSupervisor.status).toBe(403);

    const asSewing = await request(app).post('/api/verification/' + id + '/approve').set(as(sewToken));
    expect(asSewing.status).toBe(403);

    const noToken = await request(app).post('/api/verification/' + id + '/approve');
    expect(noToken.status).toBe(401);
  });

  test('Test 5: unapproved orders never appear in the sewing queue', async () => {
    const pendingId = await createOrder(10);
    const rejectedId = await createOrder(10);
    await request(app)
      .post('/api/verification/' + rejectedId + '/reject')
      .set(as(verToken))
      .send({ rejection_note: 'Defective fabric' });

    const queue = await request(app).get('/api/sewing/queue').set(as(sewToken));
    expect(queue.status).toBe(200);
    const ids = queue.body.orders.map((o) => o.id);
    expect(ids).not.toContain(pendingId);
    expect(ids).not.toContain(rejectedId);

    const tampered = await request(app)
      .get('/api/sewing/queue?status=PENDING_VERIFICATION')
      .set(as(sewToken));
    const tamperedIds = tampered.body.orders.map((o) => o.id);
    expect(tamperedIds).not.toContain(pendingId);

    const db = await pool.query('SELECT id, status FROM cutting_orders WHERE id = ANY($1)', [ids]);
    db.rows.forEach((row) => expect(row.status).toBe('VERIFIED'));
  });

  test('Input guards: negative, decimal and empty values are rejected', async () => {
    const base = { recipe_id: 1, fabric_roll_id: 'X', actual_fabric_yds: 10 };

    const neg = await request(app).post('/api/orders').set(as(supToken)).send({ ...base, target_qty: -5 });
    expect(neg.status).toBe(400);

    const dec = await request(app).post('/api/orders').set(as(supToken)).send({ ...base, target_qty: 2.5 });
    expect(dec.status).toBe(400);

    const text = await request(app).post('/api/orders').set(as(supToken)).send({ ...base, target_qty: 'abc' });
    expect(text.status).toBe(400);

    const empty = await request(app).post('/api/orders').set(as(supToken)).send({});
    expect(empty.status).toBe(400);
  });
});