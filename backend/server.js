// backend/server.js
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const webpush = require('web-push');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors()); // ✅ Permite chamadas do Cloudflare Pages
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// 🔑 Gera ou carrega chaves VAPID (persiste em arquivo para evitar quebras)
const keysPath = path.join(__dirname, 'vapid_keys.json');
let vapidKeys;

if (fs.existsSync(keysPath)) {
  vapidKeys = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
  console.log('🔑 Chaves VAPID carregadas do arquivo');
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(keysPath, JSON.stringify(vapidKeys));
  console.log('🔑 Novas chaves VAPID geradas e salvas');
}

webpush.setVapidDetails('mailto:admin@msgpwa.com', vapidKeys.publicKey, vapidKeys.privateKey);

// 💾 Armazena assinaturas em memória (resetam no deploy grátis, mas funcionam para teste)
const userSubscriptions = {};

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/subscribe', (req, res) => {
  const { userId, subscription } = req.body;
  userSubscriptions[userId] = subscription;
  console.log(`🔔 Push registrado para: ${userId}`);
  res.status(201).json({ success: true });
});

const clients = new Map();

wss.on('connection', (ws) => {
  let userId = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'register') {
        userId = msg.userId;
        clients.set(userId, { ws, publicKey: msg.publicKey || null });
        console.log(`✅ WS Registrado: ${userId}`);
        return;
      }

      if (msg.type === 'message' || msg.type === 'exchange_key' || msg.type === 'request_key') {
        const target = clients.get(msg.to);
        if (target && target.ws.readyState === 1) {
          if (msg.type === 'message') {
            msg.from = userId;
            msg.senderPub = clients.get(userId)?.publicKey || 'unknown';
            if (userSubscriptions[msg.to]) sendPushNotification(userSubscriptions[msg.to], msg.from);
          }
          if (msg.type === 'request_key' || msg.type === 'exchange_key') msg.from = userId;
          target.ws.send(JSON.stringify(msg));
        } else if (msg.type === 'message') {
          ws.send(JSON.stringify({ type: 'error', content: 'Destinatário offline.' }));
        }
      }
    } catch (e) { console.error('Erro WS:', e.message); }
  });

  ws.on('close', () => { if (userId) clients.delete(userId); });
});

function sendPushNotification(subscription, senderName) {
  const payload = JSON.stringify({
    title: '💬 Nova mensagem',
    body: `Mensagem de ${senderName || 'contato'}. Toque para abrir.`,
    icon: 'https://cdn-icons-png.flaticon.com/512/2906/2906313.png'
  });

  webpush.sendNotification(subscription, payload)
    .then(() => console.log(`📤 Push enviado para ${senderName}`))
    .catch(err => console.error('❌ Erro Push:', err.body || err.message));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Backend ativo na porta ${PORT}`));
