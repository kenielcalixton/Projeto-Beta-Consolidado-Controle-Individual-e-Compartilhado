/**
 * Armazenamento universal compatível com Browser (localStorage) e Node.js (em memória).
 * Garante que testes unitários e modo demonstração funcionem perfeitamente em ambos os ambientes.
 */

const memoryStore = new Map<string, string>();

export const universalStorage = {
  getItem(key: string): string | null {
    if (typeof localStorage !== 'undefined') {
      try {
        return localStorage.getItem(key);
      } catch {
        // Fallback para memória se localStorage estiver bloqueado
      }
    }
    return memoryStore.get(key) ?? null;
  },

  setItem(key: string, value: string): void {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(key, value);
      } catch {
        // Fallback para memória se localStorage estiver bloqueado
      }
    }
    memoryStore.set(key, value);
  },

  removeItem(key: string): void {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(key);
      } catch {}
    }
    memoryStore.delete(key);
  },

  clear(): void {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.clear();
      } catch {}
    }
    memoryStore.clear();
  },
};
