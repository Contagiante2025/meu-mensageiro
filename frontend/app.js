// app.js - Mensageiro PWA com E2EE via Web Crypto API
import { Crypto } from '/crypto.js';
import { LocalDB } from '/localdb.js';

let ws = null;
let myId = null;
let myKeys = null; // { publicKey: CryptoKey, privateKey: CryptoKey }
let contactsKeys = new Map(); // userId → { publicKey: CryptoKey, aesKey: CryptoKey }
let pendingMessage = null; // Guarda mensagem enquanto aguarda troca de chaves

// ============================================================================
// INICIALIZAÇÃO
// ============================================================================
async function init() {
  try {
    document.getElementById('loading').style.display = 'block';

    await LocalDB.init();

    // Carrega ou gera par de chaves ECDH
    const stored = localStorage.getItem('msg_keys');
    if (stored) {
      const parsed = JSON.parse(stored);
      myKeys = {
        publicKey: await Crypto.importPublicKey(parsed.publicKey),
        privateKey: await Crypto.importPrivateKey(parsed.privateKey)
      };
      console.log('✅ Chaves carregadas do localStorage');
    } else {
      myKeys = await Crypto.generateKeys();
      const pubB64 = await Crypto.exportPublicKey(myKeys.publicKey);
      const privJson = await Crypto.exportPrivateKey(myKeys.privateKey); // Formato JWK
      localStorage.setItem('msg_keys', JSON.stringify({
        publicKey: pubB64,
        privateKey: privJson
      }));
      console.log('✅ Novas chaves geradas e salvas');
    }

    // Carrega chaves públicas dos contatos
    const storedContacts = localStorage.getItem('msg_contacts');
    if (storedContacts) {
      const parsed = JSON.parse(storedContacts);
      for (const [userId, pubB64] of Object.entries(parsed)) {
        contactsKeys.set(userId, {
          publicKey: await Crypto.importPublicKey(pubB64),
          aesKey: null // Será derivada na primeira troca
        });
      }
    }

    document.getElementById('loading').style.display = 'none';
    console.log('✅ App inicializado com Web Crypto API (ECDH + AES-GCM)');
  } catch (error) {
    console.error('❌ Erro na inicialização:', error);
    document.getElementById('loading').innerHTML = 
      `❌ Erro: ${error.message}<br><small>Use Chrome 90+, Firefox 88+, Safari 15+ ou Edge 90+</small>`;
  }
}

// ============================================================================
// CONEXÃO WEBSOCKET
// ============================================================================
async function connect() {
  const name = document.getElementById('username').value.trim().toLowerCase().replace(/\s+/g, '_');
  if (!name) return alert('Digite um nome!');

  if (!myKeys?.publicKey) {
    alert('❌ Chaves não geradas. Recarregue a página.');
    return;
  }

  myId = name;
  // ⚠️ MANTENHA SUA URL DO RENDER AQUI
  const BACKEND_URL = 'wss://msg-backend-d6zc.onrender.com';

  console.log('🔌 Conectando a:', BACKEND_URL);
  ws = new WebSocket(BACKEND_URL);

  ws.onopen = async () => {
    console.log('✅ WebSocket conectado');
    const pubB64 = await Crypto.exportPublicKey(myKeys.publicKey);

    ws.send(JSON.stringify({
      type: 'register',
      userId: myId,
      publicKey: pubB64
    }));

    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('chat-screen').classList.remove('hidden');
    loadHistory();
  };

  ws.onmessage = async (e) => {
    try {
      const data = JSON.parse(e.data);

      // 🔑 Recebimento de chave pública
      if (data.type === 'exchange_key') {
        console.log('🔑 Chave recebida de:', data.from);
        const theirPub = await Crypto.importPublicKey(data.publicKey);
        const aesKey = await Crypto.deriveAESKey(theirPub, myKeys.privateKey);
        contactsKeys.set(data.from, { publicKey: theirPub, aesKey });
        saveContactsKeys();

        // 🚀 Envio automático da mensagem pendente
        if (pendingMessage && pendingMessage.to === data.from) {
          console.log('⚡ Chave recebida! Enviando mensagem pendente automaticamente...');
          await sendPendingMessage();
        }
        return;
      }

      // 📤 Solicitação de chave
      if (data.type === 'request_key') {
        console.log('📤 Enviando chave para:', data.from);
        const pubB64 = await Crypto.exportPublicKey(myKeys.publicKey);
        ws.send(JSON.stringify({
          type: 'exchange_key',
          to: data.from,
          publicKey: pubB64
        }));
        return;
      }

      // 📨 Mensagem recebida
      if (data.type === 'message') {
        console.log('📨 Mensagem de:', data.from);
        // Garante que temos a chave AES do remetente
        if (!contactsKeys.has(data.from)) {
          const theirPub = await Crypto.importPublicKey(data.senderPub);
          const aesKey = await Crypto.deriveAESKey(theirPub, myKeys.privateKey);
          contactsKeys.set(data.from, { publicKey: theirPub, aesKey });
        }
        const contact = contactsKeys.get(data.from);
        const decrypted = await Crypto.decrypt(data.content, contact.aesKey);
        if (decrypted) {
          addMessage(data.from, decrypted, 'received');
          await LocalDB.save({
            id: Date.now() + '_r',
            from: data.from,
            to: myId,
            content: decrypted,
            timestamp: data.timestamp
          });
        } else {
          console.warn('⚠️ Falha ao descriptografar mensagem');
        }
      }

      if (data.type === 'error') {
        alert('⚠️ ' + data.content);
      }
    } catch (err) {
      console.error('❌ Erro ao processar mensagem:', err);
    }
  };

  ws.onerror = (err) => {
    console.error('❌ WebSocket error:', err);
    alert('Falha na conexão. Verifique se o backend está online.');
  };

  ws.onclose = () => {
    console.log('🔌 Conexão encerrada');
    alert('Conexão encerrada. Recarregue a página.');
  };
}

// ============================================================================
// ENVIO DE MENSAGEM
// ============================================================================
async function sendPendingMessage() {
  if (!pendingMessage) return;
  const { to, content } = pendingMessage;
  pendingMessage = null;

  if (!contactsKeys.has(to)) return;

  const contact = contactsKeys.get(to);
  const encrypted = await Crypto.encrypt(content, contact.aesKey);
  const myPubB64 = await Crypto.exportPublicKey(myKeys.publicKey);

  ws.send(JSON.stringify({
    type: 'message',
    to,
    content: encrypted,
    senderPub: myPubB64
  }));

  addMessage('Você', content, 'sent');
  await LocalDB.save({ id: Date.now() + '_s', from: myId, to, content, timestamp: Date.now() });
  document.getElementById('message-input').value = '';

  // Restaura botão
  const btn = document.getElementById('send-btn');
  btn.textContent = 'Enviar';
  btn.disabled = false;
}

async function sendMessage() {
  const to = document.getElementById('target-user').value.trim().toLowerCase().replace(/\s+/g, '_');
  const content = document.getElementById('message-input').value.trim();

  if (!to || !content) return alert('Preencha destinatário e mensagem!');
  if (!ws || ws.readyState !== WebSocket.OPEN) return alert('Sem conexão.');

  // Se não tem a chave, guarda a mensagem e pede ao servidor
  if (!contactsKeys.has(to)) {
    pendingMessage = { to, content };
    console.log('🔑 Chave não encontrada. Solicitando troca...');
    ws.send(JSON.stringify({ type: 'request_key', to }));

    const btn = document.getElementById('send-btn');
    btn.textContent = '⏳ Aguardando chave...';
    btn.disabled = true;
    return;
  }

  // Envia normalmente
  const contact = contactsKeys.get(to);
  const encrypted = await Crypto.encrypt(content, contact.aesKey);
  const myPubB64 = await Crypto.exportPublicKey(myKeys.publicKey);

  ws.send(JSON.stringify({
    type: 'message',
    to,
    content: encrypted,
    senderPub: myPubB64
  }));

  addMessage('Você', content, 'sent');
  await LocalDB.save({ id: Date.now() + '_s', from: myId, to, content, timestamp: Date.now() });
  document.getElementById('message-input').value = '';
}

// ============================================================================
// HELPERS DE UI & DB
// ============================================================================
function addMessage(from, text, type) {
  const log = document.getElementById('chat-log');
  const div = document.createElement('div');
  div.className = `msg ${type}`;
  div.innerHTML = `<div class="meta">${type === 'sent' ? '→' : '←'} ${from} • ${new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</div>${text}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

async function loadHistory() {
  const history = await LocalDB.load(myId);
  history.forEach(m => {
    const sender = m.from === myId ? 'Você' : m.from;
    const type = m.from === myId ? 'sent' : 'received';
    addMessage(sender, m.content, type);
  });
}

async function saveContactsKeys() {
  const obj = {};
  for (const [userId, data] of contactsKeys.entries()) {
    obj[userId] = await Crypto.exportPublicKey(data.publicKey);
  }
  localStorage.setItem('msg_contacts', JSON.stringify(obj));
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================
document.getElementById('connect-btn').onclick = connect;
document.getElementById('send-btn').onclick = sendMessage;
document.getElementById('message-input').onkeydown = e => {
  if (e.key === 'Enter') sendMessage();
};
document.getElementById('clear-btn').onclick = async () => {
  if (confirm('Apagar todo o histórico local?')) {
    await LocalDB.clear();
    document.getElementById('chat-log').innerHTML = '';
    alert('✅ Histórico apagado!');
  }
};

// Inicia o app
init();
