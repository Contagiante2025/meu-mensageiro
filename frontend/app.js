// app.js - Mensageiro PWA Estável (Correção aesKey)
import { Crypto } from '/crypto.js';
import { LocalDB } from '/localdb.js';

let ws = null;
let myId = null;
let myKeys = null;
let contactsKeys = new Map();
let pendingMessage = null;

async function init() {
  try {
    document.getElementById('loading').style.display = 'block';
    await LocalDB.init();

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
      const privJson = await Crypto.exportPrivateKey(myKeys.privateKey);
      localStorage.setItem('msg_keys', JSON.stringify({ publicKey: pubB64, privateKey: privJson }));
      console.log('✅ Novas chaves geradas');
    }

    const storedContacts = localStorage.getItem('msg_contacts');
    if (storedContacts) {
      const parsed = JSON.parse(storedContacts);
      for (const [userId, pubB64] of Object.entries(parsed)) {
        contactsKeys.set(userId, {
          publicKey: await Crypto.importPublicKey(pubB64),
          aesKey: null // Será derivada depois
        });
      }
    }

    document.getElementById('loading').style.display = 'none';
    console.log('✅ App inicializado');
    
    // Event listeners com proteção
    const btnConnect = document.getElementById('connect-btn');
    if (btnConnect) btnConnect.onclick = connect;
    const btnSend = document.getElementById('send-btn');
    if (btnSend) btnSend.onclick = sendMessage;
    const inputMsg = document.getElementById('message-input');
    if (inputMsg) inputMsg.onkeydown = e => { if (e.key === 'Enter') sendMessage(); };
    const btnClear = document.getElementById('clear-btn');
    if (btnClear) btnClear.onclick = async () => {
      if (confirm('Apagar histórico?')) { await LocalDB.clear(); document.getElementById('chat-log').innerHTML = ''; }
    };
    const btnPush = document.getElementById('enable-push-btn');
    if (btnPush) btnPush.onclick = requestPushPermission;

  } catch (error) {
    console.error('❌ Erro init:', error);
  }
}

async function connect() {
  const nameInput = document.getElementById('username');
  const name = nameInput ? nameInput.value.trim().toLowerCase().replace(/\s+/g, '_') : '';
  if (!name) return alert('Digite um nome!');
  if (!myKeys?.publicKey) return alert('❌ Chaves inválidas.');

  myId = name;
  const BACKEND_URL = 'wss://msg-backend-d6zc.onrender.com';
  console.log('🔌 Conectando a:', BACKEND_URL);
  
  ws = new WebSocket(BACKEND_URL);

  ws.onopen = async () => {
    console.log('✅ WebSocket conectado');
    const pubB64 = await Crypto.exportPublicKey(myKeys.publicKey);
    ws.send(JSON.stringify({ type: 'register', userId: myId, publicKey: pubB64 }));

    const login = document.getElementById('login-screen');
    const chat = document.getElementById('chat-screen');
    if(login) login.classList.add('hidden');
    if(chat) chat.classList.remove('hidden');
    
    loadHistory();
    if (Notification.permission === 'granted') registerPush();
  };

  ws.onmessage = async (e) => {
    try {
      const data = JSON.parse(e.data);

      if (data.type === 'exchange_key') {
        console.log('🔑 Chave recebida de:', data.from);
        const theirPub = await Crypto.importPublicKey(data.publicKey);
        const aesKey = await Crypto.deriveAESKey(theirPub, myKeys.privateKey);
        
        // 🔧 Atualiza o contato existente com a aesKey derivada
        const existing = contactsKeys.get(data.from);
        if (existing) {
          existing.aesKey = aesKey; // Atualiza in-place
          contactsKeys.set(data.from, existing);
        } else {
          contactsKeys.set(data.from, { publicKey: theirPub, aesKey });
        }
        saveContactsKeys();

        if (pendingMessage && pendingMessage.to === data.from) {
          console.log('⚡ Enviando pendente...');
          await sendPendingMessage();
        }
        return;
      }

      if (data.type === 'request_key') {
        console.log('📤 Enviando chave para:', data.from);
        const pubB64 = await Crypto.exportPublicKey(myKeys.publicKey);
        ws.send(JSON.stringify({ type: 'exchange_key', to: data.from, publicKey: pubB64 }));
        return;
      }

      if (data.type === 'message') {
        console.log('📨 Mensagem de:', data.from);
        if (!contactsKeys.has(data.from)) {
          const theirPub = await Crypto.importPublicKey(data.senderPub);
          const aesKey = await Crypto.deriveAESKey(theirPub, myKeys.privateKey);
          contactsKeys.set(data.from, { publicKey: theirPub, aesKey });
        }
        const contact = contactsKeys.get(data.from);
        if (contact?.aesKey) {
          const decrypted = await Crypto.decrypt(data.content, contact.aesKey);
          if (decrypted) {
            addMessage(data.from, decrypted, 'received');
            await LocalDB.save({ id: Date.now() + '_r', from: data.from, to: myId, content: decrypted, timestamp: data.timestamp });
          }
        }
      }
      if (data.type === 'error') alert('⚠️ ' + data.content);
    } catch (err) { console.error('❌ Erro msg:', err); }
  };

  ws.onerror = () => alert('❌ Falha na conexão.');
  ws.onclose = () => alert('🔌 Conexão encerrada.');
}

// ============================================================================
// PUSH (Opcional)
// ============================================================================
async function requestPushPermission() {
  if (!('Notification' in window)) return alert('Não suportado.');
  const result = await Notification.requestPermission();
  if (result === 'granted') await registerPush();
}

async function registerPush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    const backendHttp = 'https://msg-backend-d6zc.onrender.com';
    
    const res = await fetch(`${backendHttp}/api/vapid-public-key`);
    if (!res.ok) return;
    const { publicKey } = await res.json();
    
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });

    await fetch(`${backendHttp}/api/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: myId, subscription })
    });
    console.log('🎉 Push ativado');
  } catch (err) { console.warn('Push falhou:', err); }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) output[i] = rawData.charCodeAt(i);
  return output;
}

// ============================================================================
// ENVIO DE MENSAGENS (CORRIGIDO)
// ============================================================================
async function sendPendingMessage() {
  if (!pendingMessage) return;
  const { to, content } = pendingMessage;
  pendingMessage = null;

  const contact = contactsKeys.get(to);
  if (!contact?.aesKey) return; // Segurança extra

  const encrypted = await Crypto.encrypt(content, contact.aesKey);
  const myPubB64 = await Crypto.exportPublicKey(myKeys.publicKey);
  ws.send(JSON.stringify({ type: 'message', to, content: encrypted, senderPub: myPubB64 }));
  
  addMessage('Você', content, 'sent');
  await LocalDB.save({ id: Date.now() + '_s', from: myId, to, content, timestamp: Date.now() });
  const input = document.getElementById('message-input');
  if(input) input.value = '';
}

async function sendMessage() {
  console.log('🔍 Tentando enviar...');
  const toInput = document.getElementById('target-user');
  const contentInput = document.getElementById('message-input');
  
  const to = toInput ? toInput.value.trim().toLowerCase().replace(/\s+/g, '_') : '';
  const content = contentInput ? contentInput.value.trim() : '';
  
  if (!to || !content) return alert('Preencha destinatário e mensagem!');
  if (!ws || ws.readyState !== WebSocket.OPEN) return alert('Sem conexão.');

  // 🔧 CORREÇÃO PRINCIPAL: Verificar contact.aesKey, não apenas contactsKeys.has()
  const contact = contactsKeys.get(to);
  if (!contact || !contact.aesKey) {
    pendingMessage = { to, content };
    console.log('🔑 aesKey ausente para', to, '- solicitando chave...');
    ws.send(JSON.stringify({ type: 'request_key', to }));

    const btn = document.getElementById('send-btn');
    if(btn) {
        btn.textContent = '⏳ Aguardando...';
        btn.disabled = true;
        setTimeout(() => { if(btn) { btn.textContent = 'Enviar'; btn.disabled = false; } }, 3000);
    }
    return;
  }

  console.log('🔐 Criptografando...');
  const encrypted = await Crypto.encrypt(content, contact.aesKey);
  const myPubB64 = await Crypto.exportPublicKey(myKeys.publicKey);

  ws.send(JSON.stringify({ type: 'message', to, content: encrypted, senderPub: myPubB64 }));
  
  addMessage('Você', content, 'sent');
  await LocalDB.save({ id: Date.now() + '_s', from: myId, to, content, timestamp: Date.now() });
  if(contentInput) contentInput.value = '';
}

// ============================================================================
// UI HELPERS
// ============================================================================
function addMessage(from, text, type) {
  const log = document.getElementById('chat-log');
  if (!log) return;
  const div = document.createElement('div');
  div.className = `msg ${type}`;
  div.innerHTML = `<div class="meta">${type === 'sent' ? '→' : '←'} ${from} • ${new Date().toLocaleTimeString()}</div>${text}`;
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

init();
