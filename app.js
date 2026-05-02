const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Database configuration
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || 'rootpassword',
  database: process.env.DB_NAME || 'depo_db',
};

// Global pool variable
let pool;
let isDbReady = false;

async function initDb() {
  try {
    console.log('Connecting to MySQL host...');
    // Create connection without database first to ensure DB exists
    const connection = await mysql.createConnection({
      host: dbConfig.host,
      user: dbConfig.user,
      password: dbConfig.password,
    });
    
    console.log('Creating database if not exists...');
    await connection.query(`CREATE DATABASE IF NOT EXISTS ${dbConfig.database}`);
    await connection.end();

    // Now create the pool with the database specified
    pool = mysql.createPool({
      ...dbConfig,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    // Initialize tables
    console.log('Initializing tables...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        price DECIMAL(10, 2) NOT NULL,
        stock INT DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sales (
        id VARCHAR(36) PRIMARY KEY,
        total_amount DECIMAL(10, 2) NOT NULL,
        sale_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        depo_id VARCHAR(50) NOT NULL,
        synced BOOLEAN DEFAULT FALSE,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sale_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sale_id VARCHAR(36),
        product_id INT,
        quantity INT,
        price DECIMAL(10, 2),
        FOREIGN KEY (sale_id) REFERENCES sales(id),
        FOREIGN KEY (product_id) REFERENCES products(id)
      )
    `);

    isDbReady = true;
    console.log('Database and tables initialized successfully');
  } catch (err) {
    console.error('Database initialization failed:', err.message);
    console.log('Retrying in 5 seconds...');
    setTimeout(initDb, 5000);
  }
}

initDb();

// Middleware to check DB readiness
app.use('/api', (req, res, next) => {
  if (!isDbReady) {
    return res.status(503).json({ error: 'Database is still initializing, please try again in a few seconds.' });
  }
  next();
});

// API Routes

// Get all products
app.get('/api/products', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM products');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a product
app.post('/api/products', async (req, res) => {
  const { name, price, stock } = req.body;
  try {
    const [result] = await pool.query(
      'INSERT INTO products (name, price, stock) VALUES (?, ?, ?)',
      [name, price, stock]
    );
    res.json({ id: result.insertId, name, price, stock });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a sale
app.post('/api/sales', async (req, res) => {
  const { items, total_amount } = req.body;
  const saleId = crypto.randomUUID();
  const depoId = process.env.DEPO_ID || 'UNKNOWN_DEPO';

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    await connection.query(
      'INSERT INTO sales (id, total_amount, depo_id, synced) VALUES (?, ?, ?, ?)',
      [saleId, total_amount, depoId, false]
    );

    for (const item of items) {
      await connection.query(
        'INSERT INTO sale_items (sale_id, product_id, quantity, price) VALUES (?, ?, ?, ?)',
        [saleId, item.product_id, item.quantity, item.price]
      );
      
      // Update stock
      await connection.query(
        'UPDATE products SET stock = stock - ? WHERE id = ?',
        [item.quantity, item.product_id]
      );
    }

    await connection.commit();
    res.json({ id: saleId, message: 'Sale recorded successfully' });
  } catch (err) {
    await connection.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    connection.release();
  }
});

// Get sales history
app.get('/api/sales', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM sales ORDER BY sale_date DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Sync Status
app.get('/api/sync-status', async (req, res) => {
  try {
    const [total] = await pool.query('SELECT COUNT(*) as count FROM sales');
    const [unsynced] = await pool.query('SELECT COUNT(*) as count FROM sales WHERE synced = 0');
    res.json({
      total: total[0].count,
      unsynced: unsynced[0].count,
      depo_id: process.env.DEPO_ID || 'UNKNOWN_DEPO'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve Frontend
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="id">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Depo Manager | High Performance Sales</title>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
        <script src="https://cdn.jsdelivr.net/npm/lucide-static@0.321.0/lib/index.min.js"></script>
        <style>
            :root {
                --primary: #6366f1;
                --primary-hover: #4f46e5;
                --bg: #0f172a;
                --card-bg: rgba(30, 41, 59, 0.7);
                --text: #f8fafc;
                --text-muted: #94a3b8;
                --success: #22c55e;
                --warning: #f59e0b;
                --danger: #ef4444;
                --glass-border: rgba(255, 255, 255, 0.1);
            }

            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
                font-family: 'Outfit', sans-serif; 
                background: var(--bg); 
                color: var(--text);
                min-height: 100vh;
                display: flex;
            }

            /* Sidebar */
            .sidebar {
                width: 260px;
                background: rgba(15, 23, 42, 0.95);
                border-right: 1px solid var(--glass-border);
                display: flex;
                flex-direction: column;
                padding: 2rem 1.5rem;
                position: fixed;
                height: 100vh;
            }

            .logo {
                font-size: 1.5rem;
                font-weight: 700;
                margin-bottom: 3rem;
                display: flex;
                align-items: center;
                gap: 12px;
                background: linear-gradient(to right, #818cf8, #c084fc);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
            }

            .nav-item {
                padding: 12px 16px;
                border-radius: 12px;
                color: var(--text-muted);
                text-decoration: none;
                margin-bottom: 8px;
                display: flex;
                align-items: center;
                gap: 12px;
                transition: all 0.3s;
                cursor: pointer;
            }

            .nav-item:hover, .nav-item.active {
                background: rgba(99, 102, 241, 0.1);
                color: var(--text);
            }

            /* Main Content */
            .main {
                flex: 1;
                margin-left: 260px;
                padding: 2.5rem;
                max-width: 1200px;
            }

            header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 3rem;
            }

            .stats-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
                gap: 1.5rem;
                margin-bottom: 3rem;
            }

            .stat-card {
                background: var(--card-bg);
                backdrop-filter: blur(12px);
                border: 1px solid var(--glass-border);
                padding: 1.5rem;
                border-radius: 20px;
                transition: transform 0.3s;
            }

            .stat-card:hover { transform: translateY(-5px); }

            .stat-label { color: var(--text-muted); font-size: 0.875rem; margin-bottom: 0.5rem; }
            .stat-value { font-size: 1.75rem; font-weight: 700; }

            /* Forms & Tables */
            .glass-panel {
                background: var(--card-bg);
                backdrop-filter: blur(12px);
                border: 1px solid var(--glass-border);
                border-radius: 24px;
                padding: 2rem;
                margin-bottom: 2rem;
            }

            h2 { margin-bottom: 1.5rem; font-size: 1.25rem; font-weight: 600; }

            .btn {
                background: var(--primary);
                color: white;
                border: none;
                padding: 12px 24px;
                border-radius: 12px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.3s;
                display: inline-flex;
                align-items: center;
                gap: 8px;
            }

            .btn:hover { background: var(--primary-hover); transform: translateY(-2px); }

            .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }

            input, select {
                background: rgba(15, 23, 42, 0.5);
                border: 1px solid var(--glass-border);
                padding: 12px;
                border-radius: 10px;
                color: white;
                width: 100%;
                margin-bottom: 1rem;
            }

            table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
            th { text-align: left; padding: 12px; color: var(--text-muted); border-bottom: 1px solid var(--glass-border); }
            td { padding: 16px 12px; border-bottom: 1px solid rgba(255,255,255,0.05); }

            .badge {
                padding: 4px 12px;
                border-radius: 99px;
                font-size: 0.75rem;
                font-weight: 600;
            }
            .badge-sync { background: rgba(34, 197, 94, 0.1); color: var(--success); }
            .badge-pending { background: rgba(245, 158, 11, 0.1); color: var(--warning); }

            #notification {
                position: fixed;
                bottom: 2rem;
                right: 2rem;
                padding: 1rem 2rem;
                border-radius: 12px;
                display: none;
                animation: slideIn 0.3s ease;
                z-index: 1000;
            }

            @keyframes slideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }
        </style>
    </head>
    <body>
        <div class="sidebar">
            <div class="logo">DEPO CORE</div>
            <div class="nav-item active" onclick="showSection('dashboard')">Dashboard</div>
            <div class="nav-item" onclick="showSection('inventory')">Inventory</div>
            <div class="nav-item" onclick="showSection('sales')">Sales Transaksi</div>
            <div class="nav-item" onclick="syncData()">Force Sync</div>
        </div>

        <div class="main">
            <header>
                <div>
                    <h1 id="page-title">Dashboard</h1>
                    <p id="depo-name" style="color: var(--text-muted)">ID Depo: Loading...</p>
                </div>
                <div class="btn" onclick="showSection('sales')">+ Transaksi Baru</div>
            </header>

            <div id="section-dashboard">
                <div class="stats-grid">
                    <div class="stat-card">
                        <div class="stat-label">Total Penjualan</div>
                        <div id="stat-total-sales" class="stat-value">Rp 0</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">Produk Terdaftar</div>
                        <div id="stat-products" class="stat-value">0</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">Belum Tersync</div>
                        <div id="stat-pending-sync" class="stat-value">0</div>
                    </div>
                </div>

                <div class="glass-panel">
                    <h2>Transaksi Terakhir</h2>
                    <table id="sales-table">
                        <thead>
                            <tr>
                                <th>ID Transaksi</th>
                                <th>Tanggal</th>
                                <th>Total</th>
                                <th>Status Sync</th>
                            </tr>
                        </thead>
                        <tbody></tbody>
                    </table>
                </div>
            </div>

            <div id="section-inventory" style="display: none;">
                <div class="glass-panel">
                    <h2>Tambah Produk Baru</h2>
                    <div class="grid-2">
                        <input type="text" id="p-name" placeholder="Nama Produk">
                        <input type="number" id="p-price" placeholder="Harga">
                    </div>
                    <input type="number" id="p-stock" placeholder="Stok Awal">
                    <button class="btn" onclick="addProduct()">Simpan Produk</button>
                </div>

                <div class="glass-panel">
                    <h2>Daftar Produk</h2>
                    <table id="products-table">
                        <thead>
                            <tr>
                                <th>ID</th>
                                <th>Nama</th>
                                <th>Harga</th>
                                <th>Stok</th>
                            </tr>
                        </thead>
                        <tbody></tbody>
                    </table>
                </div>
            </div>

            <div id="section-sales" style="display: none;">
                <div class="glass-panel">
                    <h2>Input Penjualan</h2>
                    <div id="sale-form">
                        <select id="sale-product-select"></select>
                        <input type="number" id="sale-qty" placeholder="Jumlah">
                        <button class="btn" onclick="addToCart()">Tambah ke Keranjang</button>
                    </div>
                    
                    <div style="margin-top: 2rem;">
                        <h3>Keranjang</h3>
                        <table id="cart-table">
                            <thead>
                                <tr>
                                    <th>Produk</th>
                                    <th>Qty</th>
                                    <th>Harga</th>
                                    <th>Subtotal</th>
                                </tr>
                            </thead>
                            <tbody></tbody>
                        </table>
                        <div style="margin-top: 1.5rem; text-align: right;">
                            <h3 id="cart-total">Total: Rp 0</h3>
                            <button class="btn" onclick="checkout()" style="margin-top: 1rem; background: var(--success);">Selesaikan Transaksi</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <div id="notification"></div>

        <script>
            let cart = [];
            let products = [];

            async function fetchData() {
                try {
                    const [prodRes, salesRes, syncRes] = await Promise.all([
                        fetch('/api/products'),
                        fetch('/api/sales'),
                        fetch('/api/sync-status')
                    ]);

                    if (!prodRes.ok || !salesRes.ok || !syncRes.ok) {
                        const errData = await syncRes.json();
                        throw new Error(errData.error || 'Server is starting up...');
                    }

                    products = await prodRes.json();
                    const sales = await salesRes.json();
                    const syncStatus = await syncRes.json();

                    updateUI(products, sales, syncStatus);
                } catch (err) {
                    console.error(err);
                    notify(err.message, 'warning');
                    // Set default UI state if DB not ready
                    document.getElementById('depo-name').innerText = 'ID Depo: Connecting...';
                }
            }

            function updateUI(products, sales, syncStatus) {
                document.getElementById('depo-name').innerText = 'ID Depo: ' + syncStatus.depo_id;
                document.getElementById('stat-products').innerText = products.length;
                document.getElementById('stat-pending-sync').innerText = syncStatus.unsynced;
                
                const totalSales = sales.reduce((acc, s) => acc + parseFloat(s.total_amount), 0);
                document.getElementById('stat-total-sales').innerText = 'Rp ' + totalSales.toLocaleString();

                // Products Table & Select
                const prodTable = document.querySelector('#products-table tbody');
                const prodSelect = document.getElementById('sale-product-select');
                prodTable.innerHTML = '';
                prodSelect.innerHTML = '<option value="">Pilih Produk...</option>';
                
                products.forEach(p => {
                    prodTable.innerHTML += \`
                        <tr>
                            <td>\${p.id}</td>
                            <td>\${p.name}</td>
                            <td>Rp \${parseFloat(p.price).toLocaleString()}</td>
                            <td>\${p.stock}</td>
                        </tr>
                    \`;
                    prodSelect.innerHTML += \`<option value="\${p.id}">\${p.name} (Stok: \${p.stock})</option>\`;
                });

                // Sales Table
                const salesTable = document.querySelector('#sales-table tbody');
                salesTable.innerHTML = '';
                sales.slice(0, 10).forEach(s => {
                    const statusClass = s.synced ? 'badge-sync' : 'badge-pending';
                    const statusText = s.synced ? 'Synced' : 'Pending Sync';
                    salesTable.innerHTML += \`
                        <tr>
                            <td style="font-family: monospace; font-size: 0.8rem;">\${s.id}</td>
                            <td>\${new Date(s.sale_date).toLocaleString()}</td>
                            <td>Rp \${parseFloat(s.total_amount).toLocaleString()}</td>
                            <td><span class="badge \${statusClass}">\${statusText}</span></td>
                        </tr>
                    \`;
                });
            }

            function showSection(name) {
                ['dashboard', 'inventory', 'sales'].forEach(s => {
                    document.getElementById('section-' + s).style.display = s === name ? 'block' : 'none';
                });
                document.getElementById('page-title').innerText = name.charAt(0).toUpperCase() + name.slice(1);
                
                // Update active nav
                document.querySelectorAll('.nav-item').forEach(item => {
                    item.classList.remove('active');
                    if (item.innerText.toLowerCase().includes(name)) item.classList.add('active');
                });
            }

            async function addProduct() {
                const name = document.getElementById('p-name').value;
                const price = document.getElementById('p-price').value;
                const stock = document.getElementById('p-stock').value;

                if (!name || !price) return notify('Mohon lengkapi data', 'warning');

                const res = await fetch('/api/products', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, price, stock })
                });

                if (res.ok) {
                    notify('Produk berhasil ditambahkan', 'success');
                    fetchData();
                    document.getElementById('p-name').value = '';
                    document.getElementById('p-price').value = '';
                    document.getElementById('p-stock').value = '';
                }
            }

            function addToCart() {
                const prodId = document.getElementById('sale-product-select').value;
                const qty = parseInt(document.getElementById('sale-qty').value);
                const product = products.find(p => p.id == prodId);

                if (!product || !qty || qty <= 0) return notify('Pilih produk dan jumlah yang valid', 'warning');
                if (qty > product.stock) return notify('Stok tidak mencukupi', 'danger');

                cart.push({
                    product_id: product.id,
                    name: product.name,
                    quantity: qty,
                    price: product.price,
                    subtotal: product.price * qty
                });

                updateCartUI();
            }

            function updateCartUI() {
                const tbody = document.querySelector('#cart-table tbody');
                tbody.innerHTML = '';
                let total = 0;

                cart.forEach((item, index) => {
                    total += item.subtotal;
                    tbody.innerHTML += \`
                        <tr>
                            <td>\${item.name}</td>
                            <td>\${item.quantity}</td>
                            <td>Rp \${parseFloat(item.price).toLocaleString()}</td>
                            <td>Rp \${item.subtotal.toLocaleString()}</td>
                        </tr>
                    \`;
                });

                document.getElementById('cart-total').innerText = 'Total: Rp ' + total.toLocaleString();
            }

            async function checkout() {
                if (cart.length === 0) return notify('Keranjang kosong', 'warning');

                const total = cart.reduce((acc, item) => acc + item.subtotal, 0);
                const res = await fetch('/api/sales', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ items: cart, total_amount: total })
                });

                if (res.ok) {
                    notify('Transaksi Berhasil!', 'success');
                    cart = [];
                    updateCartUI();
                    fetchData();
                    showSection('dashboard');
                } else {
                    notify('Gagal memproses transaksi', 'danger');
                }
            }

            function syncData() {
                notify('Sinkronisasi ke pusat dimulai...', 'warning');
                setTimeout(() => {
                    notify('Simulasi: Sinkronisasi berhasil!', 'success');
                    // Di dunia nyata, ini akan memanggil endpoint pusat
                }, 2000);
            }

            function notify(msg, type) {
                const n = document.getElementById('notification');
                n.innerText = msg;
                n.style.display = 'block';
                n.style.background = type === 'success' ? 'var(--success)' : 
                                   type === 'danger' ? 'var(--danger)' : 
                                   type === 'warning' ? 'var(--warning)' : 'var(--primary)';
                setTimeout(() => n.style.display = 'none', 3000);
            }

            // Initial fetch
            fetchData();
            // Refresh every 30 seconds
            setInterval(fetchData, 30000);
        </script>
    </body>
    </html>
  `);
});

app.listen(port, () => {
  console.log(`Server berjalan di http://localhost:${port}`);
});

