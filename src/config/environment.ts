/**
 * ==============================================================================
 * CONFIGURAÇÃO DE AMBIENTE E ISOLAMENTO DO FIREBASE EMULATOR SUITE (v3.1)
 * ==============================================================================
 * Regras Críticas de Isolamento (EXEC-FIREBASE-LOCAL-F5-01):
 * 1. Em ambiente de desenvolvimento ('development') e testes ('test'), o sistema
 *    opera EXCLUSIVAMENTE com o projeto isolado 'demo-projeto-beta-v3' conectado
 *    ao Firebase Emulator Suite local (127.0.0.1).
 * 2. É estritamente proibido conectar silenciosamente ao projeto remoto
 *    'teste-beta-fin-e-list' durante desenvolvimento ou execução de testes.
 * 3. Caso uma configuração local ou de produção seja inválida/incompleta ou tente
 *    apontar para projeto remoto enquanto em modo de teste/emulador, o sistema
 *    falha de maneira segura (fail-closed) lançando erro explícito.
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

export interface FirebaseEmulatorEndpoints {
  enabled: boolean;
  host: string;
  authPort: number;
  firestorePort: number;
  storagePort: number;
  functionsPort: number;
  uiPort: number;
}

const getEnvVar = (key: string): string | undefined => {
  if (
    typeof import.meta !== 'undefined' &&
    (import.meta as unknown as { env?: Record<string, string> }).env
  ) {
    const val = (import.meta as unknown as { env: Record<string, string> }).env[key];
    if (val !== undefined) return val;
  }
  if (typeof process !== 'undefined' && process.env) {
    return process.env[key];
  }
  return undefined;
};

const isDevRuntime = (): boolean => {
  if (
    typeof import.meta !== 'undefined' &&
    (import.meta as unknown as { env?: { DEV?: boolean } }).env
  ) {
    return !!(import.meta as unknown as { env: { DEV?: boolean } }).env.DEV;
  }
  return typeof process !== 'undefined' ? process.env.NODE_ENV !== 'production' : true;
};

/**
 * Identificador do projeto local de demonstração/emulador (prefixo 'demo-' garante
 * no SDK do Firebase e na CLI que nenhuma chamada alcance o Google Cloud real).
 */
export const LOCAL_EMULATOR_PROJECT_ID = 'demo-projeto-beta-v3';

/**
 * Identificador do projeto remoto preservado (bloqueado em ambiente de teste/emulador).
 */
export const PROTECTED_REMOTE_PROJECT_ID = 'teste-beta-fin-e-list';

export function resolveAppEnvironment(): AppEnvironment {
  const explicitEnv = getEnvVar('VITE_APP_ENV') || getEnvVar('NODE_ENV');
  if (explicitEnv === 'production') return 'production';
  if (explicitEnv === 'test') return 'test';
  return isDevRuntime() ? 'development' : 'production';
}

export const APP_ENV: AppEnvironment = resolveAppEnvironment();
export const isDevelopment = APP_ENV === 'development';
export const isProduction = APP_ENV === 'production';
export const isTest = APP_ENV === 'test';

/**
 * Configuração canônica para execução 100% local no Firebase Emulator Suite.
 * Não contém segredos nem credenciais administrativas.
 */
export const LOCAL_EMULATOR_FIREBASE_CONFIG: FirebaseEnvironmentConfig = {
  apiKey: 'demo-local-emulator-api-key',
  authDomain: `${LOCAL_EMULATOR_PROJECT_ID}.firebaseapp.com`,
  projectId: LOCAL_EMULATOR_PROJECT_ID,
  storageBucket: `${LOCAL_EMULATOR_PROJECT_ID}.appspot.com`,
  messagingSenderId: '000000000000',
  appId: '1:000000000000:web:demo000000000000',
};

/**
 * Referência histórica preservada do projeto remoto (NÃO utilizada como fallback
 * automático em desenvolvimento ou testes para evitar contaminação de dados remotos).
 */
export const REMOTE_REFERENCE_FIREBASE_CONFIG: FirebaseEnvironmentConfig = {
  apiKey: 'AIzaSyCtekht1J4c3P1TMEtS8zsQubKb25c4J5w',
  authDomain: 'teste-beta-fin-e-list.firebaseapp.com',
  projectId: PROTECTED_REMOTE_PROJECT_ID,
  storageBucket: 'teste-beta-fin-e-list.firebasestorage.app',
  messagingSenderId: '547954093283',
  appId: '1:547954093283:web:2e8910869f6b0d7eb169d6',
};

/**
 * Mantido como alias para compatibilidade de importações existentes, apontando
 * com segurança para a configuração local de desenvolvimento no Emulator.
 */
export const DEV_FIREBASE_CONFIG: FirebaseEnvironmentConfig = LOCAL_EMULATOR_FIREBASE_CONFIG;

/**
 * Determina se o uso dos emuladores locais está ativo.
 * Em 'development' e 'test', o emulador é OBRIGATÓRIO por padrão, a menos que
 * explicitamente configurado em modo 'production' com credenciais completas.
 */
export function shouldUseFirebaseEmulators(): boolean {
  const currentEnv = resolveAppEnvironment();
  const explicitFlag = getEnvVar('VITE_USE_FIREBASE_EMULATOR');

  if (currentEnv === 'test') {
    if (explicitFlag === 'false') {
      throw new Error(
        '[Security Isolation Error] É proibido desativar o Firebase Emulator quando APP_ENV=test. O projeto remoto deve permanecer isolado.'
      );
    }
    return true;
  }

  if (currentEnv === 'development') {
    // Em desenvolvimento local, padrão é sempre usar os emuladores locais (true)
    if (explicitFlag === 'false') {
      throw new Error(
        '[Security Isolation Error] Conexão ao Firebase remoto bloqueada em ambiente de desenvolvimento local. Utilize o Firebase Emulator Suite (demo-projeto-beta-v3).'
      );
    }
    return true;
  }

  return explicitFlag === 'true';
}

/**
 * Retorna a configuração de endpoints dos emuladores locais.
 */
export function getFirebaseEmulatorEndpoints(): FirebaseEmulatorEndpoints {
  const host = getEnvVar('VITE_FIREBASE_EMULATOR_HOST') || '127.0.0.1';
  const authPort = Number(getEnvVar('VITE_FIREBASE_AUTH_EMULATOR_PORT') || 9099);
  const firestorePort = Number(getEnvVar('VITE_FIREBASE_FIRESTORE_EMULATOR_PORT') || 8080);
  const storagePort = Number(getEnvVar('VITE_FIREBASE_STORAGE_EMULATOR_PORT') || 9199);
  const functionsPort = Number(getEnvVar('VITE_FIREBASE_FUNCTIONS_EMULATOR_PORT') || 5001);
  const uiPort = Number(getEnvVar('VITE_FIREBASE_UI_EMULATOR_PORT') || 4000);

  return {
    enabled: shouldUseFirebaseEmulators(),
    host,
    authPort,
    firestorePort,
    storagePort,
    functionsPort,
    uiPort,
  };
}

/**
 * Valida que a configuração resolvida não viola o isolamento do Firebase remoto.
 */
export function assertRemoteFirebaseIsolation(
  config: FirebaseEnvironmentConfig,
  useEmulators: boolean
): void {
  const currentEnv = resolveAppEnvironment();

  if (currentEnv === 'test' || currentEnv === 'development' || useEmulators) {
    if (config.projectId === PROTECTED_REMOTE_PROJECT_ID) {
      throw new Error(
        `[Security Isolation Error] Tentativa bloqueada de usar o projeto remoto "${PROTECTED_REMOTE_PROJECT_ID}" em ambiente "${currentEnv}". Utilize exclusivamente "${LOCAL_EMULATOR_PROJECT_ID}".`
      );
    }
    if (!config.projectId.startsWith('demo-')) {
      throw new Error(
        `[Security Isolation Error] Em modo local/emulador (${currentEnv}), o projectId deve iniciar obrigatoriamente com "demo-" (recebido: "${config.projectId}").`
      );
    }
  }
}

/**
 * Resolve a configuração ativa do Firebase com proteção estrita (fail-closed).
 * - Em 'development' e 'test': usa obrigatoriamente `demo-projeto-beta-v3` (nunca faz fallback silencioso para o projeto remoto).
 * - Em 'production': exige variáveis explícitas `VITE_FIREBASE_API_KEY` e `VITE_FIREBASE_PROJECT_ID` e falha de forma segura caso ausentes.
 */
export function getActiveFirebaseConfig(): FirebaseEnvironmentConfig {
  const currentEnv = resolveAppEnvironment();
  const useEmulators = shouldUseFirebaseEmulators();
  const envApiKey = getEnvVar('VITE_FIREBASE_API_KEY');
  const envProjectId = getEnvVar('VITE_FIREBASE_PROJECT_ID');

  if (useEmulators || currentEnv === 'development' || currentEnv === 'test') {
    const resolvedProjectId = envProjectId || LOCAL_EMULATOR_PROJECT_ID;
    const config: FirebaseEnvironmentConfig = {
      apiKey: envApiKey || LOCAL_EMULATOR_FIREBASE_CONFIG.apiKey,
      authDomain:
        getEnvVar('VITE_FIREBASE_AUTH_DOMAIN') || `${resolvedProjectId}.firebaseapp.com`,
      projectId: resolvedProjectId,
      storageBucket:
        getEnvVar('VITE_FIREBASE_STORAGE_BUCKET') || `${resolvedProjectId}.appspot.com`,
      messagingSenderId:
        getEnvVar('VITE_FIREBASE_MESSAGING_SENDER_ID') ||
        LOCAL_EMULATOR_FIREBASE_CONFIG.messagingSenderId,
      appId: getEnvVar('VITE_FIREBASE_APP_ID') || LOCAL_EMULATOR_FIREBASE_CONFIG.appId,
    };

    assertRemoteFirebaseIsolation(config, true);
    return config;
  }

  // Ambiente de produção: falha segura (fail-closed) se a configuração estiver incompleta
  if (!envApiKey || !envProjectId) {
    throw new Error(
      '[Firebase Configuration Error] Configuração de produção incompleta: VITE_FIREBASE_API_KEY e VITE_FIREBASE_PROJECT_ID são obrigatórios. Fallback silencioso para projeto remoto desativado.'
    );
  }

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
