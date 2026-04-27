import { Crypto } from '/crypto.js';
import { LocalDB } from '/localdb.js';

let ws;
let myId = null;
let myKeys = null; // { publicKey, privateKey }
let contactsKeys = new Map(); // userId → { publicKey, aesKey }

async function init() {
  try {
    document.getElementById('loading').style.display = 'block';
    
    // Inicia IndexedDB
    await LocalDB.init();

    // Carrega ou gera chaves ECDH
    const stored = localStorage.getItem('msg_keys');
    if (stored) {
      const parsed = JSON.parse(stored);
      myKeys = {
        publicKey: await Crypto.importPublicKey(parsed.publicKey),
        privateKey: await Crypto.importPrivateKey(parsed.privateKey)
      };
      console.log('✅ Chaves carregadas');
    } else {
      myKeys = await Crypto.generateKeys();
      // Exporta para salvar no localStorage
      const pubB64 = await Crypto.exportPublicKey(myKeys.publicKey);
      const privB64 = await Crypto.exportPrivateKey(myKeys.privateKey);
      localStorage.setItem('msg_keys', JSON.stringify({
        publicKey: pubB64,
        privateKey: privB64
      }));
      console.log('✅ Novas chaves geradas');
    }

    // Carrega contatos (apenas chaves públicas)
    const storedContacts = localStorage.getItem('msg_contacts');
    if (storedContacts) {
      const parsed = JSON.parse(storedContacts);
      for (const [userId, pubB64] of Object.entries(parsed)) {
        contactsKeys.set(userId, {
          publicKey: await Crypto.importPublicKey(pubB64),
          aesKey: null // será derivado na primeira mensagem
        });
      }
    }

    document.getElementById('loading').style.display = 'none';
    console.log('✅ App inicializado');
    
  } catch (error) {
    console.error('❌ Falha na inicialização:', error);
    document.getElementById('loading').innerHTML = 
      `❌ Erro: ${error.message}<br><small>Use um navegador moderno (Chrome 90+, Firefox 88+, Safari 15+)</small>`;
  }
}

async function connect() {
  const name = document.getElementById('username').value.trim().toLowerCase().replace(/\s+/g, '_');
  if (!name) return alert('Digite um nome!');
  
  if (!myKeys || !myKeys.publicKey) {
    alert('❌ Erro crítico: Chaves não geradas. Recarregue a página.');
    return;
  }
  
  myId = name;
  const BACKEND_URL = 'wss://msg-backend-d6zc.onrender.com'; // ⚠️ SUA URL
  
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
      
      if (data.type === 'exchange_key') {
        console.log('🔑 Chave recebida de:', data.from);
        // Deriva chave AES compartilhada
        const theirPub = await Crypto.importPublicKey(data.publicKey);
        const aesKey = await Crypto.deriveAESKey(theirPub, myKeys.privateKey);
        contactsKeys.set(data.from, { publicKey: theirPub, aesKey });
        saveContactsKeys();
        return;
      }
      
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
      
      if (data.type === 'message') {
        console.log('📨 Mensagem recebida');
        // Deriva chave se ainda não tiver
        if (!contactsKeys.has(data.from)) {
          const theirPub = await Crypto.importPublicKey(data.senderPub);
          const aesKey = await Crypto.deriveAESKey(theirPub, myKeys.privateKey);
          contactsKeys.set(data.from, { publicKey: theirPub, aesKey });
        }
        const contact = contactsKeys.get(data.from);
        const decrypted = await Crypto.decrypt(data.content, contact.aesKey);
        
        if (decrypted) {
          console.log('🔓 Mensagem descriptografada');
          addMessage(data.from, decrypted, 'received');
          await LocalDB.save({ 
            id: Date.now() + '_r', 
            from: data.from, 
            to: myId, 
            content: decrypted, 
            timestamp: data.timestamp 
          });
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
    alert('Falha na conexão. Verifique o backend.');
  };
  
  ws.onclose = () => alert('Conexão encerrada. Recarregue.');
}

async function sendMessage() {
  const to = document.getElementById('target-user').value.trim().toLowerCase().replace(/\s+/g, '_');
  const content = document.getElementById('message-input').value.trim();
  
  if (!to || !content) return alert('Preencha destinatário e mensagem!');
  if (!ws || ws.readyState !== 1) return alert('Sem conexão.');
  
  // Garante que temos a chave do contato
  if (!contactsKeys.has(to)) {
    console.log('🔑 Solicitando chave para:', to);
    ws.send(JSON.stringify({ type: 'request_key', to }));
    return alert(`Solicitando chave para ${to}... Aguarde 2s e tente enviar novamente.`);
  }

  const contact = contactsKeys.get(to);
  const encrypted = await Crypto.encrypt(content, contact.aesKey);
  
  console.log('🔐 Enviando mensagem criptografada');
  const myPubB64 = await Crypto.exportPublicKey(myKeys.publicKey);
  
  ws.send(JSON.stringify({ 
    type: 'message', 
    to, 
    content: encrypted, 
    senderPub: myPubB64 
  }));
  
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

// Helpers (mantidos iguais)
function addMessage(from, text, type) {
  const log = document.getElementById('chat-log');
  const div = document.createElement('div');
  div.className = `msg ${type}`;
  div.innerHTML = `<div class="meta">${type === 'sent' ? '→' : '←'} ${from} • ${new Date().toLocaleTimeString()}</div>${text}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

async function loadHistory() {
  const history = await LocalDB.load(myId);
  history.forEach(m => addMessage(m.from === myId ? 'Você' : m.from, m.content, m.from === myId ? 'sent' : 'received'));
}

async function saveContactsKeys() {
  const obj = {};
  for (const [userId, data] of contactsKeys.entries()) {
    obj[userId] = await Crypto.exportPublicKey(data.publicKey);
  }
  localStorage.setItem('msg_contacts', JSON.stringify(obj));
}

// Event listeners
document.getElementById('connect-btn').onclick = connect;
document.getElementById('send-btn').onclick = sendMessage;
document.getElementById('message-input').onkeydown = e => e.key === 'Enter' && sendMessage();
document.getElementById('clear-btn').onclick = async () => {
  if (confirm('Apagar todo o histórico local?')) {
    await LocalDB.clear();
    document.getElementById('chat-log').innerHTML = '';
  }
};

// Inicia
init();
