// app.js - Mensageiro PWA com E2EE via Web Crypto API
import { Crypto } from '/crypto.js';
import { LocalDB } from '/localdb.js';

let ws = null;
let myId = null;
let myKeys = null; // { publicKey: CryptoKey, privateKey: CryptoKey }
let contactsKeys = new Map(); // userId → { publicKey: CryptoKey, aesKey: CryptoKey }

// ============================================================================
// INICIALIZAÇÃO
// ============================================================================
async function init() {
  try {
    document.getElementById('loading').style.display = 'block';
    
    // Inicia IndexedDB para histórico local
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
      const privJson = await Crypto.exportPrivateKey(myKeys.privateKey); // JWK string
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
          aesKey: null // será derivado na primeira troca
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
  // ⚠️ SUBSTITUA PELA SUA URL DO RENDER
  const BACKEND_URL = 'wss://msg-backend-d6zc.onrender.com';
  
  console.log('🔌 Conectando a:', BACKEND_URL);
  ws = new WebSocket(BACKEND_URL);

  ws.onopen = async () => {
    console.log('✅ WebSocket conectado');
    const pubB64 = await Crypto.exportPublicKey(myKeys.publicKey);
    
    // Registra usuário no backend com chave pública
    ws.send(JSON.stringify({
      type: 'register',
      userId: myId,
      publicKey: pubB64
    }));
    
    // Troca de tela
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('chat-screen').classList.remove('hidden');
    
    // Carrega histórico local
    loadHistory();
  };

  ws.onmessage = async (e) => {
    try {
      const data = JSON.parse(e.data);
      
      // 🔑 Troca de chaves públicas (handshake E2EE)
      if (data.type === 'exchange_key') {
        console.log('🔑 Chave pública recebida de:', data.from);
        const theirPub = await Crypto.importPublicKey(data.publicKey);
        const aesKey = await Crypto.deriveAESKey(theirPub, myKeys.privateKey);
        contactsKeys.set(data.from, { publicKey: theirPub, aesKey });
        saveContactsKeys();
        return;
      }
      
      // 📤 Solicitação de chave pública
      if (data.type === 'request_key') {
        console.log('📤 Enviando chave pública para:', data.from);
        const pubB64 = await Crypto.exportPublicKey(myKeys.publicKey);
        ws.send(JSON.stringify({ 
          type: 'exchange_key', 
          to: data.from, 
          publicKey: pubB64 
        }));
        return;
      }
      
      // 📨 Mensagem criptografada recebida
      if (data.type === 'message') {
        console.log('📨 Mensagem recebida de:', data.from);
        
        // Garante que temos a chave AES do remetente
        if (!contactsKeys.has(data.from)) {
          const theirPub = await Crypto.importPublicKey(data.senderPub);
          const aesKey = await Crypto.deriveAESKey(theirPub, myKeys.privateKey);
          contactsKeys.set(data.from, { publicKey: theirPub, aesKey });
        }
        
        const contact = contactsKeys.get(data.from);
        const decrypted = await Crypto.decrypt(data.content, contact.aesKey);
        
        if (decrypted) {
          console.log('🔓 Mensagem descriptografada com sucesso');
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
      
      // ⚠️ Erro do backend
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
    console.log('🔌 Conexão WebSocket fechada');
    alert('Conexão encerrada. Recarregue a página para reconectar.');
  };
}

// ============================================================================
// ENVIO DE MENSAGEM
// ============================================================================
async function sendMessage() {
  const to = document.getElementById('target-user').value.trim().toLowerCase().replace(/\s+/g, '_');
  const content = document.getElementById('message-input').value.trim();
  
  if (!to || !content) return alert('Preencha destinatário e mensagem!');
  if (!ws || ws.readyState !== WebSocket.OPEN) return alert('Sem conexão. Recarregue a página.');
  
  // Se não temos a chave do contato, solicita
  if (!contactsKeys.has(to)) {
    console.log('🔑 Solicitando chave pública para:', to);
    ws.send(JSON.stringify({ type: 'request_key', to }));
    return alert(`Solicitando chave para ${to}... Aguarde 2 segundos e tente enviar novamente.`);
  }

  // Criptografa e envia
  const contact = contactsKeys.get(to);
  const encrypted = await Crypto.encrypt(content, contact.aesKey);
  
  console.log('🔐 Mensagem criptografada e enviada');
  const myPubB64 = await Crypto.exportPublicKey(myKeys.publicKey);
  
  ws.send(JSON.stringify({ 
    type: 'message', 
    to, 
    content: encrypted, 
    senderPub: myPubB64 
  }));
  
  // Exibe localmente e salva no histórico
  addMessage('Você', content, 'sent');
  await LocalDB.save({ 
    id: Date.now() + '_s', 
    from: myId, 
    to, 
    content, 
    timestamp: Date.now() 
  });
  
  document.getElementById('message-input').value = '';
}

// ============================================================================
// HELPERS DE UI
// ============================================================================
function addMessage(from, text, type) {
  const log = document.getElementById('chat-log');
  const div = document.createElement('div');
  div.className = `msg ${type}`;
  div.innerHTML = `
    <div class="meta">
      ${type === 'sent' ? '→' : '←'} ${from} • ${new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
    </div>
    ${text}
  `;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

async function loadHistory() {
  const history = await LocalDB.load(myId);
  console.log('📚 Histórico local carregado:', history.length, 'mensagens');
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
  console.log('💾 Chaves de contatos salvas');
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
  if (confirm('Apagar todo o histórico local? Esta ação não pode ser desfeita.')) {
    await LocalDB.clear();
    document.getElementById('chat-log').innerHTML = '';
    alert('✅ Histórico apagado com sucesso!');
  }
};

// ============================================================================
// INICIA O APP
// ============================================================================
init();
