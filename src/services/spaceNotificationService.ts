import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  updateDoc,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from './firebase';
import {
  SpaceAuditEventType,
  SpaceNotification,
  SpaceNotificationType,
} from '../types/financeV3';
import { sha256Hex } from '../utils/hashUtils';
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
 *    Clientes nunca escrevem diretamente em `users/{userId}/notifications` (`allow create: if false`).
 * 2. Backend Server-Side Real:
 *    Notificações oficiais de governança são criadas pelo backend (Cloud Functions + Admin SDK)
 *    vinculadas a uma operação/evento oficial validado (`originEventId`), com identificadores
 *    determinísticos SHA-256 para evitar duplicidade.
 * 3. Reabertura Idempotente:
 *    Suporta reabertura de notificações pendentes (`reopenPendingAuthorNotifications`) quando
 *    uma solicitação de dissolução expira por timeout de 30 dias.
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
  notificationId?: string;
  governanceEventType?: SpaceAuditEventType;
}

/**
 * Gera um identificador determinístico SHA-256 para uma notificação, vinculando
 * o evento de origem (`originEventId`), o espaço, o destinatário (`userId`) e o tipo.
 */
export function generateDeterministicNotificationId(
  input: SendSpaceNotificationInput
): string {
  if (input.notificationId && input.notificationId.trim()) {
    return input.notificationId.trim();
  }
  const canonicalOrigin =
    input.originEventId ||
    `${input.spaceId}|${input.type}|${input.senderUid || 'system'}|${input.title}`;
  const digest = sha256Hex(`${canonicalOrigin}|${input.userId}|${input.type}`).slice(0, 32);
  return `notif_${digest}`;
}

const NOTIFICATION_TO_AUDIT_EVENT_MAP: Record<SpaceNotificationType, SpaceAuditEventType> = {
  invite_received: 'invite_created',
  invite_accepted: 'invite_accepted',
  invite_rejected: 'invite_rejected',
  member_removed: 'member_removed',
  member_exited: 'member_voluntary_exit',
  space_archived: 'space_archived',
  space_unarchived: 'space_unarchived',
  dissolution_requested: 'dissolution_requested',
  dissolution_decision_pending: 'dissolution_requested',
  dissolution_cancelled: 'dissolution_cancelled',
};

/**
 * Envia uma notificação oficial para um usuário específico de maneira idempotente.
 * - Em modo demo: persiste em `universalStorage` deduplicando pelo ID determinístico.
 * - Em modo real/emulador: despacha via Cloud Function `recordOfficialSpaceGovernanceEvent` (Admin SDK).
 */
export async function sendSpaceNotification(
  input: SendSpaceNotificationInput,
  isDemo = false
): Promise<SpaceNotification> {
  if (!input.userId?.trim()) {
    throw new Error('Destinatário da notificação (userId) é obrigatório.');
  }
  if (!input.spaceId?.trim()) {
    throw new Error('Identificador do espaço (spaceId) é obrigatório.');
  }

  const notificationId = generateDeterministicNotificationId(input);
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
    const existingIndex = list.findIndex((n) => n.id === notificationId);
    if (existingIndex >= 0) {
      return list[existingIndex];
    }
    list.unshift(notification);
    saveDemoNotifications(input.userId, list);
    return notification;
  }

  const eventType =
    input.governanceEventType || NOTIFICATION_TO_AUDIT_EVENT_MAP[input.type] || 'space_created';
  const callerUid = input.senderUid || input.userId;

  const callable = httpsCallable<
    Record<string, unknown>,
    { notifications: SpaceNotification[] }
  >(functions, 'recordOfficialSpaceGovernanceEvent');

  const response = await callable({
    spaceId: input.spaceId,
    eventType,
    performedByUid: callerUid,
    performedByName: 'Participante Autorizado',
    eventId: input.originEventId,
    operationKey: input.originEventId || notificationId,
    notifications: [
      {
        notificationId,
        userId: input.userId,
        spaceName: input.spaceName,
        type: input.type,
        title: input.title,
        message: input.message,
        actionUrl: input.actionUrl,
      },
    ],
  });

  return response.data.notifications?.[0] || notification;
}

/**
 * Notifica todos os membros de um espaço (exceto o autor da ação, opcionalmente)
 * usando identificadores determinísticos por destinatário.
 */
export async function notifySpaceMembers(
  memberUids: string[],
  excludeUid: string | undefined,
  input: Omit<SendSpaceNotificationInput, 'userId'>,
  isDemo = false
): Promise<void> {
  const targets = Array.from(new Set(memberUids)).filter(
    (uid) => !excludeUid || uid !== excludeUid
  );
  await Promise.all(
    targets.map((uid) =>
      sendSpaceNotification(
        {
          ...input,
          userId: uid,
          senderUid: input.senderUid || excludeUid,
        },
        isDemo
      )
    )
  );
}

/**
 * Reabre de maneira idempotente as notificações de dissolução pendente para um autor
 * cuja decisão permaneceu em 'pending' ao fim do prazo de 30 dias (modo Demo).
 * No modo Firestore/Emulator, essa reabertura ocorre dentro da transação server-side
 * `processSpaceDissolutionTimeout`.
 */
export function reopenDemoPendingAuthorNotifications(
  userId: string,
  spaceId: string,
  realSpaceName: string,
  originEventId: string,
  nowIso: string
): void {
  const list = getDemoNotifications(userId);
  let reopenedAny = false;

  const updated = list.map((n) => {
    if (
      n.spaceId === spaceId &&
      (n.type === 'dissolution_requested' || n.type === 'dissolution_decision_pending')
    ) {
      reopenedAny = true;
      return {
        ...n,
        read: false,
        spaceName: realSpaceName,
      };
    }
    return n;
  });

  const deterministicReopenId = generateDeterministicNotificationId({
    notificationId: `notif_reopen_${sha256Hex(`${originEventId}|${userId}|reopen`).slice(0, 24)}`,
    userId,
    spaceId,
    spaceName: realSpaceName,
    type: 'dissolution_decision_pending',
    title: 'Decisão Pendente Reaberta (Prazo Expirado)',
    message: `O prazo de 30 dias da dissolução do espaço "${realSpaceName}" expirou enquanto sua decisão estava pendente. Seus dados foram preservados.`,
    originEventId,
  });

  if (!reopenedAny && !updated.some((n) => n.id === deterministicReopenId)) {
    updated.unshift({
      id: deterministicReopenId,
      userId,
      spaceId,
      spaceName: realSpaceName,
      type: 'dissolution_decision_pending',
      title: 'Decisão Pendente Reaberta (Prazo Expirado)',
      message: `O prazo de 30 dias da dissolução do espaço "${realSpaceName}" expirou enquanto sua decisão estava pendente. Seus dados foram preservados.`,
      read: false,
      originEventId,
      createdAt: nowIso,
    });
  }

  saveDemoNotifications(userId, updated);
}

/**
 * Consulta as notificações de um usuário.
 */
export async function getUserSpaceNotifications(
  userId: string,
  isDemo = false
): Promise<SpaceNotification[]> {
  if (!userId || !userId.trim()) return [];

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
