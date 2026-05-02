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
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        price DECIMAL(10, 2) NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS depo_prices (
        depo_id VARCHAR(50),
        product_id INT,
        price DECIMAL(10, 2),
        PRIMARY KEY (depo_id, product_id),
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      )
    `);

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

// API to get all products (with Depo-specific price if provided)
app.get('/api/products', async (req, res) => {
  if (!isDbReady) return res.status(503).json({ error: 'Central DB not ready' });
  const { depo_id } = req.query;
  
  try {
    let query = 'SELECT * FROM products';
    let params = [];
    
    if (depo_id) {
      // Use COALESCE to pick depo-specific price if available
      query = `
        SELECT p.id, p.name, COALESCE(dp.price, p.price) as price 
        FROM products p 
        LEFT JOIN depo_prices dp ON p.id = dp.product_id AND dp.depo_id = ?
      `;
      params = [depo_id];
    }
    
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API to set price for specific Depo
app.post('/api/depo-prices', async (req, res) => {
  const { depo_id, product_id, price } = req.body;
  try {
    await pool.query(
      'INSERT INTO depo_prices (depo_id, product_id, price) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE price = VALUES(price)',
      [depo_id, product_id, price]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API to add product in Pusat
app.post('/api/products', async (req, res) => {
  const { name, price } = req.body;
  try {
    await pool.query('INSERT INTO products (name, price) VALUES (?, ?)', [name, price]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Simple dashboard for Pusat
app.get('/', async (req, res) => {
  let sales = [];
  let products = [];
  if (isDbReady) {
    const [sRows] = await pool.query('SELECT * FROM sales_central ORDER BY received_at DESC');
    const [pRows] = await pool.query('SELECT * FROM products');
    const [dRows] = await pool.query('SELECT dp.*, p.name FROM depo_prices dp JOIN products p ON dp.product_id = p.id');
    sales = sRows;
    products = pRows;
    depoPrices = dRows;
  }

  res.send(`
    <html>
      <head>
        <title>Central Data Center</title>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
        <style>
          :root { --primary: #6366f1; --bg: #0f172a; --card: #1e293b; --text: #f8fafc; }
          body { font-family: 'Outfit', sans-serif; background: var(--bg); color: var(--text); padding: 40px; }
          .container { max-width: 1400px; margin: 0 auto; }
          .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 25px; }
          .card { background: var(--card); padding: 25px; border-radius: 16px; border: 1px solid rgba(255,255,255,0.1); }
          h1 { margin-bottom: 30px; background: linear-gradient(to right, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
          table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 0.85rem; }
          th, td { padding: 10px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.05); }
          th { color: #94a3b8; font-weight: 500; }
          .badge { background: rgba(99, 102, 241, 0.2); color: #818cf8; padding: 4px 10px; border-radius: 99px; font-size: 0.7rem; }
          input, select { background: #0f172a; border: 1px solid #334155; color: white; padding: 10px; border-radius: 8px; width: 100%; margin-bottom: 10px; }
          button { background: var(--primary); color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; width: 100%; font-weight: 600; }
          button:hover { opacity: 0.9; }
          h2 { font-size: 1.1rem; margin-bottom: 15px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Central Data Center</h1>
          
          <div class="grid">
            <!-- 1. Master Data Produk -->
            <div class="card">
              <h2>1. Katalog Global</h2>
              <div style="margin-bottom: 25px;">
                <input type="text" id="p-name" placeholder="Nama Produk">
                <input type="number" id="p-price" placeholder="Harga Default">
                <button onclick="addProduct()">Simpan ke Katalog</button>
              </div>
              <table>
                <thead><tr><th>Nama</th><th>Base Price</th></tr></thead>
                <tbody>
                  ${products.map(p => `<tr><td>${p.name}</td><td>Rp ${parseFloat(p.price).toLocaleString()}</td></tr>`).join('')}
                </tbody>
              </table>
            </div>

            <!-- 2. Depo Pricing Overrides -->
            <div class="card">
              <h2>2. Harga Khusus Depo</h2>
              <div style="margin-bottom: 25px;">
                <select id="dp-product">
                  ${products.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}
                </select>
                <input type="text" id="dp-depo" placeholder="ID Depo (contoh: DEPO_BALI_01)">
                <input type="number" id="dp-price" placeholder="Harga Khusus">
                <button onclick="setDepoPrice()" style="background: #22c55e;">Update Harga Depo</button>
              </div>
              <table>
                <thead><tr><th>Depo</th><th>Produk</th><th>Harga Khusus</th></tr></thead>
                <tbody>
                  ${depoPrices.map(dp => `<tr><td><span class="badge">${dp.depo_id}</span></td><td>${dp.name}</td><td>Rp ${parseFloat(dp.price).toLocaleString()}</td></tr>`).join('')}
                </tbody>
              </table>
            </div>

            <!-- 3. Monitoring Penjualan -->
            <div class="card">
              <h2>3. Monitoring Penjualan</h2>
              <table>
                <thead><tr><th>Depo</th><th>Total</th><th>Tanggal</th></tr></thead>
                <tbody>
                  ${sales.map(s => `
                    <tr>
                      <td><span class="badge">${s.depo_id}</span></td>
                      <td>Rp ${parseFloat(s.total_amount).toLocaleString()}</td>
                      <td>${new Date(s.sale_date).toLocaleDateString()}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <script>
          async function addProduct() {
            const name = document.getElementById('p-name').value;
            const price = document.getElementById('p-price').value;
            const res = await fetch('/api/products', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name, price })
            });
            if(res.ok) location.reload();
          }

          async function setDepoPrice() {
            const product_id = document.getElementById('dp-product').value;
            const depo_id = document.getElementById('dp-depo').value;
            const price = document.getElementById('dp-price').value;
            if(!depo_id || !price) return alert('Lengkapi data');

            const res = await fetch('/api/depo-prices', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ depo_id, product_id, price })
            });
            if(res.ok) location.reload();
          }
        </script>
      </body>
    </html>
  `);
});

app.listen(port, () => {
  console.log(`Central Server running on port ${port}`);
});
