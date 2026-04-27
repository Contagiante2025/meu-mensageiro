import { Crypto } from '/crypto.js';
import { LocalDB } from '/localdb.js';

let ws = null;
let myId = null;
let myKeys = null;
let contactsKeys = new Map();
let pendingMessage = null;

// ============================================================================
// INICIALIZAÇÃO
// ============================================================================
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
    } else {
      myKeys = await Crypto.generateKeys();
      localStorage.setItem('msg_keys', JSON.stringify({
        publicKey: await Crypto.exportPublicKey(myKeys.publicKey),
        privateKey: await Crypto.exportPrivateKey(myKeys.privateKey)
      }));
    }

    const storedContacts = localStorage.getItem('msg_contacts');
    if (storedContacts) {
      const parsed = JSON.parse(storedContacts);
      for (const [userId, pubB64] of Object.entries(parsed)) {
        contactsKeys.set(userId, {
          publicKey: await Crypto.importPublicKey(pubB64),
          aesKey: null
        });
      }
    }

    document.getElementById('loading').style.display = 'none';
  } catch (error) {
    console.error('Erro init:', error);
  }
}

// ============================================================================
// CONEXÃO WEBSOCKET
// ============================================================================
async function connect() {
  const name = document.getElementById('username').value.trim().toLowerCase().replace(/\s+/g, '_');
  if (!name) return alert('Digite um nome!');
  if (!myKeys?.publicKey) return alert('Erro nas chaves. Recarregue.');

  myId = name;
  const BACKEND_URL = 'wss://msg-backend-d6zc.onrender.com'; // ⚠️ SUA URL
  
  ws = new WebSocket(BACKEND_URL);

  ws.onopen = async () => {
    const pubB64 = await Crypto.exportPublicKey(myKeys.publicKey);
    ws.send(JSON.stringify({ type: 'register', userId: myId, publicKey: pubB64 }));

    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('chat-screen').classList.remove('hidden');
    loadHistory();

    // 🔔 Tentar ativar Push automaticamente se o usuário já permitiu antes
    if (Notification.permission === 'granted') {
      registerPush();
    }
  };

  ws.onmessage = async (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'exchange_key') {
        const theirPub = await Crypto.importPublicKey(data.publicKey);
        const aesKey = await Crypto.deriveAESKey(theirPub, myKeys.privateKey);
        contactsKeys.set(data.from, { publicKey: theirPub, aesKey });
        saveContactsKeys();
        if (pendingMessage && pendingMessage.to === data.from) await sendPendingMessage();
        return;
      }
      if (data.type === 'request_key') {
        ws.send(JSON.stringify({ type: 'exchange_key', to: data.from, publicKey: await Crypto.exportPublicKey(myKeys.publicKey) }));
        return;
      }
      if (data.type === 'message') {
        if (!contactsKeys.has(data.from)) {
          const theirPub = await Crypto.importPublicKey(data.senderPub);
          contactsKeys.set(data.from, { publicKey: theirPub, aesKey: await Crypto.deriveAESKey(theirPub, myKeys.privateKey) });
        }
        const decrypted = await Crypto.decrypt(data.content, contactsKeys.get(data.from).aesKey);
        if (decrypted) {
          addMessage(data.from, decrypted, 'received');
          await LocalDB.save({ id: Date.now() + '_r', from: data.from, to: myId, content: decrypted, timestamp: data.timestamp });
        }
      }
      if (data.type === 'error') alert('⚠️ ' + data.content);
    } catch (err) { console.error('Erro msg:', err); }
  };

  ws.onclose = () => alert('Conexão encerrada.');
}

// ============================================================================
// 🔔 LÓGICA DE NOTIFICAÇÕES PUSH
// ============================================================================
async function registerPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in navigator)) return;

  try {
    const reg = await navigator.serviceWorker.ready;
    
    // Pega a chave pública do backend
    const res = await fetch('/api/vapid-public-key'); // Cloudflare Pages roteia para o backend? Não.
    // ⚠️ CORREÇÃO: O Frontend está no Cloudflare, o Backend no Render.
    // Precisamos pedir a chave para o backend WebSocket ou criar uma rota pública.
    // Vamos fazer via HTTP para o backend Render.
    const backendHttpUrl = 'https://msg-backend-d6zc.onrender.com'; 
    
    const keyRes = await fetch(`${backendHttpUrl}/api/vapid-public-key`);
    const { publicKey } = await keyRes.json();

    const applicationServerKey = urlBase64ToUint8Array(publicKey);
    
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey
    });

    // Envia a assinatura para o backend guardar
    await fetch(`${backendHttpUrl}/api/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: myId, subscription })
    });

    console.log('🔔 Push ativado!');
  } catch (err) {
    console.warn('Falha ao ativar push:', err);
  }
}

// Função auxiliar para converter chave
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

  const encrypted = await Crypto.encrypt(content, contactsKeys.get(to).aesKey);
  ws.send(JSON.stringify({ type: 'message', to, content: encrypted, senderPub: await Crypto.exportPublicKey(myKeys.publicKey) }));
  addMessage('Você', content, 'sent');
  await LocalDB.save({ id: Date.now() + '_s', from: myId, to, content, timestamp: Date.now() });
  document.getElementById('message-input').value = '';
}

async function sendMessage() {
  const to = document.getElementById('target-user').value.trim().toLowerCase().replace(/\s+/g, '_');
  const content = document.getElementById('message-input').value.trim();
  if (!to || !content) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return alert('Sem conexão.');

  if (!contactsKeys.has(to)) {
    pendingMessage = { to, content };
    ws.send(JSON.stringify({ type: 'request_key', to }));
    const btn = document.getElementById('send-btn');
    btn.textContent = '⏳ Aguardando...'; btn.disabled = true;
    setTimeout(() => { btn.textContent = 'Enviar'; btn.disabled = false; }, 3000);
    return;
  }

  const encrypted = await Crypto.encrypt(content, contactsKeys.get(to).aesKey);
  ws.send(JSON.stringify({ type: 'message', to, content: encrypted, senderPub: await Crypto.exportPublicKey(myKeys.publicKey) }));
  addMessage('Você', content, 'sent');
  await LocalDB.save({ id: Date.now() + '_s', from: myId, to, content, timestamp: Date.now() });
  document.getElementById('message-input').value = '';
}

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

// Event Listeners
document.getElementById('connect-btn').onclick = connect;
document.getElementById('send-btn').onclick = sendMessage;
document.getElementById('message-input').onkeydown = e => { if (e.key === 'Enter') sendMessage(); };
document.getElementById('clear-btn').onclick = async () => {
  if (confirm('Apagar histórico?')) { await LocalDB.clear(); document.getElementById('chat-log').innerHTML = ''; }
};

// Botão de ativar Push manual
document.getElementById('enable-push-btn').onclick = async () => {
  const result = await Notification.requestPermission();
  if (result === 'granted') {
    registerPush();
    alert('🔔 Notificações ativadas! Feche o app e teste.');
  }
};

init();
