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

      // 2. Roteamento de mensagens e chaves
      if (msg.type === 'message' || msg.type === 'exchange_key' || msg.type === 'request_key') {
        const target = clients.get(msg.to);
        
        if (target && target.ws.readyState === 1) {
          
          // Se for mensagem, anexamos a chave pública do remetente
          if (msg.type === 'message') {
            msg.senderPub = clients.get(userId)?.publicKey || 'unknown';
          }

          // CORREÇÃO CRÍTICA: Se for pedido de chave, dizemos QUEM está pedindo
          if (msg.type === 'request_key') {
            msg.from = userId; // O servidor identifica o remetente
          }

          target.ws.send(JSON.stringify(msg));
        } else if (msg.type === 'message') {
          // Usuário alvo offline
          ws.send(JSON.stringify({ 
            type: 'error', 
            content: 'Usuário offline ou não existe. Peça para ele entrar no chat.' 
          }));
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Backend ativo na porta ${PORT}`));
