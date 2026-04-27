// Criptografia usando Web Crypto API nativa (sem dependências externas)
// Algoritmo: ECDH (troca de chaves) + AES-GCM (criptografia de mensagem)

export const Crypto = {
  // Gera par de chaves ECDH (P-256)
  generateKeys: async () => {
    return await window.crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey']
    );
  },

  // Exporta chave pública para base64 (para enviar na rede)
  exportPublicKey: async (publicKey) => {
    const raw = await window.crypto.subtle.exportKey('raw', publicKey);
    return btoa(String.fromCharCode(...new Uint8Array(raw)));
  },

  // Importa chave pública de base64
  importPublicKey: async (base64) => {
    const raw = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    return await window.crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      []
    );
  },

  // Deriva chave AES a partir do segredo ECDH
  deriveAESKey: async (theirPublic, myPrivate) => {
    const shared = await window.crypto.subtle.deriveKey(
      { name: 'ECDH', public: theirPublic },
      myPrivate,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    return shared;
  },

  // Criptografa mensagem (string → base64 cifrado)
  encrypt: async (plaintext, aesKey) => {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const cipher = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      aesKey,
      encoded
    );
    // Retorna: iv (12 bytes) + ciphertext
    const result = new Uint8Array(iv.length + cipher.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(cipher), iv.length);
    return btoa(String.fromCharCode(...result));
  },

  // Descriptografa mensagem (base64 cifrado → string)
  decrypt: async (cipherBase64, aesKey) => {
    try {
      const raw = Uint8Array.from(atob(cipherBase64), c => c.charCodeAt(0));
      const iv = raw.slice(0, 12);
      const cipher = raw.slice(12);
      const plain = await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        aesKey,
        cipher
      );
      return new TextDecoder().decode(plain);
    } catch (e) {
      console.warn('Falha na descriptografia:', e.message);
      return null;
    }
  }
};
