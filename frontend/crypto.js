// crypto.js - Web Crypto API com formato JWK para chaves privadas
// Algoritmo: ECDH (P-256) + AES-GCM

export const Crypto = {
  // Gera par de chaves ECDH
  generateKeys: async () => {
    return await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,  // exportável
      ['deriveKey']
    );
  },

  // Exporta chave pública para base64 (formato raw + base64)
  exportPublicKey: async (key) => {
    const raw = await crypto.subtle.exportKey('raw', key);
    return btoa(String.fromCharCode(...new Uint8Array(raw)));
  },

  // Importa chave pública de base64
  importPublicKey: async (base64) => {
    const raw = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    return await crypto.subtle.importKey(
      'raw', raw,
      { name: 'ECDH', namedCurve: 'P-256' },
      true, []
    );
  },

  // Exporta chave privada para JSON string (formato JWK)
  exportPrivateKey: async (key) => {
    const jwk = await crypto.subtle.exportKey('jwk', key);
    // Remove metadados sensíveis e converte para string
    const { d, ...publicData } = jwk;
    return JSON.stringify({ d, ...publicData });
  },

  // Importa chave privada de JSON string (formato JWK)
  importPrivateKey: async (jsonStr) => {
    const jwk = JSON.parse(jsonStr);
    return await crypto.subtle.importKey(
      'jwk', jwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      true, ['deriveKey']
    );
  },

  // Deriva chave AES compartilhada
  deriveAESKey: async (theirPublic, myPrivate) => {
    return await crypto.subtle.deriveKey(
      { name: 'ECDH', public: theirPublic },
      myPrivate,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  },

  // Criptografa mensagem com AES-GCM
  encrypt: async (plaintext, aesKey) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const cipher = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      encoded
    );
    const result = new Uint8Array(iv.length + cipher.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(cipher), iv.length);
    return btoa(String.fromCharCode(...result));
  },

  // Descriptografa mensagem
  decrypt: async (cipherBase64, aesKey) => {
    try {
      const raw = Uint8Array.from(atob(cipherBase64), c => c.charCodeAt(0));
      const iv = raw.slice(0, 12);
      const cipher = raw.slice(12);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        aesKey,
        cipher
      );
      return new TextDecoder().decode(plain);
    } catch (e) {
      console.warn('Descriptografia falhou:', e.message);
      return null;
    }
  }
};
