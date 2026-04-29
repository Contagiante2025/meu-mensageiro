// backend/server.js (Versão Segura + Completa)
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

// 🔑 VAPID Keys (Persistidas em arquivo)
const keysPath = path.join(__dirname, 'vapid_keys.json');
let vapidKeys;
if (fs.existsSync(keysPath)) {
  vapidKeys = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(keysPath, JSON.stringify(vapidKeys));
}
webpush.setVapidDetails('mailto:admin@meuapp.com', vapidKeys.publicKey, vapidKeys.privateKey);

// 💾 Dados em Memória
const clients = new Map();
const subscriptions = {};
const bannedUsers = new Set();
const reports = [];

// 🔒 SEGURANÇA: Senha via Variável de Ambiente (Render)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error('🚨 ERRO CRÍTICO: ADMIN_PASSWORD não configurada nas variáveis de ambiente do Render.');
  process.exit(1);
}

// 🌐 ROTAS HTTP
app.get('/api/vapid-public-key', (req, res) => res.json({ publicKey: vapidKeys.publicKey }));

app.post('/api/subscribe', (req, res) => {
  const { userId, subscription } = req.body;
  if (userId && subscription) { subscriptions[userId] = subscription; res.status(201).json({ success: true }); }
  else res.status(400).json({ error: 'Dados inválidos' });
});

app.post('/api/report', (req, res) => {
  const { reporterId, reportedUserId, messageId, timestamp, reason } = req.body;
  reports.push({ id: Date.now().toString(), reporterId, reportedUserId, messageId, timestamp, reason: reason || 'Conteúdo inadequado', reportedAt: new Date().toISOString(), status: 'pending' });
  res.status(201).json({ success: true });
});

const checkAdmin = (req, res, next) => {
  if (req.headers.authorization !== `Bearer ${ADMIN_PASSWORD}`) return res.status(401).json({ error: 'Não autorizado' });
  next();
};

app.get('/api/reports', checkAdmin, (req, res) => {
  res.json({ reports, bannedUsers: Array.from(bannedUsers), stats: { total: reports.length, pending: reports.filter(r => r.status === 'pending').length, resolved: reports.filter(r => r.status === 'resolved').length } });
});

app.post('/api/ban', checkAdmin, (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'ID necessário' });
  bannedUsers.add(userId);
  if (clients.has(userId)) { const c = clients.get(userId); c.ws.send(JSON.stringify({ type: 'banned', content: 'Conta banida.' })); c.ws.close(); }
  res.json({ success: true });
});

app.post('/api/unban', checkAdmin, (req, res) => { bannedUsers.delete(req.body.userId); res.json({ success: true }); });
app.post('/api/report/resolve', checkAdmin, (req, res) => { const r = reports.find(x => x.id === req.body.reportId); if (r) { r.status = 'resolved'; res.json({ success: true }); } else res.status(404).json({ error: 'Não encontrado' }); });

// 🔌 WEBSOCKET
wss.on('connection', (ws) => {
  let userId = null;
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'register') {
        userId = msg.userId;
        if (bannedUsers.has(userId)) { ws.send(JSON.stringify({ type: 'banned', content: 'Você foi banido.' })); ws.close(); return; }
        clients.set(userId, { ws, publicKey: msg.publicKey || null });
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
        } else if (msg.type === 'message') ws.send(JSON.stringify({ type: 'error', content: 'Usuário offline.' }));
      }
    } catch (e) { console.error('Erro WS:', e.message); }
  });
  ws.on('close', () => { if (userId) clients.delete(userId); });
});

function sendPushNotification(subscription, senderName) {
  webpush.sendNotification(subscription, JSON.stringify({ title: 'Nova mensagem', body: `Mensagem de ${senderName}.`, icon: 'https://cdn-icons-png.flaticon.com/512/2906/2906313.png' })).catch(() => {});
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Backend seguro rodando na porta ${PORT}`));
