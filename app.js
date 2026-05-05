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
    const tempConn = await mysql.createConnection({
      host: dbConfig.host,
      user: dbConfig.user,
      password: dbConfig.password,
    });
    await tempConn.query(`CREATE DATABASE IF NOT EXISTS ${dbConfig.database}`);
    await tempConn.query(`USE ${dbConfig.database}`);
    await tempConn.query(`CREATE TABLE IF NOT EXISTS settings (setting_key VARCHAR(50) PRIMARY KEY, setting_value TEXT)`);

    const [rows] = await tempConn.query('SELECT setting_key, setting_value FROM settings WHERE setting_key IN ("db_user", "db_pass")');
    const settings = {};
    rows.forEach(r => settings[r.setting_key] = r.setting_value);
    await tempConn.end();

    pool = mysql.createPool({ ...dbConfig, user: settings.db_user || dbConfig.user, password: settings.db_pass || dbConfig.password, waitForConnections: true, connectionLimit: 10 });
    
    await pool.query(`CREATE TABLE IF NOT EXISTS products (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL, price DECIMAL(10, 2) NOT NULL, stock INT DEFAULT 0)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS sales (id VARCHAR(36) PRIMARY KEY, total_amount DECIMAL(10, 2) NOT NULL, sale_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP, depo_id VARCHAR(50) NOT NULL, synced BOOLEAN DEFAULT FALSE)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS employees (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, username VARCHAR(50) UNIQUE, password VARCHAR(255), position VARCHAR(50), phone VARCHAR(20), synced BOOLEAN DEFAULT FALSE)`);
    try { await pool.query(`ALTER TABLE employees ADD COLUMN username VARCHAR(50) UNIQUE AFTER name`); } catch (e) {}
    try { await pool.query(`ALTER TABLE employees ADD COLUMN password VARCHAR(255) AFTER username`); } catch (e) {}

    isDbReady = true;
    console.log('Depo Database ready');
  } catch (err) {
    console.error(`Database not ready (${err.message}), retrying in 2s...`);
    setTimeout(initDb, 2000);
  }
}

initDb();

app.use('/api', (req, res, next) => {
  if (!isDbReady) return res.status(503).json({ error: 'DB Loading' });
  next();
});

async function getLocalSetting(key) {
  try {
    const [rows] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = ?', [key]);
    return rows.length > 0 ? rows[0].setting_value : null;
  } catch (e) { return null; }
}

async function checkAuth(req, res, next) {
  if (req.signedCookies.auth === 'true') return next();
  const mobileToken = req.headers['x-depo-token'];
  const storedToken = await getLocalSetting('depo_token');
  if (mobileToken && mobileToken === storedToken) return next();
  
  console.log('Auth Failed: No cookie and token mismatch. Received:', mobileToken, 'Expected:', storedToken);
  res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/config', async (req, res) => {
  const depo_id = await getLocalSetting('depo_id');
  const depo_name = await getLocalSetting('depo_name');
  const authenticated = req.signedCookies.auth === 'true';
  res.json({ activated: !!depo_id, depo_id, depo_name, authenticated });
});

app.get('/api/check-token', async (req, res) => {
  const { token } = req.query;
  const storedToken = await getLocalSetting('depo_token');
  const depoId = await getLocalSetting('depo_id');
  const depoName = await getLocalSetting('depo_name');
  if (token === storedToken) {
    res.json({ success: true, depo_id: depoId, name: depoName });
  } else {
    res.status(403).json({ error: 'Token Invalid' });
  }
});

app.post('/api/activate', async (req, res) => {
  const { token } = req.body;
  const centralBaseUrl = (process.env.CENTRAL_URL || 'http://web-pusat:4000/api/receive-sync').replace('/api/receive-sync', '');
  try {
    const response = await fetch(`${centralBaseUrl}/api/check-token?token=${token}`);
    if (!response.ok) throw new Error('Token Invalid');
    const data = await response.json();

    const conn = await mysql.createConnection({ host: dbConfig.host, user: dbConfig.user, password: dbConfig.password });
    if (data.db_user && data.db_pass) {
      await conn.query(`CREATE USER IF NOT EXISTS '${data.db_user}'@'%' IDENTIFIED BY '${data.db_pass}'`);
      await conn.query(`GRANT ALL PRIVILEGES ON ${dbConfig.database}.* TO '${data.db_user}'@'%'`);
      await conn.query('FLUSH PRIVILEGES');
    }
    await conn.query(`USE ${dbConfig.database}`);
    await conn.query('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', ['depo_id', data.depo_id]);
    await conn.query('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', ['depo_name', data.name]);
    await conn.query('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', ['depo_token', token]);
    await conn.query('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', ['db_user', data.db_user]);
    await conn.query('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', ['db_pass', data.db_pass]);
    await conn.query('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', ['admin_user', data.admin_user]);
    await conn.query('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', ['admin_pass', data.admin_pass]);
    await conn.end();

    res.json({ success: true, message: 'Activated' });
    setTimeout(() => process.exit(0), 1000);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const u = await getLocalSetting('admin_user');
  const p = await getLocalSetting('admin_pass');
  if (username === u && password === p) {
    res.cookie('auth', 'true', { signed: true, maxAge: 86400000 });
    res.json({ success: true });
  } else res.status(401).json({ error: 'Unauthorized' });
});

app.post('/api/logout', (req, res) => { res.clearCookie('auth'); res.json({ success: true }); });
app.get('/api/products', checkAuth, async (req, res) => { const [rows] = await pool.query('SELECT * FROM products'); res.json(rows); });

app.get('/api/sales', checkAuth, async (req, res) => { const [rows] = await pool.query('SELECT * FROM sales ORDER BY sale_date DESC'); res.json(rows); });
app.post('/api/sales', checkAuth, async (req, res) => {
  const { id, total_amount, sale_date } = req.body;
  const depo_id = await getLocalSetting('depo_id');
  try {
    // Format date for MySQL if provided, otherwise use NOW()
    const finalDate = sale_date ? new Date(sale_date).toISOString().slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ');
    await pool.query('INSERT INTO sales (id, total_amount, sale_date, depo_id, synced) VALUES (?, ?, ?, ?, 0)', [id, total_amount, finalDate, depo_id]);
    res.json({ success: true });
  } catch (err) { 
    console.error('Error submitting sale:', err);
    res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/employees', checkAuth, async (req, res) => { const [rows] = await pool.query('SELECT * FROM employees'); res.json(rows); });
app.post('/api/employees', checkAuth, async (req, res) => { const { name, username, password, position, phone } = req.body; await pool.query('INSERT INTO employees (name, username, password, position, phone) VALUES (?, ?, ?, ?, ?)', [name, username, password, position, phone]); res.json({ success: true }); });
app.get('/api/sync-status', checkAuth, async (req, res) => { const [s] = await pool.query('SELECT COUNT(*) as count FROM sales WHERE synced = 0'); const [e] = await pool.query('SELECT COUNT(*) as count FROM employees WHERE synced = 0'); res.json({ unsynced_sales: s[0].count, unsynced_employees: e[0].count }); });

app.post('/api/sync-to-central', checkAuth, async (req, res) => {
  try {
    const depo_token = await getLocalSetting('depo_token');
    const centralUrl = (process.env.CENTRAL_URL || 'http://web-pusat:4000/api/receive-sync');
    const [sales] = await pool.query('SELECT * FROM sales WHERE synced = 0');
    if (sales.length > 0) {
      await fetch(centralUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Depo-Token': depo_token }, body: JSON.stringify({ sales }) });
      await pool.query('UPDATE sales SET synced = 1 WHERE id IN (?)', [sales.map(s => s.id)]);
    }
    const [employees] = await pool.query('SELECT * FROM employees');
    await fetch(centralUrl.replace('/receive-sync', '/employees-sync'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Depo-Token': depo_token }, body: JSON.stringify({ employees }) });
    await pool.query('UPDATE employees SET synced = 1');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/sync-products-from-central', checkAuth, async (req, res) => {
  const depo_token = await getLocalSetting('depo_token');
  const r = await fetch((process.env.CENTRAL_URL || 'http://web-pusat:4000/api/receive-sync').replace('/receive-sync', '/products'), { headers: { 'X-Depo-Token': depo_token } });
  const products = await r.json();
  
  const incomingIds = products.map(p => p.id);
  if (incomingIds.length > 0) {
    await pool.query('DELETE FROM products WHERE id NOT IN (?)', [incomingIds]);
  } else {
    await pool.query('DELETE FROM products');
  }

  for (const p of products) await pool.query('INSERT INTO products (id, name, price) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name), price=VALUES(price)', [p.id, p.name, p.price]);
  res.json({ success: true });
});

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="id">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Depo Manager</title>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
        <script src="https://cdn.jsdelivr.net/npm/lucide-static@0.321.0/lib/index.min.js"></script>
        <style>
          :root { --primary: #6366f1; --bg: #0f172a; --card-bg: rgba(30, 41, 59, 0.7); --text: #f8fafc; --text-muted: #94a3b8; --success: #22c55e; --warning: #f59e0b; --danger: #ef4444; --glass-border: rgba(255, 255, 255, 0.1); }
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: 'Outfit', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; }
          #loading-overlay { position: fixed; inset: 0; background: var(--bg); z-index: 10001; display: flex; align-items: center; justify-content: center; flex-direction: column; }
          #activation-overlay, #login-overlay { position: fixed; inset: 0; background: var(--bg); z-index: 10000; display: none; align-items: center; justify-content: center; }
          .auth-card { background: var(--card-bg); border: 1px solid var(--glass-border); padding: 3rem; border-radius: 24px; text-align: center; width: 400px; backdrop-filter: blur(20px); }
          .sidebar { width: 260px; background: rgba(15, 23, 42, 0.95); border-right: 1px solid var(--glass-border); display: flex; flex-direction: column; padding: 2rem 1.5rem; position: fixed; height: 100vh; }
          .logo { font-size: 1.5rem; font-weight: 700; margin-bottom: 3rem; background: linear-gradient(to right, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
          .nav-item { padding: 12px 16px; border-radius: 12px; color: var(--text-muted); margin-bottom: 8px; display: flex; align-items: center; gap: 12px; cursor: pointer; transition: 0.3s; }
          .nav-item:hover, .nav-item.active { background: rgba(99, 102, 241, 0.1); color: var(--text); }
          .main { flex: 1; margin-left: 260px; padding: 2.5rem; display: none; }
          header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 3rem; }
          .glass-panel { background: var(--card-bg); backdrop-filter: blur(12px); border: 1px solid var(--glass-border); border-radius: 24px; padding: 2rem; margin-bottom: 2rem; }
          .btn { background: var(--primary); color: white; border: none; padding: 12px 24px; border-radius: 12px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; }
          input { background: rgba(15, 23, 42, 0.5); border: 1px solid var(--glass-border); padding: 12px; border-radius: 10px; color: white; width: 100%; margin-bottom: 1rem; }
          table { width: 100%; border-collapse: collapse; }
          th { text-align: left; padding: 12px; color: var(--text-muted); border-bottom: 1px solid var(--glass-border); }
          td { padding: 16px 12px; border-bottom: 1px solid rgba(255,255,255,0.05); }
          #notification { position: fixed; bottom: 2rem; right: 2rem; padding: 1rem 2rem; border-radius: 12px; display: none; z-index: 10002; }
          .spinner { width: 40px; height: 40px; border: 4px solid rgba(255,255,255,0.1); border-top-color: var(--primary); border-radius: 50%; animation: spin 1s linear infinite; margin-bottom: 1rem; }
          @keyframes spin { to { transform: rotate(360deg); } }
        </style>
    </head>
    <body>
        <div id="loading-overlay"><div class="spinner"></div><p id="loading-msg">Inisialisasi Sistem...</p></div>
        <div id="activation-overlay"><div class="auth-card"><h2>Aktivasi</h2><input id="activation-token" placeholder="Token Access"><button class="btn" onclick="activateApp()">Aktifkan</button></div></div>
        <div id="login-overlay"><div class="auth-card"><h2>Login</h2><input id="login-user" placeholder="Username"><input type="password" id="login-pass" placeholder="Password"><button class="btn" onclick="loginApp()">Masuk</button></div></div>
        <nav id="sidebar" class="sidebar" style="display:none">
            <div class="logo">DEPO CORE</div>
            <div class="nav-item active" onclick="showSection('dashboard')"><i data-lucide="layout-dashboard"></i> Dashboard</div>
            <div class="nav-item" onclick="showSection('inventory')"><i data-lucide="package"></i> Inventory</div>
            <div class="nav-item" onclick="showSection('employees')"><i data-lucide="users"></i> Karyawan</div>
            <div class="nav-item" onclick="syncData()"><i data-lucide="refresh-cw"></i> Force Sync</div>
            <div style="margin-top:auto"><div class="nav-item" onclick="logoutApp()" style="color:var(--danger)"><i data-lucide="log-out"></i> Logout</div></div>
        </nav>
        <div id="main-content" class="main">
            <header><h1 id="page-title">Dashboard</h1><p id="depo-info" style="color:var(--primary); font-weight: 600;"></p></header>
            <div id="section-dashboard"><div class="glass-panel"><h2>Transaksi Terakhir</h2><table id="sales-table"><thead><tr><th>ID</th><th>Total</th><th>Status</th></tr></thead><tbody></tbody></table></div></div>
            <div id="section-inventory" style="display:none"><div class="glass-panel" style="text-align:center"><button class="btn" onclick="syncMasterData()">Sync Produk dari Pusat</button></div><div class="glass-panel"><table id="products-table"><thead><tr><th>Nama</th><th>Harga</th></tr></thead><tbody></tbody></table></div></div>
            <div id="section-employees" style="display:none"><div class="glass-panel"><h2>Input Karyawan</h2><input id="e-name" placeholder="Nama"><input id="e-user" placeholder="Username"><input type="password" id="e-pass" placeholder="Password"><input id="e-pos" placeholder="Posisi"><input id="e-phone" placeholder="HP"><button class="btn" onclick="addEmployee()">Tambah</button></div><div class="glass-panel"><table id="emp-table"><thead><tr><th>Nama</th><th>Username</th><th>Posisi</th><th>HP</th></tr></thead><tbody></tbody></table></div></div>
        </div>
        <div id="notification"></div>
        <script>
            async function initApp() {
                const r = await fetch('/api/config'); 
                if (r.status === 503) { 
                    document.getElementById('loading-msg').innerText = 'Menunggu Database...';
                    setTimeout(initApp, 2000); return; 
                }
                const c = await r.json();
                document.getElementById('loading-overlay').style.display = 'none';
                if(!c.activated) { document.getElementById('activation-overlay').style.display='flex'; return; }
                if(!c.authenticated) { document.getElementById('login-overlay').style.display='flex'; return; }
                document.getElementById('sidebar').style.display = 'flex';
                document.getElementById('main-content').style.display = 'block';
                document.getElementById('depo-info').innerText = c.depo_name; fetchData();
            }
            async function fetchData() {
                const [pr, sr, er] = await Promise.all([fetch('/api/products'), fetch('/api/sales'), fetch('/api/employees')]);
                if (pr.status === 401) { location.reload(); return; }
                const products = await pr.json();
                const st = document.querySelector('#sales-table tbody'); st.innerHTML = '';
                (await sr.json()).forEach(s => st.innerHTML += \`<tr><td>\${s.id.slice(0,8)}</td><td>Rp \${parseFloat(s.total_amount).toLocaleString()}</td><td>\${s.synced?'OK':'Wait'}</td></tr>\`);
                const pt = document.querySelector('#products-table tbody'); pt.innerHTML = '';
                products.forEach(p => pt.innerHTML += \`<tr><td>\${p.name}</td><td>Rp \${parseFloat(p.price).toLocaleString()}</td></tr>\`);
                const et = document.querySelector('#emp-table tbody'); et.innerHTML = '';
                (await er.json()).forEach(e => et.innerHTML += \`<tr><td>\${e.name}</td><td>\${e.username || '-'}</td><td>\${e.position}</td><td>\${e.phone}</td></tr>\`);
                lucide.createIcons();
            }
            async function addEmployee() {
                const name = document.getElementById('e-name').value; 
                const username = document.getElementById('e-user').value;
                const password = document.getElementById('e-pass').value;
                const position = document.getElementById('e-pos').value; 
                const phone = document.getElementById('e-phone').value;
                await fetch('/api/employees', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name, username, password, position, phone}) });
                fetchData(); notify('Berhasil', 'success');
            }
            async function syncData() { notify('Syncing...', 'warning'); await fetch('/api/sync-to-central', {method:'POST'}); fetchData(); notify('Success!', 'success'); }
            async function syncMasterData() { notify('Syncing...', 'warning'); await fetch('/api/sync-products-from-central', {method:'POST'}); fetchData(); notify('Update!', 'success'); }
            function showSection(n) { ['dashboard','inventory','employees'].forEach(s => document.getElementById('section-'+s).style.display = s===n?'block':'none'); }
            function notify(m,t) { const n=document.getElementById('notification'); n.innerText=m; n.style.display='block'; n.style.background=t==='success'?'var(--success)':'var(--danger)'; setTimeout(()=>n.style.display='none',3000); }
            async function activateApp() { const token=document.getElementById('activation-token').value; const r=await fetch('/api/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})}); if(r.ok) { notify('Sukses!', 'success'); setTimeout(()=>location.reload(), 2000); } else { const err = await r.json(); notify(err.error, 'danger'); } }
            async function loginApp() { const username=document.getElementById('login-user').value; const password=document.getElementById('login-pass').value; const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})}); if(r.ok) location.reload(); else notify('Gagal', 'danger'); }
            function logoutApp() { fetch('/api/logout',{method:'POST'}).then(()=>location.reload()); }
            initApp();
        </script>
    </body>
    </html>
  `);
});

app.listen(port, () => console.log('Depo Server running on port ' + port));
