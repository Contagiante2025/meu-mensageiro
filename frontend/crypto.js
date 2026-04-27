// Wrapper seguro para libsodium (carrega de forma assíncrona)
let sodiumReady = false;
const sodium = window.sodium || {};

export const Crypto = {
  // Aguarda carregamento da biblioteca
  ready: () => new Promise(resolve => {
    const check = setInterval(() => {
      if (window.sodium && window.sodium.crypto_box_keypair) {
        clearInterval(check);
        sodiumReady = true;
        resolve();
      }
    }, 50);
  }),

  // Gera par de chaves (pública + secreta) em Uint8Array
  generateKeys() {
    return window.sodium.crypto_box_keypair();
  },

  // Converte Uint8Array para base64 (para trafegar na rede)
  toBase64(arr) {
    return btoa(String.fromCharCode(...arr));
  },

  // Converte base64 para Uint8Array
  fromBase64(str) {
    return Uint8Array.from(atob(str), c => c.charCodeAt(0));
  },

  // Criptografa mensagem (plaintext string → base64 cifrado)
  encrypt(plaintext, recipientPub, mySecret) {
    const msg = new TextEncoder().encode(plaintext);
    const nonce = window.sodium.randombytes_buf(window.sodium.crypto_box_NONCEBYTES);
    const cipher = window.sodium.crypto_box_easy(msg, nonce, recipientPub, mySecret);
    return this.toBase64(new Uint8Array([...nonce, ...cipher]));
  },

  // Descriptografa mensagem (base64 cifrado → string original)
  decrypt(cipherBase64, senderPub, mySecret) {
    const raw = this.fromBase64(cipherBase64);
    const nonce = raw.slice(0, window.sodium.crypto_box_NONCEBYTES);
    const cipher = raw.slice(window.sodium.crypto_box_NONCEBYTES);
    try {
      const plain = window.sodium.crypto_box_open_easy(cipher, nonce, senderPub, mySecret);
      return new TextDecoder().decode(plain);
    } catch (e) {
      console.warn("Falha na descriptografia. Chave inválida ou mensagem corrompida.");
      return null;
    }
  }
};
