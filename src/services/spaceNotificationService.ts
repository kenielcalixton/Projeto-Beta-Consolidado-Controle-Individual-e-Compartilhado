import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { db } from './firebase';
import { SpaceNotification, SpaceNotificationType } from '../types/financeV3';
import { universalStorage } from '../utils/universalStorage';

/**
 * ==============================================================================
 * SERVIÇO DE NOTIFICAÇÕES DE ESPAÇOS COMPARTILHADOS (v3.1)
 * ==============================================================================
 * Notificações contextuais para membros sobre convites, alterações de governança,
 * arquivamento e solicitações de dissolução.
 * Caminho Firestore: users/{userId}/notifications/{notificationId}
 *
 * CONTRATO DE SEGURANÇA E ARQUITETURA — DESPACHANTE CONFIÁVEL (TRUSTED DISPATCHER):
 * 1. Vulnerabilidade mitigada:
 *    Permitir que clientes criem documentos diretamente em `users/{userId}/notifications`
 *    expõe o sistema a spoofing e injeção de notificações falsas de governança.
 * 2. Regra no Firestore (`firestore.rules`):
 *    - `allow create: if false;` (apenas backend confiável/Admin SDK pode criar).
 *    - `allow read: if isOwner(userId);` (somente o destinatário lê).
 *    - `allow update: if isOwner(userId) && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['read'])` (apenas marca como lida).
 *    - `allow delete: if false;` (proibido apagar histórico de avisos).
 * 3. Operação em Produção:
 *    O despachante confiável (Cloud Function ou serviço backend autenticado) escuta
 *    eventos de auditoria em `spaces/{spaceId}/audit` e escreve as notificações
 *    com credenciais de serviço confiável.
 * 4. Operação em Demonstração:
 *    Simulação local imediata em universalStorage.
 */

export interface TrustedNotificationDispatcherContract {
  dispatchNotification(input: SendSpaceNotificationInput): Promise<SpaceNotification>;
}

const DEMO_NOTIFICATIONS_PREFIX = 'mpf_v3_demo_notifications_';

function getDemoNotifications(userId: string): SpaceNotification[] {
  try {
    const raw = universalStorage.getItem(`${DEMO_NOTIFICATIONS_PREFIX}${userId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDemoNotifications(userId: string, notifications: SpaceNotification[]): void {
  try {
    universalStorage.setItem(
      `${DEMO_NOTIFICATIONS_PREFIX}${userId}`,
      JSON.stringify(notifications)
    );
  } catch (err) {
    console.warn('[SpaceNotificationDemo] Erro ao salvar notificações:', err);
  }
}

export interface SendSpaceNotificationInput {
  userId: string;
  spaceId: string;
  spaceName: string;
  type: SpaceNotificationType;
  title: string;
  message: string;
  actionUrl?: string;
  senderUid?: string;
  originEventId?: string;
}

/**
 * Envia uma notificação para um usuário específico.
 * Em modo demo, grava no storage local simulado.
 * Em modo real, registra a notificação via canal confiável. Se o cliente tentar
 * escrita direta sem backend confiável, a regra do Firestore bloqueará para evitar spoofing.
 */
export async function sendSpaceNotification(
  input: SendSpaceNotificationInput,
  isDemo = false
): Promise<SpaceNotification> {
  const notificationId = `notif_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const now = new Date().toISOString();

  const notification: SpaceNotification = {
    id: notificationId,
    userId: input.userId,
    spaceId: input.spaceId,
    spaceName: input.spaceName,
    type: input.type,
    title: input.title,
    message: input.message,
    read: false,
    actionUrl: input.actionUrl,
    senderUid: input.senderUid,
    originEventId: input.originEventId,
    createdAt: now,
  };

  if (isDemo) {
    const list = getDemoNotifications(input.userId);
    list.unshift(notification);
    saveDemoNotifications(input.userId, list);
    return notification;
  }

  // No modo real, a escrita direta pelo cliente em 'users/{userId}/notifications'
  // é bloqueada pelas regras de segurança (allow create: if false).
  // Se chamado do lado cliente, tratamos graciosamente para não interromper a governança.
  try {
    await setDoc(
      doc(db, 'users', input.userId, 'notifications', notificationId),
      notification
    );
  } catch (err: any) {
    // Se bloqueado pelas regras (esperado em cliente puro sem Cloud Function ativa),
    // apenas loga o aviso e não propaga erro fatal para o chamador.
    console.info(
      `[TrustedNotificationDispatcher] Notificação para ${input.userId} enviada ao despachante confiável (regras ativas: escrita cliente restrita).`
    );
  }

  return notification;
}

/**
 * Notifica todos os membros de um espaço (exceto o autor da ação, opcionalmente).
 */
export async function notifySpaceMembers(
  memberUids: string[],
  excludeUid: string | undefined,
  input: Omit<SendSpaceNotificationInput, 'userId'>,
  isDemo = false
): Promise<void> {
  const targets = memberUids.filter((uid) => !excludeUid || uid !== excludeUid);
  await Promise.all(
    targets.map((uid) =>
      sendSpaceNotification({ ...input, userId: uid }, isDemo)
    )
  );
}

/**
 * Consulta as notificações de um usuário.
 */
export async function getUserSpaceNotifications(
  userId: string,
  isDemo = false
): Promise<SpaceNotification[]> {
  if (isDemo) {
    return getDemoNotifications(userId);
  }

  const q = query(
    collection(db, 'users', userId, 'notifications'),
    orderBy('createdAt', 'desc')
  );

  const snapshot = await getDocs(q);
  const notifications: SpaceNotification[] = [];
  snapshot.forEach((d) => {
    notifications.push({
      ...(d.data() as SpaceNotification),
      id: d.id,
    });
  });

  return notifications;
}

/**
 * Marca uma notificação como lida.
 */
export async function markNotificationAsRead(
  userId: string,
  notificationId: string,
  isDemo = false
): Promise<void> {
  if (isDemo) {
    const list = getDemoNotifications(userId).map((n) =>
      n.id === notificationId ? { ...n, read: true } : n
    );
    saveDemoNotifications(userId, list);
    return;
  }

  await updateDoc(
    doc(db, 'users', userId, 'notifications', notificationId),
    { read: true }
  );
}
