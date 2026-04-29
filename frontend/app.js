// app.js - Mensageiro PWA Completo (E2EE + Push + Moderação Inteligente)
import { Crypto } from '/crypto.js';
import { LocalDB } from '/localdb.js';

let ws = null;
let myId = null;
let myKeys = null; // { publicKey, privateKey }
let contactsKeys = new Map(); // userId → { publicKey, aesKey }
let pendingMessage = null;

// ============================================================================
// 🛡️ CONFIGURAÇÃO DE MODERAÇÃO
// ============================================================================
const BLOCKED_WORDS = {
  // 🔴 Bloqueio rígido (não envia de jeito nenhum)
  hard: ['spam', 'golpe', 'xxx', 'palavrao_grave'],
  // 🟡 Alerta suave (pergunta confirmação)
  soft: ['burro', 'idiota', 'preconceito', 'termo_ofensivo']
};

function checkContent(text) {
  const lower = text.toLowerCase().trim();
  for (const word of BLOCKED_WORDS.hard) {
    const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (regex.test(lower)) return { action: 'block', reason: `"${word}" é um termo proibido` };
  }
  for (const word of BLOCKED_WORDS.soft) {
    const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (regex.test(lower)) return { action: 'confirm', reason: `"${word}" pode ser ofensivo` };
  }
  return { action: 'allow' };
}

function showConfirmationModal(message, onConfirm, onCancel) {
  const existing = document.getElementById('confirm-modal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'confirm-modal';
  modal.style.cssText = `position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 9999; font-family: system-ui, sans-serif;`;
  modal.innerHTML = `
    <div style="background: #1e293b; color: #e2e8f0; padding: 24px; border-radius: 16px; max-width: 400px; width: 90%; box-shadow: 0 10px 40px rgba(0,0,0,0.3); border: 1px solid #334155;">
      <h3 style="margin: 0 0 12px 0; color: #fbbf24; display: flex; align-items: center; gap: 8px;">️ Atenção</h3>
      <p style="margin: 0 0 20px 0; line-height: 1.5; color: #94a3b8;">${message}</p>
      <div style="display: flex; gap: 12px; justify-content: flex-end;">
        <button id="modal-cancel" style="padding: 10px 20px; background: #334155; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 500;">Cancelar</button>
        <button id="modal-confirm" style="padding: 10px 20px; background: #fbbf24; color: #0f172a; border: none; border-radius: 8px; cursor: pointer; font-weight: 600;">Enviar assim mesmo</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  document.getElementById('modal-cancel').onclick = () => { modal.remove(); if (onCancel) onCancel(); };
  document.getElementById('modal-confirm').onclick = () => { modal.remove(); if (onConfirm) onConfirm(); };
  modal.onclick = (e) => { if (e.target === modal) { modal.remove(); if (onCancel) onCancel(); } };
}

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
        contactsKeys.set(userId, { publicKey: await Crypto.importPublicKey(pubB64), aesKey: null });
      }
    }

    document.getElementById('loading').style.display = 'none';
    console.log('✅ App inicializado');

    // Event listeners com proteção contra null
    const btnConnect = document.getElementById('connect-btn');
    if (btnConnect) btnConnect.onclick = connect;
    const btnSend = document.getElementById('send-btn');
    if (btnSend) btnSend.onclick = sendMessage;
    const inputMsg = document.getElementById('message-input');
    if (inputMsg) inputMsg.onkeydown = e => { if (e.key === 'Enter') sendMessage(); };
    const btnClear = document.getElementById('clear-btn');
    if (btnClear) btnClear.onclick = async () => { if (confirm('Apagar histórico?')) { await LocalDB.clear(); document.getElementById('chat-log').innerHTML = ''; } };
    const btnPush = document.getElementById('enable-push-btn');
    if (btnPush) btnPush.onclick = requestPushPermission;

  } catch (error) {
    console.error('❌ Erro init:', error);
    const loading = document.getElementById('loading');
    if (loading) loading.innerHTML = `❌ Erro: ${error.message}`;
  }
}

// ============================================================================
// CONEXÃO WEBSOCKET
// ============================================================================
async function connect() {
  const nameInput = document.getElementById('username');
  const name = nameInput ? nameInput.value.trim().toLowerCase().replace(/\s+/g, '_') : '';
  if (!name) return alert('Digite um nome!');
  if (!myKeys?.publicKey) return alert('❌ Chaves inválidas.');

  myId = name;
  // ⚠️ ATUALIZE SE SUA URL DO RENDER MUDAR
  const BACKEND_URL = 'wss://msg-backend-d6zc.onrender.com';
  console.log('🔌 Conectando a:', BACKEND_URL);
  ws = new WebSocket(BACKEND_URL);

  ws.onopen = async () => {
    console.log('✅ WebSocket conectado');
    ws.send(JSON.stringify({ type: 'register', userId: myId, publicKey: await Crypto.exportPublicKey(myKeys.publicKey) }));
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
        const theirPub = await Crypto.importPublicKey(data.publicKey);
        const aesKey = await Crypto.deriveAESKey(theirPub, myKeys.privateKey);
        const existing = contactsKeys.get(data.from);
        if (existing) existing.aesKey = aesKey;
        else contactsKeys.set(data.from, { publicKey: theirPub, aesKey });
        saveContactsKeys();
        if (pendingMessage && pendingMessage.to === data.from) { console.log(' Enviando pendente...'); await sendPendingMessage(); }
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
    } catch (err) { console.error(' Erro msg:', err); }
  };

  ws.onerror = () => alert('❌ Falha na conexão.');
  ws.onclose = () => alert('🔌 Conexão encerrada.');
}

// ============================================================================
// 🔔 NOTIFICAÇÕES PUSH
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
    // ⚠️ ATUALIZE SE SUA URL HTTP DO RENDER MUDAR
    const backendHttp = 'https://msg-backend-d6zc.onrender.com';
    const res = await fetch(`${backendHttp}/api/vapid-public-key`);
    if (!res.ok) return;
    const { publicKey } = await res.json();
    const subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    await fetch(`${backendHttp}/api/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: myId, subscription }) });
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
// ENVIO DE MENSAGENS (COM FILTRO)
// ============================================================================
async function sendMessage() {
  console.log('🔍 Tentando enviar...');
  const toInput = document.getElementById('target-user');
  const contentInput = document.getElementById('message-input');
  const to = toInput ? toInput.value.trim().toLowerCase().replace(/\s+/g, '_') : '';
  const content = contentInput ? contentInput.value.trim() : '';
  
  if (!to || !content) return alert('Preencha destinatário e mensagem!');
  if (!ws || ws.readyState !== WebSocket.OPEN) return alert('Sem conexão.');

  const check = checkContent(content);
  if (check.action === 'block') {
    return alert(`❌ ${check.reason}.\nEsta mensagem não pode ser enviada.`);
  }
  if (check.action === 'confirm') {
    return new Promise((resolve) => {
      showConfirmationModal(
        `${check.reason}.<br><br>Respeito gera respeito. Deseja mesmo enviar esta mensagem?`,
        async () => { console.log('✅ Confirmado pelo usuário'); await proceedToSend(to, content, contentInput); resolve(); },
        () => { console.log('❌ Cancelado pelo usuário'); contentInput?.focus(); resolve(); }
      );
    });
  }
  await proceedToSend(to, content, contentInput);
}

async function proceedToSend(to, content, contentInput) {
  const contact = contactsKeys.get(to);
  if (!contact || !contact.aesKey) {
    pendingMessage = { to, content };
    console.log('🔑 aesKey ausente. Solicitando chave...');
    ws.send(JSON.stringify({ type: 'request_key', to }));
    const btn = document.getElementById('send-btn');
    if(btn) { btn.textContent = '⏳ Aguardando...'; btn.disabled = true; setTimeout(() => { if(btn) { btn.textContent = 'Enviar'; btn.disabled = false; } }, 3000); }
    return;
  }

  console.log('🔐 Criptografando...');
  const encrypted = await Crypto.encrypt(content, contact.aesKey);
  ws.send(JSON.stringify({ type: 'message', to, content: encrypted, senderPub: await Crypto.exportPublicKey(myKeys.publicKey) }));
  addMessage('Você', content, 'sent');
  await LocalDB.save({ id: Date.now() + '_s', from: myId, to, content, timestamp: Date.now() });
  if(contentInput) contentInput.value = '';
}

async function sendPendingMessage() {
  if (!pendingMessage) return;
  const { to, content } = pendingMessage;
  pendingMessage = null;
  const contact = contactsKeys.get(to);
  if (!contact?.aesKey) return;
  const encrypted = await Crypto.encrypt(content, contact.aesKey);
  ws.send(JSON.stringify({ type: 'message', to, content: encrypted, senderPub: await Crypto.exportPublicKey(myKeys.publicKey) }));
  addMessage('Você', content, 'sent');
  await LocalDB.save({ id: Date.now() + '_s', from: myId, to, content, timestamp: Date.now() });
  const input = document.getElementById('message-input');
  if(input) input.value = '';
}

// ============================================================================
// HELPERS DE UI & DB
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
  history.forEach(m => addMessage(m.from === myId ? 'Você' : m.from, m.content, m.from === myId ? 'sent' : 'received'));
}

async function saveContactsKeys() {
  const obj = {};
  for (const [userId, data] of contactsKeys.entries()) {
    obj[userId] = await Crypto.exportPublicKey(data.publicKey);
  }
  localStorage.setItem('msg_contacts', JSON.stringify(obj));
}

// Inicia o aplicativo
init();
