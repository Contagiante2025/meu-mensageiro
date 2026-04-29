// backend/server.js
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const webpush = require('web-push');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// 🔑 VAPID
const keysPath = path.join(__dirname, 'vapid_keys.json');
let vapidKeys;
if (fs.existsSync(keysPath)) vapidKeys = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
else { vapidKeys = webpush.generateVAPIDKeys(); fs.writeFileSync(keysPath, JSON.stringify(vapidKeys)); }
webpush.setVapidDetails('mailto:admin@meuapp.com', vapidKeys.publicKey, vapidKeys.privateKey);

// 💾 Memória
const clients = new Map();
const subscriptions = {};
const bannedUsers = new Set();
const reports = [];

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) { console.error('🚨 ADMIN_PASSWORD não configurada!'); process.exit(1); }

// 🌐 ROTAS
app.get('/api/vapid-public-key', (req, res) => res.json({ publicKey: vapidKeys.publicKey }));
app.post('/api/subscribe', (req, res) => {
  const { userId, subscription } = req.body;
  if (userId && subscription) { subscriptions[userId] = subscription; res.status(201).json({ success: true }); }
  else res.status(400).json({ error: 'Dados inválidos' });
});

app.post('/api/report', (req, res) => {
  reports.push({ id: Date.now().toString(), ...req.body, reportedAt: new Date().toISOString(), status: 'pending' });
  res.status(201).json({ success: true });
});

const checkAdmin = (req, res, next) => req.headers.authorization === `Bearer ${ADMIN_PASSWORD}` ? next() : res.status(401).json({ error: 'Não autorizado' });
app.get('/api/reports', checkAdmin, (req, res) => res.json({ reports, bannedUsers: Array.from(bannedUsers), stats: { total: reports.length, pending: reports.filter(r=>r.status==='pending').length, resolved: reports.filter(r=>r.status==='resolved').length } }));
app.post('/api/ban', checkAdmin, (req, res) => { bannedUsers.add(req.body.userId); if(clients.has(req.body.userId)){const c=clients.get(req.body.userId); c.ws.send(JSON.stringify({type:'banned',content:'Conta banida.'})); c.ws.close();} res.json({success:true}); });
app.post('/api/unban', checkAdmin, (req, res) => { bannedUsers.delete(req.body.userId); res.json({success:true}); });
app.post('/api/report/resolve', checkAdmin, (req, res) => { const r=reports.find(x=>x.id===req.body.reportId); if(r){r.status='resolved'; res.json({success:true});} else res.status(404).json({error:'Não encontrado'}); });

//  WEBSOCKET
wss.on('connection', (ws) => {
  let userId = null;
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'register') {
        userId = msg.userId;
        
        // 👈 FIX 3: BLOQUEIO DE NOMES DUPLICADOS
        if (clients.has(userId)) {
          ws.send(JSON.stringify({ type: 'error', content: ' Nome já em uso. Escolha outro e reconecte.' }));
          ws.close();
          return;
        }
        if (bannedUsers.has(userId)) {
          ws.send(JSON.stringify({ type: 'banned', content: 'Você foi banido.' }));
          ws.close();
          return;
        }

        clients.set(userId, { ws, publicKey: msg.publicKey || null });
        console.log(`✅ Conectado: ${userId}`);
        return;
      }

      if (msg.type === 'message' || msg.type === 'exchange_key' || msg.type === 'request_key') {
        const target = clients.get(msg.to);
        
        if (target && target.ws.readyState === 1) {
          if (msg.type === 'request_key' || msg.type === 'exchange_key') msg.from = userId;
          if (msg.type === 'message') {
            msg.from = userId;
            msg.senderPub = clients.get(userId)?.publicKey || 'unknown';
            if (subscriptions[msg.to]) sendPushNotification(subscriptions[msg.to], msg.from);
          }
          target.ws.send(JSON.stringify(msg));
        } else if (msg.type === 'message') {
          // 👈 FIX 2: AVISO CLARO DE OFFLINE
          ws.send(JSON.stringify({ type: 'error', content: `📴 ${msg.to} está offline ou não existe.` }));
        }
      }
    } catch (e) { console.error('Erro WS:', e.message); }
  });

  ws.on('close', () => { if (userId) { clients.delete(userId); console.log(`🔌 Desconectado: ${userId}`); } });
});

// 🔔 PUSH COM LOGS DE DEBUG
function sendPushNotification(subscription, senderName) {
  const payload = JSON.stringify({ title: 'Nova mensagem', body: `Mensagem de ${senderName}.`, icon: 'https://cdn-icons-png.flaticon.com/512/2906/2906313.png' });
  webpush.sendNotification(subscription, payload)
    .then(() => console.log(`📤 Push enviado para ${senderName}`))
    .catch(err => {
      if (err.statusCode === 410) console.log('🗑️ Subscription expirada (410)');
      else console.error('❌ Erro Push:', err.statusCode, err.body || err.message);
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Backend seguro rodando na porta ${PORT}`));
