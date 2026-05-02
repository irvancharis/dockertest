const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(bodyParser.json());

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || 'rootpassword',
  database: process.env.DB_NAME || 'pusat_db',
};

let pool;
let isDbReady = false;

async function initDb() {
  try {
    const connection = await mysql.createConnection({
      host: dbConfig.host,
      user: dbConfig.user,
      password: dbConfig.password,
    });
    await connection.query(`CREATE DATABASE IF NOT EXISTS ${dbConfig.database}`);
    await connection.end();

    pool = mysql.createPool(dbConfig);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sales_central (
        id VARCHAR(36) PRIMARY KEY,
        total_amount DECIMAL(10, 2),
        sale_date DATETIME,
        depo_id VARCHAR(50),
        received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    isDbReady = true;
    console.log('Central Database ready');
  } catch (err) {
    console.error('Central DB Init Error:', err.message);
    setTimeout(initDb, 5000);
  }
}

initDb();

// API to receive sync from Depo
app.post('/api/receive-sync', async (req, res) => {
  if (!isDbReady) return res.status(503).json({ error: 'Central DB not ready' });
  
  const { sales } = req.body;
  console.log(`Received sync from Depo. Total records: ${sales.length}`);

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    for (const sale of sales) {
      const formattedDate = new Date(sale.sale_date).toISOString().slice(0, 19).replace('T', ' ');
      await connection.query(
        'INSERT INTO sales_central (id, total_amount, sale_date, depo_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE total_amount = VALUES(total_amount), sale_date = VALUES(sale_date)',
        [sale.id, sale.total_amount, formattedDate, sale.depo_id]
      );
    }

    await connection.commit();
    res.json({ message: 'Sync successful', count: sales.length });
  } catch (err) {
    await connection.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    connection.release();
  }
});

// Simple dashboard for Pusat
app.get('/', async (req, res) => {
  let sales = [];
  if (isDbReady) {
    const [rows] = await pool.query('SELECT * FROM sales_central ORDER BY received_at DESC');
    sales = rows;
  }

  res.send(`
    <html>
      <head>
        <title>Central Dashboard</title>
        <style>
          body { font-family: sans-serif; background: #0f172a; color: white; padding: 50px; }
          table { width: 100%; border-collapse: collapse; margin-top: 20px; }
          th, td { border: 1px solid #334155; padding: 12px; text-align: left; }
          th { background: #1e293b; }
          .badge { background: #6366f1; padding: 4px 8px; border-radius: 4px; font-size: 0.8rem; }
        </style>
      </head>
      <body>
        <h1>Pusat Control Panel</h1>
        <p>Monitoring data dari semua Depo</p>
        <table>
          <thead>
            <tr>
              <th>ID Sale</th>
              <th>Depo</th>
              <th>Total</th>
              <th>Tanggal Transaksi</th>
              <th>Diterima di Pusat</th>
            </tr>
          </thead>
          <tbody>
            ${sales.map(s => `
              <tr>
                <td>${s.id}</td>
                <td><span class="badge">${s.depo_id}</span></td>
                <td>Rp ${parseFloat(s.total_amount).toLocaleString()}</td>
                <td>${new Date(s.sale_date).toLocaleString()}</td>
                <td>${new Date(s.received_at).toLocaleString()}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </body>
    </html>
  `);
});

app.listen(port, () => {
  console.log(`Central Server running on port ${port}`);
});
