// backend/server.js
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Map(); // userId -> { ws, publicKey }

wss.on('connection', (ws) => {
  let userId = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      // 1. Registrar usuário
      if (msg.type === 'register') {
        userId = msg.userId;
        clients.set(userId, { ws, publicKey: msg.publicKey || null });
        console.log(`✅ Registrado: ${userId}`);
        return;
      }

      // 2. Roteamento unificado
      if (msg.type === 'message' || msg.type === 'exchange_key' || msg.type === 'request_key') {
        const target = clients.get(msg.to);
        
        if (target && target.ws.readyState === 1) {
          // 🔑 CORREÇÃO: Identifica quem está enviando a chave/pedido
          if (msg.type === 'request_key' || msg.type === 'exchange_key') {
            msg.from = userId;
          }
          // 📨 Para mensagens, anexa a chave pública do remetente
          if (msg.type === 'message') {
            msg.senderPub = clients.get(userId)?.publicKey || 'unknown';
          }
          
          target.ws.send(JSON.stringify(msg));
        } else if (msg.type === 'message') {
          ws.send(JSON.stringify({ 
            type: 'error', 
            content: 'Destinatário offline. Peça para ele entrar no chat.' 
          }));
        }
      }
    } catch (e) {
      console.error('Erro de roteamento:', e.message);
    }
  });

  ws.on('close', () => {
    if (userId) clients.delete(userId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Backend ativo na porta ${PORT}`));
