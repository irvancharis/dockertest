const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(cookieParser('secret-key'));
app.use(express.static('public'));

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || 'rootpassword',
  database: process.env.DB_NAME || 'depo_db',
};

let pool;
let isDbReady = false;

async function initDb() {
  try {
    // 1. Initial connection as root to load specialized settings
    const tempConn = await mysql.createConnection({
      host: dbConfig.host,
      user: dbConfig.user,
      password: dbConfig.password,
    });
    await tempConn.query(`CREATE DATABASE IF NOT EXISTS ${dbConfig.database}`);
    await tempConn.query(`USE ${dbConfig.database}`);
    await tempConn.query(`
      CREATE TABLE IF NOT EXISTS settings (
        setting_key VARCHAR(50) PRIMARY KEY,
        setting_value TEXT
      )
    `);

    // Check for specialized credentials
    const [rows] = await tempConn.query('SELECT setting_key, setting_value FROM settings WHERE setting_key IN ("db_user", "db_pass")');
    const settings = {};
    rows.forEach(r => settings[r.setting_key] = r.setting_value);
    await tempConn.end();

    // 2. Create the ACTUAL pool using specialized credentials if available
    const finalUser = settings.db_user || dbConfig.user;
    const finalPass = settings.db_pass || dbConfig.password;

    console.log(`Initializing Pool as: ${finalUser}`);
    pool = mysql.createPool({
      ...dbConfig,
      user: finalUser,
      password: finalPass,
      waitForConnections: true,
      connectionLimit: 10
    });

    // 3. Initialize other tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        price DECIMAL(10, 2) NOT NULL,
        stock INT DEFAULT 0
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sales (
        id VARCHAR(36) PRIMARY KEY,
        total_amount DECIMAL(10, 2) NOT NULL,
        sale_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        depo_id VARCHAR(50) NOT NULL,
        synced BOOLEAN DEFAULT FALSE
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        position VARCHAR(50),
        phone VARCHAR(20),
        synced BOOLEAN DEFAULT FALSE
      )
    `);

    isDbReady = true;
    console.log('Depo Database ready with specialized credentials');
  } catch (err) {
    console.error('DB Init Error:', err.message);
    setTimeout(initDb, 5000);
  }
}

initDb();

async function getLocalSetting(key) {
  try {
    const [rows] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = ?', [key]);
    return rows.length > 0 ? rows[0].setting_value : process.env[key.toUpperCase()];
  } catch (e) { return process.env[key.toUpperCase()]; }
}

async function checkAuth(req, res, next) {
  const depo_id = await getLocalSetting('depo_id');
  if (!depo_id) return next();
  if (req.signedCookies.auth === 'true') next();
  else res.status(401).json({ error: 'Unauthorized' });
}

// API Routes
app.get('/api/config', async (req, res) => {
  const depo_id = await getLocalSetting('depo_id');
  const depo_name = await getLocalSetting('depo_name');
  const authenticated = req.signedCookies.auth === 'true';
  res.json({ activated: !!depo_id, depo_id, depo_name, authenticated });
});

app.post('/api/activate', async (req, res) => {
  const { token } = req.body;
  const centralBaseUrl = (process.env.CENTRAL_URL || 'http://web-pusat:4000/api/receive-sync').replace('/api/receive-sync', '');
  try {
    const response = await fetch(`${centralBaseUrl}/api/check-token?token=${token}`);
    if (!response.ok) throw new Error('Token Invalid');
    const data = await response.json();

    // 1. Setup specialized MySQL user locally
    if (data.db_user && data.db_pass) {
      const conn = await mysql.createConnection({ host: dbConfig.host, user: dbConfig.user, password: dbConfig.password });
      await conn.query(`CREATE USER IF NOT EXISTS '${data.db_user}'@'%' IDENTIFIED BY '${data.db_pass}'`);
      await conn.query(`GRANT ALL PRIVILEGES ON ${dbConfig.database}.* TO '${data.db_user}'@'%'`);
      await conn.query('FLUSH PRIVILEGES');
      await conn.end();
    }

    // 2. Save settings
    await pool.query('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', ['depo_id', data.depo_id]);
    await pool.query('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', ['depo_name', data.name]);
    await pool.query('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', ['depo_token', token]);
    await pool.query('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', ['db_user', data.db_user]);
    await pool.query('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', ['db_pass', data.db_pass]);
    await pool.query('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', ['admin_user', data.admin_user]);
    await pool.query('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', ['admin_pass', data.admin_pass]);
    
    // Reboot server to apply new credentials
    res.json({ success: true, message: 'Activated. System will reboot to apply credentials.' });
    setTimeout(() => process.exit(0), 1000); 
  } catch (err) { res.status(401).json({ error: err.message }); }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const u = await getLocalSetting('admin_user');
  const p = await getLocalSetting('admin_pass');
  if (username === u && password === p) {
    res.cookie('auth', 'true', { signed: true, maxAge: 86400000 });
    res.json({ success: true });
  } else res.status(401).json({ error: 'Wrong credentials' });
});

app.post('/api/logout', (req, res) => { res.clearCookie('auth'); res.json({ success: true }); });

// Inventory & Sales APIs
app.get('/api/products', checkAuth, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM products');
  res.json(rows);
});

app.post('/api/sales', checkAuth, async (req, res) => {
  const { items, total_amount } = req.body;
  const saleId = crypto.randomUUID();
  const depoId = await getLocalSetting('depo_id');
  await pool.query('INSERT INTO sales (id, total_amount, depo_id) VALUES (?, ?, ?)', [saleId, total_amount, depoId]);
  res.json({ success: true });
});

app.get('/api/sales', checkAuth, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM sales ORDER BY sale_date DESC');
  res.json(rows);
});

// NEW: Employee APIs
app.get('/api/employees', checkAuth, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM employees');
  res.json(rows);
});

app.post('/api/employees', checkAuth, async (req, res) => {
  const { name, position, phone } = req.body;
  await pool.query('INSERT INTO employees (name, position, phone) VALUES (?, ?, ?)', [name, position, phone]);
  res.json({ success: true });
});

app.delete('/api/employees/:id', checkAuth, async (req, res) => {
  await pool.query('DELETE FROM employees WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

app.get('/api/sync-status', checkAuth, async (req, res) => {
  const [s] = await pool.query('SELECT COUNT(*) as count FROM sales WHERE synced = 0');
  const [e] = await pool.query('SELECT COUNT(*) as count FROM employees WHERE synced = 0');
  res.json({ unsynced_sales: s[0].count, unsynced_employees: e[0].count });
});

app.post('/api/sync-to-central', checkAuth, async (req, res) => {
  try {
    const depo_token = await getLocalSetting('depo_token');
    const centralUrl = (process.env.CENTRAL_URL || 'http://web-pusat:4000/api/receive-sync');
    const [sales] = await pool.query('SELECT * FROM sales WHERE synced = 0');
    if (sales.length > 0) {
      await fetch(centralUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Depo-Token': depo_token },
        body: JSON.stringify({ sales })
      });
      await pool.query('UPDATE sales SET synced = 1 WHERE id IN (?)', [sales.map(s => s.id)]);
    }
    const [employees] = await pool.query('SELECT * FROM employees');
    const empUrl = centralUrl.replace('/receive-sync', '/employees-sync');
    await fetch(empUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Depo-Token': depo_token },
      body: JSON.stringify({ employees })
    });
    await pool.query('UPDATE employees SET synced = 1');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/sync-products-from-central', checkAuth, async (req, res) => {
  const depo_token = await getLocalSetting('depo_token');
  const centralUrl = (process.env.CENTRAL_URL || 'http://web-pusat:4000/api/receive-sync').replace('/receive-sync', '/products');
  const r = await fetch(centralUrl, { headers: { 'X-Depo-Token': depo_token } });
  const products = await r.json();
  for (const p of products) {
    await pool.query('INSERT INTO products (id, name, price) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name), price=VALUES(price)', [p.id, p.name, p.price]);
  }
  res.json({ success: true });
});

// Frontend
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="id">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Depo Manager | Secure Access</title>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
        <script src="https://cdn.jsdelivr.net/npm/lucide-static@0.321.0/lib/index.min.js"></script>
        <style>
          :root { --primary: #6366f1; --bg: #0f172a; --card-bg: rgba(30, 41, 59, 0.7); --text: #f8fafc; --text-muted: #94a3b8; --success: #22c55e; --warning: #f59e0b; --danger: #ef4444; --glass-border: rgba(255, 255, 255, 0.1); }
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: 'Outfit', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; }
          #activation-overlay, #login-overlay { position: fixed; inset: 0; background: var(--bg); z-index: 9999; display: flex; align-items: center; justify-content: center; }
          .auth-card { background: var(--card-bg); border: 1px solid var(--glass-border); padding: 3rem; border-radius: 24px; text-align: center; width: 400px; backdrop-filter: blur(20px); }
          .sidebar { width: 260px; background: rgba(15, 23, 42, 0.95); border-right: 1px solid var(--glass-border); display: flex; flex-direction: column; padding: 2rem 1.5rem; position: fixed; height: 100vh; }
          .logo { font-size: 1.5rem; font-weight: 700; margin-bottom: 3rem; background: linear-gradient(to right, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
          .nav-item { padding: 12px 16px; border-radius: 12px; color: var(--text-muted); margin-bottom: 8px; display: flex; align-items: center; gap: 12px; cursor: pointer; transition: 0.3s; }
          .nav-item:hover, .nav-item.active { background: rgba(99, 102, 241, 0.1); color: var(--text); }
          .main { flex: 1; margin-left: 260px; padding: 2.5rem; }
          header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 3rem; }
          .glass-panel { background: var(--card-bg); backdrop-filter: blur(12px); border: 1px solid var(--glass-border); border-radius: 24px; padding: 2rem; margin-bottom: 2rem; }
          .btn { background: var(--primary); color: white; border: none; padding: 12px 24px; border-radius: 12px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; }
          input, select { background: rgba(15, 23, 42, 0.5); border: 1px solid var(--glass-border); padding: 12px; border-radius: 10px; color: white; width: 100%; margin-bottom: 1rem; }
          table { width: 100%; border-collapse: collapse; }
          th { text-align: left; padding: 12px; color: var(--text-muted); border-bottom: 1px solid var(--glass-border); }
          td { padding: 16px 12px; border-bottom: 1px solid rgba(255,255,255,0.05); }
          #notification { position: fixed; bottom: 2rem; right: 2rem; padding: 1rem 2rem; border-radius: 12px; display: none; z-index: 10000; }
        </style>
    </head>
    <body>
        <div id="activation-overlay" style="display: none;"><div class="auth-card"><h2>Aktivasi</h2><input id="activation-token" placeholder="Token Access"><button class="btn" onclick="activateApp()">Aktifkan</button></div></div>
        <div id="login-overlay" style="display: none;"><div class="auth-card"><h2>Login</h2><input id="login-user" placeholder="Username"><input type="password" id="login-pass" placeholder="Password"><button class="btn" onclick="loginApp()">Masuk</button></div></div>
        <nav class="sidebar">
            <div class="logo">DEPO CORE</div>
            <div class="nav-item active" onclick="showSection('dashboard')"><i data-lucide="layout-dashboard"></i> Dashboard</div>
            <div class="nav-item" onclick="showSection('inventory')"><i data-lucide="package"></i> Inventory</div>
            <div class="nav-item" onclick="showSection('employees')"><i data-lucide="users"></i> Karyawan</div>
            <div class="nav-item" onclick="showSection('sales')"><i data-lucide="shopping-cart"></i> Sales</div>
            <div class="nav-item" onclick="syncData()"><i data-lucide="refresh-cw"></i> Force Sync</div>
            <div style="margin-top:auto"><div class="nav-item" onclick="logoutApp()" style="color:var(--danger)"><i data-lucide="log-out"></i> Logout</div></div>
        </nav>
        <div class="main">
            <header><h1 id="page-title">Dashboard</h1><p id="depo-info" style="color:var(--primary); font-weight: 600;"></p></header>
            <div id="section-dashboard">
                <div class="glass-panel"><h2>Transaksi Terakhir</h2><table id="sales-table"><thead><tr><th>ID</th><th>Total</th><th>Status</th></tr></thead><tbody></tbody></table></div>
            </div>
            <div id="section-inventory" style="display:none">
                <div class="glass-panel" style="text-align:center"><button class="btn" onclick="syncMasterData()">Sync Produk dari Pusat</button></div>
                <div class="glass-panel"><h2>Daftar Produk</h2><table id="products-table"><thead><tr><th>Nama</th><th>Harga</th></tr></thead><tbody></tbody></table></div>
            </div>
            <div id="section-employees" style="display:none">
                <div class="glass-panel">
                    <h2>Input Karyawan</h2>
                    <input id="e-name" placeholder="Nama"><input id="e-pos" placeholder="Posisi"><input id="e-phone" placeholder="No. HP">
                    <button class="btn" onclick="addEmployee()">Tambah Karyawan</button>
                </div>
                <div class="glass-panel"><h2>Daftar Karyawan Lokal</h2><table id="emp-table"><thead><tr><th>Nama</th><th>Posisi</th><th>HP</th></tr></thead><tbody></tbody></table></div>
            </div>
            <div id="section-sales" style="display:none">
                <div class="glass-panel"><h2>Input Penjualan</h2><select id="sale-product-select"></select><input type="number" id="sale-qty" placeholder="Qty"><button class="btn" onclick="addToCart()">Add to Cart</button><div id="cart-total" style="margin-top: 1rem; font-weight: 600;"></div><button class="btn" onclick="checkout()" style="background: var(--success); margin-top: 1rem;">Checkout</button></div>
            </div>
        </div>
        <div id="notification"></div>
        <script>
            let products = [];
            async function initApp() {
                const r = await fetch('/api/config'); const c = await r.json();
                if(!c.activated) { document.getElementById('activation-overlay').style.display='flex'; return; }
                if(!c.authenticated) { document.getElementById('login-overlay').style.display='flex'; return; }
                document.getElementById('depo-info').innerText = c.depo_name + ' | ID: ' + c.depo_id; fetchData();
            }
            async function fetchData() {
                try {
                    const [pr, sr, er] = await Promise.all([fetch('/api/products'), fetch('/api/sales'), fetch('/api/employees')]);
                    if (pr.status === 401) { location.reload(); return; }
                    products = await pr.json();
                    const st = document.querySelector('#sales-table tbody'); st.innerHTML = '';
                    (await sr.json()).forEach(s => st.innerHTML += \`<tr><td>\${s.id.slice(0,8)}</td><td>Rp \${parseFloat(s.total_amount).toLocaleString()}</td><td>\${s.synced?'OK':'Wait'}</td></tr>\`);
                    const pt = document.querySelector('#products-table tbody'); pt.innerHTML = '';
                    const ps = document.getElementById('sale-product-select'); ps.innerHTML = '';
                    products.forEach(p => { 
                        pt.innerHTML += \`<tr><td>\${p.name}</td><td>Rp \${parseFloat(p.price).toLocaleString()}</td></tr>\`; 
                        ps.innerHTML += \`<option value="\${p.id}">\${p.name}</option>\`;
                    });
                    const et = document.querySelector('#emp-table tbody'); et.innerHTML = '';
                    (await er.json()).forEach(e => et.innerHTML += \`<tr><td>\${e.name}</td><td>\${e.position}</td><td>\${e.phone}</td></tr>\`);
                    lucide.createIcons();
                } catch(e) { notify('Gagal memuat data', 'danger'); }
            }
            async function addEmployee() {
                const name = document.getElementById('e-name').value;
                const position = document.getElementById('e-pos').value;
                const phone = document.getElementById('e-phone').value;
                await fetch('/api/employees', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name, position, phone}) });
                fetchData(); notify('Karyawan ditambahkan', 'success');
            }
            async function syncData() { notify('Syncing...', 'warning'); const r = await fetch('/api/sync-to-central', {method:'POST'}); if(r.ok) { fetchData(); notify('Synced!', 'success'); } else { notify('Sync Gagal', 'danger'); } }
            async function syncMasterData() { notify('Syncing Produk...', 'warning'); await fetch('/api/sync-products-from-central', {method:'POST'}); fetchData(); notify('Master Data Terupdate', 'success'); }
            function showSection(n) { ['dashboard','inventory','employees','sales'].forEach(s => document.getElementById('section-'+s).style.display = s===n?'block':'none'); document.getElementById('page-title').innerText = n.toUpperCase(); }
            function notify(m,t) { const n=document.getElementById('notification'); n.innerText=m; n.style.display='block'; n.style.background=t==='success'?'var(--success)':'var(--danger)'; setTimeout(()=>n.style.display='none',3000); }
            async function activateApp() { const token=document.getElementById('activation-token').value; notify('Mengaktifkan...', 'warning'); const r=await fetch('/api/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})}); if(r.ok) { notify('Sukses! Restarting...', 'success'); setTimeout(()=>location.reload(), 2000); } else { notify('Token salah', 'danger'); } }
            async function loginApp() { const username=document.getElementById('login-user').value; const password=document.getElementById('login-pass').value; const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})}); if(r.ok) location.reload(); else notify('Login Gagal', 'danger'); }
            function logoutApp() { fetch('/api/logout',{method:'POST'}).then(()=>location.reload()); }
            initApp();
        </script>
    </body>
    </html>
  `);
});

app.listen(port, () => console.log('Depo Server running on port ' + port));
