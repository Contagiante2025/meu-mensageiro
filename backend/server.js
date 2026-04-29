// backend/server.js
// Versão Completa: Chat E2EE + Push Notifications + Painel Admin

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const webpush = require('web-push');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors()); // Permite conexões do Frontend (Cloudflare)
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ============================================================================
// 🔑 CONFIGURAÇÃO DE PUSH (VAPID)
// ============================================================================
// Salva as chaves num arquivo para não mudar toda vez que reiniciar o servidor
const keysPath = path.join(__dirname, 'vapid_keys.json');
let vapidKeys;

if (fs.existsSync(keysPath)) {
  vapidKeys = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
  console.log(' Chaves VAPID carregadas do arquivo.');
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(keysPath, JSON.stringify(vapidKeys));
  console.log('🔑 Novas chaves VAPID geradas e salvas.');
}

webpush.setVapidDetails(
  'mailto:admin@meuapp.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// ============================================================================
// 💾 ARMAZENAMENTO EM MEMÓRIA (Dados Temporários)
// ============================================================================
const clients = new Map();       // userId -> { ws, publicKey }
const subscriptions = {};        // userId -> subscriptionObj (Push)
const bannedUsers = new Set();   // userId (Banidos)
const reports = [];              // Lista de denúncias

// Senha do Admin (MUDE ISSO ANTES DE LANÇAR!)
const ADMIN_PASSWORD = 'admin123';

// ============================================================================
//  ROTAS HTTP (API para Frontend e Admin)
// ============================================================================

// 1. Frontend pega a chave pública para ativar Push
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// 2. Frontend envia a assinatura do Push
app.post('/api/subscribe', (req, res) => {
  const { userId, subscription } = req.body;
  if (userId && subscription) {
    subscriptions[userId] = subscription;
    console.log(`🔔 Push ativado para: ${userId}`);
    res.status(201).json({ success: true });
  } else {
    res.status(400).json({ error: 'Dados inválidos' });
  }
});

// 3. Enviar Denúncia (Usuário Comum)
app.post('/api/report', (req, res) => {
  const { reporterId, reportedUserId, messageId, timestamp, reason } = req.body;
  
  const report = {
    id: Date.now().toString(),
    reporterId,
    reportedUserId,
    messageId,
    timestamp,
    reason: reason || 'Conteúdo inadequado',
    reportedAt: new Date().toISOString(),
    status: 'pending'
  };
  
  reports.push(report);
  console.log(`🚨 Denúncia: ${reportedUserId} reportado por ${reporterId}`);
  res.status(201).json({ success: true });
});

// 4. Listar Denúncias (Admin) - Protegido por senha
app.get('/api/reports', (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${ADMIN_PASSWORD}`) return res.status(401).json({ error: 'Não autorizado' });
  
  res.json({
    reports,
    bannedUsers: Array.from(bannedUsers),
    stats: {
      total: reports.length,
      pending: reports.filter(r => r.status === 'pending').length,
      resolved: reports.filter(r => r.status === 'resolved').length
    }
  });
});

// 5. Banir Usuário (Admin)
app.post('/api/ban', (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${ADMIN_PASSWORD}`) return res.status(401).json({ error: 'Não autorizado' });
  
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'ID necessário' });
  
  bannedUsers.add(userId);
  console.log(`🚫 Usuário BANIDO: ${userId}`);
  
  // Se estiver online, chuta imediatamente
  if (clients.has(userId)) {
    const client = clients.get(userId);
    client.ws.send(JSON.stringify({ type: 'banned', content: 'Sua conta foi banida.' }));
    client.ws.close();
  }
  
  res.json({ success: true });
});

// 6. Desbanir Usuário (Admin)
app.post('/api/unban', (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${ADMIN_PASSWORD}`) return res.status(401).json({ error: 'Não autorizado' });
  
  const { userId } = req.body;
  bannedUsers.delete(userId);
  console.log(`✅ Usuário DESBANIDO: ${userId}`);
  res.json({ success: true });
});

// 7. Resolver Denúncia (Admin)
app.post('/api/report/resolve', (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${ADMIN_PASSWORD}`) return res.status(401).json({ error: 'Não autorizado' });
  
  const { reportId } = req.body;
  const report = reports.find(r => r.id === reportId);
  if (report) {
    report.status = 'resolved';
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Não encontrado' });
  }
});

// ============================================================================
// 🔌 LÓGICA WEBSOCKET (Chat em Tempo Real)
// ============================================================================

wss.on('connection', (ws) => {
  let userId = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      // --- REGISTRO DE USUÁRIO ---
      if (msg.type === 'register') {
        userId = msg.userId;
        
        // Verifica se está banido
        if (bannedUsers.has(userId)) {
          ws.send(JSON.stringify({ type: 'banned', content: 'Você foi banido deste chat.' }));
          ws.close();
          return;
        }

        clients.set(userId, { ws, publicKey: msg.publicKey || null });
        console.log(`✅ Conectado: ${userId}`);
        return;
      }

      // --- ROTEAMENTO DE MENSAGENS E CHAVES ---
      if (msg.type === 'message' || msg.type === 'exchange_key' || msg.type === 'request_key') {
        const target = clients.get(msg.to);
        
        if (target && target.ws.readyState === 1) {
          // Identifica quem está enviando
          if (msg.type === 'request_key' || msg.type === 'exchange_key') {
            msg.from = userId;
          }
          if (msg.type === 'message') {
            msg.from = userId;
            msg.senderPub = clients.get(userId)?.publicKey || 'unknown';
            
            // 🔔 Dispara Push Notification se o destinatário tiver ativado
            if (subscriptions[msg.to]) {
              sendPushNotification(subscriptions[msg.to], msg.from);
            }
          }
          
          target.ws.send(JSON.stringify(msg));
        } else if (msg.type === 'message') {
          ws.send(JSON.stringify({ type: 'error', content: 'Usuário offline.' }));
        }
      }

    } catch (e) {
      console.error('Erro no WS:', e.message);
    }
  });

  ws.on('close', () => {
    if (userId) {
      clients.delete(userId);
      console.log(` Desconectado: ${userId}`);
    }
  });
});

// Função auxiliar para enviar Notificação Push
function sendPushNotification(subscription, senderName) {
  const payload = JSON.stringify({
    title: 'Nova mensagem',
    body: `Você recebeu uma mensagem de ${senderName}.`,
    icon: 'https://cdn-icons-png.flaticon.com/512/2906/2906313.png'
  });

  webpush.sendNotification(subscription, payload).catch(err => {
    // Erros 410 (Gone) significam que a assinatura expirou
    if (err.statusCode === 410) {
      console.log('🗑️ Assinatura de push expirada/removida.');
    }
  });
}

// ============================================================================
// 🚀 INICIALIZAÇÃO DO SERVIDOR
// ============================================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Backend rodando na porta ${PORT}`));
