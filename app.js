const express = require('express');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const app = express();
const port = 4000;

app.use(express.json());

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || 'rootpassword',
  database: process.env.DB_NAME || 'central_db',
};

let pool;
let isDbReady = false;

async function initDb() {
  try {
    const tempConn = await mysql.createConnection({
      host: dbConfig.host,
      user: dbConfig.user,
      password: dbConfig.password,
    });
    await tempConn.query(`CREATE DATABASE IF NOT EXISTS ${dbConfig.database}`);
    await tempConn.end();

    pool = mysql.createPool(dbConfig);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        price DECIMAL(10, 2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
        last_ip VARCHAR(50),
        status ENUM('Active', 'Inactive') DEFAULT 'Active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS depo_prices (
        depo_id VARCHAR(50),
        product_id INT,
        price DECIMAL(10, 2) NOT NULL,
        PRIMARY KEY (depo_id, product_id),
        FOREIGN KEY (depo_id) REFERENCES depos_master(depo_id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sales_central (
        id VARCHAR(100) PRIMARY KEY,
        depo_id VARCHAR(50),
        total_amount DECIMAL(10, 2) NOT NULL,
        sale_date TIMESTAMP,
        received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (depo_id) REFERENCES depos_master(depo_id) ON DELETE CASCADE
      )
    `);

    // NEW: Employee table in Central
    await pool.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id INT AUTO_INCREMENT PRIMARY KEY,
        depo_id VARCHAR(50),
        name VARCHAR(100) NOT NULL,
        username VARCHAR(50),
        password VARCHAR(255),
        position VARCHAR(50),
        phone VARCHAR(20),
        synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (depo_id) REFERENCES depos_master(depo_id) ON DELETE CASCADE
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS product_assignments (
        depo_id VARCHAR(50),
        product_id INT,
        PRIMARY KEY (depo_id, product_id),
        FOREIGN KEY (depo_id) REFERENCES depos_master(depo_id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      )
    `);

    isDbReady = true;
    console.log('Central Database ready');
  } catch (err) {
    console.error('Database init failed:', err.message);
  }
}

initDb();

// Middleware to check Depo Token
async function checkDepoToken(req, res, next) {
  const token = req.headers['x-depo-token'];
  if (!token) return res.status(401).json({ error: 'Token diperlukan (X-Depo-Token)' });
  
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  try {
    const [rows] = await pool.query('SELECT * FROM depos_master WHERE token = ? AND status = "Active"', [token]);
    if (rows.length === 0) return res.status(403).json({ error: 'Token tidak valid' });
    
    await pool.query('UPDATE depos_master SET last_ip = ? WHERE depo_id = ?', [clientIp, rows[0].depo_id]);
    req.depo = rows[0];
    next();
  } catch (err) {
    res.status(500).json({ error: 'Security check failed' });
  }
}

// API Routes
app.get('/api/products', checkDepoToken, async (req, res) => {
  if (!isDbReady) return res.status(503).json({ error: 'DB not ready' });
  try {
    // ONLY return products assigned to this depo
    const [rows] = await pool.query(`
      SELECT p.id, p.name, COALESCE(dp.price, p.price) as price 
      FROM products p 
      JOIN product_assignments pa ON p.id = pa.product_id
      LEFT JOIN depo_prices dp ON p.id = dp.product_id AND dp.depo_id = ?
      WHERE pa.depo_id = ?
    `, [req.depo.depo_id, req.depo.depo_id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// NEW: API to get and set assignments
app.get('/api/assignments/:depo_id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT product_id FROM product_assignments WHERE depo_id = ?', [req.params.depo_id]);
    res.json(rows.map(r => r.product_id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/assignments', async (req, res) => {
  const { depo_id, product_ids } = req.body;
  try {
    await pool.query('DELETE FROM product_assignments WHERE depo_id = ?', [depo_id]);
    if (product_ids.length > 0) {
      const values = product_ids.map(pid => [depo_id, pid]);
      await pool.query('INSERT INTO product_assignments (depo_id, product_id) VALUES ?', [values]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/products', async (req, res) => {
  const { name, price } = req.body;
  try {
    await pool.query('INSERT INTO products (name, price) VALUES (?, ?)', [name, price]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/products/:id', async (req, res) => {
  const { name, price } = req.body;
  try {
    await pool.query('UPDATE products SET name = ?, price = ? WHERE id = ?', [name, price, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM products WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/receive-sync', checkDepoToken, async (req, res) => {
  const { sales } = req.body;
  const depo_id = req.depo.depo_id;
  try {
    for (const s of sales) {
      await pool.query(
        'INSERT INTO sales_central (id, depo_id, total_amount, sale_date) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE total_amount = VALUES(total_amount)',
        [s.id, depo_id, s.total_amount, s.sale_date]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// NEW: API for Employee Sync from Depo
app.post('/api/employees-sync', checkDepoToken, async (req, res) => {
  const { employees } = req.body;
  const depo_id = req.depo.depo_id;
  try {
    // Delete old employee records for this depo before sync (Full sync)
    await pool.query('DELETE FROM employees WHERE depo_id = ?', [depo_id]);
    for (const e of employees) {
      await pool.query(
        'INSERT INTO employees (depo_id, name, username, password, position, phone) VALUES (?, ?, ?, ?, ?, ?)',
        [depo_id, e.name, e.username, e.password, e.position, e.phone]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/depos', async (req, res) => {
  const { depo_id, name, db_user, db_pass, admin_user, admin_pass, ip_address } = req.body;
  const token = crypto.randomBytes(16).toString('hex');
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

app.delete('/api/depos/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM depos_master WHERE depo_id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/check-token', async (req, res) => {
  const { token } = req.query;
  try {
    const [rows] = await pool.query('SELECT * FROM depos_master WHERE token = ? AND status = "Active"', [token]);
    if (rows.length === 0) return res.status(401).json({ error: 'Token Invalid' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UI Route (Admin Panel)
app.get('/', async (req, res) => {
  if (!isDbReady) return res.send('Database connecting...');
  
  const [products] = await pool.query('SELECT * FROM products');
  const [deposMaster] = await pool.query('SELECT * FROM depos_master');
  const [depoPrices] = await pool.query(`
    SELECT dp.*, p.name FROM depo_prices dp 
    JOIN products p ON dp.product_id = p.id
  `);
  const [sales] = await pool.query('SELECT * FROM sales_central ORDER BY sale_date DESC LIMIT 50');
  const [employees] = await pool.query('SELECT * FROM employees');

  res.send(`
    <!DOCTYPE html>
    <html lang="id">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Pusat Komando | Hub-and-Spoke MDM</title>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
        <script src="https://cdn.jsdelivr.net/npm/lucide-static@0.321.0/lib/index.min.js"></script>
        <style>
          :root { --primary: #6366f1; --secondary: #ec4899; --bg: #0f172a; --card-bg: rgba(30, 41, 59, 0.7); --text: #f8fafc; --text-muted: #94a3b8; --glass-border: rgba(255, 255, 255, 0.1); }
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: 'Outfit', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; }
          
          /* Sidebar */
          .sidebar { width: 260px; background: rgba(15, 23, 42, 0.95); border-right: 1px solid var(--glass-border); display: flex; flex-direction: column; padding: 2rem 1.5rem; position: fixed; height: 100vh; }
          .logo { font-size: 1.5rem; font-weight: 700; margin-bottom: 3rem; display: flex; align-items: center; gap: 12px; background: linear-gradient(to right, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
          .nav-item { padding: 12px 16px; border-radius: 12px; color: var(--text-muted); text-decoration: none; margin-bottom: 8px; display: flex; align-items: center; gap: 12px; transition: all 0.3s; cursor: pointer; }
          .nav-item:hover, .nav-item.active { background: rgba(99, 102, 241, 0.1); color: var(--text); }
          
          /* Main Content */
          .main { flex: 1; margin-left: 260px; padding: 2.5rem; max-width: 1400px; width: calc(100% - 260px); }
          header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 3rem; }
          .glass-panel { background: var(--card-bg); backdrop-filter: blur(12px); border: 1px solid var(--glass-border); border-radius: 24px; padding: 2rem; margin-bottom: 2rem; }
          
          .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1.5rem; margin-bottom: 3rem; }
          .stat-card { background: var(--card-bg); border: 1px solid var(--glass-border); padding: 1.5rem; border-radius: 20px; }
          .stat-label { color: var(--text-muted); font-size: 0.875rem; margin-bottom: 0.5rem; }
          .stat-value { font-size: 1.75rem; font-weight: 700; }

          .btn { background: var(--primary); color: white; border: none; padding: 10px 20px; border-radius: 10px; font-weight: 600; cursor: pointer; transition: 0.3s; display: inline-flex; align-items: center; gap: 8px; font-size: 0.85rem; }
          .btn:hover { transform: translateY(-2px); opacity: 0.9; }
          .btn-danger { background: #ef4444; }
          .btn-success { background: #22c55e; }

          input, select { background: rgba(15, 23, 42, 0.5); border: 1px solid var(--glass-border); padding: 10px; border-radius: 8px; color: white; width: 100%; margin-bottom: 0.5rem; font-size: 0.9rem; }
          table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
          th { text-align: left; padding: 12px; color: var(--text-muted); border-bottom: 1px solid var(--glass-border); font-size: 0.85rem; }
          td { padding: 16px 12px; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 0.9rem; }
          .badge { padding: 4px 10px; border-radius: 99px; font-size: 0.7rem; font-weight: 600; background: rgba(99,102,241,0.1); color: var(--primary); }
          
          #modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.8); backdrop-filter: blur(5px); z-index: 10000; display: none; align-items: center; justify-content: center; }
          .modal { background: var(--bg); border: 1px solid var(--glass-border); border-radius: 24px; padding: 2rem; width: 400px; }
        </style>
    </head>
    <body>
        <nav class="sidebar">
            <div class="logo"><i data-lucide="shield-check"></i> PUSAT</div>
            <div class="nav-item active" onclick="showSection('dashboard')"><i data-lucide="layout-dashboard"></i> Dashboard</div>
            <div class="nav-item" onclick="showSection('depos')"><i data-lucide="network"></i> Manajemen Depo</div>
            <div class="nav-item" onclick="showSection('products')"><i data-lucide="package"></i> Master Produk</div>
            <div class="nav-item" onclick="showSection('employees')"><i data-lucide="users"></i> Karyawan</div>
            <div class="nav-item" onclick="showSection('sales')"><i data-lucide="bar-chart-3"></i> Penjualan</div>
        </nav>

        <div class="main">
            <header>
                <div>
                    <h1 id="page-title">Dashboard</h1>
                    <p style="color: var(--text-muted);">Selamat datang di Pusat Kendali Hub-and-Spoke.</p>
                </div>
                <div class="btn" onclick="location.reload()"><i data-lucide="refresh-cw"></i> Refresh Data</div>
            </header>

            <!-- Dashboard Overview -->
            <div id="section-dashboard">
                <div class="stats-grid">
                    <div class="stat-card"><div class="stat-label">Total Cabang</div><div class="stat-value">${deposMaster.length}</div></div>
                    <div class="stat-card"><div class="stat-label">Total Produk</div><div class="stat-value">${products.length}</div></div>
                    <div class="stat-card"><div class="stat-label">Total Karyawan</div><div class="stat-value">${employees.length}</div></div>
                    <div class="stat-card"><div class="stat-label">Total Omzet</div><div class="stat-value">Rp ${sales.reduce((a,b)=>a+parseFloat(b.total_amount), 0).toLocaleString()}</div></div>
                </div>
                <div class="glass-panel">
                    <h2>Koneksi Depo Terakhir</h2>
                    <table>
                        <thead><tr><th>Depo</th><th>IP Terakhir</th><th>Status</th></tr></thead>
                        <tbody>
                            ${deposMaster.map(d => `
                                <tr>
                                    <td><strong>${d.name}</strong><br><small style="color:var(--text-muted)">${d.depo_id}</small></td>
                                    <td>${d.last_ip || '---'}</td>
                                    <td><span class="badge" style="${d.status === 'Active' ? 'background:rgba(34,197,94,0.1);color:#22c55e' : 'background:rgba(239,68,68,0.1);color:#ef4444'}">${d.status}</span></td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- Management Sections -->
            <div id="section-depos" style="display:none">
                <div class="glass-panel">
                    <h2>Registrasi Depo Baru</h2>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:1rem;">
                        <input id="m-depoid" placeholder="ID Depo (BALI_01)">
                        <input id="m-name" placeholder="Nama Cabang">
                        <input id="m-dbuser" placeholder="DB User">
                        <input id="m-dbpass" placeholder="DB Pass">
                        <input id="m-adminuser" placeholder="Admin Login">
                        <input id="m-adminpass" placeholder="Admin Pass">
                        <button class="btn btn-success" onclick="registerDepo()" style="grid-column: span 2">Daftarkan Depo</button>
                    </div>
                </div>
                <div class="glass-panel">
                    <h2>Daftar Cabang Aktif</h2>
                    <table>
                        <thead><tr><th>ID</th><th>Nama</th><th>Token Aktivasi</th><th>Aksi</th></tr></thead>
                        <tbody>
                            ${deposMaster.map(d => `
                                <tr>
                                    <td>${d.depo_id}</td>
                                    <td>${d.name}</td>
                                    <td><code style="background:#1e293b;padding:4px;border-radius:4px">${d.token}</code></td>
                                    <td>
                                        <button class="btn btn-success" onclick="openAssignProducts('${d.depo_id}')">Atur Produk</button>
                                        <button class="btn btn-danger" onclick="deleteDepo('${d.depo_id}')">Hapus</button>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>

            <div id="section-products" style="display:none">
                <div class="glass-panel">
                    <h2>Tambah Produk Baru</h2>
                    <div style="display:flex; gap:10px; margin-top:1rem;">
                        <input id="p-name" placeholder="Nama Produk">
                        <input id="p-price" type="number" placeholder="Harga Base">
                        <button class="btn" onclick="addProduct()">Tambah</button>
                    </div>
                </div>
                <div class="glass-panel">
                    <h2>Daftar Produk & Harga Khusus</h2>
                    <table>
                        <thead><tr><th>ID</th><th>Nama</th><th>Harga Base</th><th>Aksi</th></tr></thead>
                        <tbody>
                            ${products.map(p => `
                                <tr>
                                    <td>${p.id}</td>
                                    <td>${p.name}</td>
                                    <td>Rp ${parseFloat(p.price).toLocaleString()}</td>
                                    <td>
                                        <button class="btn" onclick="openEditProduct(${p.id}, '${p.name}', ${p.price})">Edit</button>
                                        <button class="btn btn-danger" onclick="deleteProduct(${p.id})">Hapus</button>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>

            <div id="section-employees" style="display:none">
                <div class="glass-panel">
                    <h2>Monitoring Karyawan (Synced from Spoke)</h2>
                    <table>
                        <thead><tr><th>Cabang</th><th>Nama</th><th>Username</th><th>Posisi</th><th>Telepon</th></tr></thead>
                        <tbody>
                            ${employees.map(e => `
                                <tr>
                                    <td><span class="badge">${e.depo_id}</span></td>
                                    <td>${e.name}</td>
                                    <td>${e.username || '-'}</td>
                                    <td>${e.position}</td>
                                    <td>${e.phone}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>

            <div id="section-sales" style="display:none">
                <div class="glass-panel">
                    <h2>Log Penjualan Terkonsolidasi</h2>
                    <table>
                        <thead><tr><th>Depo</th><th>ID Transaksi</th><th>Total</th><th>Tanggal</th></tr></thead>
                        <tbody>
                            ${sales.map(s => `
                                <tr>
                                    <td><span class="badge">${s.depo_id}</span></td>
                                    <td>${s.id.slice(0,8)}...</td>
                                    <td>Rp ${parseFloat(s.total_amount).toLocaleString()}</td>
                                    <td>${new Date(s.sale_date).toLocaleString()}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>

        <!-- Modals -->
        <div id="modal-overlay">
            <div class="modal">
                <h3 id="modal-title">Edit Data</h3><br>
                <div id="modal-body">
                    <input id="edit-id" type="hidden">
                    <input id="edit-field1">
                    <input id="edit-field2">
                </div>
                <div id="assign-body" style="display:none; max-height: 300px; overflow-y: auto; margin-bottom: 1rem;">
                    ${products.map(p => `
                        <div style="display:flex; align-items:center; gap:10px; padding:8px; border-bottom:1px solid var(--glass-border)">
                            <input type="checkbox" class="prod-check" value="${p.id}" style="width:20px; margin:0">
                            <span>${p.name}</span>
                        </div>
                    `).join('')}
                </div>
                <div style="display:flex; gap:10px; margin-top:1rem;">
                    <button class="btn btn-success" style="flex:1" id="btn-save" onclick="saveEdit()">Simpan</button>
                    <button class="btn btn-danger" style="flex:1" onclick="closeModal()">Batal</button>
                </div>
            </div>
        </div>

        <script>
            function showSection(name) {
                ['dashboard', 'depos', 'products', 'employees', 'sales'].forEach(s => {
                    document.getElementById('section-' + s).style.display = s === name ? 'block' : 'none';
                });
                document.querySelectorAll('.nav-item').forEach(i => {
                    i.classList.toggle('active', i.innerText.toLowerCase().includes(name));
                });
                document.getElementById('page-title').innerText = name.charAt(0).toUpperCase() + name.slice(1);
            }

            async function addProduct() {
                const name = document.getElementById('p-name').value;
                const price = document.getElementById('p-price').value;
                const res = await fetch('/api/products', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, price }) });
                if(res.ok) location.reload();
            }

            async function registerDepo() {
                const d = {
                    depo_id: document.getElementById('m-depoid').value,
                    name: document.getElementById('m-name').value,
                    db_user: document.getElementById('m-dbuser').value,
                    db_pass: document.getElementById('m-dbpass').value,
                    admin_user: document.getElementById('m-adminuser').value,
                    admin_pass: document.getElementById('m-adminpass').value
                };
                const res = await fetch('/api/depos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
                if(res.ok) location.reload();
            }

            async function deleteProduct(id) {
                if(!confirm('Hapus produk ini?')) return;
                await fetch('/api/products/' + id, { method: 'DELETE' });
                location.reload();
            }

            async function deleteDepo(id) {
                if(!confirm('Hapus depo ini?')) return;
                await fetch('/api/depos/' + id, { method: 'DELETE' });
                location.reload();
            }

            function openEditProduct(id, name, price) {
                document.getElementById('modal-title').innerText = 'Edit Produk';
                document.getElementById('modal-body').style.display = 'block';
                document.getElementById('assign-body').style.display = 'none';
                document.getElementById('btn-save').onclick = saveEdit;
                document.getElementById('edit-id').value = id;
                document.getElementById('edit-field1').value = name;
                document.getElementById('edit-field2').value = price;
                document.getElementById('modal-overlay').style.display = 'flex';
            }

            async function openAssignProducts(depoId) {
                document.getElementById('modal-title').innerText = 'Pilih Produk untuk ' + depoId;
                document.getElementById('modal-body').style.display = 'none';
                document.getElementById('assign-body').style.display = 'block';
                document.getElementById('edit-id').value = depoId;
                document.getElementById('btn-save').onclick = saveAssignments;
                
                // Load current assignments
                const res = await fetch('/api/assignments/' + depoId);
                const assigned = await res.json();
                document.querySelectorAll('.prod-check').forEach(cb => {
                    cb.checked = assigned.includes(parseInt(cb.value));
                });

                document.getElementById('modal-overlay').style.display = 'flex';
            }

            async function saveAssignments() {
                const depo_id = document.getElementById('edit-id').value;
                const product_ids = Array.from(document.querySelectorAll('.prod-check:checked')).map(cb => cb.value);
                const res = await fetch('/api/assignments', { 
                    method: 'POST', 
                    headers: { 'Content-Type': 'application/json' }, 
                    body: JSON.stringify({ depo_id, product_ids }) 
                });
                if(res.ok) location.reload();
            }

            async function saveEdit() {
                const id = document.getElementById('edit-id').value;
                const name = document.getElementById('edit-field1').value;
                const price = document.getElementById('edit-field2').value;
                const res = await fetch('/api/products/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, price }) });
                if(res.ok) location.reload();
            }

            function closeModal() { document.getElementById('modal-overlay').style.display = 'none'; }

            lucide.createIcons();
        </script>
    </body>
    </html>
  `);
});

app.listen(port, () => {
  console.log(`Central Server running on port ${port}`);
});
