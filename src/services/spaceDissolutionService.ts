import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { db } from './firebase';
import {
  AuthorDataDestinationDecision,
  ISO8601String,
  Space,
  SpaceDissolutionRequest,
  SpaceDissolutionRequestStatus,
} from '../types/financeV3';
import { recordSpaceAuditEvent } from './spaceAuditService';
import { notifySpaceMembers, sendSpaceNotification } from './spaceNotificationService';
import { getSpaceById, getSpaceMembers } from './spaceService';
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
 *    a solicitação é AUTOMATICAMENTE CANCELADA, os dados são 100% preservados e o espaço
 *    permanece arquivado em modo somente leitura.
 * 5. Não há exclusão física ou migração remota automática nesta fase.
 */

export const DISSOLUTION_DEADLINE_DAYS = 30;

const DEMO_DISSOLUTION_PREFIX = 'mpf_v3_demo_dissolution_';

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
  const space = await getSpaceById(spaceId, requesterUid, isDemo);
  if (!space) {
    throw new Error(`Espaço "${spaceId}" não encontrado.`);
  }

  if (space.creatorUid !== requesterUid) {
    throw new Error(
      'Violação de soberania: Somente o criador original do espaço tem autorização para iniciar a solicitação de dissolução definitiva.'
    );
  }

  // Verifica se já existe solicitação aberta
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

  // Mapeia todos os membros conhecidos para colher suas decisões individuais
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

  // Se o espaço não estava arquivado, transiciona para arquivado para garantir modo somente leitura imediato
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

  if (isDemo) {
    saveDemoDissolution(spaceId, dissolutionRequest);

    await recordSpaceAuditEvent(
      {
        spaceId,
        eventType: 'dissolution_requested',
        performedByUid: requesterUid,
        performedByName: requesterName,
        details: { deadlineDate, authorsCount: Object.keys(authorDestinations).length },
      },
      true
    );

    await notifySpaceMembers(
      space.memberUids,
      requesterUid,
      {
        spaceId,
        spaceName: space.name,
        type: 'dissolution_requested',
        title: 'Solicitação de Dissolução do Espaço',
        message: `O criador iniciou a solicitação de dissolução do espaço "${space.name}". Você tem até 30 dias (${new Date(deadlineDate).toLocaleDateString()}) para definir a destinação dos seus registros.`,
      },
      true
    );

    return dissolutionRequest;
  }

  await setDoc(doc(db, 'spaces', spaceId, 'dissolution', 'request'), dissolutionRequest);

  await recordSpaceAuditEvent(
    {
      spaceId,
      eventType: 'dissolution_requested',
      performedByUid: requesterUid,
      performedByName: requesterName,
      details: { deadlineDate, authorsCount: Object.keys(authorDestinations).length },
    },
    false
  );

  await notifySpaceMembers(
    space.memberUids,
    requesterUid,
    {
      spaceId,
      spaceName: space.name,
      type: 'dissolution_requested',
      title: 'Solicitação de Dissolução do Espaço',
      message: `O criador iniciou a solicitação de dissolução do espaço "${space.name}". Você tem até 30 dias para definir a destinação dos seus registros.`,
    },
    false
  );

  return dissolutionRequest;
}

/**
 * Consulta a solicitação de dissolução de um espaço.
 */
export async function getSpaceDissolutionRequest(
  spaceId: string,
  userId: string,
  isDemo = false
): Promise<SpaceDissolutionRequest | null> {
  await getSpaceById(spaceId, userId, isDemo);

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
    // Cancela automaticamente por estouro de prazo
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
      targetSpaceId: targetSpaceId?.trim() || undefined,
      decidedAt: now,
    },
  };

  // Verifica se todos os autores responderam (nenhum sobrou em 'pending')
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

  if (isDemo) {
    saveDemoDissolution(spaceId, updatedReq);

    await recordSpaceAuditEvent(
      {
        spaceId,
        eventType: 'author_destination_decided',
        performedByUid: authorUid,
        performedByName: authorName,
        details: { decision, allAnswered },
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
    },
    false
  );

  return updatedReq;
}

/**
 * Predicado puro: verifica se o prazo de 30 dias da solicitação expirou.
 * (Apenas leitura e computação temporal; sem efeito colateral).
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
 * Processa o timeout da solicitação de dissolução de forma rigorosamente IDEMPOTENTE.
 *
 * REGRA MANDATÓRIA (D5 / A5): Silêncio NUNCA é consentimento. Preservação integral dos dados.
 *
 * Propriedades de Idempotência:
 * - Se a solicitação já estiver cancelada por timeout ('auto_cancelled_timeout'), retorna imediatamente
 *   sem regravar o documento, sem criar eventos duplicados na trilha de auditoria e sem reenviar notificações.
 * - Se o prazo ainda não expirou ou não há pendências, retorna o estado original sem mutação.
 * - Quando o timeout é acionado pela 1ª vez:
 *     1. Persiste o status 'auto_cancelled_timeout'.
 *     2. Registra um único evento de auditoria imutável ('dissolution_cancelled').
 *     3. Dispara notificações informando o encerramento do prazo e a proteção integral dos dados.
 *     4. Mantém o espaço e todos os seus lançamentos 100% íntegros e preservados.
 */
export async function processDissolutionTimeout(
  spaceId: string,
  isDemo = false,
  now: Date = new Date()
): Promise<SpaceDissolutionRequest> {
  const req = isDemo
    ? getDemoDissolution(spaceId)
    : ((await getDoc(doc(db, 'spaces', spaceId, 'dissolution', 'request'))).data() as SpaceDissolutionRequest | null);

  if (!req) {
    throw new Error('Solicitação de dissolução não encontrada.');
  }

  // Idempotência: Se já foi cancelado por timeout, não reprocessa nada
  if (req.requestStatus === 'auto_cancelled_timeout') {
    return req;
  }

  // Se não atende aos critérios para cancelamento por timeout, retorna sem alterar
  if (!canCancelDissolutionDueToTimeout(req, now)) {
    return req;
  }

  const pendingAuthors = Object.entries(req.authorDestinations).filter(
    ([, v]) => v.decision === 'pending'
  );

  const nowIso = now.toISOString();
  const updatedReq: SpaceDissolutionRequest = {
    ...req,
    requestStatus: 'auto_cancelled_timeout',
    cancelledAt: nowIso,
    cancellationReason:
      'Cancelamento automático: decorrido o prazo improrrogável de 30 dias com decisões pendentes de autores. Silêncio não é consentimento. Dados preservados integralmente.',
  };

  if (isDemo) {
    saveDemoDissolution(spaceId, updatedReq);

    await recordSpaceAuditEvent(
      {
        spaceId,
        eventType: 'dissolution_cancelled',
        performedByUid: 'system',
        performedByName: 'Sistema (Automação de Integridade)',
        details: { reason: updatedReq.cancellationReason },
      },
      true
    );

    // Notifica os autores pendentes e o criador informando o cancelamento
    for (const [uid] of pendingAuthors) {
      await sendSpaceNotification(
        {
          userId: uid,
          spaceId,
          spaceName: 'Espaço',
          type: 'dissolution_cancelled',
          title: 'Solicitação de Dissolução Cancelada',
          message:
            'O prazo de 30 dias encerrou com decisões pendentes. A solicitação foi cancelada e seus dados continuam 100% protegidos.',
        },
        true
      );
    }

    return updatedReq;
  }

  await updateDoc(doc(db, 'spaces', spaceId, 'dissolution', 'request'), {
    requestStatus: 'auto_cancelled_timeout',
    cancelledAt: nowIso,
    cancellationReason: updatedReq.cancellationReason,
  });

  await recordSpaceAuditEvent(
    {
      spaceId,
      eventType: 'dissolution_cancelled',
      performedByUid: 'system',
      performedByName: 'Sistema (Automação de Integridade)',
      details: { reason: updatedReq.cancellationReason },
    },
    false
  );

  for (const [uid] of pendingAuthors) {
    await sendSpaceNotification(
      {
        userId: uid,
        spaceId,
        spaceName: 'Espaço',
        type: 'dissolution_cancelled',
        title: 'Solicitação de Dissolução Cancelada',
        message:
          'O prazo de 30 dias encerrou com decisões pendentes. A solicitação foi cancelada e seus dados continuam 100% protegidos.',
      },
      false
    );
  }

  return updatedReq;
}

/**
 * Avalia o prazo da solicitação e executa o processamento de timeout se aplicável.
 * Mantido para compatibilidade retrospectiva de chamadas.
 */
export async function checkAndCancelExpiredDissolution(
  spaceId: string,
  isDemo = false
): Promise<SpaceDissolutionRequest> {
  return processDissolutionTimeout(spaceId, isDemo);
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
  const space = await getSpaceById(spaceId, creatorUid, isDemo);
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

  if (isDemo) {
    saveDemoDissolution(spaceId, updatedReq);

    await recordSpaceAuditEvent(
      {
        spaceId,
        eventType: 'dissolution_cancelled',
        performedByUid: creatorUid,
        performedByName: creatorName,
        details: { cancellationReason },
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
    },
    false
  );

  return updatedReq;
}
