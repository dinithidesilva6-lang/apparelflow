const express = require('express');
const cors = require('cors');
const { router: authRouter } = require('./auth');
const { ordersRouter, recipesRouter } = require('./orders');
const verificationRouter = require('./verification');
const sewingRouter = require('./sewing');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth', authRouter);
app.use('/api/recipes', recipesRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/verification', verificationRouter);
app.use('/api/sewing', sewingRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

module.exports = app;