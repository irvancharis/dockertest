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
      CREATE TABLE IF NOT EXISTS depos_master (
        depo_id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        token VARCHAR(100) UNIQUE NOT NULL,
        db_user VARCHAR(50),
        db_pass VARCHAR(50),
        admin_user VARCHAR(50),
        admin_pass VARCHAR(50),
        status VARCHAR(20) DEFAULT 'Active',
        last_ip VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

// Middleware to verify Depo Token for security
async function checkDepoToken(req, res, next) {
  const token = req.headers['x-depo-token'];
  if (!token) return res.status(401).json({ error: 'Token diperlukan (X-Depo-Token)' });
  
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  try {
    const [rows] = await pool.query('SELECT * FROM depos_master WHERE token = ? AND status = "Active"', [token]);
    if (rows.length === 0) return res.status(403).json({ error: 'Token tidak valid atau Depo dinonaktifkan' });
    
    // Track last known IP
    await pool.query('UPDATE depos_master SET last_ip = ? WHERE depo_id = ?', [clientIp, rows[0].depo_id]);
    
    req.depo = rows[0]; // Attach depo info to request
    next();
  } catch (err) {
    res.status(500).json({ error: 'Security check failed' });
  }
}

// API to receive sync from Depo
app.post('/api/receive-sync', checkDepoToken, async (req, res) => {
  if (!isDbReady) return res.status(503).json({ error: 'Central DB not ready' });
  
  const { sales } = req.body;
  const depo_id = req.depo.depo_id; // Use ID from validated token
  
  console.log(`Received sync from Depo ${depo_id}. Total records: ${sales.length}`);

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
app.get('/api/products', checkDepoToken, async (req, res) => {
  if (!isDbReady) return res.status(503).json({ error: 'Central DB not ready' });
  const depo_id = req.depo.depo_id; // Derived from verified token
  
  try {
    // Use COALESCE to pick depo-specific price if available
    const query = `
      SELECT p.id, p.name, COALESCE(dp.price, p.price) as price 
      FROM products p 
      LEFT JOIN depo_prices dp ON p.id = dp.product_id AND dp.depo_id = ?
    `;
    
    const [rows] = await pool.query(query, [depo_id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API to check token (used by Depo during first setup or sync)
app.get('/api/check-token', async (req, res) => {
  const { token } = req.query;
  try {
    const [rows] = await pool.query('SELECT * FROM depos_master WHERE token = ? AND status = "Active"', [token]);
    if (rows.length === 0) return res.status(401).json({ error: 'Token tidak valid atau tidak aktif' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API to manage depos from Pusat
app.post('/api/depos', async (req, res) => {
  const { depo_id, name, db_user, db_pass, admin_user, admin_pass, ip_address } = req.body;
  const token = require('crypto').randomBytes(16).toString('hex'); // Generate unique token
  try {
    await pool.query(
      'INSERT INTO depos_master (depo_id, name, token, db_user, db_pass, admin_user, admin_pass, last_ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 
      [depo_id, name, token, db_user, db_pass, admin_user, admin_pass, ip_address]
    );
    res.json({ success: true, token });
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

// Delete Depo
app.delete('/api/depos/:depo_id', async (req, res) => {
  try {
    await pool.query('DELETE FROM depos_master WHERE depo_id = ?', [req.params.depo_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle Depo Status
app.patch('/api/depos/:depo_id/status', async (req, res) => {
  const { status } = req.body;
  try {
    await pool.query('UPDATE depos_master SET status = ? WHERE depo_id = ?', [status, req.params.depo_id]);
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

// Delete Product
app.delete('/api/products/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM products WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Simple dashboard for Pusat
app.get('/', async (req, res) => {
  let sales = [];
  let products = [];
  let depoPrices = [];
  let deposMaster = [];
  
  if (isDbReady) {
    const [sRows] = await pool.query('SELECT * FROM sales_central ORDER BY received_at DESC LIMIT 50');
    const [pRows] = await pool.query('SELECT * FROM products');
    const [dRows] = await pool.query('SELECT dp.*, p.name FROM depo_prices dp JOIN products p ON dp.product_id = p.id');
    const [mRows] = await pool.query('SELECT * FROM depos_master ORDER BY created_at DESC');
    sales = sRows;
    products = pRows;
    depoPrices = dRows;
    deposMaster = mRows;
  }

  res.send(`
    <html>
      <head>
        <title>Central Control Hub</title>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
        <style>
          :root { --primary: #6366f1; --bg: #0f172a; --card: #1e293b; --text: #f8fafc; }
          body { font-family: 'Outfit', sans-serif; background: var(--bg); color: var(--text); padding: 30px; }
          .container { max-width: 1600px; margin: 0 auto; }
          .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 25px; }
          .card { background: var(--card); padding: 20px; border-radius: 16px; border: 1px solid rgba(255,255,255,0.1); }
          h1 { margin-bottom: 25px; background: linear-gradient(to right, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
          table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 0.8rem; }
          th, td { padding: 8px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.05); }
          th { color: #94a3b8; font-weight: 500; }
          .badge { background: rgba(99, 102, 241, 0.2); color: #818cf8; padding: 2px 8px; border-radius: 99px; font-size: 0.65rem; }
          input, select { background: #0f172a; border: 1px solid #334155; color: white; padding: 8px; border-radius: 6px; width: 100%; margin-bottom: 8px; font-size: 0.8rem; }
          button { background: var(--primary); color: white; border: none; padding: 8px 15px; border-radius: 6px; cursor: pointer; width: 100%; font-weight: 600; font-size: 0.8rem; }
          button:hover { opacity: 0.9; }
          h2 { font-size: 1rem; margin-bottom: 12px; display: flex; align-items: center; gap: 10px; }
          .token-text { font-family: monospace; color: #fbbf24; font-size: 0.75rem; background: rgba(251,191,36,0.1); padding: 2px 6px; border-radius: 4px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Central Control Hub</h1>
          
          <div class="grid">
            <!-- 1. Master Data Produk -->
            <div class="card">
              <h2>📦 Katalog Global Produk</h2>
              <div style="display: flex; gap: 10px;">
                <input type="text" id="p-name" placeholder="Nama Produk">
                <input type="number" id="p-price" placeholder="Harga Default">
                <button onclick="addProduct()" style="width: 150px;">Simpan</button>
              </div>
              <table>
                <thead><tr><th>Nama</th><th>Base Price</th><th>Aksi</th></tr></thead>
                <tbody>
                  ${products.map(p => `
                    <tr>
                      <td>${p.name}</td>
                      <td>Rp ${parseFloat(p.price).toLocaleString()}</td>
                      <td><button onclick="deleteProduct(${p.id})" style="padding: 4px; background: #ef4444; width: auto; font-size: 0.6rem;">Hapus</button></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>

            <!-- 2. Manajemen Depo & Token -->
            <div class="card">
              <h2>🔑 Manajemen Depo & Token</h2>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px;">
                <input type="text" id="m-depoid" placeholder="ID Depo (e.g. BALI_01)">
                <input type="text" id="m-name" placeholder="Nama Cabang">
                <input type="text" id="m-dbuser" placeholder="MySQL User">
                <input type="text" id="m-dbpass" placeholder="MySQL Pass">
                <input type="text" id="m-adminuser" placeholder="Admin Login">
                <input type="text" id="m-adminpass" placeholder="Admin Pass">
                <input type="text" id="m-ip" placeholder="IP Server Depo (Optional)">
                <button onclick="registerDepo()" style="grid-column: span 2; background: #ec4899;">Register & Generate Token</button>
              </div>
              <table>
                <thead><tr><th>ID Depo</th><th>Profil & Akses</th><th>Token</th><th>Status</th><th>Aksi</th></tr></thead>
                <tbody>
                  ${deposMaster.map(d => `
                    <tr>
                      <td><span class="badge">${d.depo_id}</span></td>
                      <td>
                        <div style="font-size: 0.75rem; font-weight: 600;">${d.name}</div>
                        <div style="font-size: 0.65rem; color: #94a3b8;">DB: ${d.db_user} | Login: ${d.admin_user}</div>
                        <div style="font-size: 0.65rem; color: #6366f1; font-weight: bold;">IP: ${d.last_ip || 'Never Connected'}</div>
                      </td>
                      <td><span class="token-text">${d.token}</span></td>
                      <td>
                        <span class="badge" style="background: ${d.status === 'Active' ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}; color: ${d.status === 'Active' ? '#4ade80' : '#f87171'};">
                          ${d.status}
                        </span>
                      </td>
                      <td>
                        <div style="display: flex; gap: 5px;">
                          <button onclick="toggleDepo('${d.depo_id}', '${d.status === 'Active' ? 'Inactive' : 'Active'}')" style="padding: 4px; background: #64748b; font-size: 0.6rem;">Toggle</button>
                          <button onclick="deleteDepo('${d.depo_id}')" style="padding: 4px; background: #ef4444; font-size: 0.6rem;">Hapus</button>
                        </div>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>

            <!-- 3. Harga Khusus Depo -->
            <div class="card">
              <h2>💰 Harga Khusus Depo</h2>
              <div style="display: flex; gap: 10px;">
                <select id="dp-product" style="flex: 2;">
                  ${products.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}
                </select>
                <input type="text" id="dp-depo" placeholder="ID Depo" style="flex: 1;">
                <input type="number" id="dp-price" placeholder="Harga" style="flex: 1;">
                <button onclick="setDepoPrice()" style="width: 100px; background: #22c55e;">Set</button>
              </div>
              <table>
                <thead><tr><th>Depo</th><th>Produk</th><th>Harga Khusus</th></tr></thead>
                <tbody>
                  ${depoPrices.map(dp => `<tr><td><span class="badge">${dp.depo_id}</span></td><td>${dp.name}</td><td>Rp ${parseFloat(dp.price).toLocaleString()}</td></tr>`).join('')}
                </tbody>
              </table>
            </div>

            <!-- 4. Monitoring Penjualan -->
            <div class="card">
              <h2>📊 Monitoring Penjualan</h2>
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

          async function registerDepo() {
            const depo_id = document.getElementById('m-depoid').value;
            const name = document.getElementById('m-name').value;
            const db_user = document.getElementById('m-dbuser').value;
            const db_pass = document.getElementById('m-dbpass').value;
            const admin_user = document.getElementById('m-adminuser').value;
            const admin_pass = document.getElementById('m-adminpass').value;
            const ip_address = document.getElementById('m-ip').value;

            if(!depo_id || !name || !db_user || !db_pass) return alert('Lengkapi data Depo & DB');
            
            const res = await fetch('/api/depos', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ depo_id, name, db_user, db_pass, admin_user, admin_pass, ip_address })
            });
            if(res.ok) location.reload();
          }

          async function setDepoPrice() {
            const product_id = document.getElementById('dp-product').value;
            const depo_id = document.getElementById('dp-depo').value;
            const price = document.getElementById('dp-price').value;
            const res = await fetch('/api/depo-prices', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ depo_id, product_id, price })
            });
            if(res.ok) location.reload();
          }

          async function deleteDepo(id) {
            if(!confirm('Hapus Depo ini?')) return;
            const res = await fetch('/api/depos/' + id, { method: 'DELETE' });
            if(res.ok) location.reload();
          }

          async function toggleDepo(id, status) {
            const res = await fetch('/api/depos/' + id + '/status', { 
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status })
            });
            if(res.ok) location.reload();
          }

          async function deleteProduct(id) {
            if(!confirm('Hapus Produk ini?')) return;
            const res = await fetch('/api/products/' + id, { method: 'DELETE' });
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
