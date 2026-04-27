import { Crypto } from '/crypto.js';
import { LocalDB } from '/localdb.js';

let ws;
let myId = null;
let myKeys = null;
let contactsKeys = new Map();

// Inicialização com tratamento de erro
async function init() {
  try {
    // Mostra loading
    document.getElementById('loading').style.display = 'block';
    
    // Aguarda libsodium
    await Crypto.ready();
    
    // Inicia IndexedDB
    await LocalDB.init();

    // Carrega ou gera chaves
    const stored = localStorage.getItem('msg_keys');
    if (stored) {
      myKeys = JSON.parse(stored);
      myKeys.publicKey = Crypto.fromBase64(myKeys.publicKey);
      myKeys.secretKey = Crypto.fromBase64(myKeys.secretKey);
      console.log('✅ Chaves carregadas do localStorage');
    } else {
      myKeys = Crypto.generateKeys();
      localStorage.setItem('msg_keys', JSON.stringify({
        publicKey: Crypto.toBase64(myKeys.publicKey),
        secretKey: Crypto.toBase64(myKeys.secretKey)
      }));
      console.log('✅ Novas chaves geradas');
    }

    // Carrega contatos
    const storedContacts = localStorage.getItem('msg_contacts');
    if (storedContacts) {
      const parsed = JSON.parse(storedContacts);
      contactsKeys = new Map(Object.entries(parsed).map(([k, v]) => [k, Crypto.fromBase64(v)]));
    }

    // Esconde loading e mostra login
    document.getElementById('loading').style.display = 'none';
    console.log('✅ App inicializado com sucesso');
    
  } catch (error) {
    console.error('❌ Falha na inicialização:', error);
    document.getElementById('loading').innerHTML = 
      `❌ Erro: ${error.message}<br><small>Recarregue a página ou verifique sua conexão.</small>`;
  }
}

async function connect() {
  const name = document.getElementById('username').value.trim().toLowerCase().replace(/\s+/g, '_');
  if (!name) return alert('Digite um nome!');
  
  // Validação CRÍTICA: myKeys deve existir
  if (!myKeys || !myKeys.publicKey) {
    alert('❌ Erro crítico: Chaves não geradas. Recarregue a página.');
    console.error('myKeys é null ou inválido:', myKeys);
    return;
  }
  
  myId = name;

  const BACKEND_URL = 'wss://msg-backend-d6zc.onrender.com'; // ⚠️ SUA URL DO RENDER
  console.log('🔌 Conectando a:', BACKEND_URL);
  
  ws = new WebSocket(BACKEND_URL);

  ws.onopen = () => {
    console.log('✅ WebSocket conectado');
    console.log('🔑 Enviando chave pública:', Crypto.toBase64(myKeys.publicKey).substring(0, 20) + '...');
    
    ws.send(JSON.stringify({
      type: 'register',
      userId: myId,
      publicKey: Crypto.toBase64(myKeys.publicKey)
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
        contactsKeys.set(data.from, Crypto.fromBase64(data.publicKey));
        saveContactsKeys();
        return;
      }
      
      if (data.type === 'request_key') {
        console.log('📤 Enviando chave para:', data.from);
        ws.send(JSON.stringify({
          type: 'exchange_key',
          to: data.from,
          publicKey: Crypto.toBase64(myKeys.publicKey)
        }));
        return;
      }
      
      if (data.type === 'message') {
        console.log('📨 Mensagem recebida de:', data.from);
        const senderPub = Crypto.fromBase64(data.senderPub);
        const decrypted = Crypto.decrypt(data.content, senderPub, myKeys.secretKey);
        
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
    console.log('🔌 WebSocket fechado');
    alert('Conexão encerrada. Recarregue a página.');
  };
}

async function sendMessage() {
  const to = document.getElementById('target-user').value.trim().toLowerCase().replace(/\s+/g, '_');
  const content = document.getElementById('message-input').value.trim();
  
  if (!to || !content) return alert('Preencha destinatário e mensagem!');
  if (!ws || ws.readyState !== 1) return alert('Sem conexão. Recarregue a página.');
  if (!contactsKeys.has(to)) {
    console.log('🔑 Solicitando chave para:', to);
    ws.send(JSON.stringify({ type: 'request_key', to }));
    return alert(`Solicitando chave para ${to}... Aguarde 2s e tente novamente.`);
  }

  const encrypted = Crypto.encrypt(content, contactsKeys.get(to), myKeys.secretKey);
  console.log('🔐 Mensagem criptografada e enviada');
  
  ws.send(JSON.stringify({ 
    type: 'message', 
    to, 
    content: encrypted, 
    senderPub: Crypto.toBase64(myKeys.publicKey) 
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

function addMessage(from, text, type)
