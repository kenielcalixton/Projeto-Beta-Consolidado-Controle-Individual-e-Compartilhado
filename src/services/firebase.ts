import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { doc, getDocFromServer, getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

/**
 * ============================================================================
 * CONFIGURAÇÃO UNIFICADA DO FIREBASE (PROJETO: teste-beta-fin-e-list)
 * ============================================================================
 */
export const MASTER_ADMIN_UID = 'GOgPDiSr6UP3VGR0zRcdFlgDseY2';

export const firebaseConfig = {
  apiKey: 'AIzaSyCtekht1J4c3P1TMEtS8zsQubKb25c4J5w',
  authDomain: 'teste-beta-fin-e-list.firebaseapp.com',
  projectId: 'teste-beta-fin-e-list',
  storageBucket: 'teste-beta-fin-e-list.firebasestorage.app',
  messagingSenderId: '547954093283',
  appId: '1:547954093283:web:2e8910869f6b0d7eb169d6',
};

export const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);
export const googleProvider = new GoogleAuthProvider();

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

testConnection();
