// app.js - Mensageiro PWA Estável (E2EE + Push Seguros)
import { Crypto } from '/crypto.js';
import { LocalDB } from '/localdb.js';

let ws = null;
let myId = null;
let myKeys = null; // { publicKey, privateKey }
let contactsKeys = new Map(); // userId → { publicKey, aesKey }
let pendingMessage = null; // Guarda mensagem enquanto aguarda chave

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
    console.log('✅ App inicializado com Web Crypto API');
    
    // ========================================================================
    // EVENT LISTENERS COM PROTEÇÃO (Verifica se o botão existe)
    // ========================================================================
    const btnConnect = document.getElementById('connect-btn');
    if (btnConnect) btnConnect.onclick = connect;

    const btnSend = document.getElementById('send-btn');
    if (btnSend) btnSend.onclick = sendMessage;

    const inputMsg = document.getElementById('message-input');
    if (inputMsg) inputMsg.onkeydown = e => { if (e.key === 'Enter') sendMessage(); };

    const btnClear = document.getElementById('clear-btn');
    if (btnClear) btnClear.onclick = async () => {
      if (confirm('Apagar todo o histórico local?')) {
        await LocalDB.clear();
        document.getElementById('chat-log').innerHTML = '';
        alert('✅ Histórico apagado!');
      }
    };

    // Botão de Notificações (Opcional - se existir no HTML)
    const btnPush = document.getElementById('enable-push-btn');
    if (btnPush) {
      btnPush.onclick = requestPushPermission;
    } else {
      console.log('ℹ️ Botão de Push não encontrado no HTML (Push desativado).');
    }

  } catch (error) {
    console.error('❌ Erro na inicialização:', error);
    document.getElementById('loading').innerHTML = 
      `❌ Erro: ${error.message}<br><small>Use Chrome 90+, Firefox 88+ ou Safari 15+</small>`;
  }
}

// ============================================================================
// CONEXÃO WEBSOCKET
// ============================================================================
async function connect() {
  const nameInput = document.getElementById('username');
  const name = nameInput ? nameInput.value.trim().toLowerCase().replace(/\s+/g, '_') : '';
  
  if (!name) return alert('Digite um nome!');
  if (!myKeys?.publicKey) return alert('❌ Chaves não geradas. Recarregue.');

  myId = name;
  const BACKEND_URL = 'wss://msg-backend-d6zc.onrender.com'; // ⚠️ SUA URL DO RENDER
  
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

    // Esconde login, mostra chat
    const loginScreen = document.getElementById('login-screen');
    const chatScreen = document.getElementById('chat-screen');
    if(loginScreen) loginScreen.classList.add('hidden');
    if(chatScreen) chatScreen.classList.remove('hidden');
    
    loadHistory();

    // Se o usuário já deu permissão para notificações antes, registra o Push
    if (Notification.permission === 'granted') {
      registerPush();
    }
  };

  ws.onmessage = async (e) => {
    try {
      const data = JSON.parse(e.data);

      // 🔑 Troca de chaves
      if (data.type === 'exchange_key') {
        console.log('🔑 Chave recebida de:', data.from);
        const theirPub = await Crypto.importPublicKey(data.publicKey);
        const aesKey = await Crypto.deriveAESKey(theirPub, myKeys.privateKey);
        contactsKeys.set(data.from, { publicKey: theirPub, aesKey });
        saveContactsKeys();

        // 🚀 Envio automático da mensagem pendente
        if (pendingMessage && pendingMessage.to === data.from) {
          console.log('⚡ Chave recebida! Enviando pendente...');
          await sendPendingMessage();
        }
        return;
      }

      // 📤 Pedido de chave
      if (data.type === 'request_key') {
        console.log('📤 Enviando chave para:', data.from);
        const pubB64 = await Crypto.exportPublicKey(myKeys.publicKey);
        ws.send(JSON.stringify({ type: 'exchange_key', to: data.from, publicKey: pubB64 }));
        return;
      }

      // 📨 Mensagem recebida
      if (data.type === 'message') {
        console.log('📨 Mensagem de:', data.from);
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
            id: Date.now() + '_r', from: data.from, to: myId, 
            content: decrypted, timestamp: data.timestamp 
          });
        }
      }

      if (data.type === 'error') alert('⚠️ ' + data.content);
    } catch (err) {
      console.error('❌ Erro ao processar mensagem:', err);
    }
  };

  ws.onerror = () => alert('❌ Falha na conexão. Verifique se o backend está online.');
  ws.onclose = () => alert('🔌 Conexão encerrada. Recarregue.');
}

// ============================================================================
// 🔔 NOTIFICAÇÕES PUSH (Opcional)
// ============================================================================
async function requestPushPermission() {
  if (!('Notification' in window)) return alert('Notificações não suportadas.');
  const result = await Notification.requestPermission();
  if (result === 'granted') {
    await registerPush();
  } else {
    alert('⚠️ Permissão negada.');
  }
}

async function registerPush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in navigator)) {
      console.warn('Push não suportado'); return;
    }

    const reg = await navigator.serviceWorker.ready;
    const backendHttpUrl = 'https://msg-backend-d6zc.onrender.com'; // ⚠️ SUA URL HTTP
    
    const res = await fetch(`${backendHttpUrl}/api/vapid-public-key`);
    if (!res.ok) throw new Error('Falha ao buscar chave VAPID');
    
    const { publicKey } = await res.json();
    const applicationServerKey = urlBase64ToUint8Array(publicKey);
    
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey
    });

    await fetch(`${backendHttpUrl}/api/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: myId, subscription })
    });

    console.log('🎉 Push ativado!');
    const btn = document.getElementById('enable-push-btn');
    if(btn) { btn.textContent = '✅ Ativo'; btn.disabled = true; }

  } catch (err) {
    console.error('❌ Erro no Push:', err);
    // Não alertamos o usuário aqui para não atrapalhar o chat
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// ============================================================================
// MENSAGENS E UI
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
    type: 'message', to, content: encrypted, senderPub: myPubB64
  }));

  addMessage('Você', content, 'sent');
  await LocalDB.save({ id: Date.now() + '_s', from: myId, to, content, timestamp: Date.now() });
  const input = document.getElementById('message-input');
  if(input) input.value = '';
}

async function sendMessage() {
  console.log('🔍 Tentando enviar mensagem...');
  const toInput = document.getElementById('target-user');
  const contentInput = document.getElementById('message-input');
  
  const to = toInput ? toInput.value.trim().toLowerCase().replace(/\s+/g, '_') : '';
  const content = contentInput ? contentInput.value.trim() : '';
  
  if (!to || !content) return alert('Preencha destinatário e mensagem!');
  if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error('❌ WebSocket não está aberto');
      return alert('Sem conexão. Recarregue.');
  }

  if (!contactsKeys.has(to)) {
    pendingMessage = { to, content };
    console.log('🔑 Chave não encontrada. Solicitando...');
    ws.send(JSON.stringify({ type: 'request_key', to }));

    const btn = document.getElementById('send-btn');
    if(btn) {
        btn.textContent = '⏳ Aguardando...';
        btn.disabled = true;
        setTimeout(() => { btn.textContent = 'Enviar'; btn.disabled = false; }, 3000);
    }
    return;
  }

  console.log(' Criptografando e enviando...');
  const contact = contactsKeys.get(to);
  const encrypted = await Crypto.encrypt(content, contact.aesKey);
  const myPubB64 = await Crypto.exportPublicKey(myKeys.publicKey);

  ws.send(JSON.stringify({ type: 'message', to, content: encrypted, senderPub: myPubB64 }));
  
  addMessage('Você', content, 'sent');
  await LocalDB.save({ id: Date.now() + '_s', from: myId, to, content, timestamp: Date.now() });
  if(contentInput) contentInput.value = '';
}

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

// Inicia o app
init();
