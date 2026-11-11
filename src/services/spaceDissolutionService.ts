import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from './firebase';
import {
  AuthorDataDestinationDecision,
  ISO8601String,
  Space,
  SpaceDissolutionRequest,
  SpaceDissolutionRequestStatus,
} from '../types/financeV3';
import {
  generateDeterministicAuditEventId,
  recordSpaceAuditEvent,
} from './spaceAuditService';
import {
  notifySpaceMembers,
  reopenDemoPendingAuthorNotifications,
  sendSpaceNotification,
} from './spaceNotificationService';
import { getSpaceById, getSpaceMembers } from './spaceService';
import { sha256Hex } from '../utils/hashUtils';
import { universalStorage } from '../utils/universalStorage';

/**
 * ==============================================================================
 * SERVIÇO DE DISSOLUÇÃO E EXCLUSÃO DEFINITIVA DE ESPAÇOS (v3.1)
 * ==============================================================================
 * Regras Normativas Rígidas (Decisões Aprovadas D5, A4 e A5):
 * 1. SOMENTE o criador do espaço (creatorUid) pode iniciar uma solicitação de dissolução.
 * 2. Prazo estrito e improrrogável de 30 DIAS para manifestação individual de todos os autores.
 * 3. Cada autor decide de forma soberana o destino de seus registros autorais.
 * 4. Silêncio NUNCA é consentimento: se decorridos 30 dias houver qualquer decisão em 'pending',
 *    a solicitação é AUTOMATICAMENTE CANCELADA, os dados são 100% preservados, o espaço
 *    permanece arquivado em modo somente leitura e as notificações dos autores pendentes
 *    são reabertas de forma idempotente.
 * 5. Execução Server-Side Transacional (Problema 3):
 *    No Firestore/Emulator, `processDissolutionTimeout` executa via Cloud Function
 *    `processSpaceDissolutionTimeout` dentro de `db.runTransaction` com IDs determinísticos
 *    SHA-256 vinculados a `spaceId + initiatedAt`, garantindo que múltiplas chamadas
 *    concorrentes (`Promise.all`) resultem em uma única transição, um único evento de
 *    auditoria e uma única notificação por destinatário.
 */

export const DISSOLUTION_DEADLINE_DAYS = 30;

const DEMO_DISSOLUTION_PREFIX = 'mpf_v3_demo_dissolution_';

// Mutex assíncrono por espaço para serializar chamadas concorrentes em modo Demo
const demoTimeoutLocks = new Map<string, Promise<SpaceDissolutionRequest>>();

function getDemoDissolution(spaceId: string): SpaceDissolutionRequest | null {
  try {
    const raw = universalStorage.getItem(`${DEMO_DISSOLUTION_PREFIX}${spaceId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveDemoDissolution(spaceId: string, req: SpaceDissolutionRequest | null): void {
  try {
    if (!req) {
      universalStorage.removeItem(`${DEMO_DISSOLUTION_PREFIX}${spaceId}`);
    } else {
      universalStorage.setItem(
        `${DEMO_DISSOLUTION_PREFIX}${spaceId}`,
        JSON.stringify(req)
      );
    }
  } catch (err) {
    console.warn('[DemoStorage] Erro ao salvar dissolução:', err);
  }
}

function getDemoSpaceName(spaceId: string): string {
  try {
    const raw = universalStorage.getItem('mpf_v3_demo_spaces');
    const spaces: Space[] = raw ? JSON.parse(raw) : [];
    const found = spaces.find((s) => s.id === spaceId);
    return found?.name || 'Espaço Compartilhado';
  } catch {
    return 'Espaço Compartilhado';
  }
}

/**
 * Inicia formalmente o processo de solicitação de dissolução definitiva do espaço.
 * REGRA: Exclusiva do criador do espaço (creatorUid).
 */
export async function initiateSpaceDissolution(
  spaceId: string,
  requesterUid: string,
  requesterName: string,
  isDemo = false
): Promise<SpaceDissolutionRequest> {
  const space = await getSpaceById(spaceId, requesterUid, isDemo, false);
  if (!space) {
    throw new Error(`Espaço "${spaceId}" não encontrado.`);
  }

  if (space.creatorUid !== requesterUid) {
    throw new Error(
      'Violação de soberania: Somente o criador original do espaço tem autorização para iniciar a solicitação de dissolução definitiva.'
    );
  }

  const existing = await getSpaceDissolutionRequest(spaceId, requesterUid, isDemo);
  if (existing && existing.requestStatus === 'pending_author_responses') {
    throw new Error('Já existe um processo formal de dissolução em andamento para este espaço.');
  }

  const members = await getSpaceMembers(spaceId, requesterUid, isDemo);
  const now = new Date();
  const initiatedAt: ISO8601String = now.toISOString();
  const deadlineDate: ISO8601String = new Date(
    now.getTime() + DISSOLUTION_DEADLINE_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const authorDestinations: SpaceDissolutionRequest['authorDestinations'] = {};
  for (const m of members) {
    authorDestinations[m.uid] = {
      decision: 'pending',
    };
  }

  const dissolutionRequest: SpaceDissolutionRequest = {
    id: 'request',
    spaceId,
    initiatedByUid: requesterUid,
    initiatedAt,
    deadlineDate,
    requestStatus: 'pending_author_responses',
    totalRecordsAudit: {
      expensesCount: 0,
      paymentsCount: 0,
      listsCount: 0,
      itemsCount: 0,
      custodyTransfersCount: 0,
    },
    authorDestinations,
  };

  if (space.spaceStatus !== 'archived') {
    const updatedSpace: Space = {
      ...space,
      spaceStatus: 'archived',
      archivedAt: initiatedAt,
      archivedByUid: requesterUid,
    };
    if (isDemo) {
      const spaces = JSON.parse(universalStorage.getItem('mpf_v3_demo_spaces') || '[]') as Space[];
      const idx = spaces.findIndex((s) => s.id === spaceId);
      if (idx >= 0) {
        spaces[idx] = updatedSpace;
        universalStorage.setItem('mpf_v3_demo_spaces', JSON.stringify(spaces));
      }
    } else {
      await updateDoc(doc(db, 'spaces', spaceId), {
        spaceStatus: 'archived',
        archivedAt: initiatedAt,
        archivedByUid: requesterUid,
      });
    }
  }

  const operationKey = `dissolution_init_${spaceId}_${initiatedAt}`;
  const auditInput = {
    spaceId,
    eventType: 'dissolution_requested' as const,
    performedByUid: requesterUid,
    performedByName: requesterName,
    details: { deadlineDate, authorsCount: Object.keys(authorDestinations).length },
    operationKey,
    timestamp: initiatedAt,
  };
  const eventId = generateDeterministicAuditEventId(auditInput);

  if (isDemo) {
    saveDemoDissolution(spaceId, dissolutionRequest);

    await recordSpaceAuditEvent({ ...auditInput, eventId }, true);

    await notifySpaceMembers(
      space.memberUids,
      requesterUid,
      {
        spaceId,
        spaceName: space.name,
        type: 'dissolution_requested',
        title: 'Solicitação de Dissolução do Espaço',
        message: `O criador iniciou a solicitação de dissolução do espaço "${space.name}". Você tem até 30 dias (${new Date(deadlineDate).toLocaleDateString()}) para definir a destinação dos seus registros.`,
        senderUid: requesterUid,
        originEventId: eventId,
        governanceEventType: 'dissolution_requested',
      },
      true
    );

    return dissolutionRequest;
  }

  await setDoc(doc(db, 'spaces', spaceId, 'dissolution', 'request'), dissolutionRequest);

  await recordSpaceAuditEvent({ ...auditInput, eventId }, false);

  await notifySpaceMembers(
    space.memberUids,
    requesterUid,
    {
      spaceId,
      spaceName: space.name,
      type: 'dissolution_requested',
      title: 'Solicitação de Dissolução do Espaço',
      message: `O criador iniciou a solicitação de dissolução do espaço "${space.name}". Você tem até 30 dias para definir a destinação dos seus registros.`,
      senderUid: requesterUid,
      originEventId: eventId,
      governanceEventType: 'dissolution_requested',
    },
    false
  );

  return dissolutionRequest;
}

/**
 * Consulta a solicitação de dissolução de um espaço.
 * SEGURANÇA (Problema 1): Exige que o solicitante seja participante ATIVO (`allowHistorical = false`),
 * impedindo que ex-participantes leiam decisões individuais privadas dos autores ativos.
 */
export async function getSpaceDissolutionRequest(
  spaceId: string,
  userId: string,
  isDemo = false
): Promise<SpaceDissolutionRequest | null> {
  await getSpaceById(spaceId, userId, isDemo, false);

  if (isDemo) {
    return getDemoDissolution(spaceId);
  }

  const snap = await getDoc(doc(db, 'spaces', spaceId, 'dissolution', 'request'));
  if (!snap.exists()) return null;
  return snap.data() as SpaceDissolutionRequest;
}

/**
 * Registra a manifestação soberana de um autor sobre a destinação de seus próprios dados.
 */
export async function submitAuthorDestinationDecision(
  spaceId: string,
  authorUid: string,
  authorName: string,
  decision: AuthorDataDestinationDecision,
  targetSpaceId?: string,
  isDemo = false
): Promise<SpaceDissolutionRequest> {
  const req = await getSpaceDissolutionRequest(spaceId, authorUid, isDemo);
  if (!req) {
    throw new Error('Não há solicitação de dissolução ativa para este espaço.');
  }

  if (req.requestStatus !== 'pending_author_responses') {
    throw new Error(`A solicitação de dissolução não aceita novas respostas (status atual: ${req.requestStatus}).`);
  }

  // Verifica se o prazo de 30 dias já expirou
  if (new Date().getTime() > new Date(req.deadlineDate).getTime()) {
    return await checkAndCancelExpiredDissolution(spaceId, isDemo);
  }

  if (!req.authorDestinations[authorUid]) {
    throw new Error('Você não consta na relação de autores consultados para esta dissolução.');
  }

  const now: ISO8601String = new Date().toISOString();
  const updatedDestinations = {
    ...req.authorDestinations,
    [authorUid]: {
      decision,
      ...(targetSpaceId?.trim() ? { targetSpaceId: targetSpaceId.trim() } : {}),
      decidedAt: now,
    },
  };

  const allAnswered = Object.values(updatedDestinations).every(
    (d) => d.decision !== 'pending'
  );

  const nextStatus: SpaceDissolutionRequestStatus = allAnswered
    ? 'fully_approved_ready'
    : 'pending_author_responses';

  const updatedReq: SpaceDissolutionRequest = {
    ...req,
    authorDestinations: updatedDestinations,
    requestStatus: nextStatus,
  };

  const operationKey = `dissolution_decision_${spaceId}_${req.initiatedAt}_${authorUid}_${decision}`;

  if (isDemo) {
    saveDemoDissolution(spaceId, updatedReq);

    await recordSpaceAuditEvent(
      {
        spaceId,
        eventType: 'author_destination_decided',
        performedByUid: authorUid,
        performedByName: authorName,
        details: { decision, allAnswered },
        operationKey,
        timestamp: now,
      },
      true
    );

    return updatedReq;
  }

  await updateDoc(doc(db, 'spaces', spaceId, 'dissolution', 'request'), {
    authorDestinations: updatedDestinations,
    requestStatus: nextStatus,
  });

  await recordSpaceAuditEvent(
    {
      spaceId,
      eventType: 'author_destination_decided',
      performedByUid: authorUid,
      performedByName: authorName,
      details: { decision, allAnswered },
      operationKey,
      timestamp: now,
    },
    false
  );

  return updatedReq;
}

/**
 * Predicado puro: verifica se o prazo de 30 dias da solicitação expirou.
 */
export function isDissolutionExpired(
  req: SpaceDissolutionRequest,
  now: Date = new Date()
): boolean {
  if (req.requestStatus !== 'pending_author_responses') {
    return false;
  }
  const deadline = new Date(req.deadlineDate);
  return now.getTime() > deadline.getTime();
}

/**
 * Predicado puro: verifica se a solicitação expirou E possui respostas pendentes de autores,
 * exigindo o cancelamento automático compulsório por timeout.
 */
export function canCancelDissolutionDueToTimeout(
  req: SpaceDissolutionRequest,
  now: Date = new Date()
): boolean {
  if (!isDissolutionExpired(req, now)) {
    return false;
  }
  return Object.values(req.authorDestinations).some((v) => v.decision === 'pending');
}

/**
 * Processa o timeout da solicitação de dissolução de forma TRANSACIONAL e IDEMPOTENTE.
 *
 * REGRA MANDATÓRIA (Problema 3):
 * - No modo Firestore/Emulator (`isDemo = false`): delega a execução integralmente para
 *   a Cloud Function `processSpaceDissolutionTimeout` (que usa Admin SDK + `db.runTransaction`).
 * - No modo Demo (`isDemo = true`): serializa execuções concorrentes via lock assíncrono
 *   por espaço e utiliza IDs determinísticos SHA-256 vinculados ao ciclo `spaceId + initiatedAt`.
 * - Reabre as notificações dos autores pendentes e utiliza o nome real do espaço.
 */
export async function processDissolutionTimeout(
  spaceId: string,
  isDemo = false,
  now: Date = new Date()
): Promise<SpaceDissolutionRequest> {
  if (!spaceId || !spaceId.trim()) {
    throw new Error('O identificador do espaço (spaceId) é obrigatório.');
  }

  if (isDemo) {
    const existingLock = demoTimeoutLocks.get(spaceId);
    if (existingLock) {
      return await existingLock;
    }

    const task = (async () => {
      const req = getDemoDissolution(spaceId);
      if (!req) {
        throw new Error('Solicitação de dissolução não encontrada.');
      }

      if (req.requestStatus === 'auto_cancelled_timeout') {
        return req;
      }

      if (!canCancelDissolutionDueToTimeout(req, now)) {
        return req;
      }

      const pendingAuthors = Object.entries(req.authorDestinations)
        .filter(([, v]) => v.decision === 'pending')
        .map(([uid]) => uid);

      const realSpaceName = getDemoSpaceName(spaceId);
      const nowIso = now.toISOString();
      const cancellationReason =
        'Cancelamento automático: decorrido o prazo improrrogável de 30 dias com decisões pendentes de autores. Silêncio não é consentimento. Dados preservados integralmente.';

      const updatedReq: SpaceDissolutionRequest = {
        ...req,
        requestStatus: 'auto_cancelled_timeout',
        cancelledAt: nowIso,
        cancellationReason,
      };

      // Atualiza estado antes de disparar eventos determinísticos
      saveDemoDissolution(spaceId, updatedReq);

      const requestCycleKey = `${spaceId}|${req.initiatedAt}`;
      const deterministicAuditId = `audit_timeout_${sha256Hex(requestCycleKey).slice(0, 32)}`;

      await recordSpaceAuditEvent(
        {
          spaceId,
          eventType: 'dissolution_cancelled',
          performedByUid: 'system',
          performedByName: 'Sistema (Automação de Integridade)',
          details: {
            reason: cancellationReason,
            pendingAuthors,
            initiatedAt: req.initiatedAt,
            deadlineDate: req.deadlineDate,
          },
          eventId: deterministicAuditId,
          timestamp: nowIso,
        },
        true
      );

      // Reabre notificações pendentes e envia notificação única de cancelamento com nome real do espaço
      const recipientUids = Array.from(new Set([...pendingAuthors, req.initiatedByUid]));
      for (const uid of pendingAuthors) {
        reopenDemoPendingAuthorNotifications(
          uid,
          spaceId,
          realSpaceName,
          deterministicAuditId,
          nowIso
        );
      }

      for (const uid of recipientUids) {
        const deterministicNotifId = `notif_timeout_cancel_${sha256Hex(`${requestCycleKey}|${uid}`).slice(0, 32)}`;
        await sendSpaceNotification(
          {
            notificationId: deterministicNotifId,
            userId: uid,
            spaceId,
            spaceName: realSpaceName,
            type: 'dissolution_cancelled',
            title: 'Solicitação de Dissolução Cancelada',
            message: `O prazo de 30 dias do espaço "${realSpaceName}" encerrou com decisões pendentes. A solicitação foi cancelada e seus dados continuam 100% protegidos.`,
            originEventId: deterministicAuditId,
          },
          true
        );
      }

      return updatedReq;
    })();

    demoTimeoutLocks.set(spaceId, task);
    try {
      return await task;
    } finally {
      demoTimeoutLocks.delete(spaceId);
    }
  }

  // Modo Firestore / Emulator: execução transacional server-side via Cloud Function (Admin SDK)
  const callable = httpsCallable<
    { spaceId: string; referenceNowIso: string },
    { dissolutionRequest: SpaceDissolutionRequest }
  >(functions, 'processSpaceDissolutionTimeout');

  const response = await callable({
    spaceId,
    referenceNowIso: now.toISOString(),
  });

  return response.data.dissolutionRequest;
}

/**
 * Avalia o prazo da solicitação e executa o processamento de timeout se aplicável.
 */
export async function checkAndCancelExpiredDissolution(
  spaceId: string,
  isDemo = false,
  now: Date = new Date()
): Promise<SpaceDissolutionRequest> {
  return processDissolutionTimeout(spaceId, isDemo, now);
}

/**
 * Cancelamento voluntário da solicitação pelo criador do espaço.
 */
export async function cancelDissolutionByCreator(
  spaceId: string,
  creatorUid: string,
  creatorName: string,
  reason?: string,
  isDemo = false
): Promise<SpaceDissolutionRequest> {
  const space = await getSpaceById(spaceId, creatorUid, isDemo, false);
  if (!space) {
    throw new Error(`Espaço "${spaceId}" não encontrado.`);
  }

  if (space.creatorUid !== creatorUid) {
    throw new Error('Apenas o criador do espaço pode cancelar a solicitação de dissolução.');
  }

  const req = await getSpaceDissolutionRequest(spaceId, creatorUid, isDemo);
  if (!req || (req.requestStatus !== 'pending_author_responses' && req.requestStatus !== 'fully_approved_ready')) {
    throw new Error('Não há solicitação ativa passível de cancelamento.');
  }

  const nowIso = new Date().toISOString();
  const cancellationReason = reason?.trim() || 'Cancelado voluntariamente pelo criador do espaço.';

  const updatedReq: SpaceDissolutionRequest = {
    ...req,
    requestStatus: 'cancelled_by_creator',
    cancelledAt: nowIso,
    cancellationReason,
  };

  const operationKey = `dissolution_cancel_creator_${spaceId}_${req.initiatedAt}`;

  if (isDemo) {
    saveDemoDissolution(spaceId, updatedReq);

    await recordSpaceAuditEvent(
      {
        spaceId,
        eventType: 'dissolution_cancelled',
        performedByUid: creatorUid,
        performedByName: creatorName,
        details: { cancellationReason },
        operationKey,
        timestamp: nowIso,
      },
      true
    );

    return updatedReq;
  }

  await updateDoc(doc(db, 'spaces', spaceId, 'dissolution', 'request'), {
    requestStatus: 'cancelled_by_creator',
    cancelledAt: nowIso,
    cancellationReason,
  });

  await recordSpaceAuditEvent(
    {
      spaceId,
      eventType: 'dissolution_cancelled',
      performedByUid: creatorUid,
      performedByName: creatorName,
      details: { cancellationReason },
      operationKey,
      timestamp: nowIso,
    },
    false
  );

  return updatedReq;
}
