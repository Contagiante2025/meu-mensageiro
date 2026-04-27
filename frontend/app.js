import { Crypto } from './crypto.js';
import { LocalDB } from './localdb.js';

let ws;
let myId = null;
let myKeys = null;
let contactsKeys = new Map(); // armazena chaves públicas dos contatos

// 1. Inicialização segura
async function init() {
  await Crypto.ready();
  await LocalDB.init();

  // Carrega ou gera chaves do usuário
  const stored = localStorage.getItem('msg_keys');
  if (stored) {
    myKeys = JSON.parse(stored);
    myKeys.publicKey = Crypto.fromBase64(myKeys.publicKey);
    myKeys.secretKey = Crypto.fromBase64(myKeys.secretKey);
  } else {
    myKeys = Crypto.generateKeys();
    localStorage.setItem('msg_keys', JSON.stringify({
      publicKey: Crypto.toBase64(myKeys.publicKey),
      secretKey: Crypto.toBase64(myKeys.secretKey)
    }));
  }

  // Carrega chaves de contatos salvas
  const storedContacts = localStorage.getItem('msg_contacts');
  if (storedContacts) {
    const parsed = JSON.parse(storedContacts);
    contactsKeys = new Map(Object.entries(parsed).map(([k, v]) => [k, Crypto.fromBase64(v)]));
  }
}

// 2. Conexão WebSocket
async function connect() {
  const name = document.getElementById('username').value.trim().toLowerCase().replace(/\s+/g, '_');
  if (!name) return alert('Digite um nome!');
  myId = name;

  const BACKEND_URL = 'wss://msg-backend-d6zc.onrender.com'; // ⚠️ SUBSTITUA DEPOIS
  ws = new WebSocket(BACKEND_URL);

  ws.onopen = () => {
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
    const data = JSON.parse(e.data);
    if (data.type === 'exchange_key') {
      // Contato enviou a chave pública dele
      contactsKeys.set(data.from, Crypto.fromBase64(data.publicKey));
      saveContactsKeys();
      return;
    }
    if (data.type === 'request_key') {
      // Contato pede sua chave
      ws.send(JSON.stringify({
        type: 'exchange_key',
        to: data.from,
        publicKey: Crypto.toBase64(myKeys.publicKey)
      }));
      return;
    }
    if (data.type === 'message') {
      const decrypted = Crypto.decrypt(data.content, Crypto.fromBase64(data.senderPub), myKeys.secretKey);
      if (decrypted) {
        addMessage(data.from, decrypted, 'received');
        await LocalDB.save({ id: Date.now() + '_r', from: data.from, to: myId, content: decrypted, timestamp: data.timestamp });
      }
    }
  };

  ws.onerror = () => alert('Falha na conexão. Verifique o backend.');
  ws.onclose = () => alert('Conexão encerrada. Recarregue.');
}

// 3. Envio de Mensagem
async function sendMessage() {
  const to = document.getElementById('target-user').value.trim().toLowerCase().replace(/\s+/g, '_');
  const content = document.getElementById('message-input').value.trim();
  if (!to || !content || !ws || ws.readyState !== 1) return;

  // Se não tem a chave do contato, solicita
  if (!contactsKeys.has(to)) {
    ws.send(JSON.stringify({ type: 'request_key', to }));
    return alert(`Solicitando chave para ${to}... Tente enviar novamente em 2s.`);
  }

  const encrypted = Crypto.encrypt(content, contactsKeys.get(to), myKeys.secretKey);
  ws.send(JSON.stringify({ type: 'message', to, content: encrypted, senderPub: Crypto.toBase64(myKeys.publicKey) }));
  
  addMessage('Você', content, 'sent');
  await LocalDB.save({ id: Date.now() + '_s', from: myId, to, content, timestamp: Date.now() });
  document.getElementById('message-input').value = '';
}

// 4. Helpers de UI & DB
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
  history.forEach(m => addMessage(m.from === myId ? 'Você' : m.from, m.content, m.from === myId ? 'sent' : 'received'));
}

function saveContactsKeys() {
  const obj = {};
  contactsKeys.forEach((v, k) => obj[k] = Crypto.toBase64(v));
  localStorage.setItem('msg_contacts', JSON.stringify(obj));
}

// 5. Event Listeners
document.getElementById('connect-btn').onclick = connect;
document.getElementById('send-btn').onclick = sendMessage;
document.getElementById('message-input').onkeydown = e => e.key === 'Enter' && sendMessage();
document.getElementById('clear-btn').onclick = async () => {
  if (confirm('Apagar todo o histórico local?')) {
    await LocalDB.clear();
    document.getElementById('chat-log').innerHTML = '';
  }
};

// Inicia tudo ao carregar
init();
