const express = require('express');
const app = express();
const port = 3000;

app.get('/', (req, res) => {
  res.send(`
    <style>
      body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background-color: #f0f2f5; }
      .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center; }
      h1 { color: #007bff; }
      .status { color: #28a745; font-weight: bold; }
    </style>
    <div class="card">
      <h1>Hello from Docker! 🚀</h1>
      <p>Project dummy Anda berhasil dijalankan di dalam container.</p>
      <p class="status">Status: Running</p>
    </div>
  `);
});

app.listen(port, () => {
  console.log(`Aplikasi dummy berjalan di http://localhost:${port}`);
});
