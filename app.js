const express = require('express');
const app = express();
const port = 3000;

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Docker Control Panel</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600&display=swap" rel="stylesheet">
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
                font-family: 'Inter', sans-serif; 
                background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); 
                height: 100vh; 
                display: flex; 
                align-items: center; 
                justify-content: center; 
                color: white;
                overflow: hidden;
            }
            .glass-card {
                background: rgba(255, 255, 255, 0.05);
                backdrop-filter: blur(10px);
                -webkit-backdrop-filter: blur(10px);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 24px;
                padding: 3rem;
                width: 90%;
                max-width: 500px;
                text-align: center;
                box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
                animation: fadeIn 0.8s ease-out;
            }
            @keyframes fadeIn {
                from { opacity: 0; transform: translateY(20px); }
                to { opacity: 1; transform: translateY(0); }
            }
            .docker-icon {
                font-size: 4rem;
                margin-bottom: 1.5rem;
                display: inline-block;
                filter: drop-shadow(0 0 15px #38bdf8);
            }
            h1 { font-weight: 600; font-size: 2rem; margin-bottom: 1rem; letter-spacing: -0.025em; }
            p { color: #94a3b8; line-height: 1.6; margin-bottom: 2rem; }
            .status-badge {
                display: inline-flex;
                align-items: center;
                gap: 8px;
                background: rgba(34, 197, 94, 0.1);
                color: #4ade80;
                padding: 8px 16px;
                border-radius: 99px;
                font-weight: 600;
                font-size: 0.875rem;
                border: 1px solid rgba(34, 197, 94, 0.2);
            }
            .pulse {
                width: 8px;
                height: 8px;
                background: #4ade80;
                border-radius: 50%;
                box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7);
                animation: pulse-animation 2s infinite;
            }
            @keyframes pulse-animation {
                0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); }
                70% { transform: scale(1); box-shadow: 0 0 0 10px rgba(34, 197, 94, 0); }
                100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
            }
            .footer { margin-top: 2rem; font-size: 0.75rem; color: #64748b; }
        </style>
    </head>
    <body>
        <div class="glass-card">
            <div class="docker-icon">🐳</div>
            <h1>Docker Dashboard</h1>
            <p>Node.js application successfully containerized and running in high-performance mode.</p>
            <div class="status-badge">
                <div class="pulse"></div>
                LIVE SYSTEM ACTIVE
            </div>
            <div class="footer">
                Environment: Production • Server: VPS • Port: 3000
            </div>
        </div>
    </body>
    </html>
  `);
});

app.listen(port, () => {
  console.log(`Aplikasi dummy berjalan di http://localhost:${port}`);
});
