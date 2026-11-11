import { initializeApp, getApps, getApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, GoogleAuthProvider } from 'firebase/auth';
import {
  connectFirestoreEmulator,
  doc,
  getDocFromServer,
  getFirestore,
} from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import { connectStorageEmulator, getStorage } from 'firebase/storage';

import {
  assertRemoteFirebaseIsolation,
  getActiveFirebaseConfig,
  getFirebaseEmulatorEndpoints,
} from '../config/environment';

/**
 * ============================================================================
 * CONFIGURAÇÃO UNIFICADA DO FIREBASE E CONEXÃO AOS EMULADORES (v3.1)
 * ============================================================================
 * Em desenvolvimento e testes locais, conecta obrigatoriamente ao Firebase
 * Emulator Suite (projeto: demo-projeto-beta-v3) antes de qualquer operação,
 * com guarda contra reconexão duplicada durante HMR.
 */
export const MASTER_ADMIN_UID = 'GOgPDiSr6UP3VGR0zRcdFlgDseY2';

export const firebaseConfig = getActiveFirebaseConfig();
export const emulatorEndpoints = getFirebaseEmulatorEndpoints();

// Garantia explícita de isolamento antes de inicializar os serviços
assertRemoteFirebaseIsolation(firebaseConfig, emulatorEndpoints.enabled);

export const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);
export const functions = getFunctions(app, 'us-central1');
export const googleProvider = new GoogleAuthProvider();

// Guarda global contra reconexão duplicada durante Hot Module Replacement (HMR) ou múltiplos imports
const globalEmulatorState = globalThis as unknown as {
  __MPF_FIREBASE_EMULATORS_CONNECTED__?: boolean;
  __MPF_FIREBASE_CONNECTED_ENDPOINTS__?: {
    projectId: string;
    host: string;
    authPort: number;
    firestorePort: number;
    storagePort: number;
    functionsPort: number;
  };
};

if (emulatorEndpoints.enabled && !globalEmulatorState.__MPF_FIREBASE_EMULATORS_CONNECTED__) {
  connectAuthEmulator(
    auth,
    `http://${emulatorEndpoints.host}:${emulatorEndpoints.authPort}`,
    { disableWarnings: true }
  );
  connectFirestoreEmulator(
    db,
    emulatorEndpoints.host,
    emulatorEndpoints.firestorePort
  );
  connectStorageEmulator(
    storage,
    emulatorEndpoints.host,
    emulatorEndpoints.storagePort
  );
  connectFunctionsEmulator(
    functions,
    emulatorEndpoints.host,
    emulatorEndpoints.functionsPort
  );

  globalEmulatorState.__MPF_FIREBASE_EMULATORS_CONNECTED__ = true;
  globalEmulatorState.__MPF_FIREBASE_CONNECTED_ENDPOINTS__ = {
    projectId: firebaseConfig.projectId,
    host: emulatorEndpoints.host,
    authPort: emulatorEndpoints.authPort,
    firestorePort: emulatorEndpoints.firestorePort,
    storagePort: emulatorEndpoints.storagePort,
    functionsPort: emulatorEndpoints.functionsPort,
  };
}

/**
 * Inspeciona o estado real da conexão aos emuladores para validação em testes e diagnóstico.
 */
export function getFirebaseConnectionDiagnostics() {
  return {
    projectId: firebaseConfig.projectId,
    emulatorsEnabled: emulatorEndpoints.enabled,
    emulatorsConnected: !!globalEmulatorState.__MPF_FIREBASE_EMULATORS_CONNECTED__,
    endpoints: globalEmulatorState.__MPF_FIREBASE_CONNECTED_ENDPOINTS__ || null,
  };
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export type FirestoreCloudStatus =
  | 'checking'
  | 'connected'
  | 'api_disabled_or_offline'
  | 'permission_denied';

let currentCloudStatus: FirestoreCloudStatus = 'checking';
let currentCloudErrorDetail: string | null = null;
const statusListeners = new Set<
  (status: FirestoreCloudStatus, detail: string | null) => void
>();

export function setFirestoreCloudStatus(
  status: FirestoreCloudStatus,
  detail: string | null = null
) {
  currentCloudStatus = status;
  currentCloudErrorDetail = detail;
  statusListeners.forEach((listener) => listener(status, detail));
}

export function getFirestoreCloudStatus() {
  return {
    status: currentCloudStatus,
    detail: currentCloudErrorDetail,
  };
}

export function subscribeToFirestoreCloudStatus(
  listener: (status: FirestoreCloudStatus, detail: string | null) => void
) {
  statusListeners.add(listener);
  listener(currentCloudStatus, currentCloudErrorDetail);
  return () => {
    statusListeners.delete(listener);
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): void {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const errInfo: FirestoreErrorInfo = {
    error: rawMessage,
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };

  const lower = rawMessage.toLowerCase();
  if (
    lower.includes('the client is offline') ||
    lower.includes('cloud firestore api has not been used') ||
    lower.includes('unavailable')
  ) {
    setFirestoreCloudStatus('api_disabled_or_offline', rawMessage);
  } else if (lower.includes('permission') || lower.includes('insufficient')) {
    setFirestoreCloudStatus('permission_denied', rawMessage);
  }

  console.warn('[Firestore Notice]', JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    setFirestoreCloudStatus('connected', null);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const lower = msg.toLowerCase();
    if (
      lower.includes('the client is offline') ||
      lower.includes('cloud firestore api has not been used') ||
      lower.includes('unavailable')
    ) {
      setFirestoreCloudStatus('api_disabled_or_offline', msg);
    } else if (lower.includes('permission') || lower.includes('insufficient')) {
      // Even a permission-denied response proves the Firestore database exists and responded
      setFirestoreCloudStatus('connected', null);
    }
  }
}

// Dispara teste de conectividade apenas em ambiente de navegador (evita travar o runner de testes em Node.js)
if (typeof window !== 'undefined') {
  testConnection();
}
