// backend/server.js
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const webpush = require('web-push');

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --- CONFIGURAÇÃO VAPID (Chaves para Push) ---
// Se não existirem chaves salvas, o servidor gera um par novo (efêmero)
// Em produção, você usaria chaves fixas. Aqui geramos para facilitar o deploy.
const vapidKeys = webpush.generateVAPIDKeys();

webpush.setVapidDetails(
  'mailto:admin@meuapp.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// Rota para o Frontend pegar a chave pública
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// Rota para o Frontend salvar o "Push Subscription"
const userSubscriptions = {}; // Armazena em memória (reinicia com o servidor)
app.post('/api/subscribe', (req, res) => {
  const { userId, subscription } = req.body;
  userSubscriptions[userId] = subscription;
  console.log(`🔔 Usuário ${userId} ativou notificações.`);
  res.status(201).json({});
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
        console.log(`✅ Registrado: ${userId}`);
        return;
      }

      if (msg.type === 'message' || msg.type === 'exchange_key' || msg.type === 'request_key') {
        const target = clients.get(msg.to);

        if (target && target.ws.readyState === 1) {
          if (msg.type === 'message') {
            msg.from = userId;
            msg.senderPub = clients.get(userId)?.publicKey || 'unknown';
            
            // 🔔 DISPARAR PUSH: Avisa o destinatário que chegou mensagem
            if (userSubscriptions[msg.to]) {
              sendPushNotification(userSubscriptions[msg.to], msg.from);
            }
          }
          if (msg.type === 'request_key' || msg.type === 'exchange_key') {
            msg.from = userId;
          }
          target.ws.send(JSON.stringify(msg));
        } else if (msg.type === 'message') {
          ws.send(JSON.stringify({ type: 'error', content: 'Destinatário offline.' }));
        }
      }
    } catch (e) {
      console.error('Erro:', e.message);
    }
  });

  ws.on('close', () => {
    if (userId) clients.delete(userId);
  });
});

// Função auxiliar para enviar o Push
function sendPushNotification(subscription, senderName) {
  const payload = JSON.stringify({
    title: 'Nova mensagem',
    body: `Você recebeu uma mensagem de ${senderName || 'alguém'}.`,
    icon: 'https://cdn-icons-png.flaticon.com/512/2906/2906313.png' // Ícone padrão
  });

  webpush.sendNotification(subscription, payload).catch(err => {
    console.error('Erro ao enviar push:', err);
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Backend ativo na porta ${PORT}`));
