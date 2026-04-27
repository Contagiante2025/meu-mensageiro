// Aguarda libsodium carregar completamente
export const Crypto = {
  ready: async () => {
    // Verifica se window.sodium existe
    if (!window.sodium) {
      console.error('❌ libsodium não carregou! Verifique sua conexão.');
      throw new Error('libsodium not loaded');
    }

    // Aguarda inicialização da WebAssembly
    try {
      await window.sodium.ready;
      console.log('✅ libsodium pronto');
      return true;
    } catch (e) {
      console.error('❌ Erro ao inicializar libsodium:', e);
      throw e;
    }
  },

  generateKeys() {
    if (!window.sodium) throw new Error('libsodium não carregado');
    return window.sodium.crypto_box_keypair();
  },

  toBase64(arr) {
    return btoa(String.fromCharCode(...arr));
  },

  fromBase64(str) {
    return Uint8Array.from(atob(str), c => c.charCodeAt(0));
  },

  encrypt(plaintext, recipientPub, mySecret) {
    const msg = new TextEncoder().encode(plaintext);
    const nonce = window.sodium.randombytes_buf(window.sodium.crypto_box_NONCEBYTES);
    const cipher = window.sodium.crypto_box_easy(msg, nonce, recipientPub, mySecret);
    return this.toBase64(new Uint8Array([...nonce, ...cipher]));
  },

  decrypt(cipherBase64, senderPub, mySecret) {
    const raw = this.fromBase64(cipherBase64);
    const nonce = raw.slice(0, window.sodium.crypto_box_NONCEBYTES);
    const cipher = raw.slice(window.sodium.crypto_box_NONCEBYTES);
    try {
      const plain = window.sodium.crypto_box_open_easy(cipher, nonce, senderPub, mySecret);
      return new TextDecoder().decode(plain);
    } catch (e) {
      console.warn("Falha na descriptografia:", e.message);
      return null;
    }
  }
};
