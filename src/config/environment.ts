/**
 * ==============================================================================
 * CONFIGURAÇÃO DE AMBIENTE DA APLICAÇÃO
 * ==============================================================================
 * Este módulo isola e padroniza a resolução de variáveis de ambiente do Vite,
 * garantindo separação clara entre o ambiente de desenvolvimento/testes e
 * a preparação para ambientes de produção.
 */

export type AppEnvironment = 'development' | 'production' | 'test';

export interface FirebaseEnvironmentConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

const getEnvVar = (key: string): string | undefined => {
  if (typeof import.meta !== 'undefined' && (import.meta as unknown as { env?: Record<string, string> }).env) {
    return (import.meta as unknown as { env: Record<string, string> }).env[key];
  }
  if (typeof process !== 'undefined' && process.env) {
    return process.env[key];
  }
  return undefined;
};

const isDevEnv = (): boolean => {
  if (typeof import.meta !== 'undefined' && (import.meta as unknown as { env?: { DEV?: boolean } }).env) {
    return !!(import.meta as unknown as { env: { DEV?: boolean } }).env.DEV;
  }
  return process.env.NODE_ENV !== 'production';
};

/**
 * Identificador do ambiente atual da aplicação.
 * Em desenvolvimento, padrão é 'development'.
 */
export const APP_ENV: AppEnvironment =
  (getEnvVar('VITE_APP_ENV') as AppEnvironment) ||
  (isDevEnv() ? 'development' : 'production');

export const isDevelopment = APP_ENV === 'development';
export const isProduction = APP_ENV === 'production';
export const isTest = APP_ENV === 'test';

/**
 * ==============================================================================
 * CONFIGURAÇÃO OFICIAL DO FIREBASE (DEV / TESTES)
 * Projeto: teste-beta-fin-e-list
 * ==============================================================================
 * Mantido como ambiente padrão de desenvolvimento e testes.
 * Em produção, as variáveis VITE_FIREBASE_* têm precedência, evitando
 * qualquer vinculação estática ou criação acidental de novo projeto.
 */
export const DEV_FIREBASE_CONFIG: FirebaseEnvironmentConfig = {
  apiKey: 'AIzaSyCtekht1J4c3P1TMEtS8zsQubKb25c4J5w',
  authDomain: 'teste-beta-fin-e-list.firebaseapp.com',
  projectId: 'teste-beta-fin-e-list',
  storageBucket: 'teste-beta-fin-e-list.firebasestorage.app',
  messagingSenderId: '547954093283',
  appId: '1:547954093283:web:2e8910869f6b0d7eb169d6',
};

/**
 * Resolve a configuração ativa do Firebase com fallback seguro para o ambiente de testes.
 */
export function getActiveFirebaseConfig(): FirebaseEnvironmentConfig {
  const envApiKey = getEnvVar('VITE_FIREBASE_API_KEY');
  const envProjectId = getEnvVar('VITE_FIREBASE_PROJECT_ID');

  // Se variáveis de produção foram fornecidas, utiliza-as; caso contrário, utiliza o ambiente de testes atual.
  if (envApiKey && envProjectId) {
    return {
      apiKey: envApiKey,
      authDomain: getEnvVar('VITE_FIREBASE_AUTH_DOMAIN') || `${envProjectId}.firebaseapp.com`,
      projectId: envProjectId,
      storageBucket:
        getEnvVar('VITE_FIREBASE_STORAGE_BUCKET') || `${envProjectId}.firebasestorage.app`,
      messagingSenderId: getEnvVar('VITE_FIREBASE_MESSAGING_SENDER_ID') || '',
      appId: getEnvVar('VITE_FIREBASE_APP_ID') || '',
    };
  }

  return DEV_FIREBASE_CONFIG;
}
