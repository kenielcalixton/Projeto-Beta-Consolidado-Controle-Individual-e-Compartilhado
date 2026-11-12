/**
 * ==============================================================================
 * BACKEND SERVER-SIDE REAL — FIREBASE CLOUD FUNCTIONS + ADMIN SDK (FASE 5)
 * ==============================================================================
 * Executado exclusivamente no ambiente server-side (Node.js / Functions Emulator /
 * Cloud Functions), utilizando `firebase-admin` com privilégios administrativos
 * fora do bundle do frontend React/Vite.
 *
 * Responsabilidades Críticas:
 * 1. Validar identidade do solicitante (context.auth.uid) e sua autoridade no espaço.
 * 2. Validar o estado atual do espaço e a transição solicitada.
 * 3. Gravar eventos oficiais e imutáveis de auditoria em `spaces/{spaceId}/audit/{eventId}`
 *    com identificadores determinísticos (idempotentes).
 * 4. Despachar notificações oficiais em `users/{userId}/notifications/{notificationId}`
 *    com identificadores determinísticos vinculados ao evento de origem.
 * 5. Executar o cancelamento automático de dissolução por timeout (`processSpaceDissolutionTimeout`)
 *    dentro de uma transação ACID (`db.runTransaction`), garantindo:
 *    - Transição condicional única `pending_author_responses -> auto_cancelled_timeout`
 *    - Exatamente 1 evento oficial de auditoria
 *    - Exatamente 1 notificação de cancelamento + reabertura idempotente das notificações
 *      dos autores que ainda estavam pendentes (`decision === 'pending'`)
 *    - Uso do nome real do espaço (nunca 'Espaço' genérico quando o espaço existe).
 */

import crypto from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';

if (getApps().length === 0) {
  initializeApp({
    projectId: process.env.GCLOUD_PROJECT || 'demo-projeto-beta-v3',
  });
}

const getAdminDb = () => getFirestore();

export const ALLOWED_GOVERNANCE_EVENTS = new Set([
  'space_created',
  'space_archived',
  'space_unarchived',
  'invite_created',
  'invite_accepted',
  'invite_rejected',
  'invite_revoked',
  'member_joined',
  'member_role_changed',
  'member_removed',
  'member_voluntary_exit',
  'dissolution_requested',
  'author_destination_decided',
  'dissolution_cancelled',
  'shared_expense_created',
  'payment_declaration_submitted',
  'payment_approved',
  'payment_rejected',
  'payment_approval_revoked',
  'supplier_refund_recorded',
  'restitution_created',
  'restitution_declared',
  'restitution_receipt_confirmed',
  'custody_transfer_created',
  'custody_receipt_confirmed',
  'custody_consumed',
  'custody_return_requested',
  'custody_return_confirmed',
  'acquisition_purchased',
  'acquisition_stock_moved',
  'acquisition_deposit_recorded',
]);

/**
 * Gera um identificador determinístico SHA-256 (prefixado) a partir de componentes canônicos.
 */
export function buildDeterministicGovernanceId(prefix, parts) {
  const canonical = parts
    .map((p) => (p === undefined || p === null ? '' : String(p).trim()))
    .join('|');
  const digest = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  return `${prefix}_${digest}`;
}

/**
 * Sincroniza a projeção histórica individual (`spaces/{spaceId}/historical_views/{memberUid}`)
 * sem expor dados privados ou operacionais dos demais participantes.
 */
export async function syncHistoricalSpaceProjection(db, space, memberUid, exitedAt) {
  if (!space || !space.id || !memberUid) return;
  const projectionRef = db
    .collection('spaces')
    .doc(space.id)
    .collection('historical_views')
    .doc(memberUid);

  const projection = {
    id: space.id,
    spaceId: space.id,
    memberUid,
    creatorUid: space.creatorUid,
    ownerId: space.ownerId,
    name: space.name,
    description: space.description || '',
    icon: space.icon || 'ph-users-three',
    color: space.color || '#3b82f6',
    spaceStatus: space.spaceStatus,
    enabledModules: space.enabledModules || ['finance', 'acquisitions'],
    createdAt: space.createdAt,
    exitedAt: exitedAt || new Date().toISOString(),
  };

  await projectionRef.set(projection, { merge: true });
}

/**
 * Valida a autoridade do usuário autenticado sobre o espaço para registrar um evento oficial
 * de auditoria e despachar notificações correspondentes no servidor.
 */
export async function executeTrustedGovernanceEvent(db, callerUid, payload) {
  if (!callerUid || typeof callerUid !== 'string' || !callerUid.trim()) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória para operações de governança.');
  }

  const {
    spaceId,
    eventType,
    performedByUid,
    performedByName,
    targetUid,
    targetName,
    details,
    operationKey,
    notifications = [],
  } = payload || {};

  if (!spaceId || typeof spaceId !== 'string') {
    throw new HttpsError('invalid-argument', 'spaceId é obrigatório.');
  }
  if (!eventType || !ALLOWED_GOVERNANCE_EVENTS.has(eventType)) {
    throw new HttpsError('invalid-argument', `Tipo de evento de governança inválido: ${String(eventType)}.`);
  }
  if (performedByUid !== callerUid) {
    throw new HttpsError(
      'permission-denied',
      'Violação de identidade: performedByUid deve corresponder exatamente ao UID autenticado.'
    );
  }

  const spaceRef = db.collection('spaces').doc(spaceId);
  const spaceSnap = await spaceRef.get();
  if (!spaceSnap.exists) {
    throw new HttpsError('not-found', `Espaço "${spaceId}" não encontrado.`);
  }

  const space = spaceSnap.data();
  const isCreator = space.creatorUid === callerUid;
  const isOwner = space.ownerId === callerUid;
  const isActiveMember = Array.isArray(space.memberUids) && space.memberUids.includes(callerUid);
  const isHistoricalMember =
    Array.isArray(space.historicalMemberUids) && space.historicalMemberUids.includes(callerUid);

  // Busca papel do membro quando aplicável
  const memberSnap = await spaceRef.collection('members').doc(callerUid).get();
  const memberData = memberSnap.exists ? memberSnap.data() : null;
  const isAdminOrOwner =
    isCreator ||
    isOwner ||
    (isActiveMember && memberData && (memberData.role === 'owner' || memberData.role === 'admin'));

  // Validação estrita de autoridade e estado por tipo de evento
  switch (eventType) {
    case 'space_created':
    case 'space_archived':
    case 'space_unarchived':
    case 'dissolution_requested':
    case 'dissolution_cancelled':
      if (!isCreator) {
        throw new HttpsError(
          'permission-denied',
          `Somente o criador do espaço pode registrar o evento oficial "${eventType}".`
        );
      }
      break;

    case 'invite_created':
    case 'invite_revoked':
    case 'member_role_changed':
      if (!isAdminOrOwner) {
        throw new HttpsError(
          'permission-denied',
          `Apenas proprietários ou administradores ativos podem executar "${eventType}".`
        );
      }
      break;

    case 'member_removed':
      if (!isAdminOrOwner) {
        throw new HttpsError(
          'permission-denied',
          'Apenas proprietários ou administradores ativos podem remover participantes.'
        );
      }
      if (targetUid && space.memberUids && space.memberUids.includes(targetUid)) {
        throw new HttpsError(
          'failed-precondition',
          'O participante alvo ainda consta como ativo no espaço; a remoção deve preceder a auditoria.'
        );
      }
      if (targetUid) {
        await syncHistoricalSpaceProjection(db, { ...space, id: spaceId }, targetUid);
      }
      break;

    case 'member_voluntary_exit':
      if (!isHistoricalMember && !isActiveMember) {
        throw new HttpsError(
          'permission-denied',
          'Usuário sem vínculo com o espaço não pode registrar saída voluntária.'
        );
      }
      await syncHistoricalSpaceProjection(db, { ...space, id: spaceId }, callerUid);
      break;

    case 'invite_accepted':
    case 'member_joined':
    case 'author_destination_decided':
      if (!isActiveMember) {
        throw new HttpsError(
          'permission-denied',
          `Apenas participantes ativos do espaço podem registrar "${eventType}".`
        );
      }
      break;

    case 'invite_rejected':
      // Qualquer usuário autenticado que rejeitou um convite válido pode registrar a rejeição
      break;

    default:
      throw new HttpsError('invalid-argument', `Evento não suportado: ${eventType}`);
  }

  // Determina chave canônica para idempotência do evento de auditoria
  const canonicalOpKey =
    operationKey ||
    buildDeterministicGovernanceId('op', [
      spaceId,
      eventType,
      callerUid,
      targetUid || '',
      JSON.stringify(details || {}),
    ]);

  const deterministicEventId = payload.eventId || buildDeterministicGovernanceId('audit', [
    spaceId,
    eventType,
    canonicalOpKey,
  ]);

  const auditRef = spaceRef.collection('audit').doc(deterministicEventId);

  const result = await db.runTransaction(async (tx) => {
    const existingAudit = await tx.get(auditRef);
    const nowIso = new Date().toISOString();

    let auditEvent;
    let isIdempotentReplay = false;

    if (existingAudit.exists) {
      auditEvent = existingAudit.data();
      isIdempotentReplay = true;
    } else {
      auditEvent = {
        id: deterministicEventId,
        spaceId,
        eventType,
        performedByUid: callerUid,
        performedByName: performedByName || 'Participante',
        ...(targetUid ? { targetUid } : {}),
        ...(targetName ? { targetName } : {}),
        ...(details ? { details } : {}),
        timestamp: payload.timestamp || nowIso,
      };
      tx.set(auditRef, auditEvent);
    }

    const dispatchedNotifications = [];
    if (Array.isArray(notifications)) {
      for (const notifInput of notifications) {
        if (!notifInput || !notifInput.userId) continue;
        const notifId =
          notifInput.notificationId ||
          buildDeterministicGovernanceId('notif', [
             deterministicEventId,
            notifInput.userId,
            notifInput.type || eventType,
          ]);

        const notifRef = db
          .collection('users')
          .doc(notifInput.userId)
          .collection('notifications')
          .doc(notifId);

        const notifSnap = await tx.get(notifRef);
        if (notifSnap.exists) {
          dispatchedNotifications.push(notifSnap.data());
        } else {
          const notifDoc = {
            id: notifId,
            userId: notifInput.userId,
            spaceId,
            spaceName: space.name || notifInput.spaceName || 'Espaço Compartilhado',
            type: notifInput.type,
            title: notifInput.title,
            message: notifInput.message,
            read: false,
            ...(notifInput.actionUrl ? { actionUrl: notifInput.actionUrl } : {}),
            senderUid: callerUid,
            originEventId: deterministicEventId,
            createdAt: nowIso,
          };
          tx.set(notifRef, notifDoc);
          dispatchedNotifications.push(notifDoc);
        }
      }
    }

    return {
      auditEvent,
      notifications: dispatchedNotifications,
      isIdempotentReplay,
    };
  });

  return result;
}

/**
 * Executa de forma transacional, server-side e idempotente o cancelamento automático
 * por timeout (30 dias) de uma solicitação de dissolução com decisões pendentes.
 */
export async function executeServerSideDissolutionTimeout(db, callerUid, payload) {
  if (!callerUid || typeof callerUid !== 'string' || !callerUid.trim()) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória.');
  }

  const { spaceId, referenceNowIso } = payload || {};
  if (!spaceId || typeof spaceId !== 'string') {
    throw new HttpsError('invalid-argument', 'spaceId é obrigatório.');
  }

  const evalNow = referenceNowIso ? new Date(referenceNowIso) : new Date();
  if (Number.isNaN(evalNow.getTime())) {
    throw new HttpsError('invalid-argument', 'Data de referência inválida.');
  }

  const spaceRef = db.collection('spaces').doc(spaceId);
  const dissolutionRef = spaceRef.collection('dissolution').doc('request');

  return await db.runTransaction(async (tx) => {
    const [spaceSnap, reqSnap] = await Promise.all([
      tx.get(spaceRef),
      tx.get(dissolutionRef),
    ]);

    if (!spaceSnap.exists) {
      throw new HttpsError('not-found', `Espaço "${spaceId}" não encontrado.`);
    }
    if (!reqSnap.exists) {
      throw new HttpsError('not-found', 'Solicitação de dissolução não encontrada.');
    }

    const space = spaceSnap.data();
    const isActiveMember =
      Array.isArray(space.memberUids) && space.memberUids.includes(callerUid);

    if (!isActiveMember && callerUid !== 'system') {
      throw new HttpsError(
        'permission-denied',
        'Apenas participantes ativos do espaço podem acionar a verificação de prazo da dissolução.'
      );
    }

    const req = reqSnap.data();

    // 1. Idempotência: se já foi cancelada por timeout anteriormente, retorna o estado existente sem duplicar nada
    if (req.requestStatus === 'auto_cancelled_timeout') {
      return {
        dissolutionRequest: req,
        Transitioned: false,
        isIdempotentReplay: true,
      };
    }

    // 2. Se não está em 'pending_author_responses', não há transição a fazer
    if (req.requestStatus !== 'pending_author_responses') {
      return {
        dissolutionRequest: req,
        Transitioned: false,
        isIdempotentReplay: false,
      };
    }

    // 3. Verifica se o prazo de 30 dias expirou e se há pelo menos 1 decisão pendente
    const deadlineMs = new Date(req.deadlineDate).getTime();
    const isExpired = evalNow.getTime() > deadlineMs;
    const authorEntries = Object.entries(req.authorDestinations || {});
    const pendingAuthors = authorEntries
      .filter(([, dest]) => dest && dest.decision === 'pending')
      .map(([uid]) => uid);

    if (!isExpired || pendingAuthors.length === 0) {
      return {
        dissolutionRequest: req,
        Transitioned: false,
        isIdempotentReplay: false,
      };
    }

    const realSpaceName = space.name || 'Espaço Compartilhado';
    const requestCycleKey = `${spaceId}_${req.initiatedAt}`;
    const deterministicAuditId = buildDeterministicGovernanceId('audit_timeout', [
      spaceId,
      req.initiatedAt,
    ]);

    const auditRef = spaceRef.collection('audit').doc(deterministicAuditId);
    const existingAuditSnap = await tx.get(auditRef);

    // Pré-leitura de todas as notificações determinísticas dentro da transação (Firestore exige reads antes de writes)
    const recipientUids = Array.from(new Set([...pendingAuthors, space.creatorUid]));
    const cancelNotifRefs = recipientUids.map((uid) => ({
      uid,
      ref: db
        .collection('users')
        .doc(uid)
        .collection('notifications')
        .doc(buildDeterministicGovernanceId('notif_timeout_cancel', [requestCycleKey, uid])),
    }));

    const reopenedPendingNotifRefs = pendingAuthors.map((uid) => ({
      uid,
      ref: db
        .collection('users')
        .doc(uid)
        .collection('notifications')
        .doc(buildDeterministicGovernanceId('notif_timeout_reopen', [requestCycleKey, uid])),
    }));

    // Também verifica se existem notificações anteriores de dissolução para os autores pendentes para reabri-las (read: false)
    const existingNotifQueries = await Promise.all(
      pendingAuthors.map((uid) =>
        tx.get(
          db
            .collection('users')
            .doc(uid)
            .collection('notifications')
            .where('spaceId', '==', spaceId)
        )
      )
    );

    const nowIso = evalNow.toISOString();
    const cancellationReason =
      'Cancelamento automático: decorrido o prazo improrrogável de 30 dias com decisões pendentes de autores. Silêncio não é consentimento. Dados preservados integralmente.';

    const updatedReq = {
      ...req,
      requestStatus: 'auto_cancelled_timeout',
      cancelledAt: nowIso,
      cancellationReason,
    };

    // Garante que o espaço permaneça arquivado e somente leitura
    if (space.spaceStatus !== 'archived') {
      tx.update(spaceRef, {
        spaceStatus: 'archived',
        archivedAt: space.archivedAt || nowIso,
        archivedByUid: space.archivedByUid || space.creatorUid,
      });
    }

    // Atualiza o documento de dissolução de forma condicional dentro da transação
    tx.update(dissolutionRef, {
      requestStatus: 'auto_cancelled_timeout',
      cancelledAt: nowIso,
      cancellationReason,
    });

    // Registra evento único de auditoria oficial
    if (!existingAuditSnap.exists) {
      tx.set(auditRef, {
        id: deterministicAuditId,
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
        timestamp: nowIso,
      });
    }

    // Reabre notificações existentes de dissolução dos autores pendentes ou cria a notificação reaberta determinística
    pendingAuthors.forEach((uid, idx) => {
      const snap = existingNotifQueries[idx];
      let reopenedAny = false;
      snap.forEach((docSnap) => {
        const data = docSnap.data();
        if (
          data.type === 'dissolution_requested' ||
          data.type === 'dissolution_decision_pending'
        ) {
          reopenedAny = true;
          tx.update(docSnap.ref, {
            read: false,
            spaceName: realSpaceName,
          });
        }
      });

      if (!reopenedAny) {
        const reopenEntry = reopenedPendingNotifRefs[idx];
        tx.set(reopenEntry.ref, {
          id: reopenEntry.ref.id,
          userId: uid,
          spaceId,
          spaceName: realSpaceName,
          type: 'dissolution_decision_pending',
          title: 'Decisão Pendente Reaberta (Prazo Expirado)',
          message: `O prazo de 30 dias da dissolução do espaço "${realSpaceName}" expirou enquanto sua decisão estava pendente. Seus dados foram preservados.`,
          read: false,
          originEventId: deterministicAuditId,
          createdAt: nowIso,
        });
      }
    });

    // Cria 1 notificação oficial de cancelamento por destinatário previsto (idempotente por ID determinístico)
    for (const { uid, ref } of cancelNotifRefs) {
      tx.set(ref, {
        id: ref.id,
        userId: uid,
        spaceId,
        spaceName: realSpaceName,
        type: 'dissolution_cancelled',
        title: 'Solicitação de Dissolução Cancelada',
        message: `O prazo de 30 dias do espaço "${realSpaceName}" encerrou com decisões pendentes. A solicitação foi cancelada e seus dados continuam 100% protegidos.`,
        read: false,
        originEventId: deterministicAuditId,
        createdAt: nowIso,
      });
    }

    return {
      dissolutionRequest: updatedReq,
      Transitioned: true,
      isIdempotentReplay: false,
    };
  });
}

/**
 * Aceitação atômica e server-side de convite por usuário autenticado, validando hash SHA-256,
 * uso único, prazo de expiração, estado do espaço e gravando auditoria e notificação determinísticas.
 */
export async function executeServerSideAcceptSpaceInvite(db, callerUid, payload) {
  if (!callerUid || typeof callerUid !== 'string' || !callerUid.trim()) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória para aceitar convite.');
  }

  const { rawToken, tokenHash: providedHash, user, operationKey } = payload || {};
  const cleanUid = callerUid.trim();

  if (user?.uid && user.uid.trim() !== cleanUid) {
    throw new HttpsError(
      'permission-denied',
      'O UID do usuário deve corresponder ao usuário autenticado na sessão.'
    );
  }

  let tokenHash = providedHash;
  if (rawToken && typeof rawToken === 'string' && rawToken.trim()) {
    tokenHash = crypto.createHash('sha256').update(rawToken.trim()).digest('hex');
  }

  if (!tokenHash || typeof tokenHash !== 'string') {
    throw new HttpsError('invalid-argument', 'Token de convite inválido.');
  }

  const inviteRef = db.collection('space_invites').doc(tokenHash);

  return await db.runTransaction(async (tx) => {
    const inviteSnap = await tx.get(inviteRef);
    if (!inviteSnap.exists) {
      throw new HttpsError('not-found', 'Convite não encontrado ou token inválido.');
    }

    const invite = inviteSnap.data();
    if (invite.tokenStatus !== 'pending') {
      throw new HttpsError(
        'failed-precondition',
        `Este convite não pode ser utilizado pois seu status atual é: ${invite.tokenStatus}.`
      );
    }

    if (new Date(invite.expiresAt).getTime() < Date.now()) {
      tx.update(inviteRef, { tokenStatus: 'expired' });
      throw new HttpsError(
        'failed-precondition',
        'Este convite expirou e não pode mais ser aceito.'
      );
    }

    const spaceRef = db.collection('spaces').doc(invite.spaceId);
    const spaceSnap = await tx.get(spaceRef);
    if (!spaceSnap.exists) {
      throw new HttpsError('not-found', 'O espaço associado a este convite não foi encontrado.');
    }

    const space = spaceSnap.data();
    if (space.spaceStatus === 'archived') {
      throw new HttpsError(
        'failed-precondition',
        'Não é possível ingressar em um espaço que se encontra arquivado.'
      );
    }

    if (Array.isArray(space.memberUids) && space.memberUids.includes(cleanUid)) {
      throw new HttpsError(
        'already-exists',
        'Você já é um participante ativo deste espaço.'
      );
    }

    const now = new Date().toISOString();
    const displayName = user?.displayName?.trim() || 'Novo Participante';
    const contactEmail = user?.email?.trim() || '';

    const updatedMemberUids = [...(space.memberUids || []), cleanUid];
    const updatedHistoricalUids = Array.from(
      new Set([...(space.historicalMemberUids || space.memberUids || []), cleanUid])
    );

    const newMember = {
      id: cleanUid,
      spaceId: invite.spaceId,
      uid: cleanUid,
      displayName,
      contactEmail,
      role: invite.invitedRole || 'member',
      participationStatus: 'active',
      invitedAt: invite.createdAt,
      joinedAt: now,
    };

    const canonicalOpKey = operationKey || `invite_accept_${tokenHash}_${cleanUid}`;
    const deterministicAuditId = buildDeterministicGovernanceId('audit', [
      invite.spaceId,
      'invite_accepted',
      canonicalOpKey,
    ]);
    const deterministicNotifId = buildDeterministicGovernanceId('notif', [
      deterministicAuditId,
      space.creatorUid,
      'invite_accepted',
    ]);

    const auditRef = spaceRef.collection('audit').doc(deterministicAuditId);
    const notifRef = db
      .collection('users')
      .doc(space.creatorUid)
      .collection('notifications')
      .doc(deterministicNotifId);

    const memberRef = spaceRef.collection('members').doc(cleanUid);

    tx.update(inviteRef, {
      tokenStatus: 'accepted',
      acceptedByUid: cleanUid,
      acceptedByName: displayName,
      acceptedAt: now,
    });

    tx.update(spaceRef, {
      memberUids: updatedMemberUids,
      historicalMemberUids: updatedHistoricalUids,
    });

    tx.set(memberRef, newMember);

    tx.set(auditRef, {
      id: deterministicAuditId,
      spaceId: invite.spaceId,
      eventType: 'invite_accepted',
      performedByUid: cleanUid,
      performedByName: displayName,
      targetUid: cleanUid,
      details: { role: newMember.role, tokenHash },
      timestamp: now,
    });

    tx.set(notifRef, {
      id: deterministicNotifId,
      userId: space.creatorUid,
      spaceId: invite.spaceId,
      spaceName: space.name || 'Espaço Compartilhado',
      type: 'invite_accepted',
      title: 'Novo Participante no Espaço',
      message: `${displayName} aceitou o convite e ingressou no espaço "${space.name}".`,
      read: false,
      senderUid: cleanUid,
      originEventId: deterministicAuditId,
      createdAt: now,
    });

    return {
      space: {
        ...space,
        id: invite.spaceId,
        memberUids: updatedMemberUids,
        historicalMemberUids: updatedHistoricalUids,
      },
      member: newMember,
    };
  });
}

// Cloud Functions v2 HTTP Callable Endpoints (executados pelo Functions Emulator na porta 5001)
export const recordOfficialSpaceGovernanceEvent = onCall(
  { region: 'us-central1' },
  async (request) => {
    const callerUid = request.auth?.uid;
    return await executeTrustedGovernanceEvent(getAdminDb(), callerUid, request.data);
  }
);

export const processSpaceDissolutionTimeout = onCall(
  { region: 'us-central1' },
  async (request) => {
    const callerUid = request.auth?.uid;
    return await executeServerSideDissolutionTimeout(getAdminDb(), callerUid, request.data);
  }
);

export const acceptSpaceInviteOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    const callerUid = request.auth?.uid;
    return await executeServerSideAcceptSpaceInvite(getAdminDb(), callerUid, request.data);
  }
);

// ==============================================================================
// FASES 3 E 4 — BACKEND FINANCEIRO CONFIÁVEL (LIVRO, TRANSAÇÕES, CARTÕES, REEMBOLSOS)
// ==============================================================================

function sha256HexServer(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function stripUndefined(obj) {
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      result[k] = v;
    }
  }
  return result;
}

function validatePositiveCentsServer(amountCents) {
  return (
    typeof amountCents === 'number' &&
    Number.isSafeInteger(amountCents) &&
    amountCents > 0
  );
}

export function serverGenerateMovementDocId(accountIdOrKey, idempotencyKey) {
  let accountId = '';
  let key = '';
  if (idempotencyKey !== undefined) {
    accountId = String(accountIdOrKey || '').trim();
    key = String(idempotencyKey || '').trim();
  } else {
    key = String(accountIdOrKey || '').trim();
  }
  const cleanSlug = key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  const hashInput = accountId ? `${accountId}:${key}` : key;
  const hash = sha256HexServer(hashInput);
  return `mov_${cleanSlug ? `${cleanSlug}_` : ''}${hash}`;
}

export function serverGenerateReversalDocId(originalMovementId) {
  const clean = String(originalMovementId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 32);
  const hash = sha256HexServer(String(originalMovementId || '').trim());
  return `rev_${clean}_${hash}`;
}

export function serverGeneratePaymentReversalDocId(paymentId) {
  const clean = String(paymentId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 32);
  const hash = sha256HexServer(String(paymentId || '').trim());
  return `payrev_${clean}_${hash}`;
}

function serverValidateMovementPayloadMatch(existing, candidate) {
  const mismatches = [];
  if (existing.accountId !== candidate.accountId) {
    mismatches.push(`accountId (${existing.accountId} vs ${candidate.accountId})`);
  }
  if (existing.userId !== candidate.userId) {
    mismatches.push(`userId (${existing.userId} vs ${candidate.userId})`);
  }
  if (existing.direction !== candidate.direction) {
    mismatches.push(`direction (${existing.direction} vs ${candidate.direction})`);
  }
  if (existing.amountCents !== candidate.amountCents) {
    mismatches.push(`amountCents (${existing.amountCents} vs ${candidate.amountCents})`);
  }
  if (existing.originType !== candidate.originType) {
    mismatches.push(`originType (${existing.originType} vs ${candidate.originType})`);
  }
  if (existing.originId !== candidate.originId) {
    mismatches.push(`originId (${existing.originId} vs ${candidate.originId})`);
  }
  if (mismatches.length > 0) {
    throw new HttpsError(
      'already-exists',
      `Conflito de idempotência: A chave "${candidate.idempotencyKey || candidate.id}" já foi utilizada para outra operação com parâmetros divergentes: ${mismatches.join(', ')}.`
    );
  }
}

function serverBuildFinancialMovement(params) {
  if (!validatePositiveCentsServer(params?.amountCents)) {
    throw new HttpsError(
      'invalid-argument',
      'O valor do movimento deve ser um inteiro estritamente positivo em centavos.'
    );
  }
  if (!params?.accountId || !String(params.accountId).trim()) {
    throw new HttpsError('invalid-argument', 'Identificador da conta bancária (accountId) é obrigatório.');
  }
  if (!params?.userId || !String(params.userId).trim()) {
    throw new HttpsError('invalid-argument', 'Identificador do titular da conta (userId) é obrigatório.');
  }
  if (!params?.authorUid || !String(params.authorUid).trim()) {
    throw new HttpsError('invalid-argument', 'Identificador do autor da operação (authorUid) é obrigatório.');
  }
  if (params.direction !== 'inflow' && params.direction !== 'outflow') {
    throw new HttpsError(
      'invalid-argument',
      `Direção do movimento inválida: "${params.direction}". Deve ser 'inflow' ou 'outflow'.`
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(params.effectiveDate || ''))) {
    throw new HttpsError(
      'invalid-argument',
      `Data efetiva inválida: "${params.effectiveDate}". Deve seguir formato YYYY-MM-DD.`
    );
  }
  const cleanDescription = String(params.description || '').trim();
  if (!cleanDescription) {
    throw new HttpsError('invalid-argument', 'Descrição do movimento é obrigatória.');
  }

  const registeredAt = new Date().toISOString();
  const idempotencyKey =
    params.idempotencyKey ||
    `idem_${params.originType}_${params.originId}_${params.direction}_${params.amountCents}`;

  const expectedDocId = params.reversalOfMovementId
    ? serverGenerateReversalDocId(params.reversalOfMovementId)
    : serverGenerateMovementDocId(params.accountId, idempotencyKey);

  if (params.id && params.id !== expectedDocId) {
    throw new HttpsError(
      'invalid-argument',
      `Identificador de documento inválido: O ID "${params.id}" fornecido não coincide com o ID determinístico esperado ("${expectedDocId}"). Não é permitido burlar o ID determinístico.`
    );
  }

  return stripUndefined({
    id: expectedDocId,
    accountId: String(params.accountId).trim(),
    userId: String(params.userId).trim(),
    direction: params.direction,
    amountCents: params.amountCents,
    effectiveDate: params.effectiveDate,
    registeredAt,
    originType: params.originType,
    originId: String(params.originId).trim(),
    confirmationStatus: params.confirmationStatus || 'cleared',
    idempotencyKey,
    reversalOfMovementId: params.reversalOfMovementId,
    description: cleanDescription,
    notes: params.notes ? String(params.notes).trim() : undefined,
    authorUid: String(params.authorUid).trim(),
  });
}

function serverBuildCompensatoryMovement({ originalMovement, authorUid, reversalDate, reason }) {
  if (originalMovement.reversalOfMovementId) {
    throw new HttpsError(
      'failed-precondition',
      `Operação inválida: O movimento "${originalMovement.id}" já é um estorno compensatório e não pode ser re-estornado.`
    );
  }
  const oppositeDirection = originalMovement.direction === 'inflow' ? 'outflow' : 'inflow';
  const todayDate = reversalDate || new Date().toISOString().split('T')[0];
  const reasonSuffix = reason ? ` - Motivo: ${String(reason).trim()}` : '';
  const description = `Estorno contábil de: ${originalMovement.description}${reasonSuffix}`;
  const reversalDocId = serverGenerateReversalDocId(originalMovement.id);
  const reversalIdempotencyKey = `reversal_${originalMovement.id}`;

  return serverBuildFinancialMovement({
    id: reversalDocId,
    accountId: originalMovement.accountId,
    userId: originalMovement.userId,
    direction: oppositeDirection,
    amountCents: originalMovement.amountCents,
    effectiveDate: todayDate,
    originType: 'manual_adjustment',
    originId: reversalDocId,
    description,
    notes: `Movimento compensatório referenciando #${originalMovement.id}.${reason ? ` Justificativa: ${reason}` : ''}`,
    authorUid,
    reversalOfMovementId: originalMovement.id,
    idempotencyKey: reversalIdempotencyKey,
    confirmationStatus: 'cleared',
  });
}

function calculateInvoiceMonthForPurchaseServer(purchaseDate, closingDay) {
  const parts = String(purchaseDate || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new HttpsError('invalid-argument', `Data de compra inválida: "${purchaseDate}".`);
  }
  const [year, month, day] = parts;
  const safeClosingDay = Math.min(Math.max(closingDay || 10, 1), 28);
  let targetYear = year;
  let targetMonth = month;
  if (day > safeClosingDay) {
    targetMonth += 1;
    if (targetMonth > 12) {
      targetMonth = 1;
      targetYear += 1;
    }
  }
  return `${targetYear}-${String(targetMonth).padStart(2, '0')}`;
}

function buildInvoiceDatesServer(invoiceMonth, closingDay = 10, dueDay = 17) {
  const [year, month] = String(invoiceMonth).split('-').map(Number);
  const safeClosing = String(Math.min(Math.max(closingDay, 1), 28)).padStart(2, '0');
  const safeDue = String(Math.min(Math.max(dueDay, 1), 28)).padStart(2, '0');
  let dueYear = year;
  let dueMonth = month;
  if (dueDay < closingDay) {
    dueMonth += 1;
    if (dueMonth > 12) {
      dueMonth = 1;
      dueYear += 1;
    }
  }
  return {
    closingDate: `${year}-${String(month).padStart(2, '0')}-${safeClosing}`,
    dueDate: `${dueYear}-${String(dueMonth).padStart(2, '0')}-${safeDue}`,
  };
}

function isAccountArchivedServer(accData) {
  return Boolean(accData?.isArchived || accData?.status === 'archived');
}

/**
 * 1. Gravação canônica de movimentação financeira (Server-Side Admin SDK)
 */
export async function executeServerSideRecordMovement(db, callerUid, payload) {
  if (!callerUid || typeof callerUid !== 'string' || !callerUid.trim()) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória para registrar movimentação.');
  }
  const cleanUid = callerUid.trim();
  if (payload?.userId && payload.userId.trim() !== cleanUid) {
    throw new HttpsError('permission-denied', 'Acesso negado: o userId não corresponde ao usuário autenticado.');
  }
  if (payload?.authorUid && payload.authorUid.trim() !== cleanUid) {
    throw new HttpsError('permission-denied', 'Acesso negado: o authorUid não corresponde ao usuário autenticado.');
  }

  const candidateMovement = serverBuildFinancialMovement({
    ...payload,
    userId: cleanUid,
    authorUid: cleanUid,
  });

  const accountRef = db.collection('accounts').doc(candidateMovement.accountId);
  const movRef = accountRef.collection('movements').doc(candidateMovement.id);

  return await db.runTransaction(async (tx) => {
    const [accSnap, existingMovSnap] = await Promise.all([
      tx.get(accountRef),
      tx.get(movRef),
    ]);

    if (!accSnap.exists) {
      throw new HttpsError('not-found', `Conta "${candidateMovement.accountId}" não encontrada.`);
    }
    const accData = accSnap.data();
    if (accData.userId !== cleanUid) {
      throw new HttpsError('permission-denied', 'Acesso negado: Você não é o titular desta conta.');
    }
    if (isAccountArchivedServer(accData)) {
      throw new HttpsError(
        'failed-precondition',
        `Conta "${accData.name}" está arquivada e não aceita novas movimentações.`
      );
    }

    if (existingMovSnap.exists) {
      const existingData = existingMovSnap.data();
      serverValidateMovementPayloadMatch(existingData, candidateMovement);
      return {
        movement: existingData,
        newProjectedBalanceCents: accData.projectedBalanceCents ?? 0,
        isIdempotentReplay: true,
      };
    }

    const delta =
      candidateMovement.direction === 'inflow'
        ? candidateMovement.amountCents
        : -candidateMovement.amountCents;
    const newBalance = (accData.projectedBalanceCents || 0) + delta;

    tx.set(movRef, candidateMovement);
    tx.update(accountRef, {
      projectedBalanceCents: newBalance,
      updatedAt: new Date().toISOString(),
    });

    return {
      movement: candidateMovement,
      newProjectedBalanceCents: newBalance,
      isIdempotentReplay: false,
    };
  });
}

/**
 * 2. Estorno compensatório atômico (Server-Side Admin SDK)
 */
export async function executeServerSideReverseMovement(db, callerUid, payload) {
  if (!callerUid || typeof callerUid !== 'string' || !callerUid.trim()) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória para estornar movimentação.');
  }
  const cleanUid = callerUid.trim();
  const { accountId, movementId, authorUid, reason, reversalDate, idempotent } = payload || {};
  if (authorUid && String(authorUid).trim() !== cleanUid) {
    throw new HttpsError('permission-denied', 'Acesso negado: authorUid divergente do usuário autenticado.');
  }
  if (!accountId || !movementId) {
    throw new HttpsError('invalid-argument', 'accountId e movementId são obrigatórios para estorno.');
  }

  const accountRef = db.collection('accounts').doc(String(accountId).trim());
  const origMovRef = accountRef.collection('movements').doc(String(movementId).trim());
  const reversalDocId = serverGenerateReversalDocId(String(movementId).trim());
  const revMovRef = accountRef.collection('movements').doc(reversalDocId);

  return await db.runTransaction(async (tx) => {
    const [accSnap, origSnap, revSnap, existingReversalsQuery] = await Promise.all([
      tx.get(accountRef),
      tx.get(origMovRef),
      tx.get(revMovRef),
      tx.get(accountRef.collection('movements').where('reversalOfMovementId', '==', String(movementId).trim())),
    ]);

    if (!accSnap.exists) {
      throw new HttpsError('not-found', `Conta "${accountId}" não encontrada.`);
    }
    const accData = accSnap.data();
    if (accData.userId !== cleanUid) {
      throw new HttpsError('permission-denied', 'Acesso negado: Você não é o titular desta conta.');
    }
    if (isAccountArchivedServer(accData)) {
      throw new HttpsError('failed-precondition', 'Não é possível estornar movimentações em contas arquivadas.');
    }

    if (!origSnap.exists) {
      throw new HttpsError('not-found', `Movimento original "${movementId}" não encontrado.`);
    }
    const origMov = origSnap.data();
    if (origMov.userId !== cleanUid) {
      throw new HttpsError('permission-denied', 'Acesso negado ao movimento original.');
    }

    if (revSnap.exists || !existingReversalsQuery.empty) {
      const existingRevData = revSnap.exists ? revSnap.data() : existingReversalsQuery.docs[0].data();
      if (idempotent) {
        return {
          compensatoryMovement: existingRevData,
          newProjectedBalanceCents: accData.projectedBalanceCents || 0,
          isIdempotentReplay: true,
        };
      }
      throw new HttpsError(
        'already-exists',
        `Operação bloqueada: O movimento "${movementId}" já possui estorno compensatório registrado ("${existingRevData.id}").`
      );
    }

    // Leitura atômica de transação e pagamento vinculados (se houver), ANTES de qualquer escrita na transação Firestore
    let linkedTxRef = null;
    let linkedTxSnap = null;
    let linkedPayRef = null;
    let linkedPaySnap = null;
    let linkedPayRevRef = null;

    if (origMov.originId && (origMov.originType === 'personal_expense' || origMov.originType === 'personal_income')) {
      let candidateTxId = null;
      let candidatePayId = null;

      if (origMov.originId.startsWith('txpay_init_')) {
        candidateTxId = origMov.originId.replace('txpay_init_', '');
        candidatePayId = origMov.originId;
      } else if (origMov.originId.startsWith('txpay_')) {
        candidatePayId = origMov.originId;
        const match = String(origMov.notes || '').match(/Amortização de #([a-zA-Z0-9_-]+)/);
        if (match && match[1]) {
          candidateTxId = match[1];
        } else {
          const match2 = origMov.originId.match(/^txpay_([^_]+)_/);
          if (match2 && match2[1]) {
            candidateTxId = match2[1];
          }
        }
      } else {
        candidateTxId = origMov.originId;
        candidatePayId = `txpay_init_${origMov.originId}`;
      }

      if (candidateTxId) {
        linkedTxRef = db.collection('users').doc(cleanUid).collection('personal_transactions').doc(candidateTxId);
        linkedTxSnap = await tx.get(linkedTxRef);
        if (!linkedTxSnap.exists && origMov.notes) {
          const fallbackMatch = String(origMov.notes).match(/Amortização de #([a-zA-Z0-9_-]+)/);
          if (fallbackMatch && fallbackMatch[1] && fallbackMatch[1] !== candidateTxId) {
            linkedTxRef = db.collection('users').doc(cleanUid).collection('personal_transactions').doc(fallbackMatch[1]);
            linkedTxSnap = await tx.get(linkedTxRef);
          }
        }

        if (candidatePayId && linkedTxRef) {
          linkedPayRef = linkedTxRef.collection('payments').doc(candidatePayId);
          linkedPaySnap = await tx.get(linkedPayRef);
          if (!linkedPaySnap.exists) {
            const payQuerySnap = await tx.get(
              linkedTxRef.collection('payments').where('financialMovementId', '==', String(movementId).trim())
            );
            if (!payQuerySnap.empty) {
              linkedPayRef = payQuerySnap.docs[0].ref;
              linkedPaySnap = payQuerySnap.docs[0];
            }
          }
          if (linkedPaySnap && linkedPaySnap.exists) {
            const actualPayId = linkedPaySnap.data().id || linkedPaySnap.id;
            const payRevDocId = serverGeneratePaymentReversalDocId(actualPayId);
            linkedPayRevRef = linkedTxRef.collection('payment_reversals').doc(payRevDocId);
          }
        }
      }
    }

    const compensatoryMovement = serverBuildCompensatoryMovement({
      originalMovement: origMov,
      authorUid: cleanUid,
      reversalDate,
      reason,
    });

    const delta =
      compensatoryMovement.direction === 'inflow'
        ? compensatoryMovement.amountCents
        : -compensatoryMovement.amountCents;
    const newBalance = (accData.projectedBalanceCents || 0) + delta;

    tx.set(revMovRef, compensatoryMovement);
    tx.update(accountRef, {
      projectedBalanceCents: newBalance,
      updatedAt: new Date().toISOString(),
    });

    if (linkedTxRef && linkedTxSnap && linkedTxSnap.exists) {
      const txData = linkedTxSnap.data();
      if (txData.status !== 'cancelled') {
        const currentPaid = txData.paidAmountCents !== undefined ? txData.paidAmountCents : (txData.status === 'paid' ? txData.amountCents : 0);
        const newPaid = Math.max(0, currentPaid - origMov.amountCents);
        const newRemaining = Math.max(0, txData.amountCents - newPaid);
        const newStatus = newPaid === 0 ? 'pending' : 'partially_paid';
        const updatedNotes = `${txData.notes ? `${txData.notes} | ` : ''}Estorno de movimento: ${reason || 'Estorno contábil'}`;
        tx.update(linkedTxRef, {
          paidAmountCents: newPaid,
          remainingAmountCents: newRemaining,
          status: newStatus,
          notes: updatedNotes,
          updatedAt: new Date().toISOString(),
        });
      }
    }

    // Histórico estritamente imutável: NUNCA atualiza ou apaga o pagamento original.
    // Registra novo evento compensatório em 'payment_reversals'.
    if (linkedPayRef && linkedPaySnap && linkedPaySnap.exists && linkedPayRevRef) {
      const payData = linkedPaySnap.data();
      const actualPayId = payData.id || linkedPaySnap.id;
      const reversalRecord = stripUndefined({
        id: linkedPayRevRef.id,
        transactionId: linkedTxRef.id,
        paymentId: actualPayId,
        userId: cleanUid,
        amountCents: payData.amountCents || origMov.amountCents,
        originalFinancialMovementId: origMov.id,
        reversalMovementId: compensatoryMovement.id,
        reversalDate: reversalDate || new Date().toISOString().split('T')[0],
        reversedAt: new Date().toISOString(),
        authorUid: cleanUid,
        reason: reason || 'Estorno contábil',
        idempotencyKey: `payrev_${actualPayId}`,
        createdAt: new Date().toISOString(),
      });
      tx.set(linkedPayRevRef, reversalRecord);
    }

    return {
      compensatoryMovement,
      newProjectedBalanceCents: newBalance,
      isIdempotentReplay: false,
    };
  });
}

/**
 * 3. Reconciliação oficial de saldo de conta (Server-Side Admin SDK)
 */
export async function executeServerSideReconcileAccount(db, callerUid, payload) {
  if (!callerUid || typeof callerUid !== 'string' || !callerUid.trim()) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória para reconciliar conta.');
  }
  const cleanUid = callerUid.trim();
  const { accountId } = payload || {};
  if (!accountId || !String(accountId).trim()) {
    throw new HttpsError('invalid-argument', 'accountId é obrigatório.');
  }

  const accountRef = db.collection('accounts').doc(String(accountId).trim());

  return await db.runTransaction(async (tx) => {
    const [accSnap, movsSnap] = await Promise.all([
      tx.get(accountRef),
      tx.get(accountRef.collection('movements')),
    ]);

    if (!accSnap.exists) {
      throw new HttpsError('not-found', `Conta "${accountId}" não encontrada.`);
    }
    const accData = accSnap.data();
    if (accData.userId !== cleanUid) {
      throw new HttpsError('permission-denied', 'Acesso negado: Você não é o titular desta conta.');
    }

    let balance = 0;
    movsSnap.forEach((docSnap) => {
      const mov = docSnap.data();
      if (!validatePositiveCentsServer(mov.amountCents)) {
        throw new HttpsError('internal', `Movimentação "${mov.id}" possui valor inválido.`);
      }
      if (mov.direction === 'inflow') {
        balance += mov.amountCents;
      } else if (mov.direction === 'outflow') {
        balance -= mov.amountCents;
      }
    });

    const previousProjectedBalanceCents = accData.projectedBalanceCents || 0;
    const wasDivergent = previousProjectedBalanceCents !== balance;

    if (wasDivergent) {
      tx.update(accountRef, {
        projectedBalanceCents: balance,
        updatedAt: new Date().toISOString(),
      });
    }

    return {
      reconciledBalanceCents: balance,
      previousProjectedBalanceCents,
      wasDivergent,
    };
  });
}

function isCreditAccountServer(accData) {
  return Boolean(accData?.type === 'credit' || accData?.accountType === 'credit_card');
}

function computeInvoiceStatusServer(invoice, todayStr = new Date().toISOString().slice(0, 10)) {
  if (invoice.carriedOverToMonth) {
    return 'carried_over';
  }
  if (invoice.remainingBalanceCents <= 0) {
    return invoice.totalPaidAmountCents > 0 ? 'paid' : 'open';
  }
  if (invoice.totalPaidAmountCents > 0) {
    return 'partially_paid';
  }
  if (todayStr > invoice.closingDate) {
    return todayStr > invoice.dueDate ? 'overdue' : 'closed';
  }
  return 'open';
}

/**
 * 4. Transferência atômica entre contas próprias (Server-Side Admin SDK)
 * Executa a saída na origem, a entrada no destino, a atualização de ambos os saldos
 * e a gravação do registro de transferência em UMA ÚNICA transação Firestore.
 */
export async function executeServerSideInternalTransfer(db, callerUid, payload) {
  if (!callerUid || typeof callerUid !== 'string' || !callerUid.trim()) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória para realizar transferência.');
  }
  const cleanUid = callerUid.trim();
  const {
    userId,
    sourceAccountId,
    destinationAccountId,
    amountCents,
    transferDate,
    description,
    idempotencyKey,
  } = payload || {};

  if (userId && String(userId).trim() !== cleanUid) {
    throw new HttpsError('permission-denied', 'Acesso negado: userId divergente do usuário autenticado.');
  }
  if (!sourceAccountId || !destinationAccountId) {
    throw new HttpsError('invalid-argument', 'Conta de origem e conta de destino são obrigatórias.');
  }
  if (sourceAccountId === destinationAccountId) {
    throw new HttpsError('invalid-argument', 'A conta de origem e a conta de destino não podem ser a mesma.');
  }
  if (!validatePositiveCentsServer(amountCents)) {
    throw new HttpsError('invalid-argument', 'O valor da transferência deve ser um inteiro positivo em centavos.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(transferDate || ''))) {
    throw new HttpsError('invalid-argument', 'A data da transferência deve estar no formato YYYY-MM-DD.');
  }

  const cleanDesc = String(description || '').trim() || 'Transferência entre contas próprias';
  const canonicalKey = idempotencyKey
    ? String(idempotencyKey).trim()
    : `trf_${sourceAccountId}_${destinationAccountId}_${transferDate}_${amountCents}_${cleanDesc}`;
  const cleanSlug = canonicalKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  const transferId = `trf_${cleanSlug}_${sha256HexServer(`${cleanUid}:${canonicalKey}`)}`;

  const outIdemKey = `${canonicalKey}_out`;
  const inIdemKey = `${canonicalKey}_in`;
  const outMovDocId = serverGenerateMovementDocId(sourceAccountId, outIdemKey);
  const inMovDocId = serverGenerateMovementDocId(destinationAccountId, inIdemKey);

  const srcAccRef = db.collection('accounts').doc(String(sourceAccountId).trim());
  const dstAccRef = db.collection('accounts').doc(String(destinationAccountId).trim());
  const transferRef = db
    .collection('users')
    .doc(cleanUid)
    .collection('internal_transfers')
    .doc(transferId);
  const outMovRef = srcAccRef.collection('movements').doc(outMovDocId);
  const inMovRef = dstAccRef.collection('movements').doc(inMovDocId);

  return await db.runTransaction(async (tx) => {
    const [srcAccSnap, dstAccSnap, transferSnap, outMovSnap, inMovSnap] = await Promise.all([
      tx.get(srcAccRef),
      tx.get(dstAccRef),
      tx.get(transferRef),
      tx.get(outMovRef),
      tx.get(inMovRef),
    ]);

    if (!srcAccSnap.exists) {
      throw new HttpsError('not-found', `Conta de origem "${sourceAccountId}" não encontrada.`);
    }
    if (!dstAccSnap.exists) {
      throw new HttpsError('not-found', `Conta de destino "${destinationAccountId}" não encontrada.`);
    }
    const srcAcc = srcAccSnap.data();
    const dstAcc = dstAccSnap.data();

    if (srcAcc.userId !== cleanUid || dstAcc.userId !== cleanUid) {
      throw new HttpsError(
        'permission-denied',
        'Violação de segurança: Transferências entre contas só são permitidas entre contas do mesmo usuário.'
      );
    }
    if (isAccountArchivedServer(srcAcc)) {
      throw new HttpsError(
        'failed-precondition',
        `A conta de origem "${srcAcc.name}" está arquivada e não pode realizar saídas.`
      );
    }
    if (isAccountArchivedServer(dstAcc)) {
      throw new HttpsError(
        'failed-precondition',
        `A conta de destino "${dstAcc.name}" está arquivada e não pode receber transferências.`
      );
    }
    if (isCreditAccountServer(srcAcc) || isCreditAccountServer(dstAcc)) {
      throw new HttpsError(
        'invalid-argument',
        'Transferências diretas não são permitidas para contas de cartão de crédito. Utilize o fluxo de pagamento de fatura.'
      );
    }

    if (transferSnap.exists) {
      const existingTransfer = transferSnap.data();
      if (
        existingTransfer.sourceAccountId !== sourceAccountId ||
        existingTransfer.destinationAccountId !== destinationAccountId ||
        existingTransfer.amountCents !== amountCents ||
        existingTransfer.transferDate !== transferDate
      ) {
        throw new HttpsError(
          'already-exists',
          `Conflito de idempotência: A chave "${canonicalKey}" já foi utilizada para uma transferência com parâmetros divergentes.`
        );
      }
      if (outMovSnap.exists && inMovSnap.exists) {
        return {
          transfer: existingTransfer,
          outflowMovement: outMovSnap.data(),
          inflowMovement: inMovSnap.data(),
          isIdempotentReplay: true,
        };
      }
    }

    const nowIso = new Date().toISOString();
    const candidateOutMov = serverBuildFinancialMovement({
      id: outMovDocId,
      accountId: sourceAccountId,
      userId: cleanUid,
      direction: 'outflow',
      amountCents,
      effectiveDate: transferDate,
      originType: 'internal_transfer_out',
      originId: transferId,
      description: `${cleanDesc} (Para: ${dstAcc.name})`,
      notes: `Transferência própria vinculada #${transferId}`,
      authorUid: cleanUid,
      idempotencyKey: outIdemKey,
    });

    const candidateInMov = serverBuildFinancialMovement({
      id: inMovDocId,
      accountId: destinationAccountId,
      userId: cleanUid,
      direction: 'inflow',
      amountCents,
      effectiveDate: transferDate,
      originType: 'internal_transfer_in',
      originId: transferId,
      description: `${cleanDesc} (De: ${srcAcc.name})`,
      notes: `Transferência própria vinculada #${transferId}`,
      authorUid: cleanUid,
      idempotencyKey: inIdemKey,
    });

    if (outMovSnap.exists) {
      serverValidateMovementPayloadMatch(outMovSnap.data(), candidateOutMov);
    } else {
      tx.set(outMovRef, candidateOutMov);
      tx.update(srcAccRef, {
        projectedBalanceCents: (srcAcc.projectedBalanceCents || 0) - amountCents,
        updatedAt: nowIso,
      });
    }

    if (inMovSnap.exists) {
      serverValidateMovementPayloadMatch(inMovSnap.data(), candidateInMov);
    } else {
      tx.set(inMovRef, candidateInMov);
      tx.update(dstAccRef, {
        projectedBalanceCents: (dstAcc.projectedBalanceCents || 0) + amountCents,
        updatedAt: nowIso,
      });
    }

    const transferRecord = {
      id: transferId,
      userId: cleanUid,
      sourceAccountId,
      destinationAccountId,
      amountCents,
      transferDate,
      description: cleanDesc,
      idempotencyKey: canonicalKey,
      sourceMovementId: outMovDocId,
      destinationMovementId: inMovDocId,
      createdAt: transferSnap.exists ? transferSnap.data().createdAt : nowIso,
    };

    tx.set(transferRef, transferRecord);

    return {
      transfer: transferRecord,
      outflowMovement: outMovSnap.exists ? outMovSnap.data() : candidateOutMov,
      inflowMovement: inMovSnap.exists ? inMovSnap.data() : candidateInMov,
      isIdempotentReplay: false,
    };
  });
}

/**
 * 5. Criação atômica de Receita ou Despesa Pessoal (Server-Side Admin SDK)
 */
export async function executeServerSideCreatePersonalTransaction(db, callerUid, payload) {
  if (!callerUid || typeof callerUid !== 'string' || !callerUid.trim()) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória para criar lançamento pessoal.');
  }
  const cleanUid = callerUid.trim();
  const params = payload || {};
  if (params.userId && String(params.userId).trim() !== cleanUid) {
    throw new HttpsError('permission-denied', 'Acesso negado: userId divergente do usuário autenticado.');
  }
  if (!validatePositiveCentsServer(params.amountCents)) {
    throw new HttpsError('invalid-argument', 'O valor da transação deve ser um inteiro estritamente positivo em centavos.');
  }
  const cleanDesc = String(params.description || '').trim();
  if (!cleanDesc) {
    throw new HttpsError('invalid-argument', 'A descrição da transação é obrigatória.');
  }
  if (params.type !== 'income' && params.type !== 'expense') {
    throw new HttpsError('invalid-argument', 'Tipo de transação inválido. Use income ou expense.');
  }
  const competenceDate = String(params.competenceDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(competenceDate)) {
    throw new HttpsError('invalid-argument', 'Data de competência inválida. Use o formato YYYY-MM-DD.');
  }
  const dueDate = params.dueDate ? String(params.dueDate).trim() : competenceDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    throw new HttpsError('invalid-argument', 'Data de vencimento inválida. Use o formato YYYY-MM-DD.');
  }

  const initialStatus = params.status || 'pending';
  if (initialStatus === 'paid' && !params.accountId?.trim()) {
    throw new HttpsError(
      'invalid-argument',
      'Uma conta bancária, carteira ou cartão é obrigatório para transações pagas.'
    );
  }

  const providedIdemKey = params.idempotencyKey ? String(params.idempotencyKey).trim() : '';
  const txId = providedIdemKey
    ? `ptx_${providedIdemKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20)}_${sha256HexServer(`${cleanUid}:${providedIdemKey}`)}`
    : `ptx_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  const canonicalIdemKey = providedIdemKey || `idem_ptx_${cleanUid}_${txId}_${params.amountCents}`;

  const txRef = db.collection('users').doc(cleanUid).collection('personal_transactions').doc(txId);

  return await db.runTransaction(async (tx) => {
    const txSnap = await tx.get(txRef);
    if (txSnap.exists) {
      const existing = txSnap.data();
      if (
        existing.type !== params.type ||
        existing.amountCents !== params.amountCents ||
        existing.competenceDate !== competenceDate
      ) {
        throw new HttpsError(
          'already-exists',
          `Conflito de idempotência: A chave "${canonicalIdemKey}" já foi utilizada para outra transação com parâmetros divergentes.`
        );
      }
      return { transaction: existing, isIdempotentReplay: true };
    }

    let targetAcc = null;
    let targetAccRef = null;
    let invRef = null;
    let invSnap = null;
    let chargeRef = null;
    let invoiceMonth = undefined;
    let movRef = null;
    let movSnap = null;
    let candidateMov = null;

    if (params.accountId && String(params.accountId).trim()) {
      targetAccRef = db.collection('accounts').doc(String(params.accountId).trim());
      const accSnap = await tx.get(targetAccRef);
      if (!accSnap.exists) {
        throw new HttpsError('not-found', `Conta "${params.accountId}" não encontrada.`);
      }
      targetAcc = accSnap.data();
      if (targetAcc.userId !== cleanUid) {
        throw new HttpsError('permission-denied', 'Acesso negado: Você não é o titular desta conta.');
      }
      if (isAccountArchivedServer(targetAcc)) {
        throw new HttpsError(
          'failed-precondition',
          `A conta "${targetAcc.name}" está arquivada e não recebe lançamentos.`
        );
      }

      if (initialStatus === 'paid') {
        if (isCreditAccountServer(targetAcc)) {
          if (params.type === 'income') {
            throw new HttpsError(
              'invalid-argument',
              'Receitas não podem ter cartão de crédito como meio de recebimento.'
            );
          }
          const closingDay = targetAcc.closingDay || 20;
          invoiceMonth = calculateInvoiceMonthForPurchaseServer(competenceDate, closingDay);
          invRef = targetAccRef.collection('invoices').doc(invoiceMonth);
          chargeRef = invRef.collection('charges').doc(txId);
          invSnap = await tx.get(invRef);
        } else {
          const effectiveDate = params.paymentDate || competenceDate;
          const movIdemKey = `mov_${canonicalIdemKey}`;
          candidateMov = serverBuildFinancialMovement({
            accountId: targetAcc.id || String(params.accountId).trim(),
            userId: cleanUid,
            direction: params.type === 'income' ? 'inflow' : 'outflow',
            amountCents: params.amountCents,
            effectiveDate,
            originType: params.type === 'income' ? 'personal_income' : 'personal_expense',
            originId: txId,
            description: cleanDesc,
            notes: params.notes || `Lançamento individual (${params.categoryName || 'Geral'})`,
            authorUid: cleanUid,
            idempotencyKey: movIdemKey,
          });
          movRef = targetAccRef.collection('movements').doc(candidateMov.id);
          movSnap = await tx.get(movRef);
        }
      }
    }

    const nowIso = new Date().toISOString();
    let financialMovementId = undefined;
    let paidAmountCents = 0;
    let remainingAmountCents = params.amountCents;

    if (initialStatus === 'paid' && targetAcc && targetAccRef) {
      if (isCreditAccountServer(targetAcc) && invRef && chargeRef && invoiceMonth) {
        const closingDay = targetAcc.closingDay || 20;
        const dueDay = targetAcc.dueDay || 28;
        const { closingDate, dueDate: invDueDate } = buildInvoiceDatesServer(
          invoiceMonth,
          closingDay,
          dueDay
        );

        const chargeRecord = {
          id: txId,
          transactionId: txId,
          accountId: targetAcc.id || String(params.accountId).trim(),
          userId: cleanUid,
          invoiceMonth,
          description: cleanDesc,
          amountCents: params.amountCents,
          purchaseDate: competenceDate,
          categoryId: params.categoryId || 'uncategorized',
          categoryName: params.categoryName || 'Geral',
          status: 'active',
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        tx.set(chargeRef, chargeRecord);

        if (!invSnap.exists) {
          const baseInvoice = {
            id: invoiceMonth,
            accountId: targetAcc.id || String(params.accountId).trim(),
            userId: cleanUid,
            invoiceMonth,
            closingDate,
            dueDate: invDueDate,
            totalPurchasesAmountCents: params.amountCents,
            carriedOverBalanceCents: 0,
            interestAndFeesCents: 0,
            totalDueAmountCents: params.amountCents,
            totalPaidAmountCents: 0,
            remainingBalanceCents: params.amountCents,
            invoiceStatus: 'open',
            updatedAt: nowIso,
          };
          baseInvoice.invoiceStatus = computeInvoiceStatusServer(baseInvoice);
          tx.set(invRef, baseInvoice);
        } else {
          const invData = invSnap.data();
          const newPurchases = (invData.totalPurchasesAmountCents || 0) + params.amountCents;
          const newTotalDue =
            newPurchases + (invData.carriedOverBalanceCents || 0) + (invData.interestAndFeesCents || 0);
          const newRemaining = Math.max(0, newTotalDue - (invData.totalPaidAmountCents || 0));
          const updatedInv = {
            ...invData,
            totalPurchasesAmountCents: newPurchases,
            totalDueAmountCents: newTotalDue,
            remainingBalanceCents: newRemaining,
            updatedAt: nowIso,
          };
          updatedInv.invoiceStatus = computeInvoiceStatusServer(updatedInv);
          tx.set(invRef, updatedInv, { merge: true });
        }

        paidAmountCents = params.amountCents;
        remainingAmountCents = 0;
      } else if (candidateMov && movRef) {
        if (movSnap && movSnap.exists) {
          serverValidateMovementPayloadMatch(movSnap.data(), candidateMov);
        } else {
          const delta =
            candidateMov.direction === 'inflow'
              ? candidateMov.amountCents
              : -candidateMov.amountCents;
          tx.set(movRef, candidateMov);
          tx.update(targetAccRef, {
            projectedBalanceCents: (targetAcc.projectedBalanceCents || 0) + delta,
            updatedAt: nowIso,
          });
        }
        financialMovementId = candidateMov.id;
        paidAmountCents = params.amountCents;
        remainingAmountCents = 0;

        const initPayRef = txRef.collection('payments').doc(`txpay_init_${txId}`);
        tx.set(initPayRef, {
          id: `txpay_init_${txId}`,
          transactionId: txId,
          userId: cleanUid,
          amountCents: params.amountCents,
          paymentDate: params.paymentDate || competenceDate,
          accountId: targetAcc.id || String(params.accountId).trim(),
          financialMovementId: candidateMov.id,
          authorUid: cleanUid,
          idempotencyKey: canonicalIdemKey,
          notes: 'Pagamento integral inicial',
          createdAt: nowIso,
        });
      }
    }

    const newTx = stripUndefined({
      id: txId,
      userId: cleanUid,
      description: cleanDesc,
      amountCents: params.amountCents,
      type: params.type,
      status: initialStatus,
      categoryId: params.categoryId || 'uncategorized',
      categoryName: params.categoryName || 'Geral',
      accountId: params.accountId ? String(params.accountId).trim() : undefined,
      competenceDate,
      dueDate,
      paymentDate:
        initialStatus === 'paid' ? params.paymentDate || competenceDate : undefined,
      invoiceMonth,
      financialMovementId,
      originType: params.originType || 'manual',
      originRefId: params.originRefId,
      idempotencyKey: canonicalIdemKey,
      paidAmountCents,
      remainingAmountCents,
      notes: params.notes ? String(params.notes).trim() : undefined,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    tx.set(txRef, newTx);

    return {
      transaction: newTx,
      isIdempotentReplay: false,
    };
  });
}

/**
 * 6. Liquidação parcial ou integral de transação pessoal (Server-Side Admin SDK)
 */
export async function executeServerSideRecordPersonalPayment(db, callerUid, payload) {
  if (!callerUid || typeof callerUid !== 'string' || !callerUid.trim()) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória para liquidar lançamento.');
  }
  const cleanUid = callerUid.trim();
  const params = payload || {};
  if (params.userId && String(params.userId).trim() !== cleanUid) {
    throw new HttpsError('permission-denied', 'Acesso negado: userId divergente do usuário autenticado.');
  }
  if (params.authorUid && String(params.authorUid).trim() !== cleanUid) {
    throw new HttpsError('permission-denied', 'Acesso negado: authorUid divergente do usuário autenticado.');
  }
  if (!params.txId && !params.transactionId) {
    throw new HttpsError('invalid-argument', 'txId é obrigatório.');
  }
  if (!validatePositiveCentsServer(params.amountCents)) {
    throw new HttpsError('invalid-argument', 'O valor do pagamento parcial deve ser estritamente positivo em centavos.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(params.paymentDate || ''))) {
    throw new HttpsError('invalid-argument', 'Data de pagamento inválida (YYYY-MM-DD).');
  }
  if (!params.accountId || !String(params.accountId).trim()) {
    throw new HttpsError('invalid-argument', 'Conta bancária (accountId) é obrigatória.');
  }

  const txId = String(params.txId || params.transactionId).trim();
  const targetAccountId = String(params.accountId).trim();
  const idemKey = params.idempotencyKey ? String(params.idempotencyKey).trim() : undefined;
  const paymentId = idemKey
    ? `txpay_${txId}_${idemKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20)}_${sha256HexServer(`${cleanUid}:${txId}:${idemKey}`)}`
    : `txpay_${txId}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;

  const txRef = db.collection('users').doc(cleanUid).collection('personal_transactions').doc(txId);
  const payRef = txRef.collection('payments').doc(paymentId);
  const targetAccRef = db.collection('accounts').doc(targetAccountId);

  return await db.runTransaction(async (tx) => {
    const [txSnap, paySnap, accSnap] = await Promise.all([
      tx.get(txRef),
      tx.get(payRef),
      tx.get(targetAccRef),
    ]);

    if (!txSnap.exists) {
      throw new HttpsError('not-found', `Transação "${txId}" não encontrada.`);
    }
    const txData = txSnap.data();
    if (txData.userId !== cleanUid) {
      throw new HttpsError('permission-denied', 'Acesso negado a esta transação.');
    }
    if (txData.status === 'cancelled') {
      throw new HttpsError(
        'failed-precondition',
        'Não é permitido registrar pagamentos para uma transação cancelada.'
      );
    }

    if (paySnap.exists) {
      const existingPay = paySnap.data();
      if (
        existingPay.amountCents !== params.amountCents ||
        existingPay.accountId !== targetAccountId
      ) {
        throw new HttpsError(
          'already-exists',
          `Conflito de idempotência: A chave "${idemKey}" já foi utilizada para outro pagamento parcial com parâmetros divergentes.`
        );
      }
      return {
        transaction: txData,
        paymentRecord: existingPay,
        isIdempotentReplay: true,
      };
    }

    const currentRemaining = txData.remainingAmountCents ?? txData.amountCents;
    if (txData.status === 'paid' && currentRemaining <= 0) {
      throw new HttpsError('failed-precondition', 'Esta obrigação já está integralmente liquidada.');
    }
    if (params.amountCents > currentRemaining) {
      throw new HttpsError(
        'invalid-argument',
        `O valor informado (${params.amountCents} centavos) ultrapassa o saldo devedor restante (${currentRemaining} centavos). Excedentes não são permitidos sem tratamento explícito.`
      );
    }

    if (!accSnap.exists) {
      throw new HttpsError('not-found', `Conta bancária "${targetAccountId}" não encontrada.`);
    }
    const targetAcc = accSnap.data();
    if (targetAcc.userId !== cleanUid) {
      throw new HttpsError('permission-denied', 'Acesso negado à conta selecionada.');
    }
    if (isAccountArchivedServer(targetAcc)) {
      throw new HttpsError(
        'failed-precondition',
        `A conta "${targetAcc.name}" está arquivada e não recebe lançamentos.`
      );
    }

    const nowIso = new Date().toISOString();
    let movement = undefined;

    if (txData.type === 'expense' && isCreditAccountServer(targetAcc)) {
      const closingDay = targetAcc.closingDay || 20;
      const dueDay = targetAcc.dueDay || 28;
      const invMonth = calculateInvoiceMonthForPurchaseServer(params.paymentDate, closingDay);
      const invRef = targetAccRef.collection('invoices').doc(invMonth);
      const chargeRef = invRef.collection('charges').doc(paymentId);
      const invSnap = await tx.get(invRef);

      tx.set(chargeRef, {
        id: paymentId,
        transactionId: txId,
        accountId: targetAccountId,
        userId: cleanUid,
        invoiceMonth: invMonth,
        description: txData.description,
        amountCents: params.amountCents,
        purchaseDate: params.paymentDate,
        categoryId: txData.categoryId || 'uncategorized',
        categoryName: txData.categoryName || 'Geral',
        status: 'active',
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      if (!invSnap.exists) {
        const { closingDate, dueDate } = buildInvoiceDatesServer(invMonth, closingDay, dueDay);
        const newInv = {
          id: invMonth,
          accountId: targetAccountId,
          userId: cleanUid,
          invoiceMonth: invMonth,
          closingDate,
          dueDate,
          totalPurchasesAmountCents: params.amountCents,
          carriedOverBalanceCents: 0,
          interestAndFeesCents: 0,
          totalDueAmountCents: params.amountCents,
          totalPaidAmountCents: 0,
          remainingBalanceCents: params.amountCents,
          invoiceStatus: 'open',
          updatedAt: nowIso,
        };
        newInv.invoiceStatus = computeInvoiceStatusServer(newInv);
        tx.set(invRef, newInv);
      } else {
        const invData = invSnap.data();
        const newPurchases = (invData.totalPurchasesAmountCents || 0) + params.amountCents;
        const newTotalDue =
          newPurchases + (invData.carriedOverBalanceCents || 0) + (invData.interestAndFeesCents || 0);
        const newRemaining = Math.max(0, newTotalDue - (invData.totalPaidAmountCents || 0));
        const updatedInv = {
          ...invData,
          totalPurchasesAmountCents: newPurchases,
          totalDueAmountCents: newTotalDue,
          remainingBalanceCents: newRemaining,
          updatedAt: nowIso,
        };
        updatedInv.invoiceStatus = computeInvoiceStatusServer(updatedInv);
        tx.set(invRef, updatedInv, { merge: true });
      }
    } else {
      const direction = txData.type === 'income' ? 'inflow' : 'outflow';
      const originType = txData.type === 'income' ? 'personal_income' : 'personal_expense';
      const desc = `${txData.type === 'income' ? 'Recebimento parcial' : 'Pagamento parcial'}: ${txData.description}`;
      const movIdemKey = idemKey || `idem_${paymentId}`;

      const candidateMov = serverBuildFinancialMovement({
        accountId: targetAccountId,
        userId: cleanUid,
        direction,
        amountCents: params.amountCents,
        effectiveDate: params.paymentDate,
        originType,
        originId: paymentId,
        description: desc,
        notes: params.notes || `Amortização de #${txData.id}`,
        authorUid: cleanUid,
        idempotencyKey: movIdemKey,
      });

      const movRef = targetAccRef.collection('movements').doc(candidateMov.id);
      const movSnap = await tx.get(movRef);

      if (movSnap.exists) {
        serverValidateMovementPayloadMatch(movSnap.data(), candidateMov);
        movement = movSnap.data();
      } else {
        const delta =
          candidateMov.direction === 'inflow'
            ? candidateMov.amountCents
            : -candidateMov.amountCents;
        tx.set(movRef, candidateMov);
        tx.update(targetAccRef, {
          projectedBalanceCents: (targetAcc.projectedBalanceCents || 0) + delta,
          updatedAt: nowIso,
        });
        movement = candidateMov;
      }
    }

    const paymentRecord = stripUndefined({
      id: paymentId,
      transactionId: txId,
      userId: cleanUid,
      amountCents: params.amountCents,
      paymentDate: params.paymentDate,
      accountId: targetAccountId,
      financialMovementId: movement ? movement.id : paymentId,
      authorUid: cleanUid,
      idempotencyKey: idemKey,
      notes: params.notes ? String(params.notes).trim() : undefined,
      createdAt: nowIso,
    });

    const newPaidAmount = (txData.paidAmountCents || 0) + params.amountCents;
    const newRemaining = txData.amountCents - newPaidAmount;
    const newStatus = newRemaining === 0 ? 'paid' : 'partially_paid';

    const updatedTx = stripUndefined({
      ...txData,
      paidAmountCents: newPaidAmount,
      remainingAmountCents: newRemaining,
      status: newStatus,
      paymentDate: newRemaining === 0 ? params.paymentDate : txData.paymentDate,
      accountId: txData.accountId || targetAccountId,
      financialMovementId: txData.financialMovementId || (movement ? movement.id : undefined),
      updatedAt: nowIso,
    });

    tx.set(payRef, paymentRecord);
    tx.set(txRef, updatedTx, { merge: true });

    return {
      transaction: updatedTx,
      paymentRecord,
      movement,
      isIdempotentReplay: false,
    };
  });
}

/**
 * 7. Cancelamento atômico de transação pessoal com reversão compensatória integral (Server-Side Admin SDK)
 * Estorna todos os movimentos financeiros vinculados (pagamento único ou múltiplos pagamentos parciais)
 * ou cancela o encargo na fatura do cartão sem apagar o histórico.
 */
export async function executeServerSideCancelPersonalTransaction(db, callerUid, payload) {
  if (!callerUid || typeof callerUid !== 'string' || !callerUid.trim()) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória para cancelar lançamento.');
  }
  const cleanUid = callerUid.trim();
  const { userId, txId, transactionId, reason } = payload || {};
  if (userId && String(userId).trim() !== cleanUid) {
    throw new HttpsError('permission-denied', 'Acesso negado: userId divergente do usuário autenticado.');
  }
  const targetTxId = String(txId || transactionId || '').trim();
  if (!targetTxId) {
    throw new HttpsError('invalid-argument', 'txId é obrigatório.');
  }
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) {
    throw new HttpsError('invalid-argument', 'Justificativa para cancelamento da transação é obrigatória.');
  }

  const txRef = db
    .collection('users')
    .doc(cleanUid)
    .collection('personal_transactions')
    .doc(targetTxId);

  return await db.runTransaction(async (tx) => {
    const [txSnap, paymentsSnap, paymentReversalsSnap] = await Promise.all([
      tx.get(txRef),
      tx.get(txRef.collection('payments')),
      tx.get(txRef.collection('payment_reversals')),
    ]);

    if (!txSnap.exists) {
      throw new HttpsError('not-found', `Transação "${targetTxId}" não encontrada.`);
    }
    const txData = txSnap.data();
    if (txData.userId !== cleanUid) {
      throw new HttpsError('permission-denied', 'Acesso negado a esta transação.');
    }
    if (txData.status === 'cancelled') {
      return { transaction: txData, isIdempotentReplay: true };
    }

    // Identifica pagamentos que já possuem estorno compensatório prévio gravado
    const existingReversedPaymentIds = new Set();
    paymentReversalsSnap.forEach((docSnap) => {
      const revData = docSnap.data();
      if (revData.paymentId) {
        existingReversedPaymentIds.add(revData.paymentId);
      }
    });

    // Coleta todos os pares (accountId, movementId) que precisam de estorno compensatório
    const movementsToReverseMap = new Map();
    paymentsSnap.forEach((docSnap) => {
      const pay = docSnap.data();
      if (pay.financialMovementId && pay.accountId) {
        movementsToReverseMap.set(`${pay.accountId}:${pay.financialMovementId}`, {
          accountId: pay.accountId,
          movementId: pay.financialMovementId,
        });
      }
    });
    if (txData.financialMovementId && txData.accountId) {
      movementsToReverseMap.set(`${txData.accountId}:${txData.financialMovementId}`, {
        accountId: txData.accountId,
        movementId: txData.financialMovementId,
      });
    }

    const movementsToReverse = Array.from(movementsToReverseMap.values());
    const uniqueAccountIds = Array.from(
      new Set([
        ...movementsToReverse.map((m) => m.accountId),
        ...(txData.accountId ? [txData.accountId] : []),
      ])
    );

    // Lê todas as contas, movimentos originais e movimentos de estorno ANTES de qualquer escrita
    const accountSnapsMap = new Map();
    for (const accId of uniqueAccountIds) {
      const accRef = db.collection('accounts').doc(accId);
      accountSnapsMap.set(accId, { ref: accRef, snap: await tx.get(accRef) });
    }

    const movReads = [];
    for (const { accountId, movementId } of movementsToReverse) {
      const accRef = db.collection('accounts').doc(accountId);
      const origRef = accRef.collection('movements').doc(movementId);
      const revDocId = serverGenerateReversalDocId(movementId);
      const revRef = accRef.collection('movements').doc(revDocId);
      const [origSnap, revSnap] = await Promise.all([tx.get(origRef), tx.get(revRef)]);
      movReads.push({ accountId, movementId, origRef, origSnap, revRef, revSnap });
    }

    // Se for compra de cartão de crédito alocada em fatura, lê a fatura e o encargo antes das escritas
    let cardInvRef = null;
    let cardInvSnap = null;
    let cardChargeRef = null;
    let cardChargeSnap = null;

    const mainAccountEntry = txData.accountId ? accountSnapsMap.get(txData.accountId) : null;
    const isCardPurchase =
      txData.type === 'expense' &&
      txData.accountId &&
      mainAccountEntry?.snap?.exists &&
      isCreditAccountServer(mainAccountEntry.snap.data()) &&
      (txData.status === 'paid' || txData.status === 'partially_paid');

    if (isCardPurchase) {
      const cardData = mainAccountEntry.snap.data();
      const invMonth =
        txData.invoiceMonth ||
        calculateInvoiceMonthForPurchaseServer(txData.competenceDate, cardData.closingDay || 20);
      cardInvRef = mainAccountEntry.ref.collection('invoices').doc(invMonth);
      cardChargeRef = cardInvRef.collection('charges').doc(txData.id);
      [cardInvSnap, cardChargeSnap] = await Promise.all([
        tx.get(cardInvRef),
        tx.get(cardChargeRef),
      ]);
    }

    const nowIso = new Date().toISOString();
    const accountBalancesDelta = new Map();

    for (const item of movReads) {
      if (item.origSnap.exists && !item.revSnap.exists) {
        const origMov = item.origSnap.data();
        const compMov = serverBuildCompensatoryMovement({
          originalMovement: origMov,
          authorUid: cleanUid,
          reason: `Cancelamento de transação: ${cleanReason}`,
        });
        tx.set(item.revRef, compMov);
        const delta = compMov.direction === 'inflow' ? compMov.amountCents : -compMov.amountCents;
        accountBalancesDelta.set(
          item.accountId,
          (accountBalancesDelta.get(item.accountId) || 0) + delta
        );
      }
    }

    for (const [accId, totalDelta] of accountBalancesDelta.entries()) {
      const accEntry = accountSnapsMap.get(accId);
      if (accEntry && accEntry.snap.exists) {
        const currentBal = accEntry.snap.data().projectedBalanceCents || 0;
        tx.update(accEntry.ref, {
          projectedBalanceCents: currentBal + totalDelta,
          updatedAt: nowIso,
        });
      }
    }

    // Histórico estritamente imutável: NUNCA atualiza ou apaga os pagamentos originais.
    // Registra novo evento compensatório em 'payment_reversals' para cada pagamento ainda não revertido.
    paymentsSnap.forEach((docSnap) => {
      const payData = docSnap.data();
      const payId = payData.id || docSnap.id;
      if (!existingReversedPaymentIds.has(payId)) {
        const matchingMovRead = movReads.find(
          (m) => m.movementId === payData.financialMovementId
        );
        const reversalMovId = matchingMovRead ? matchingMovRead.revRef.id : '';
        const payRevDocId = serverGeneratePaymentReversalDocId(payId);
        const payRevRef = txRef.collection('payment_reversals').doc(payRevDocId);
        const reversalRecord = stripUndefined({
          id: payRevDocId,
          transactionId: targetTxId,
          paymentId: payId,
          userId: cleanUid,
          amountCents: payData.amountCents,
          originalFinancialMovementId: payData.financialMovementId || '',
          reversalMovementId: reversalMovId,
          reversalDate: nowIso.split('T')[0],
          reversedAt: nowIso,
          authorUid: cleanUid,
          reason: `Cancelamento de transação: ${cleanReason}`,
          idempotencyKey: `cancel_payrev_${payId}`,
          createdAt: nowIso,
        });
        tx.set(payRevRef, reversalRecord);
        existingReversedPaymentIds.add(payId);
      }
    });

    if (cardInvRef && cardInvSnap && cardInvSnap.exists) {
      const invData = cardInvSnap.data();
      const chargeAmount =
        cardChargeSnap && cardChargeSnap.exists
          ? cardChargeSnap.data().amountCents
          : txData.paidAmountCents || txData.amountCents;
      const isAlreadyCancelled =
        cardChargeSnap && cardChargeSnap.exists && cardChargeSnap.data().status === 'cancelled';

      if (!isAlreadyCancelled) {
        if (cardChargeRef && cardChargeSnap && cardChargeSnap.exists) {
          tx.update(cardChargeRef, {
            status: 'cancelled',
            updatedAt: nowIso,
          });
        }
        const newPurchases = Math.max(0, (invData.totalPurchasesAmountCents || 0) - chargeAmount);
        const newTotalDue =
          newPurchases + (invData.carriedOverBalanceCents || 0) + (invData.interestAndFeesCents || 0);
        const newRemaining = Math.max(0, newTotalDue - (invData.totalPaidAmountCents || 0));
        const updatedInv = {
          ...invData,
          totalPurchasesAmountCents: newPurchases,
          totalDueAmountCents: newTotalDue,
          remainingBalanceCents: newRemaining,
          updatedAt: nowIso,
        };
        updatedInv.invoiceStatus = computeInvoiceStatusServer(updatedInv);
        tx.set(cardInvRef, updatedInv, { merge: true });
      }
    }

    const updatedNotes = `${txData.notes ? `${txData.notes} | ` : ''}Cancelada: ${cleanReason}`;
    const updatedTx = {
      ...txData,
      status: 'cancelled',
      remainingAmountCents: 0,
      notes: updatedNotes,
      updatedAt: nowIso,
    };

    tx.update(txRef, {
      status: 'cancelled',
      remainingAmountCents: 0,
      notes: updatedNotes,
      updatedAt: nowIso,
    });

    return {
      transaction: updatedTx,
      isIdempotentReplay: false,
    };
  });
}

/**
 * 8. Alocação / Inicialização atômica de compra em fatura de cartão (Server-Side Admin SDK)
 */
export async function executeServerSideAttachPurchaseToInvoice(db, callerUid, payload) {
  if (!callerUid || typeof callerUid !== 'string' || !callerUid.trim()) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória para operar fatura de cartão.');
  }
  const cleanUid = callerUid.trim();
  const params = payload || {};
  if (params.userId && String(params.userId).trim() !== cleanUid) {
    throw new HttpsError('permission-denied', 'Acesso negado: userId divergente do usuário autenticado.');
  }
  const cardAccountId = String(params.cardAccountId || params.accountId || '').trim();
  if (!cardAccountId) {
    throw new HttpsError('invalid-argument', 'cardAccountId é obrigatório.');
  }

  const cardAccRef = db.collection('accounts').doc(cardAccountId);

  return await db.runTransaction(async (tx) => {
    const cardSnap = await tx.get(cardAccRef);
    if (!cardSnap.exists || cardSnap.data().userId !== cleanUid) {
      throw new HttpsError('permission-denied', 'Cartão de crédito não encontrado ou acesso negado.');
    }
    const cardAcc = cardSnap.data();
    if (!isCreditAccountServer(cardAcc)) {
      throw new HttpsError('invalid-argument', `A conta "${cardAcc.name}" não é um cartão de crédito.`);
    }

    const closingDay = cardAcc.closingDay || 20;
    const dueDay = cardAcc.dueDay || 28;
    const invoiceMonth =
      params.invoiceMonth ||
      calculateInvoiceMonthForPurchaseServer(params.purchaseDate, closingDay);
    const invRef = cardAccRef.collection('invoices').doc(invoiceMonth);
    const invSnap = await tx.get(invRef);

    const amountCents = Number(params.amountCents || 0);
    const nowIso = new Date().toISOString();

    if (params.chargeId || params.transactionId) {
      const chargeId = String(params.chargeId || params.transactionId).trim();
      const chargeRef = invRef.collection('charges').doc(chargeId);
      const chargeSnap = await tx.get(chargeRef);
      if (chargeSnap.exists) {
        return {
          invoice: invSnap.data(),
          charge: chargeSnap.data(),
          isIdempotentReplay: true,
        };
      }
      if (amountCents > 0) {
        tx.set(chargeRef, {
          id: chargeId,
          transactionId: chargeId,
          accountId: cardAccountId,
          userId: cleanUid,
          invoiceMonth,
          description: String(params.description || 'Compra no Cartão').trim(),
          amountCents,
          purchaseDate: params.purchaseDate || nowIso.slice(0, 10),
          categoryId: params.categoryId || 'uncategorized',
          categoryName: params.categoryName || 'Geral',
          status: 'active',
          createdAt: nowIso,
          updatedAt: nowIso,
        });
      }
    }

    if (!invSnap.exists) {
      const { closingDate, dueDate } = buildInvoiceDatesServer(invoiceMonth, closingDay, dueDay);
      const newInvoice = {
        id: invoiceMonth,
        accountId: cardAccountId,
        userId: cleanUid,
        invoiceMonth,
        closingDate,
        dueDate,
        totalPurchasesAmountCents: amountCents,
        carriedOverBalanceCents: 0,
        interestAndFeesCents: 0,
        totalDueAmountCents: amountCents,
        totalPaidAmountCents: 0,
        remainingBalanceCents: amountCents,
        invoiceStatus: 'open',
        updatedAt: nowIso,
      };
      newInvoice.invoiceStatus = computeInvoiceStatusServer(newInvoice);
      tx.set(invRef, newInvoice);
      return { invoice: newInvoice, isIdempotentReplay: false };
    }

    if (amountCents === 0) {
      return { invoice: invSnap.data(), isIdempotentReplay: true };
    }

    const invData = invSnap.data();
    const newPurchases = (invData.totalPurchasesAmountCents || 0) + amountCents;
    const newTotalDue =
      newPurchases + (invData.carriedOverBalanceCents || 0) + (invData.interestAndFeesCents || 0);
    const newRemaining = Math.max(0, newTotalDue - (invData.totalPaidAmountCents || 0));
    const updatedInvoice = {
      ...invData,
      totalPurchasesAmountCents: newPurchases,
      totalDueAmountCents: newTotalDue,
      remainingBalanceCents: newRemaining,
      updatedAt: nowIso,
    };
    updatedInvoice.invoiceStatus = computeInvoiceStatusServer(updatedInvoice);
    tx.set(invRef, updatedInvoice, { merge: true });

    return { invoice: updatedInvoice, isIdempotentReplay: false };
  });
}

/**
 * 9. Pagamento total ou parcial de fatura de cartão (Server-Side Admin SDK)
 * Debita a conta bancária pagadora (originType: 'credit_card_payment') e reduz a obrigação da fatura
 * sem criar nova despesa pessoal.
 */
export async function executeServerSidePayCardInvoice(db, callerUid, payload) {
  if (!callerUid || typeof callerUid !== 'string' || !callerUid.trim()) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória para pagar fatura de cartão.');
  }
  const cleanUid = callerUid.trim();
  const params = payload || {};
  if (params.userId && String(params.userId).trim() !== cleanUid) {
    throw new HttpsError('permission-denied', 'Acesso negado: userId divergente do usuário autenticado.');
  }
  if (!params.cardAccountId || !params.sourceAccountId || !params.invoiceMonth) {
    throw new HttpsError('invalid-argument', 'cardAccountId, sourceAccountId e invoiceMonth são obrigatórios.');
  }
  if (params.cardAccountId === params.sourceAccountId) {
    throw new HttpsError('invalid-argument', 'A conta pagadora não pode ser o próprio cartão de crédito.');
  }
  if (!validatePositiveCentsServer(params.amountPaidCents)) {
    throw new HttpsError('invalid-argument', 'O valor do pagamento da fatura deve ser um inteiro positivo em centavos.');
  }
  if (!/^\d{4}-\d{2}$/.test(String(params.invoiceMonth || ''))) {
    throw new HttpsError('invalid-argument', 'Competência da fatura inválida (YYYY-MM).');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(params.paymentDate || ''))) {
    throw new HttpsError('invalid-argument', 'Data de pagamento inválida (YYYY-MM-DD).');
  }

  const idemKey = params.idempotencyKey
    ? String(params.idempotencyKey).trim()
    : `idem_invpay_${params.cardAccountId}_${params.invoiceMonth}_${params.amountPaidCents}_${params.paymentDate}`;
  const cleanSlug = idemKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
  const paymentId = `invpay_${cleanSlug}_${sha256HexServer(`${cleanUid}:${idemKey}`)}`;
  const movDocId = serverGenerateMovementDocId(params.sourceAccountId, idemKey);

  const cardAccRef = db.collection('accounts').doc(String(params.cardAccountId).trim());
  const srcAccRef = db.collection('accounts').doc(String(params.sourceAccountId).trim());
  const invRef = cardAccRef.collection('invoices').doc(String(params.invoiceMonth).trim());
  const payRef = invRef.collection('payments').doc(paymentId);
  const movRef = srcAccRef.collection('movements').doc(movDocId);

  return await db.runTransaction(async (tx) => {
    const [cardSnap, srcSnap, invSnap, paySnap, movSnap] = await Promise.all([
      tx.get(cardAccRef),
      tx.get(srcAccRef),
      tx.get(invRef),
      tx.get(payRef),
      tx.get(movRef),
    ]);

    if (!cardSnap.exists || cardSnap.data().userId !== cleanUid) {
      throw new HttpsError('permission-denied', 'Cartão de crédito não encontrado ou acesso negado.');
    }
    if (!srcSnap.exists || srcSnap.data().userId !== cleanUid) {
      throw new HttpsError('permission-denied', 'Conta bancária pagadora não encontrada ou acesso negado.');
    }
    const cardAcc = cardSnap.data();
    const srcAcc = srcSnap.data();

    if (!isCreditAccountServer(cardAcc)) {
      throw new HttpsError('invalid-argument', 'A conta informada como cartão não é um cartão de crédito.');
    }
    if (isCreditAccountServer(srcAcc)) {
      throw new HttpsError(
        'invalid-argument',
        'Não é permitido pagar uma fatura utilizando outro cartão de crédito diretamente.'
      );
    }
    if (isAccountArchivedServer(srcAcc)) {
      throw new HttpsError('failed-precondition', 'A conta pagadora está arquivada.');
    }
    if (!invSnap.exists) {
      throw new HttpsError('not-found', `Fatura "${params.invoiceMonth}" do cartão não encontrada.`);
    }
    const invData = invSnap.data();

    if (paySnap.exists) {
      const existingPay = paySnap.data();
      if (
        existingPay.amountPaidCents !== params.amountPaidCents ||
        existingPay.sourceAccountId !== params.sourceAccountId ||
        existingPay.invoiceMonth !== params.invoiceMonth
      ) {
        throw new HttpsError(
          'already-exists',
          `Conflito de idempotência: A chave "${idemKey}" já foi utilizada para outro pagamento de fatura com parâmetros divergentes.`
        );
      }
      return {
        invoice: invData,
        payment: existingPay,
        movement: movSnap.exists ? movSnap.data() : null,
        isIdempotentReplay: true,
      };
    }

    if (invData.remainingBalanceCents <= 0) {
      throw new HttpsError(
        'failed-precondition',
        `A fatura ${params.invoiceMonth} não possui saldo devedor em aberto.`
      );
    }
    if (params.amountPaidCents > invData.remainingBalanceCents) {
      throw new HttpsError(
        'invalid-argument',
        `O valor pago (${params.amountPaidCents} centavos) excede o saldo devedor restante da fatura (${invData.remainingBalanceCents} centavos).`
      );
    }

    const nowIso = new Date().toISOString();
    const candidateMov = serverBuildFinancialMovement({
      id: movDocId,
      accountId: params.sourceAccountId,
      userId: cleanUid,
      direction: 'outflow',
      amountCents: params.amountPaidCents,
      effectiveDate: params.paymentDate,
      originType: 'credit_card_payment',
      originId: paymentId,
      description: `Pagamento de Fatura ${params.invoiceMonth}`,
      notes: params.notes || 'Amortização de fatura do cartão',
      authorUid: cleanUid,
      idempotencyKey: idemKey,
    });

    if (movSnap.exists) {
      serverValidateMovementPayloadMatch(movSnap.data(), candidateMov);
    } else {
      tx.set(movRef, candidateMov);
      tx.update(srcAccRef, {
        projectedBalanceCents: (srcAcc.projectedBalanceCents || 0) - params.amountPaidCents,
        updatedAt: nowIso,
      });
    }

    const newTotalPaid = (invData.totalPaidAmountCents || 0) + params.amountPaidCents;
    const totalDue =
      invData.totalDueAmountCents ??
      (invData.totalPurchasesAmountCents || 0) +
        (invData.carriedOverBalanceCents || 0) +
        (invData.interestAndFeesCents || 0);
    const newRemaining = Math.max(0, totalDue - newTotalPaid);
    const newStatus = newRemaining === 0 ? 'paid' : 'partially_paid';

    const paymentRecord = {
      id: paymentId,
      invoiceMonth: params.invoiceMonth,
      accountId: params.cardAccountId,
      sourceAccountId: params.sourceAccountId,
      amountPaidCents: params.amountPaidCents,
      paymentDate: params.paymentDate,
      financialMovementId: candidateMov.id,
      clientTransactionUuid: paymentId,
      idempotencyKey: idemKey,
      createdAt: nowIso,
    };

    const updatedInvoice = {
      ...invData,
      totalPaidAmountCents: newTotalPaid,
      remainingBalanceCents: newRemaining,
      invoiceStatus: newStatus,
      updatedAt: nowIso,
    };

    tx.set(payRef, paymentRecord);
    tx.set(invRef, updatedInvoice, { merge: true });

    return {
      invoice: updatedInvoice,
      payment: paymentRecord,
      movement: candidateMov,
      isIdempotentReplay: false,
    };
  });
}

/**
 * 10. Rolagem de saldo residual de fatura para o ciclo seguinte (Server-Side Admin SDK)
 * Quita a obrigação na fatura de origem por rolagem (remainingBalanceCents = 0, invoiceStatus = 'paid', carriedOverToMonth)
 * e transfere o principal + encargos para a fatura de destino sem duplicar o limite comprometido.
 */
export async function executeServerSideCarryOverInvoiceBalance(db, callerUid, payload) {
  if (!callerUid || typeof callerUid !== 'string' || !callerUid.trim()) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória para rolar saldo de fatura.');
  }
  const cleanUid = callerUid.trim();
  const params = payload || {};
  if (params.userId && String(params.userId).trim() !== cleanUid) {
    throw new HttpsError('permission-denied', 'Acesso negado: userId divergente do usuário autenticado.');
  }
  const cardAccountId = String(params.cardAccountId || params.cardAccount?.id || '').trim();
  if (!cardAccountId || !params.sourceInvoiceMonth || !params.targetInvoiceMonth) {
    throw new HttpsError(
      'invalid-argument',
      'cardAccountId, sourceInvoiceMonth e targetInvoiceMonth são obrigatórios.'
    );
  }
  if (params.targetInvoiceMonth <= params.sourceInvoiceMonth) {
    throw new HttpsError(
      'invalid-argument',
      'A competência de destino do saldo rolado deve ser posterior à competência de origem.'
    );
  }

  const rate = typeof params.interestRateMonthly === 'number' ? params.interestRateMonthly : 0.12;
  const carryId = `carry_${cardAccountId}_${params.sourceInvoiceMonth}_to_${params.targetInvoiceMonth}`;

  const cardAccRef = db.collection('accounts').doc(cardAccountId);
  const srcInvRef = cardAccRef.collection('invoices').doc(String(params.sourceInvoiceMonth).trim());
  const targetInvRef = cardAccRef.collection('invoices').doc(String(params.targetInvoiceMonth).trim());
  const carryRef = srcInvRef.collection('carry_overs').doc(carryId);

  return await db.runTransaction(async (tx) => {
    const [cardSnap, srcInvSnap, targetInvSnap, carrySnap] = await Promise.all([
      tx.get(cardAccRef),
      tx.get(srcInvRef),
      tx.get(targetInvRef),
      tx.get(carryRef),
    ]);

    if (!cardSnap.exists || cardSnap.data().userId !== cleanUid) {
      throw new HttpsError('permission-denied', 'Cartão de crédito não encontrado ou acesso negado.');
    }
    const cardAcc = cardSnap.data();

    if (carrySnap.exists) {
      return {
        sourceInvoice: srcInvSnap.data(),
        targetInvoice: targetInvSnap.data(),
        carryOver: carrySnap.data(),
        isIdempotentReplay: true,
      };
    }

    if (!srcInvSnap.exists) {
      throw new HttpsError('not-found', `Fatura de origem ${params.sourceInvoiceMonth} não encontrada.`);
    }
    const srcInv = srcInvSnap.data();
    if (srcInv.remainingBalanceCents <= 0) {
      throw new HttpsError(
        'failed-precondition',
        'A fatura de origem não possui saldo restante a ser transportado.'
      );
    }

    const nowIso = new Date().toISOString();
    const unpaidPrincipal = srcInv.remainingBalanceCents;
    const appliedInterest =
      typeof params.additionalInterestCents === 'number'
        ? params.additionalInterestCents
        : Math.round(unpaidPrincipal * rate);

    const carryOver = {
      id: carryId,
      sourceInvoiceMonth: params.sourceInvoiceMonth,
      targetInvoiceMonth: params.targetInvoiceMonth,
      unpaidPrincipalCents: unpaidPrincipal,
      interestRateMonthly: rate,
      appliedInterestCents: appliedInterest,
      status: 'active',
      createdAt: nowIso,
    };

    const updatedSourceInvoice = {
      ...srcInv,
      remainingBalanceCents: 0,
      invoiceStatus: 'carried_over',
      carriedOverToMonth: params.targetInvoiceMonth,
      updatedAt: nowIso,
    };

    tx.set(srcInvRef, updatedSourceInvoice, { merge: true });
    tx.set(carryRef, carryOver);

    const closingDay = cardAcc.closingDay || 20;
    const dueDay = cardAcc.dueDay || 28;
    const { closingDate, dueDate } = buildInvoiceDatesServer(
      params.targetInvoiceMonth,
      closingDay,
      dueDay
    );

    const baseTarget = targetInvSnap.exists
      ? targetInvSnap.data()
      : {
          id: params.targetInvoiceMonth,
          accountId: cardAccountId,
          userId: cleanUid,
          invoiceMonth: params.targetInvoiceMonth,
          closingDate,
          dueDate,
          totalPurchasesAmountCents: 0,
          carriedOverBalanceCents: 0,
          interestAndFeesCents: 0,
          totalDueAmountCents: 0,
          totalPaidAmountCents: 0,
          remainingBalanceCents: 0,
          invoiceStatus: 'open',
          updatedAt: nowIso,
        };

    const newCarriedOver = (baseTarget.carriedOverBalanceCents || 0) + unpaidPrincipal;
    const newInterest = (baseTarget.interestAndFeesCents || 0) + appliedInterest;
    const newTotalDue =
      (baseTarget.totalPurchasesAmountCents || 0) + newCarriedOver + newInterest;
    const newRemaining = Math.max(0, newTotalDue - (baseTarget.totalPaidAmountCents || 0));

    const updatedTargetInvoice = {
      ...baseTarget,
      carriedOverBalanceCents: newCarriedOver,
      interestAndFeesCents: newInterest,
      totalDueAmountCents: newTotalDue,
      remainingBalanceCents: newRemaining,
      updatedAt: nowIso,
    };
    updatedTargetInvoice.invoiceStatus = computeInvoiceStatusServer(updatedTargetInvoice);

    tx.set(targetInvRef, updatedTargetInvoice, { merge: true });

    return {
      sourceInvoice: updatedSourceInvoice,
      targetInvoice: updatedTargetInvoice,
      carryOver,
      isIdempotentReplay: false,
    };
  });
}

/**
 * 11. Criação atômica de pedido de reembolso individual (Server-Side Admin SDK)
 * Valida o vínculo obrigatório com uma despesa original válida do usuário.
 */
export async function executeServerSideCreatePersonalRefund(db, callerUid, payload) {
  if (!callerUid || typeof callerUid !== 'string' || !callerUid.trim()) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória para registrar reembolso.');
  }
  const cleanUid = callerUid.trim();
  const params = payload || {};
  if (params.userId && String(params.userId).trim() !== cleanUid) {
    throw new HttpsError('permission-denied', 'Acesso negado: userId divergente do usuário autenticado.');
  }
  if (!params.originalTransactionId || !String(params.originalTransactionId).trim()) {
    throw new HttpsError(
      'invalid-argument',
      'O reembolso deve referenciar a transação original (originalTransactionId).'
    );
  }
  const amountDueCents = params.amountDueCents ?? params.expectedAmountCents;
  if (!validatePositiveCentsServer(amountDueCents)) {
    throw new HttpsError(
      'invalid-argument',
      'O valor do reembolso deve ser um inteiro estritamente positivo em centavos.'
    );
  }
  const cleanDebtor = String(params.debtorName || '').trim();
  if (!cleanDebtor) {
    throw new HttpsError('invalid-argument', 'O nome do devedor/reembolsador é obrigatório.');
  }

  const origTxId = String(params.originalTransactionId).trim();
  const idemKey = params.idempotencyKey ? String(params.idempotencyKey).trim() : undefined;
  const refundId = idemKey
    ? `ref_${idemKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20)}_${sha256HexServer(`${cleanUid}:${idemKey}`)}`
    : `ref_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;

  const origTxRef = db.collection('users').doc(cleanUid).collection('personal_transactions').doc(origTxId);
  const refundRef = db.collection('users').doc(cleanUid).collection('personal_refunds').doc(refundId);

  return await db.runTransaction(async (tx) => {
    const [origTxSnap, refundSnap] = await Promise.all([tx.get(origTxRef), tx.get(refundRef)]);

    if (refundSnap.exists) {
      const existing = refundSnap.data();
      if (
        existing.originalTransactionId !== origTxId ||
        existing.amountDueCents !== amountDueCents
      ) {
        throw new HttpsError(
          'already-exists',
          `Conflito de idempotência: A chave "${idemKey}" já foi utilizada para outro reembolso com parâmetros divergentes.`
        );
      }
      return { refund: existing, isIdempotentReplay: true };
    }

    if (!origTxSnap.exists) {
      throw new HttpsError(
        'not-found',
        `Despesa original "${origTxId}" não encontrada para vincular ao reembolso.`
      );
    }
    const origTx = origTxSnap.data();
    if (origTx.userId !== cleanUid) {
      throw new HttpsError('permission-denied', 'Acesso negado à despesa original.');
    }
    if (origTx.type !== 'expense') {
      throw new HttpsError(
        'invalid-argument',
        'Reembolsos individuais só podem ser vinculados a despesas (expense).'
      );
    }
    if (origTx.status === 'cancelled') {
      throw new HttpsError(
        'failed-precondition',
        'Não é possível vincular um reembolso a uma despesa cancelada.'
      );
    }
    if (amountDueCents > origTx.amountCents) {
      throw new HttpsError(
        'invalid-argument',
        `O valor do reembolso (${amountDueCents} centavos) não pode exceder o valor da despesa original (${origTx.amountCents} centavos).`
      );
    }

    const nowIso = new Date().toISOString();
    const newRefund = stripUndefined({
      id: refundId,
      userId: cleanUid,
      originalTransactionId: origTxId,
      debtorName: cleanDebtor,
      amountDueCents,
      amountReceivedCents: 0,
      remainingAmountCents: amountDueCents,
      status: 'pending',
      description: String(params.description || '').trim() || `Reembolso de ${cleanDebtor}`,
      idempotencyKey: idemKey,
      notes: params.notes ? String(params.notes).trim() : undefined,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    tx.set(refundRef, newRefund);

    return {
      refund: newRefund,
      isIdempotentReplay: false,
    };
  });
}

/**
 * 12. Recebimento total ou parcial de reembolso individual (Server-Side Admin SDK)
 * Registra movimento de entrada com originType: 'personal_refund' na conta bancária escolhida
 * sem alterar faturas de cartão e sem apagar a despesa original.
 */
export async function executeServerSideRecordRefundReceipt(db, callerUid, payload) {
  if (!callerUid || typeof callerUid !== 'string' || !callerUid.trim()) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória para registrar recebimento de reembolso.');
  }
  const cleanUid = callerUid.trim();
  const params = payload || {};
  if (params.userId && String(params.userId).trim() !== cleanUid) {
    throw new HttpsError('permission-denied', 'Acesso negado: userId divergente do usuário autenticado.');
  }
  if (params.authorUid && String(params.authorUid).trim() !== cleanUid) {
    throw new HttpsError('permission-denied', 'Acesso negado: authorUid divergente do usuário autenticado.');
  }
  const amountCents = params.amountCents ?? params.amountReceivedCents;
  const receiptDate = String(params.receiptDate || params.receivedDate || '').trim();
  if (!params.refundId || !params.destinationAccountId) {
    throw new HttpsError('invalid-argument', 'refundId e destinationAccountId são obrigatórios.');
  }
  if (!validatePositiveCentsServer(amountCents)) {
    throw new HttpsError('invalid-argument', 'O valor do recebimento deve ser um inteiro positivo em centavos.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receiptDate)) {
    throw new HttpsError('invalid-argument', 'Data de recebimento inválida (YYYY-MM-DD).');
  }

  const refundId = String(params.refundId).trim();
  const destAccountId = String(params.destinationAccountId).trim();
  const idemKey = params.idempotencyKey
    ? String(params.idempotencyKey).trim()
    : `idem_refrec_${refundId}_${destAccountId}_${receiptDate}_${amountCents}`;
  const cleanSlug = idemKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
  const receiptId = `rec_${cleanSlug}_${sha256HexServer(`${cleanUid}:${refundId}:${idemKey}`)}`;
  const movDocId = serverGenerateMovementDocId(destAccountId, idemKey);

  const refundRef = db.collection('users').doc(cleanUid).collection('personal_refunds').doc(refundId);
  const receiptRef = refundRef.collection('receipts').doc(receiptId);
  const destAccRef = db.collection('accounts').doc(destAccountId);
  const movRef = destAccRef.collection('movements').doc(movDocId);

  return await db.runTransaction(async (tx) => {
    const [refundSnap, receiptSnap, destAccSnap, movSnap] = await Promise.all([
      tx.get(refundRef),
      tx.get(receiptRef),
      tx.get(destAccRef),
      tx.get(movRef),
    ]);

    if (!refundSnap.exists) {
      throw new HttpsError('not-found', `Reembolso "${refundId}" não encontrado.`);
    }
    const refund = refundSnap.data();
    if (refund.userId !== cleanUid) {
      throw new HttpsError('permission-denied', 'Acesso negado a este reembolso.');
    }

    if (!destAccSnap.exists || destAccSnap.data().userId !== cleanUid) {
      throw new HttpsError('permission-denied', `Conta bancária de destino "${destAccountId}" não encontrada.`);
    }
    const destAcc = destAccSnap.data();
    if (isCreditAccountServer(destAcc)) {
      throw new HttpsError(
        'invalid-argument',
        'O reembolso financeiro deve entrar em uma conta bancária/carteira (não em cartão de crédito).'
      );
    }
    if (isAccountArchivedServer(destAcc)) {
      throw new HttpsError(
        'failed-precondition',
        `A conta "${destAcc.name}" está arquivada e não pode receber créditos.`
      );
    }

    if (receiptSnap.exists) {
      const existingRec = receiptSnap.data();
      if (
        existingRec.amountCents !== amountCents ||
        existingRec.destinationAccountId !== destAccountId
      ) {
        throw new HttpsError(
          'already-exists',
          `Conflito de idempotência: A chave "${idemKey}" já foi utilizada para outro recebimento de reembolso com parâmetros divergentes.`
        );
      }
      return {
        refund,
        receipt: existingRec,
        movement: movSnap.exists ? movSnap.data() : null,
        isIdempotentReplay: true,
      };
    }

    if (refund.status === 'cancelled') {
      throw new HttpsError(
        'failed-precondition',
        'Não é permitido receber valores de um reembolso cancelado.'
      );
    }
    if (refund.status === 'received' && refund.remainingAmountCents <= 0) {
      throw new HttpsError('failed-precondition', 'Este reembolso já foi totalmente quitado.');
    }
    if (amountCents > refund.remainingAmountCents) {
      throw new HttpsError(
        'invalid-argument',
        `O valor recebido (${amountCents} centavos) excede o saldo devedor restante do reembolso (${refund.remainingAmountCents} centavos).`
      );
    }

    const nowIso = new Date().toISOString();
    const candidateMov = serverBuildFinancialMovement({
      id: movDocId,
      accountId: destAccountId,
      userId: cleanUid,
      direction: 'inflow',
      amountCents,
      effectiveDate: receiptDate,
      originType: 'personal_refund',
      originId: receiptId,
      description: `Reembolso recebido de ${refund.debtorName}`,
      notes:
        params.notes ||
        `Reembolso #${refund.id} (Despesa original #${refund.originalTransactionId})`,
      authorUid: cleanUid,
      idempotencyKey: idemKey,
    });

    if (movSnap.exists) {
      serverValidateMovementPayloadMatch(movSnap.data(), candidateMov);
    } else {
      tx.set(movRef, candidateMov);
      tx.update(destAccRef, {
        projectedBalanceCents: (destAcc.projectedBalanceCents || 0) + amountCents,
        updatedAt: nowIso,
      });
    }

    const newReceived = (refund.amountReceivedCents || 0) + amountCents;
    const newRemaining = refund.amountDueCents - newReceived;
    const newStatus = newRemaining === 0 ? 'received' : 'partially_received';

    const receiptRecord = stripUndefined({
      id: receiptId,
      refundId: refund.id,
      originalTransactionId: refund.originalTransactionId,
      userId: cleanUid,
      amountCents,
      receiptDate,
      destinationAccountId: destAccountId,
      financialMovementId: candidateMov.id,
      originType: 'personal_refund',
      idempotencyKey: idemKey,
      authorUid: cleanUid,
      notes: params.notes ? String(params.notes).trim() : undefined,
      createdAt: nowIso,
    });

    const updatedRefund = stripUndefined({
      ...refund,
      amountReceivedCents: newReceived,
      remainingAmountCents: newRemaining,
      status: newStatus,
      updatedAt: nowIso,
    });

    tx.set(receiptRef, receiptRecord);
    tx.set(refundRef, updatedRefund);

    return {
      refund: updatedRefund,
      receipt: receiptRecord,
      movement: candidateMov,
      isIdempotentReplay: false,
    };
  });
}

// Endpoints onCall Fases 3 e 4
export const recordFinancialMovementOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideRecordMovement(getAdminDb(), request.auth?.uid, request.data);
  }
);

export const reverseFinancialMovementOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideReverseMovement(getAdminDb(), request.auth?.uid, request.data);
  }
);

export const reconcileAccountBalanceOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideReconcileAccount(getAdminDb(), request.auth?.uid, request.data);
  }
);

export const executeInternalTransferOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideInternalTransfer(getAdminDb(), request.auth?.uid, request.data);
  }
);

export const createPersonalTransactionOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideCreatePersonalTransaction(
      getAdminDb(),
      request.auth?.uid,
      request.data
    );
  }
);

export const recordPersonalTransactionPaymentOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideRecordPersonalPayment(
      getAdminDb(),
      request.auth?.uid,
      request.data
    );
  }
);

export const cancelPersonalTransactionOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideCancelPersonalTransaction(
      getAdminDb(),
      request.auth?.uid,
      request.data
    );
  }
);

export const attachPurchaseToInvoiceOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideAttachPurchaseToInvoice(
      getAdminDb(),
      request.auth?.uid,
      request.data
    );
  }
);

export const payCardInvoiceOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSidePayCardInvoice(getAdminDb(), request.auth?.uid, request.data);
  }
);

export const carryOverInvoiceBalanceOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideCarryOverInvoiceBalance(
      getAdminDb(),
      request.auth?.uid,
      request.data
    );
  }
);

export const createPersonalRefundOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideCreatePersonalRefund(
      getAdminDb(),
      request.auth?.uid,
      request.data
    );
  }
);

export const recordRefundReceiptOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideRecordRefundReceipt(
      getAdminDb(),
      request.auth?.uid,
      request.data
    );
  }
);

// ==============================================================================
// BACKEND REAL — FASE 6: RATEIOS E REEMBOLSOS COMPARTILHADOS (v3.1)
// ==============================================================================

export function serverGenerateSharedExpenseDocId(spaceId, key) {
  const cleanSpace = String(spaceId || '').trim();
  const cleanKey = String(key || '').trim();
  const cleanSlug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  const hash = crypto.createHash('sha256').update(`exp:${cleanSpace}:${cleanKey}`).digest('hex');
  return `exp_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function serverGeneratePaymentDeclarationDocId(expenseId, key) {
  const cleanExp = String(expenseId || '').trim();
  const cleanKey = String(key || '').trim();
  const cleanSlug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  const hash = crypto.createHash('sha256').update(`decl:${cleanExp}:${cleanKey}`).digest('hex');
  return `decl_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function serverGeneratePaymentApprovalDocId(declarationId) {
  const cleanDecl = String(declarationId || '').trim();
  const cleanSlug = cleanDecl.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  const hash = crypto.createHash('sha256').update(`appr_canonical:${cleanDecl}`).digest('hex');
  return `appr_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function serverGeneratePaymentRejectionDocId(declarationId) {
  const cleanDecl = String(declarationId || '').trim();
  const cleanSlug = cleanDecl.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  const hash = crypto.createHash('sha256').update(`rej_canonical:${cleanDecl}`).digest('hex');
  return `rej_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function serverGenerateApprovalRevocationDocId(approvalId) {
  const cleanAppr = String(approvalId || '').trim();
  const cleanSlug = cleanAppr.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  const hash = crypto.createHash('sha256').update(`revoc_canonical:${cleanAppr}`).digest('hex');
  return `revoc_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function serverGenerateSupplierRefundDocId(expenseId, key) {
  const cleanExp = String(expenseId || '').trim();
  const cleanKey = String(key || '').trim();
  const cleanSlug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  const hash = crypto.createHash('sha256').update(`supref:${cleanExp}:${cleanKey}`).digest('hex');
  return `supref_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function serverGenerateRestitutionDocId(revocationId) {
  const cleanRevoc = String(revocationId || '').trim();
  const cleanSlug = cleanRevoc.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  const hash = crypto.createHash('sha256').update(`restit_canonical:${cleanRevoc}`).digest('hex');
  return `restit_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function serverGenerateRestitutionDeclarationDocId(restitutionId, key) {
  const cleanRestit = String(restitutionId || '').trim();
  const cleanKey = String(key || '').trim();
  const cleanSlug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  const hash = crypto.createHash('sha256').update(`restit_decl:${cleanRestit}:${cleanKey}`).digest('hex');
  return `restit_decl_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function serverGenerateRestitutionReceiptDocId(restitutionId, key) {
  const cleanRestit = String(restitutionId || '').trim();
  const cleanKey = String(key || '').trim();
  const cleanSlug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  const hash = crypto.createHash('sha256').update(`restit_rec_${cleanRestit}:${cleanKey}`).digest('hex');
  return `restit_rec_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export async function executeServerSideCreateSharedExpense(db, callerUid, payload) {
  if (!callerUid) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória.');
  }
  const cleanUid = callerUid.trim();
  const {
    spaceId,
    title,
    description,
    totalOriginalAmountCents,
    competenceMonth,
    competenceDate,
    dueDate,
    categoryId,
    categoryName,
    createdByUid,
    responsibleUid,
    payerUid,
    originType,
    originRefId,
    splitMethod,
    calculatedSplits = [],
    idempotencyKey,
  } = payload || {};

  if (!spaceId || !title || !totalOriginalAmountCents || !competenceMonth || !competenceDate) {
    throw new HttpsError('invalid-argument', 'Campos obrigatórios ausentes para criar despesa compartilhada.');
  }

  const spaceRef = db.collection('spaces').doc(String(spaceId).trim());
  const spaceSnap = await spaceRef.get();
  if (!spaceSnap.exists) {
    throw new HttpsError('not-found', `Espaço "${spaceId}" não encontrado.`);
  }
  const spaceData = spaceSnap.data();
  if (spaceData.spaceStatus === 'archived' || spaceData.spaceStatus === 'dissolved') {
    throw new HttpsError('failed-precondition', 'Espaço arquivado ou dissolvido: operações financeiras bloqueadas.');
  }
  if (!Array.isArray(spaceData.memberUids) || !spaceData.memberUids.includes(cleanUid)) {
    throw new HttpsError('permission-denied', 'Acesso negado: Você não é membro ativo deste espaço.');
  }

  // Verifica conservação contábil
  const sumSplits = calculatedSplits.reduce((acc, s) => acc + (s.assignedShareAmountCents || 0), 0);
  if (sumSplits !== totalOriginalAmountCents) {
    throw new HttpsError('invalid-argument', `A soma das cotas (${sumSplits}) deve ser estritamente igual ao total (${totalOriginalAmountCents}).`);
  }

  const finalKey =
    idempotencyKey?.trim() ||
    `idem_exp_${String(spaceId).trim()}_${cleanUid}_${String(title).trim()}_${totalOriginalAmountCents}_${String(competenceDate).trim()}`;
  const expenseId = serverGenerateSharedExpenseDocId(spaceId, finalKey);
  const expenseRef = spaceRef.collection('shared_expenses').doc(expenseId);

  return await db.runTransaction(async (tx) => {
    const expSnap = await tx.get(expenseRef);
    if (expSnap.exists) {
      const existingData = expSnap.data();
      if (
        existingData.totalOriginalAmountCents !== totalOriginalAmountCents ||
        existingData.title !== String(title).trim()
      ) {
        throw new HttpsError(
          'already-exists',
          'Conflito de idempotência: Chave já utilizada para uma despesa com parâmetros divergentes.'
        );
      }
      const liabsSnap = await spaceRef.collection('shared_expenses').doc(expenseId).collection('liabilities').get();
      const liabilities = liabsSnap.docs.map((d) => d.data());
      return { expense: existingData, liabilities };
    }

    const now = new Date().toISOString();
    const newExpense = {
      id: expenseId,
      spaceId: String(spaceId).trim(),
      title: String(title).trim(),
      description: description ? String(description).trim() : null,
      totalOriginalAmountCents,
      competenceMonth: String(competenceMonth).trim(),
      competenceDate: String(competenceDate).trim(),
      dueDate: dueDate ? String(dueDate).trim() : null,
      categoryId: String(categoryId).trim(),
      categoryName: String(categoryName).trim(),
      createdByUid: cleanUid,
      responsibleUid: String(responsibleUid).trim(),
      payerUid: payerUid ? String(payerUid).trim() : String(responsibleUid).trim(),
      participantUids: calculatedSplits.map((s) => s.memberUid),
      validationStatus: 'approved',
      validatedByUid: String(responsibleUid).trim(),
      validatedAt: now,
      commitmentStatus: 'active',
      paymentExecutionStatus: 'unpaid',
      totalPaidToSupplierCents: 0,
      originType: originType || 'manual',
      originRefId: originRefId || null,
      idempotencyKey: finalKey,
      createdAt: now,
    };

    tx.set(expenseRef, newExpense);

    const savedLiabilities = [];
    for (const split of calculatedSplits) {
      const liabRef = expenseRef.collection('liabilities').doc(String(split.memberUid).trim());
      const liabData = {
        id: String(split.memberUid).trim(),
        expenseId,
        spaceId: String(spaceId).trim(),
        memberUid: String(split.memberUid).trim(),
        memberName: String(split.memberName).trim(),
        assignedShareAmountCents: split.assignedShareAmountCents,
        originalAmountCents: split.assignedShareAmountCents,
        refundAdjustmentCents: 0,
        adjustedShareAmountCents: split.adjustedShareAmountCents,
        paidAmountCents: 0,
        remainingAmountCents: split.adjustedShareAmountCents,
        creditNoteCents: 0,
        status: 'pending',
        splitMethod: split.splitMethod || 'equal',
        splitRatio: split.splitRatio || null,
        roundingRemainderRank: split.roundingRemainderRank || null,
      };
      tx.set(liabRef, liabData);
      savedLiabilities.push(liabData);

      // Notificação oficial de nova obrigação atribuída para os participantes
      const notifId = `notif_exp_${expenseId}_${String(split.memberUid).trim()}`;
      const notifRef = db.collection('users').doc(String(split.memberUid).trim()).collection('notifications').doc(notifId);
      tx.set(notifRef, {
        id: notifId,
        userId: String(split.memberUid).trim(),
        spaceId: String(spaceId).trim(),
        spaceName: spaceData.name || 'Espaço Compartilhado',
        type: 'shared_expense_assigned',
        title: 'Nova despesa compartilhada',
        message: `Você possui uma cota de R$ ${(split.assignedShareAmountCents / 100).toFixed(2)} referente a "${title}".`,
        read: false,
        originEventId: expenseId,
        createdAt: now,
      }, { merge: true });
    }

    return { expense: newExpense, liabilities: savedLiabilities };
  });
}

export async function executeServerSideDeclareExpensePayment(db, callerUid, payload) {
  if (!callerUid) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória.');
  }
  const cleanUid = callerUid.trim();
  const {
    spaceId,
    expenseId,
    memberUid,
    memberName,
    amountCents,
    paymentDate,
    paymentMethod,
    sourceAccountId,
    proofUrl,
    notes,
    idempotencyKey,
  } = payload || {};

  if (!spaceId || !expenseId || !amountCents || !paymentDate) {
    throw new HttpsError('invalid-argument', 'Campos obrigatórios ausentes para declaração de pagamento.');
  }
  if (memberUid !== cleanUid) {
    throw new HttpsError('permission-denied', 'Violação de identidade: você só pode declarar pagamentos da sua própria cota.');
  }

  const spaceRef = db.collection('spaces').doc(String(spaceId).trim());
  const spaceSnap = await spaceRef.get();
  if (!spaceSnap.exists) {
    throw new HttpsError('not-found', 'Espaço não encontrado.');
  }
  const spaceData = spaceSnap.data();
  if (spaceData.spaceStatus === 'archived' || spaceData.spaceStatus === 'dissolved') {
    throw new HttpsError('failed-precondition', 'Espaço arquivado ou dissolvido.');
  }
  if (!Array.isArray(spaceData.memberUids) || !spaceData.memberUids.includes(cleanUid)) {
    throw new HttpsError('permission-denied', 'Você não é membro ativo deste espaço.');
  }

  const expenseRef = spaceRef.collection('shared_expenses').doc(String(expenseId).trim());
  const liabRef = expenseRef.collection('liabilities').doc(cleanUid);
  const finalKey =
    idempotencyKey?.trim() ||
    `idem_decl_${String(expenseId).trim()}_${cleanUid}_${amountCents}_${String(paymentDate).trim()}`;
  const declId = serverGeneratePaymentDeclarationDocId(expenseId, finalKey);
  const declRef = expenseRef.collection('payment_declarations').doc(declId);

  return await db.runTransaction(async (tx) => {
    const [expSnap, liabSnap, declSnap] = await Promise.all([
      tx.get(expenseRef),
      tx.get(liabRef),
      tx.get(declRef),
    ]);

    if (!expSnap.exists) {
      throw new HttpsError('not-found', 'Despesa compartilhada não encontrada.');
    }
    if (!liabSnap.exists) {
      throw new HttpsError('not-found', 'Obrigação do membro não encontrada nesta despesa.');
    }
    if (declSnap.exists) {
      const existingDecl = declSnap.data();
      if (
        existingDecl.amountCents !== amountCents ||
        existingDecl.paymentDate !== String(paymentDate).trim()
      ) {
        throw new HttpsError(
          'already-exists',
          'Conflito de idempotência: Declaração já registrada com parâmetros divergentes.'
        );
      }
      return existingDecl;
    }

    const expense = expSnap.data();
    const liab = liabSnap.data();
    const remaining = liab.remainingAmountCents ?? liab.adjustedShareAmountCents;
    if (amountCents <= 0 || amountCents > remaining) {
      throw new HttpsError('invalid-argument', `Valor declarado (${amountCents}) inválido ou excede o saldo devedor restante (${remaining}).`);
    }

    const now = new Date().toISOString();
    const newDecl = {
      id: declId,
      expenseId: String(expenseId).trim(),
      spaceId: String(spaceId).trim(),
      memberUid: cleanUid,
      memberName: memberName ? String(memberName).trim() : 'Membro',
      responsibleUid: expense.responsibleUid,
      payerUid: expense.payerUid || expense.responsibleUid,
      amountCents,
      paymentDate: String(paymentDate).trim(),
      paymentMethod: paymentMethod || 'pix',
      sourceAccountId: sourceAccountId || null,
      proofUrl: proofUrl || null,
      notes: notes ? String(notes).trim() : null,
      status: 'pending_validation',
      idempotencyKey: finalKey,
      createdAt: now,
      updatedAt: now,
    };

    tx.set(declRef, newDecl);
    tx.update(liabRef, { status: 'in_validation' });

    // Notificação ao responsável financeiro
    if (expense.responsibleUid) {
      const notifId = `notif_decl_${declId}`;
      const notifRef = db.collection('users').doc(expense.responsibleUid).collection('notifications').doc(notifId);
      tx.set(notifRef, {
        id: notifId,
        userId: expense.responsibleUid,
        spaceId: String(spaceId).trim(),
        spaceName: spaceData.name || 'Espaço Compartilhado',
        type: 'payment_declaration_submitted',
        title: 'Nova declaração de pagamento',
        message: `${newDecl.memberName} declarou o pagamento de R$ ${(amountCents / 100).toFixed(2)} referente à cota de "${expense.title}".`,
        read: false,
        originEventId: declId,
        createdAt: now,
      }, { merge: true });
    }

    return newDecl;
  });
}

export async function executeServerSideValidateExpensePayment(db, callerUid, payload) {
  if (!callerUid) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória.');
  }
  const cleanUid = callerUid.trim();
  const {
    spaceId,
    expenseId,
    declarationId,
    decision,
    destinationAccountId,
    rejectionReason,
    idempotencyKey,
  } = payload || {};

  if (!spaceId || !expenseId || !declarationId || !decision) {
    throw new HttpsError('invalid-argument', 'Parâmetros obrigatórios ausentes para validação.');
  }
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new HttpsError('invalid-argument', `Decisão inválida: "${decision}". Deve ser "approved" ou "rejected".`);
  }

  const cleanSpaceId = String(spaceId).trim();
  const cleanExpenseId = String(expenseId).trim();
  const cleanDeclId = String(declarationId).trim();

  const spaceRef = db.collection('spaces').doc(cleanSpaceId);
  const spaceSnap = await spaceRef.get();
  if (!spaceSnap.exists) {
    throw new HttpsError('not-found', 'Espaço não encontrado.');
  }
  const spaceData = spaceSnap.data();
  if (spaceData.spaceStatus === 'archived' || spaceData.spaceStatus === 'dissolved') {
    throw new HttpsError('failed-precondition', 'Espaço arquivado ou dissolvido.');
  }

  const expenseRef = spaceRef.collection('shared_expenses').doc(cleanExpenseId);
  const declRef = expenseRef.collection('payment_declarations').doc(cleanDeclId);

  const finalKey = idempotencyKey?.trim() || `idem_val_${cleanDeclId}_${decision}`;
  const approvalId = serverGeneratePaymentApprovalDocId(cleanDeclId);
  const approvalRef = expenseRef.collection('payment_approvals').doc(approvalId);
  const rejectionId = serverGeneratePaymentRejectionDocId(cleanDeclId);
  const rejectionRef = expenseRef.collection('payment_rejections').doc(rejectionId);
  const revocationId = serverGenerateApprovalRevocationDocId(approvalId);
  const revocationRef = expenseRef.collection('approval_revocations').doc(revocationId);

  return await db.runTransaction(async (tx) => {
    const [expSnap, declSnap, apprSnap, rejSnap, revocSnap] = await Promise.all([
      tx.get(expenseRef),
      tx.get(declRef),
      tx.get(approvalRef),
      tx.get(rejectionRef),
      tx.get(revocationRef),
    ]);

    if (!expSnap.exists) {
      throw new HttpsError('not-found', 'Despesa compartilhada não encontrada.');
    }
    const expense = expSnap.data();

    // REGRA FUNDAMENTAL DE SEGURANÇA: Somente o responsibleUid tem autoridade para validar!
    if (expense.responsibleUid !== cleanUid) {
      throw new HttpsError(
        'permission-denied',
        `Acesso negado: Somente o responsável financeiro da despesa (${expense.responsibleUid}) tem competência para validar pagamentos.`
      );
    }

    if (!declSnap.exists) {
      throw new HttpsError('not-found', 'Declaração de pagamento não encontrada.');
    }
    const decl = declSnap.data();
    if (decl.expenseId !== cleanExpenseId || decl.spaceId !== cleanSpaceId) {
      throw new HttpsError('failed-precondition', 'Declaração não pertence à despesa ou espaço informados.');
    }

    const liabRef = expenseRef.collection('liabilities').doc(decl.memberUid);
    const liabSnap = await tx.get(liabRef);
    if (!liabSnap.exists) {
      throw new HttpsError('not-found', 'Obrigação do membro não encontrada.');
    }
    const liab = liabSnap.data();

    // Pré-leitura da conta e movimento caso destinationAccountId seja informado ou já exista aprovação
    const targetAccId = destinationAccountId
      ? String(destinationAccountId).trim()
      : apprSnap.exists
      ? apprSnap.data().destinationAccountId
      : null;

    let accRef = null;
    let accSnap = null;
    let movId = null;
    let movRef = null;
    let movSnap = null;

    if (targetAccId) {
      accRef = db.collection('accounts').doc(targetAccId);
      movId = serverGenerateMovementDocId(targetAccId, `reimb_mov_${approvalId}`);
      movRef = accRef.collection('movements').doc(movId);
      [accSnap, movSnap] = await Promise.all([tx.get(accRef), tx.get(movRef)]);
    }

    const now = new Date().toISOString();

    if (decision === 'approved') {
      if (rejSnap.exists) {
        throw new HttpsError(
          'failed-precondition',
          'Esta declaração de pagamento já foi rejeitada e não pode ser aprovada.'
        );
      }

      if (apprSnap.exists) {
        const existingAppr = apprSnap.data();
        if (revocSnap.exists || existingAppr.isRevoked) {
          throw new HttpsError(
            'failed-precondition',
            'A aprovação desta declaração já foi revogada anteriormente.'
          );
        }
        const reqDestAcc = destinationAccountId ? String(destinationAccountId).trim() : null;
        const existDestAcc = existingAppr.destinationAccountId || null;
        if (reqDestAcc !== existDestAcc) {
          throw new HttpsError(
            'already-exists',
            'Conflito de idempotência: Aprovação já registrada com conta de destino divergente.'
          );
        }
        return {
          approval: existingAppr,
          liability: liab,
          movement: movSnap && movSnap.exists ? movSnap.data() : null,
          declaration: { ...decl, status: 'approved' },
        };
      }

      if (decl.status === 'approved') {
        throw new HttpsError('already-exists', 'Esta declaração já foi aprovada.');
      }

      const beneficiaryUid = expense.payerUid || expense.responsibleUid;

      let financialMovementId = null;
      let movRecord = null;
      if (destinationAccountId) {
        if (!accSnap || !accSnap.exists) {
          throw new HttpsError('not-found', `Conta bancária "${destinationAccountId}" não encontrada.`);
        }
        const accData = accSnap.data();
        if (accData.userId !== beneficiaryUid) {
          throw new HttpsError(
            'permission-denied',
            `Conta bancária informada não pertence ao credor/beneficiário do reembolso (${beneficiaryUid}).`
          );
        }
        if (isAccountArchivedServer(accData)) {
          throw new HttpsError('failed-precondition', 'Não é possível receber reembolso em conta arquivada.');
        }

        if (!movSnap.exists) {
          financialMovementId = movId;
          movRecord = {
            id: movId,
            accountId: String(destinationAccountId).trim(),
            userId: beneficiaryUid, // Credita a conta do beneficiário legítimo (payerUid)
            direction: 'inflow',
            amountCents: decl.amountCents,
            effectiveDate: decl.paymentDate,
            registeredAt: now,
            originType: 'shared_reimbursement',
            originId: approvalId,
            confirmationStatus: 'cleared',
            idempotencyKey: `reimb_mov_${approvalId}`,
            description: `Reembolso de rateio recebido: ${expense.title} (${decl.memberName})`,
            authorUid: cleanUid, // Autorizado pelo responsável (responsibleUid)
          };
          tx.set(movRef, movRecord);
          const currentBal = accData.projectedBalanceCents || 0;
          tx.update(accRef, { projectedBalanceCents: currentBal + decl.amountCents });
        } else {
          financialMovementId = movId;
          movRecord = movSnap.data();
        }
      }

      // REGRA DE IMUTABILIDADE (FRENTE A):
      // O documento de aprovação é estritamente imutável desde sua criação e NUNCA recebe flags mutáveis de revogação.
      const approval = {
        id: approvalId,
        expenseId: cleanExpenseId,
        spaceId: cleanSpaceId,
        declarationId: cleanDeclId,
        liabilityId: decl.memberUid,
        memberUid: decl.memberUid,
        responsibleUid: cleanUid,
        beneficiaryUid,
        amountCents: decl.amountCents,
        destinationAccountId: destinationAccountId ? String(destinationAccountId).trim() : null,
        financialMovementId,
        approvedAt: now,
        approverUid: cleanUid,
        idempotencyKey: finalKey,
        createdAt: now,
      };

      tx.set(approvalRef, approval);
      // REGRA DE IMUTABILIDADE: O documento da declaração original NÃO é alterado. Seu status é derivado dos eventos!

      const currentPaid = liab.paidAmountCents || 0;
      const newPaid = currentPaid + decl.amountCents;
      const adjusted = liab.adjustedShareAmountCents;
      const remaining = Math.max(0, adjusted - newPaid);
      const creditNote = Math.max(0, newPaid - adjusted);
      const newStatus = remaining === 0 ? 'paid' : 'partially_paid';

      const updatedLiability = {
        ...liab,
        paidAmountCents: newPaid,
        remainingAmountCents: remaining,
        creditNoteCents: creditNote,
        status: newStatus,
      };
      tx.set(liabRef, updatedLiability);

      // Evento determinístico de auditoria no espaço
      const auditId = `audit_appr_${approvalId}`;
      const auditRef = spaceRef.collection('audit').doc(auditId);
      tx.set(auditRef, {
        id: auditId,
        spaceId: cleanSpaceId,
        eventType: 'payment_approved',
        performedByUid: cleanUid,
        performedByName: 'Responsável Financeiro',
        targetUid: decl.memberUid,
        targetName: decl.memberName,
        details: {
          expenseId: cleanExpenseId,
          declarationId: cleanDeclId,
          approvalId,
          beneficiaryUid,
          amountCents: decl.amountCents,
          financialMovementId,
        },
        timestamp: now,
      });

      // Notificação oficial de aprovação ao devedor
      const notifId = `notif_appr_${approvalId}`;
      const notifRef = db.collection('users').doc(decl.memberUid).collection('notifications').doc(notifId);
      tx.set(notifRef, {
        id: notifId,
        userId: decl.memberUid,
        spaceId: cleanSpaceId,
        spaceName: spaceData.name || 'Espaço Compartilhado',
        type: 'payment_approved',
        title: 'Pagamento aprovado!',
        message: `Seu pagamento de R$ ${(decl.amountCents / 100).toFixed(2)} referente a "${expense.title}" foi aprovado pelo responsável.`,
        read: false,
        originEventId: approvalId,
        createdAt: now,
      }, { merge: true });

      // Se a cota foi totalmente quitada, envia notificação de liquidação integral
      if (newStatus === 'paid') {
        const settledNotifId = `notif_settled_${approvalId}`;
        const settledNotifRef = db.collection('users').doc(decl.memberUid).collection('notifications').doc(settledNotifId);
        tx.set(settledNotifRef, {
          id: settledNotifId,
          userId: decl.memberUid,
          spaceId: cleanSpaceId,
          spaceName: spaceData.name || 'Espaço Compartilhado',
          type: 'liability_settled',
          title: 'Cota quitada integralmente!',
          message: `Sua participação na despesa "${expense.title}" foi totalmente liquidada.`,
          read: false,
          originEventId: approvalId,
          createdAt: now,
        }, { merge: true });
      }

      // Se o beneficiário é diferente do responsável que validou, notifica o beneficiário sobre o crédito
      if (beneficiaryUid !== cleanUid) {
        const benNotifId = `notif_reimb_${approvalId}`;
        const benNotifRef = db.collection('users').doc(beneficiaryUid).collection('notifications').doc(benNotifId);
        tx.set(benNotifRef, {
          id: benNotifId,
          userId: beneficiaryUid,
          spaceId: cleanSpaceId,
          spaceName: spaceData.name || 'Espaço Compartilhado',
          type: 'payment_approved',
          title: 'Reembolso creditado',
          message: `Foi aprovado o reembolso de R$ ${(decl.amountCents / 100).toFixed(2)} de ${decl.memberName} referente a "${expense.title}".`,
          read: false,
          originEventId: approvalId,
          createdAt: now,
        }, { merge: true });
      }

      return {
        approval,
        liability: updatedLiability,
        movement: movRecord,
        declaration: { ...decl, status: 'approved' },
      };
    } else {
      // Rejection
      if (!rejectionReason || !String(rejectionReason).trim()) {
        throw new HttpsError('invalid-argument', 'Justificativa de rejeição é estritamente obrigatória.');
      }

      if (apprSnap.exists) {
        throw new HttpsError(
          'failed-precondition',
          'Esta declaração já foi aprovada e não pode ser rejeitada diretamente (utilize a revogação de aprovação).'
        );
      }

      if (rejSnap.exists) {
        const existingRej = rejSnap.data();
        if (existingRej.reason !== String(rejectionReason).trim()) {
          throw new HttpsError(
            'already-exists',
            'Conflito de idempotência: Rejeição já registrada com justificativa divergente.'
          );
        }
        return {
          rejection: existingRej,
          declaration: { ...decl, status: 'rejected', rejectionReason: existingRej.reason },
          liability: liab,
        };
      }

      // Criação de evento independente e imutável de rejeição
      const rejection = {
        id: rejectionId,
        expenseId: cleanExpenseId,
        spaceId: cleanSpaceId,
        declarationId: cleanDeclId,
        liabilityId: decl.memberUid,
        memberUid: decl.memberUid,
        responsibleUid: cleanUid,
        amountCents: decl.amountCents,
        reason: String(rejectionReason).trim(),
        rejectionReason: String(rejectionReason).trim(),
        rejectedByUid: cleanUid,
        rejectedAt: now,
        idempotencyKey: finalKey,
        createdAt: now,
      };

      tx.set(rejectionRef, rejection);
      // REGRA DE IMUTABILIDADE: O documento da declaração original NÃO é alterado.

      const currentPaid = liab.paidAmountCents || 0;
      const newStatus = currentPaid > 0 ? 'partially_paid' : 'pending';
      const updatedLiability = { ...liab, status: newStatus };
      tx.set(liabRef, updatedLiability);

      // Auditoria determinística de rejeição
      const auditId = `audit_rej_${rejectionId}`;
      const auditRef = spaceRef.collection('audit').doc(auditId);
      tx.set(auditRef, {
        id: auditId,
        spaceId: cleanSpaceId,
        eventType: 'payment_rejected',
        performedByUid: cleanUid,
        performedByName: 'Responsável Financeiro',
        targetUid: decl.memberUid,
        targetName: decl.memberName,
        details: {
          expenseId: cleanExpenseId,
          declarationId: cleanDeclId,
          rejectionId,
          amountCents: decl.amountCents,
          reason: String(rejectionReason).trim(),
        },
        timestamp: now,
      });

      // Notificação oficial de rejeição ao devedor
      const notifId = `notif_rej_${rejectionId}`;
      const notifRef = db.collection('users').doc(decl.memberUid).collection('notifications').doc(notifId);
      tx.set(notifRef, {
        id: notifId,
        userId: decl.memberUid,
        spaceId: cleanSpaceId,
        spaceName: spaceData.name || 'Espaço Compartilhado',
        type: 'payment_rejected',
        title: 'Pagamento de rateio recusado',
        message: `O pagamento de R$ ${(decl.amountCents / 100).toFixed(2)} em "${expense.title}" foi recusado pelo responsável. Motivo: ${rejectionReason.trim()}`,
        read: false,
        originEventId: rejectionId,
        createdAt: now,
      }, { merge: true });

      return {
        rejection,
        declaration: { ...decl, status: 'rejected', rejectionReason: String(rejectionReason).trim() },
        liability: updatedLiability,
      };
    }
  });
}

export async function executeServerSideRevokeExpensePaymentApproval(db, callerUid, payload) {
  if (!callerUid) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória.');
  }
  const cleanUid = callerUid.trim();
  const {
    spaceId,
    expenseId,
    approvalId,
    reason,
    idempotencyKey,
  } = payload || {};

  if (!spaceId || !expenseId || !approvalId || !reason || !String(reason).trim()) {
    throw new HttpsError('invalid-argument', 'Parâmetros obrigatórios ausentes para revogação da aprovação.');
  }

  const cleanSpaceId = String(spaceId).trim();
  const cleanExpenseId = String(expenseId).trim();
  const cleanApprovalId = String(approvalId).trim();
  const cleanReason = String(reason).trim();

  const spaceRef = db.collection('spaces').doc(cleanSpaceId);
  const spaceSnap = await spaceRef.get();
  if (!spaceSnap.exists) {
    throw new HttpsError('not-found', 'Espaço não encontrado.');
  }
  const spaceData = spaceSnap.data();
  if (spaceData.spaceStatus === 'archived' || spaceData.spaceStatus === 'dissolved') {
    throw new HttpsError('failed-precondition', 'Espaço arquivado ou dissolvido.');
  }

  const expenseRef = spaceRef.collection('shared_expenses').doc(cleanExpenseId);
  const approvalRef = expenseRef.collection('payment_approvals').doc(cleanApprovalId);

  const finalKey = idempotencyKey?.trim() || `idem_revoc_${cleanApprovalId}`;
  const revocationId = serverGenerateApprovalRevocationDocId(cleanApprovalId);
  const revocationRef = expenseRef.collection('approval_revocations').doc(revocationId);
  const restitutionId = serverGenerateRestitutionDocId(revocationId);
  const restitutionRef = expenseRef.collection('restitutions').doc(restitutionId);

  return await db.runTransaction(async (tx) => {
    const [expSnap, apprSnap, revocSnap, restitSnap] = await Promise.all([
      tx.get(expenseRef),
      tx.get(approvalRef),
      tx.get(revocationRef),
      tx.get(restitutionRef),
    ]);

    if (!expSnap.exists) {
      throw new HttpsError('not-found', 'Despesa compartilhada não encontrada.');
    }
    const expense = expSnap.data();
    if (expense.responsibleUid !== cleanUid) {
      throw new HttpsError('permission-denied', 'Somente o responsável financeiro da despesa pode revogar aprovações.');
    }

    if (!apprSnap.exists) {
      throw new HttpsError('not-found', 'Aprovação de pagamento não encontrada.');
    }
    const approval = apprSnap.data();
    if (approval.expenseId !== cleanExpenseId || approval.spaceId !== cleanSpaceId) {
      throw new HttpsError(
        'failed-precondition',
        'A aprovação informada não pertence à despesa ou ao espaço especificados.'
      );
    }

    const liabRef = expenseRef.collection('liabilities').doc(approval.memberUid);
    const liabSnap = await tx.get(liabRef);
    if (!liabSnap.exists) {
      throw new HttpsError('not-found', 'Obrigação do participante não encontrada.');
    }
    const liab = liabSnap.data();

    // Pré-leitura de conta e movimentos caso a aprovação tenha gerado movimento financeiro
    let accRef = null;
    let accSnap = null;
    let origMovRef = null;
    let origMovSnap = null;
    let revMovId = null;
    let revMovRef = null;
    let revMovSnap = null;

    if (approval.financialMovementId && approval.destinationAccountId) {
      accRef = db.collection('accounts').doc(approval.destinationAccountId);
      origMovRef = accRef.collection('movements').doc(approval.financialMovementId);
      revMovId = serverGenerateReversalDocId(approval.financialMovementId);
      revMovRef = accRef.collection('movements').doc(revMovId);
      [accSnap, origMovSnap, revMovSnap] = await Promise.all([
        tx.get(accRef),
        tx.get(origMovRef),
        tx.get(revMovRef),
      ]);
    }

    // Verificação de revogação já existente / idempotência
    if (revocSnap.exists) {
      const existingRev = revocSnap.data();
      if (existingRev.reason !== cleanReason) {
        throw new HttpsError(
          'already-exists',
          'Conflito de idempotência: Aprovação já revogada com motivo divergente.'
        );
      }
      return {
        revocation: existingRev,
        liability: liab,
        compensatoryMovement: revMovSnap && revMovSnap.exists ? revMovSnap.data() : null,
        restitution: restitSnap && restitSnap.exists ? restitSnap.data() : null,
      };
    }

    if (approval.isRevoked) {
      throw new HttpsError('already-exists', 'Esta aprovação de pagamento já se encontra revogada.');
    }

    const now = new Date().toISOString();
    const beneficiaryUid = approval.beneficiaryUid || expense.payerUid || cleanUid;

    let compensatoryMovement = null;
    let requiresRestitution = false;
    let restitutionPendingCents = 0;

    if (approval.financialMovementId && approval.destinationAccountId) {
      if (!accSnap || !accSnap.exists) {
        throw new HttpsError('not-found', 'Conta bancária de destino original não encontrada para estorno contábil.');
      }
      if (!origMovSnap || !origMovSnap.exists) {
        throw new HttpsError('not-found', 'Movimento financeiro original de reembolso não encontrado para estorno contábil.');
      }

      const accData = accSnap.data();
      const currentBal = accData.projectedBalanceCents || 0;

      // Tratamento do caso "Dinheiro já utilizado" (Frente B 4.3 / Cenário 8):
      // Se o saldo atual da conta for inferior ao valor do reembolso estornado, o recurso já foi utilizado parcial ou totalmente.
      if (currentBal < approval.amountCents) {
        requiresRestitution = true;
        restitutionPendingCents = approval.amountCents - Math.max(0, currentBal);
      }

      if (!revMovSnap.exists) {
        compensatoryMovement = {
          id: revMovId,
          accountId: approval.destinationAccountId,
          userId: beneficiaryUid,
          direction: 'outflow',
          amountCents: approval.amountCents,
          effectiveDate: now.split('T')[0],
          registeredAt: now,
          originType: 'manual_adjustment',
          originId: revocationId,
          confirmationStatus: 'cleared',
          idempotencyKey: `reversal_${approval.financialMovementId}`,
          reversalOfMovementId: approval.financialMovementId,
          description: requiresRestitution
            ? `Estorno contábil de reembolso (Restituição financeira pendente - saldo utilizado) - Motivo: ${cleanReason}`
            : `Estorno contábil de reembolso de rateio (Ajuste contábil, não representa transferência bancária automática) - Motivo: ${cleanReason}`,
          notes: requiresRestitution
            ? `Atenção: O crédito original já havia sido utilizado parcial ou totalmente. Este lançamento é um ajuste exclusivamente contábil referenciando #${approval.financialMovementId}; resta pendente a restituição financeira real de R$ ${(restitutionPendingCents / 100).toFixed(2)}.`
            : `Lançamento compensatório exclusivamente contábil referenciando #${approval.financialMovementId}. Não realiza transferência bancária automática.`,
          authorUid: cleanUid,
        };
        tx.set(revMovRef, compensatoryMovement);
        tx.update(accRef, { projectedBalanceCents: currentBal - approval.amountCents });
      } else {
        compensatoryMovement = revMovSnap.data();
      }
    }

    const revocation = {
      id: revocationId,
      expenseId: cleanExpenseId,
      spaceId: cleanSpaceId,
      approvalId: cleanApprovalId,
      declarationId: approval.declarationId,
      liabilityId: approval.liabilityId || approval.memberUid,
      memberUid: approval.memberUid,
      responsibleUid: cleanUid,
      beneficiaryUid,
      revokedAmountCents: approval.amountCents,
      compensatoryMovementId: compensatoryMovement?.id || null,
      requiresRestitution,
      restitutionPendingCents,
      reason: cleanReason,
      revokedByUid: cleanUid,
      revokedAt: now,
      idempotencyKey: finalKey,
      createdAt: now,
    };

    tx.set(revocationRef, revocation);
    // REGRA DE IMUTABILIDADE ESTRITA:
    // O documento original em payment_approvals/{approvalId} NUNCA sofre update ou delete!
    // O estado revogado é derivado exclusivamente da existência deste evento em approval_revocations/{revocationId}.

    // ETAPA 1: Obrigação Formal e Independente de Restituição
    // O valor da obrigação independe do saldo atual da conta e é recomposto conforme recebimentos confirmados
    const restitution = {
      id: restitutionId,
      spaceId: cleanSpaceId,
      expenseId: cleanExpenseId,
      liabilityId: approval.liabilityId || approval.memberUid,
      approvalId: cleanApprovalId,
      revocationId,
      debtorUid: beneficiaryUid, // Bob (quem recebeu os fundos indevidamente e deve restituir)
      creditorUid: approval.memberUid, // Charlie (o participante credor legítimo que teve sua aprovação revogada)
      amountToRestoreCents: approval.amountCents,
      restitutedAmountCents: 0,
      remainingAmountCents: approval.amountCents,
      status: 'pending',
      reason: cleanReason,
      createdAt: now,
      updatedAt: now,
    };
    tx.set(restitutionRef, restitution);

    // Restaura saldo da obrigação preservando pagamentos parciais anteriores e ajustes de reembolso de fornecedor
    const currentPaid = liab.paidAmountCents || 0;
    const restoredPaid = Math.max(0, currentPaid - approval.amountCents);
    const original = liab.originalAmountCents ?? liab.assignedShareAmountCents;
    const assigned = liab.assignedShareAmountCents ?? original;
    const refundAdj = liab.refundAdjustmentCents || 0;
    const adjusted = liab.adjustedShareAmountCents ?? Math.max(0, original - refundAdj);
    const remaining = Math.max(0, adjusted - restoredPaid);
    const restoredCreditNote = Math.max(0, restoredPaid - adjusted);
    const newStatus = remaining === 0 ? 'paid' : restoredPaid > 0 ? 'partially_paid' : 'pending';

    const updatedLiability = {
      ...liab,
      originalAmountCents: original,
      assignedShareAmountCents: assigned,
      refundAdjustmentCents: refundAdj,
      adjustedShareAmountCents: adjusted,
      paidAmountCents: restoredPaid,
      remainingAmountCents: remaining,
      creditNoteCents: restoredCreditNote,
      status: newStatus,
    };
    tx.set(liabRef, updatedLiability);

    // Registro de evento determinístico na trilha de auditoria do espaço (revogação)
    const auditId = `audit_revoc_${revocationId}`;
    const auditRef = spaceRef.collection('audit').doc(auditId);
    tx.set(auditRef, {
      id: auditId,
      spaceId: cleanSpaceId,
      eventType: 'payment_approval_revoked',
      performedByUid: cleanUid,
      performedByName: 'Responsável Financeiro',
      targetUid: approval.memberUid,
      details: {
        expenseId: cleanExpenseId,
        approvalId: cleanApprovalId,
        revocationId,
        restitutionId,
        declarationId: approval.declarationId,
        beneficiaryUid,
        revokedAmountCents: approval.amountCents,
        compensatoryMovementId: compensatoryMovement?.id || null,
        requiresRestitution,
        restitutionPendingCents,
        reason: cleanReason,
      },
      timestamp: now,
    });

    // Auditoria de restituição gerada
    const restitAuditId = `audit_restit_${restitutionId}`;
    tx.set(spaceRef.collection('audit').doc(restitAuditId), {
      id: restitAuditId,
      spaceId: cleanSpaceId,
      eventType: 'restitution_created',
      performedByUid: cleanUid,
      performedByName: 'Responsável Financeiro',
      targetUid: beneficiaryUid,
      details: {
        expenseId: cleanExpenseId,
        restitutionId,
        revocationId,
        debtorUid: beneficiaryUid,
        creditorUid: approval.memberUid,
        amountToRestoreCents: approval.amountCents,
        reason: cleanReason,
      },
      timestamp: now,
    });

    // Notificação oficial de revogação ao devedor
    const notifId = `notif_revoc_${revocationId}`;
    const notifRef = db.collection('users').doc(approval.memberUid).collection('notifications').doc(notifId);
    tx.set(notifRef, {
      id: notifId,
      userId: approval.memberUid,
      spaceId: cleanSpaceId,
      spaceName: spaceData.name || 'Espaço Compartilhado',
      type: 'payment_approval_revoked',
      title: 'Aprovação de pagamento revogada',
      message: `A aprovação do pagamento em "${expense.title}" foi cancelada pelo responsável. Uma obrigação de restituição de R$ ${(approval.amountCents / 100).toFixed(2)} foi aberta em seu favor. Motivo: ${cleanReason}`,
      read: false,
      originEventId: revocationId,
      createdAt: now,
    }, { merge: true });

    // Notifica o beneficiário sobre o estorno contábil e sobre a obrigação de restituição
    if (beneficiaryUid) {
      const benNotifId = `notif_revoc_ben_${revocationId}`;
      const benNotifRef = db.collection('users').doc(beneficiaryUid).collection('notifications').doc(benNotifId);
      tx.set(benNotifRef, {
        id: benNotifId,
        userId: beneficiaryUid,
        spaceId: cleanSpaceId,
        spaceName: spaceData.name || 'Espaço Compartilhado',
        type: 'payment_approval_revoked',
        title: 'Reembolso estornado / Restituição gerada',
        message: `O crédito referente a "${expense.title}" foi revogado pelo responsável financeiro. Uma obrigação de restituição de R$ ${(approval.amountCents / 100).toFixed(2)} foi gerada para recomposição dos fundos. Motivo: ${cleanReason}`,
        read: false,
        originEventId: restitutionId,
        createdAt: now,
      }, { merge: true });
    }

    return { revocation, liability: updatedLiability, compensatoryMovement, restitution };
  });
}

export async function executeServerSideRecordSharedRefund(db, callerUid, payload) {
  if (!callerUid) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória.');
  }
  const cleanUid = callerUid.trim();
  const {
    spaceId,
    expenseId,
    refundType,
    amountRefundedCents,
    lossAmountCents = 0,
    recipientUid,
    destinationAccountId,
    date,
    justification,
    idempotencyKey,
  } = payload || {};

  if (!spaceId || !expenseId || !justification) {
    throw new HttpsError('invalid-argument', 'Campos obrigatórios ausentes para reembolso de fornecedor.');
  }

  const spaceRef = db.collection('spaces').doc(String(spaceId).trim());
  const spaceSnap = await spaceRef.get();
  if (!spaceSnap.exists) {
    throw new HttpsError('not-found', 'Espaço não encontrado.');
  }
  const spaceData = spaceSnap.data();
  const expenseRef = spaceRef.collection('shared_expenses').doc(String(expenseId).trim());
  const finalKey =
    idempotencyKey?.trim() ||
    `idem_supref_${String(expenseId).trim()}_${refundType || 'partial_refund'}_${amountRefundedCents || 0}_${date || ''}`;
  const refundId = serverGenerateSupplierRefundDocId(expenseId, finalKey);
  const refundRef = expenseRef.collection('refunds').doc(refundId);

  return await db.runTransaction(async (tx) => {
    const [expSnap, refSnap] = await Promise.all([
      tx.get(expenseRef),
      tx.get(refundRef),
    ]);

    if (!expSnap.exists) {
      throw new HttpsError('not-found', 'Despesa não encontrada.');
    }
    const expense = expSnap.data();
    if (expense.responsibleUid !== cleanUid && expense.createdByUid !== cleanUid) {
      throw new HttpsError('permission-denied', 'Acesso negado para registrar reembolso comercial.');
    }

    if (refSnap.exists) {
      const existingRef = refSnap.data();
      if (existingRef.amountRefundedCents !== (amountRefundedCents || 0)) {
        throw new HttpsError(
          'already-exists',
          'Conflito de idempotência: Reembolso comercial já registrado com valor divergente.'
        );
      }
      return existingRef;
    }

    const now = new Date().toISOString();
    const event = {
      id: refundId,
      expenseId: String(expenseId).trim(),
      spaceId: String(spaceId).trim(),
      refundType: refundType || 'partial_refund',
      amountRefundedCents: amountRefundedCents || 0,
      lossAmountCents: lossAmountCents || 0,
      recipientUid: recipientUid || cleanUid,
      destinationAccountId: destinationAccountId || null,
      date: date || now.split('T')[0],
      justification: String(justification).trim(),
      createdAt: now,
    };

    // Ajuste proporcional das obrigações com Maior Resto (Hare-Niemeyer) e preservação estrita de originalAmountCents
    let liabs = [];
    if (amountRefundedCents > 0 && expense.totalOriginalAmountCents > 0) {
      const liabsSnap = await tx.get(expenseRef.collection('liabilities'));
      liabs = liabsSnap.docs.map((d) => ({ docRef: d.ref, data: d.data() }));
    }

    tx.set(refundRef, event);

    if (amountRefundedCents > 0 && expense.totalOriginalAmountCents > 0 && liabs.length > 0) {
      let allocatedReduction = 0;
      const reductions = liabs.map((item) => {
        const liab = item.data;
        const orig = liab.originalAmountCents || liab.assignedShareAmountCents || 0;
        const exact = (amountRefundedCents * orig) / expense.totalOriginalAmountCents;
        const floor = Math.floor(exact);
        const remainder = exact - floor;
        allocatedReduction += floor;
        return { item, floor, remainder, reduction: floor };
      });

      let remainderToDistribute = amountRefundedCents - allocatedReduction;
      reductions.sort((a, b) => b.remainder - a.remainder);
      for (let i = 0; i < remainderToDistribute; i++) {
        reductions[i].reduction += 1;
      }

      for (const red of reductions) {
        const { item, reduction } = red;
        const liab = item.data;
        const original = liab.originalAmountCents || liab.assignedShareAmountCents;
        const prevRefund = liab.refundAdjustmentCents || 0;
        const newRefund = prevRefund + reduction;
        const newAdjusted = Math.max(0, original - newRefund);
        const paid = liab.paidAmountCents || 0;

        let remaining = 0;
        let creditNote = 0;
        if (paid > newAdjusted) {
          remaining = 0;
          creditNote = paid - newAdjusted;
        } else {
          remaining = newAdjusted - paid;
          creditNote = 0;
        }

        const newStatus = remaining === 0 && paid > 0 ? 'paid' : paid > 0 ? 'partially_paid' : liab.status;

        tx.update(item.docRef, {
          originalAmountCents: original,
          refundAdjustmentCents: newRefund,
          adjustedShareAmountCents: newAdjusted,
          remainingAmountCents: remaining,
          creditNoteCents: creditNote,
          status: newStatus,
        });

        // Notificação oficial de confirmação de reembolso do fornecedor
        const notifId = `notif_supref_${refundId}_${liab.memberUid}`;
        const notifRef = db.collection('users').doc(liab.memberUid).collection('notifications').doc(notifId);
        tx.set(notifRef, {
          id: notifId,
          userId: liab.memberUid,
          spaceId: String(spaceId).trim(),
          spaceName: spaceData.name || 'Espaço Compartilhado',
          type: 'supplier_refund_confirmed',
          title: 'Reembolso comercial confirmado',
          message: `O fornecedor devolveu R$ ${(amountRefundedCents / 100).toFixed(2)} em "${expense.title}". Sua cota líquida foi reduzida em R$ ${(reduction / 100).toFixed(2)}.${creditNote > 0 ? ` Você possui um crédito de R$ ${(creditNote / 100).toFixed(2)} a receber.` : ''}`,
          read: false,
          originEventId: refundId,
          createdAt: now,
        }, { merge: true });
      }
    }

    return event;
  });
}

// ==============================================================================
// ENDPOINTS ONCALL FASE 6
// ==============================================================================

export const createSharedExpenseOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideCreateSharedExpense(
      getAdminDb(),
      request.auth?.uid,
      request.data
    );
  }
);

export const declareExpensePaymentOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideDeclareExpensePayment(
      getAdminDb(),
      request.auth?.uid,
      request.data
    );
  }
);

export const validateExpensePaymentOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideValidateExpensePayment(
      getAdminDb(),
      request.auth?.uid,
      request.data
    );
  }
);

export const revokeExpensePaymentApprovalOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideRevokeExpensePaymentApproval(
      getAdminDb(),
      request.auth?.uid,
      request.data
    );
  }
);

export const recordSharedRefundOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideRecordSharedRefund(
      getAdminDb(),
      request.auth?.uid,
      request.data
    );
  }
);

export async function executeServerSideDeclareRestitutionPayment(db, callerUid, payload) {
  if (!callerUid) throw new HttpsError('unauthenticated', 'Autenticação obrigatória.');
  const cleanUid = callerUid.trim();
  const { spaceId, expenseId, restitutionId, amountCents, paymentDate, paymentProofUrl, notes, idempotencyKey } = payload || {};
  if (!spaceId || !expenseId || !restitutionId || !amountCents || typeof amountCents !== 'number' || amountCents <= 0) {
    throw new HttpsError('invalid-argument', 'Parâmetros inválidos para declaração de restituição.');
  }
  const cleanSpaceId = String(spaceId).trim();
  const cleanExpenseId = String(expenseId).trim();
  const cleanRestitId = String(restitutionId).trim();
  const finalKey = (idempotencyKey || `decl_rst_${cleanRestitId}_${amountCents}_${paymentDate || 'today'}`).trim();
  const declId = serverGenerateRestitutionDeclarationDocId(cleanRestitId, finalKey);

  const spaceRef = db.collection('spaces').doc(cleanSpaceId);
  const expenseRef = spaceRef.collection('shared_expenses').doc(cleanExpenseId);
  const restitRef = expenseRef.collection('restitutions').doc(cleanRestitId);
  const declRef = restitRef.collection('declarations').doc(declId);

  return await db.runTransaction(async (tx) => {
    const [spaceSnap, restitSnap, declSnap] = await Promise.all([
      tx.get(spaceRef),
      tx.get(restitRef),
      tx.get(declRef),
    ]);

    if (!spaceSnap.exists) throw new HttpsError('not-found', 'Espaço não encontrado.');
    const spaceData = spaceSnap.data();
    if (spaceData.spaceStatus === 'archived' || spaceData.spaceStatus === 'dissolved') {
      throw new HttpsError('failed-precondition', 'Espaço arquivado ou dissolvido.');
    }
    if (!restitSnap.exists) throw new HttpsError('not-found', 'Obrigação de restituição não encontrada.');
    const restitution = restitSnap.data();

    // Somente o devedor da obrigação de restituição pode declarar o pagamento
    if (restitution.debtorUid !== cleanUid) {
      throw new HttpsError('permission-denied', 'Somente o devedor da restituição pode declarar o pagamento.');
    }

    if (declSnap.exists) {
      return { declaration: declSnap.data(), restitution, isIdempotentReplay: true };
    }

    if (amountCents > restitution.remainingAmountCents) {
      throw new HttpsError('failed-precondition', `Valor declarado (${amountCents} centavos) excede o saldo pendente da restituição (${restitution.remainingAmountCents} centavos).`);
    }

    const now = new Date().toISOString();
    const declaration = {
      id: declId,
      restitutionId: cleanRestitId,
      spaceId: cleanSpaceId,
      expenseId: cleanExpenseId,
      debtorUid: cleanUid,
      amountCents,
      paymentDate: paymentDate || now.split('T')[0],
      paymentProofUrl: paymentProofUrl || null,
      notes: notes ? String(notes).trim() : null,
      idempotencyKey: finalKey,
      createdAt: now,
    };
    tx.set(declRef, declaration);

    // Auditoria
    const auditId = `audit_rst_decl_${declId}`;
    tx.set(spaceRef.collection('audit').doc(auditId), {
      id: auditId,
      spaceId: cleanSpaceId,
      eventType: 'restitution_declared',
      performedByUid: cleanUid,
      performedByName: 'Devedor da Restituição',
      targetUid: restitution.creditorUid,
      details: { restitutionId: cleanRestitId, declarationId: declId, amountCents },
      timestamp: now,
    });

    // Notificação ao credor
    const notifId = `notif_rst_decl_${declId}`;
    tx.set(db.collection('users').doc(restitution.creditorUid).collection('notifications').doc(notifId), {
      id: notifId,
      userId: restitution.creditorUid,
      spaceId: cleanSpaceId,
      spaceName: spaceData.name || 'Espaço Compartilhado',
      type: 'restitution_declared',
      title: 'Devolução de restituição declarada',
      message: `Uma devolução de R$ ${(amountCents / 100).toFixed(2)} foi declarada. Confirme o recebimento na sua conta bancária.`,
      read: false,
      originEventId: declId,
      createdAt: now,
    }, { merge: true });

    return { declaration, restitution };
  });
}

export async function executeServerSideConfirmRestitutionReceipt(db, callerUid, payload) {
  if (!callerUid) throw new HttpsError('unauthenticated', 'Autenticação obrigatória.');
  const cleanUid = callerUid.trim();
  const {
    spaceId,
    expenseId,
    restitutionId,
    declarationId,
    amountCents,
    destinationAccountId,
    notes,
    idempotencyKey,
  } = payload || {};

  if (!spaceId || !expenseId || !restitutionId || !destinationAccountId || !amountCents || typeof amountCents !== 'number' || amountCents <= 0) {
    throw new HttpsError('invalid-argument', 'Parâmetros inválidos para confirmação de recebimento de restituição.');
  }

  const cleanSpaceId = String(spaceId).trim();
  const cleanExpenseId = String(expenseId).trim();
  const cleanRestitId = String(restitutionId).trim();
  const cleanAccId = String(destinationAccountId).trim();
  const finalKey = (idempotencyKey || `rec_rst_${cleanRestitId}_${amountCents}_${declarationId || 'direct'}`).trim();
  const receiptId = serverGenerateRestitutionReceiptDocId(cleanRestitId, finalKey);

  const spaceRef = db.collection('spaces').doc(cleanSpaceId);
  const expenseRef = spaceRef.collection('shared_expenses').doc(cleanExpenseId);
  const restitRef = expenseRef.collection('restitutions').doc(cleanRestitId);
  const receiptRef = restitRef.collection('receipts').doc(receiptId);
  const accRef = db.collection('accounts').doc(cleanAccId);
  const movId = serverGenerateMovementDocId(finalKey);
  const movRef = accRef.collection('movements').doc(movId);

  return await db.runTransaction(async (tx) => {
    const [spaceSnap, restitSnap, receiptSnap, accSnap, movSnap] = await Promise.all([
      tx.get(spaceRef),
      tx.get(restitRef),
      tx.get(receiptRef),
      tx.get(accRef),
      tx.get(movRef),
    ]);

    if (!spaceSnap.exists) throw new HttpsError('not-found', 'Espaço não encontrado.');
    if (!restitSnap.exists) throw new HttpsError('not-found', 'Obrigação de restituição não encontrada.');
    const restitution = restitSnap.data();

    // REGRA DE SEGURANÇA E AUTORIDADE: Somente o credor legítimo pode confirmar o recebimento
    if (restitution.creditorUid !== cleanUid) {
      throw new HttpsError('permission-denied', 'Somente o credor legítimo da restituição pode confirmar o recebimento.');
    }

    if (!accSnap.exists) throw new HttpsError('not-found', 'Conta bancária informada não encontrada.');
    const accData = accSnap.data();
    if (accData.userId !== cleanUid) {
      throw new HttpsError('permission-denied', 'A conta de destino deve pertencer ao titular autenticado.');
    }
    if (accData.isArchived) {
      throw new HttpsError('failed-precondition', 'A conta de destino está arquivada.');
    }

    if (receiptSnap.exists) {
      return { receipt: receiptSnap.data(), restitution, movement: movSnap.exists ? movSnap.data() : null, isIdempotentReplay: true };
    }

    if (amountCents > restitution.remainingAmountCents) {
      throw new HttpsError('failed-precondition', `Valor a confirmar (${amountCents} centavos) excede o saldo pendente (${restitution.remainingAmountCents} centavos).`);
    }

    const now = new Date().toISOString();

    // 1. Criação do movimento financeiro oficial de entrada (inflow)
    const movement = {
      id: movId,
      accountId: cleanAccId,
      userId: cleanUid,
      direction: 'inflow',
      amountCents,
      effectiveDate: now.split('T')[0],
      registeredAt: now,
      originType: 'shared_settlement',
      originId: receiptId,
      confirmationStatus: 'cleared',
      idempotencyKey: finalKey,
      description: `Recebimento de restituição de cota compartilhada (${cleanRestitId})`,
      notes: notes ? String(notes).trim() : 'Confirmação oficial de restituição pelo credor.',
      authorUid: cleanUid,
    };
    tx.set(movRef, movement);
    tx.update(accRef, { projectedBalanceCents: (accData.projectedBalanceCents || 0) + amountCents });

    // 2. Criação do recibo imutável (append-only)
    const receipt = {
      id: receiptId,
      restitutionId: cleanRestitId,
      spaceId: cleanSpaceId,
      expenseId: cleanExpenseId,
      declarationId: declarationId ? String(declarationId).trim() : null,
      creditorUid: cleanUid,
      debtorUid: restitution.debtorUid,
      amountCents,
      destinationAccountId: cleanAccId,
      financialMovementId: movId,
      confirmedAt: now,
      notes: notes ? String(notes).trim() : null,
      idempotencyKey: finalKey,
      createdAt: now,
    };
    tx.set(receiptRef, receipt);

    // 3. Atualização da obrigação de restituição
    const newRestituted = (restitution.restitutedAmountCents || 0) + amountCents;
    const newRemaining = Math.max(0, restitution.amountToRestoreCents - newRestituted);
    const newStatus = newRemaining === 0 ? 'settled' : 'partial';
    const updatedRestitution = {
      ...restitution,
      restitutedAmountCents: newRestituted,
      remainingAmountCents: newRemaining,
      status: newStatus,
      updatedAt: now,
    };
    tx.set(restitRef, updatedRestitution);

    // 4. Auditoria
    const auditId = `audit_rst_rec_${receiptId}`;
    tx.set(spaceRef.collection('audit').doc(auditId), {
      id: auditId,
      spaceId: cleanSpaceId,
      eventType: 'restitution_receipt_confirmed',
      performedByUid: cleanUid,
      performedByName: 'Credor da Restituição',
      targetUid: restitution.debtorUid,
      details: { restitutionId: cleanRestitId, receiptId, amountCents, remainingAmountCents: newRemaining, status: newStatus },
      timestamp: now,
    });

    // 5. Notificação ao devedor
    const notifId = `notif_rst_rec_${receiptId}`;
    tx.set(db.collection('users').doc(restitution.debtorUid).collection('notifications').doc(notifId), {
      id: notifId,
      userId: restitution.debtorUid,
      spaceId: cleanSpaceId,
      spaceName: spaceSnap.data().name || 'Espaço Compartilhado',
      type: 'restitution_receipt_confirmed',
      title: 'Restituição confirmada',
      message: `O credor confirmou o recebimento de R$ ${(amountCents / 100).toFixed(2)}. Saldo restante: R$ ${(newRemaining / 100).toFixed(2)}.`,
      read: false,
      originEventId: receiptId,
      createdAt: now,
    }, { merge: true });

    return { receipt, restitution: updatedRestitution, movement };
  });
}

export const declareRestitutionPaymentOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideDeclareRestitutionPayment(
      getAdminDb(),
      request.auth?.uid,
      request.data
    );
  }
);

export const confirmRestitutionReceiptOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideConfirmRestitutionReceipt(
      getAdminDb(),
      request.auth?.uid,
      request.data
    );
  }
);

// ==============================================================================
// FASE 7: TRANSFERÊNCIAS E CUSTÓDIA ENTRE PARTICIPANTES
// ==============================================================================

export function serverGenerateCustodyTransferDocId(senderUid, idempotencyKey) {
  const cleanUid = (senderUid || '').trim();
  const cleanKey = (idempotencyKey || '').trim();
  const cleanSlug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  const hash = sha256HexServer(`cust_xfer:${cleanUid}:${cleanKey}`);
  return `cust_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function serverGenerateCustodyEventDocId(transferId, eventType, idempotencyKey) {
  const cleanXfer = (transferId || '').trim();
  const cleanEvt = (eventType || '').trim();
  const cleanKey = (idempotencyKey || '').trim();
  const cleanSlug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
  const hash = sha256HexServer(`cust_evt:${cleanXfer}:${cleanEvt}:${cleanKey}`);
  return `cevt_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function serverGenerateCustodyUsageDocId(transferId, expenseId, idempotencyKey) {
  const cleanXfer = (transferId || '').trim();
  const cleanExp = (expenseId || '').trim();
  const cleanKey = (idempotencyKey || '').trim();
  const cleanSlug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
  const hash = sha256HexServer(`cust_use:${cleanXfer}:${cleanExp}:${cleanKey}`);
  return `cuse_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function serverGenerateCustodyReturnDocId(transferId, idempotencyKey) {
  const cleanXfer = (transferId || '').trim();
  const cleanKey = (idempotencyKey || '').trim();
  const cleanSlug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
  const hash = sha256HexServer(`cust_ret:${cleanXfer}:${cleanKey}`);
  return `cret_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

/**
 * Criação da transferência sob custódia:
 * Debita a conta de origem do remetente e cria a obrigação/registro de custódia em pending_receipt.
 */
export async function executeServerSideCreateCustodyTransfer(db, callerUid, payload) {
  if (!callerUid || typeof callerUid !== 'string' || !callerUid.trim()) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória para transferências sob custódia.');
  }

  const cleanSender = callerUid.trim();
  const cleanCustodian = (payload.custodianUid || '').trim();
  const cleanSourceAcc = (payload.sourceAccountId || '').trim();
  const spaceId = payload.spaceId ? String(payload.spaceId).trim() : null;
  const scopeType = payload.scopeType === 'direct_bilateral' ? 'direct_bilateral' : 'shared_space';
  const transferType = payload.transferType === 'linked_to_expense' ? 'linked_to_expense' : 'free_custody';
  const targetExpenseId = payload.targetExpenseId ? String(payload.targetExpenseId).trim() : null;
  const initialAmountCents = Number(payload.initialAmountCents);
  const transferDate = (payload.transferDate || '').trim();
  const description = (payload.description || '').trim() || 'Transferência sob custódia';
  const notes = payload.notes ? String(payload.notes).trim() : null;
  const idemKey = (payload.idempotencyKey || '').trim();

  if (!cleanCustodian || cleanCustodian === cleanSender) {
    throw new HttpsError('invalid-argument', 'O destinatário da custódia deve ser um participante distinto do remetente.');
  }
  if (!Number.isSafeInteger(initialAmountCents) || initialAmountCents <= 0) {
    throw new HttpsError('invalid-argument', 'O valor inicial deve ser um inteiro estritamente positivo em centavos.');
  }
  if (!cleanSourceAcc) {
    throw new HttpsError('invalid-argument', 'A conta bancária de origem é obrigatória.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(transferDate)) {
    throw new HttpsError('invalid-argument', 'Data de transferência inválida. Use o formato YYYY-MM-DD.');
  }
  if (!idemKey) {
    throw new HttpsError('invalid-argument', 'Chave de idempotência é obrigatória.');
  }

  const transferId = serverGenerateCustodyTransferDocId(cleanSender, idemKey);

  return await db.runTransaction(async (tx) => {
    // 1. Valida espaço se aplicável
    let spaceData = null;
    if (scopeType === 'shared_space' && spaceId) {
      const spaceSnap = await tx.get(db.collection('spaces').doc(spaceId));
      if (!spaceSnap.exists) {
        throw new HttpsError('not-found', 'Espaço compartilhado não encontrado.');
      }
      spaceData = spaceSnap.data();
      if (spaceData.spaceStatus !== 'active') {
        throw new HttpsError('failed-precondition', 'Espaço compartilhado não está ativo.');
      }
      const members = spaceData.memberUids || [];
      if (!members.includes(cleanSender) || !members.includes(cleanCustodian)) {
        throw new HttpsError('permission-denied', 'Ambos os participantes devem ser membros do espaço compartilhado.');
      }
    }

    // 2. Verifica idempotência
    const transferRef = db.collection('transfers').doc(transferId);
    const transferSnap = await tx.get(transferRef);
    if (transferSnap.exists) {
      const existing = transferSnap.data();
      if (
        existing.initialAmountCents !== initialAmountCents ||
        existing.senderUid !== cleanSender ||
        existing.custodianUid !== cleanCustodian ||
        existing.sourceAccountId !== cleanSourceAcc
      ) {
        throw new HttpsError('already-exists', 'Conflito de idempotência: transferência existente com parâmetros divergentes.');
      }
      const existingMovSnap = await tx.get(
        db.collection('accounts').doc(cleanSourceAcc).collection('movements').doc(existing.sourceMovementId)
      );
      return {
        transfer: existing,
        sourceMovement: existingMovSnap.exists ? existingMovSnap.data() : null,
        isIdempotentReplay: true,
      };
    }

    // 3. Valida conta de origem
    const sourceAccRef = db.collection('accounts').doc(cleanSourceAcc);
    const sourceAccSnap = await tx.get(sourceAccRef);
    if (!sourceAccSnap.exists || sourceAccSnap.data().userId !== cleanSender) {
      throw new HttpsError('permission-denied', 'Conta bancária de origem não encontrada ou não pertence ao remetente.');
    }
    const sourceAcc = sourceAccSnap.data();
    if (isAccountArchivedServer(sourceAcc)) {
      throw new HttpsError('failed-precondition', 'A conta de origem está arquivada.');
    }
    if (isCreditAccountServer(sourceAcc)) {
      throw new HttpsError('invalid-argument', 'Transferências sob custódia não podem ser debitadas diretamente de conta de cartão de crédito.');
    }

    const now = new Date().toISOString();
    const movId = serverGenerateMovementDocId(cleanSourceAcc, `${idemKey}_out`);
    const movRef = sourceAccRef.collection('movements').doc(movId);

    const sourceMovement = serverBuildFinancialMovement({
      id: movId,
      accountId: cleanSourceAcc,
      userId: cleanSender,
      direction: 'outflow',
      amountCents: initialAmountCents,
      effectiveDate: transferDate,
      originType: 'custody_transfer_out',
      originId: transferId,
      description: `${description} (Custodiante: ${cleanCustodian})`,
      notes: notes || `Transferência de recursos para custódia #${transferId}`,
      authorUid: cleanSender,
      idempotencyKey: `${idemKey}_out`,
    });

    // 4. Executa débito contábil
    tx.set(movRef, sourceMovement);
    const currentBal = sourceAcc.projectedBalanceCents || 0;
    tx.update(sourceAccRef, {
      projectedBalanceCents: currentBal - initialAmountCents,
      updatedAt: now,
    });

    // 5. Grava documento canônico da custódia
    const transferDoc = {
      id: transferId,
      scopeType,
      spaceId: spaceId || null,
      transferType,
      targetExpenseId: targetExpenseId || null,
      senderUid: cleanSender,
      custodianUid: cleanCustodian,
      initialAmountCents,
      confirmedAmountCents: null,
      usedAmountCents: 0,
      returnedAmountCents: 0,
      availableBalanceCents: 0, // Apenas fica disponível após a confirmação do custodiante
      sourceAccountId: cleanSourceAcc,
      destinationAccountId: null,
      custodyStatus: 'pending_receipt',
      description,
      notes: notes || null,
      transferDate,
      idempotencyKey: idemKey,
      sourceMovementId: movId,
      destinationMovementId: null,
      createdAt: now,
      updatedAt: now,
    };
    tx.set(transferRef, transferDoc);

    // 6. Registra evento de auditoria da custódia
    const eventId = serverGenerateCustodyEventDocId(transferId, 'transfer_declared', idemKey);
    const eventRef = transferRef.collection('events').doc(eventId);
    tx.set(eventRef, {
      id: eventId,
      transferId,
      eventType: 'transfer_declared',
      amountCents: initialAmountCents,
      targetExpenseId: targetExpenseId || null,
      affectedAccountId: cleanSourceAcc,
      financialMovementId: movId,
      performedByUid: cleanSender,
      justification: notes || null,
      clientTransactionUuid: transferId,
      idempotencyKey: idemKey,
      timestamp: now,
    });

    // 7. Notificação e auditoria do espaço
    if (scopeType === 'shared_space' && spaceId && spaceData) {
      const auditId = `audit_cust_created_${transferId}`;
      tx.set(db.collection('spaces').doc(spaceId).collection('audit').doc(auditId), {
        id: auditId,
        spaceId,
        eventType: 'custody_transfer_created',
        performedByUid: cleanSender,
        performedByName: 'Participante',
        targetUid: cleanCustodian,
        details: { transferId, initialAmountCents, transferType, targetExpenseId },
        timestamp: now,
      });

      const notifId = `notif_cust_declared_${transferId}`;
      tx.set(db.collection('users').doc(cleanCustodian).collection('notifications').doc(notifId), {
        id: notifId,
        userId: cleanCustodian,
        spaceId,
        spaceName: spaceData.name || 'Espaço Compartilhado',
        type: 'custody_transfer_created',
        title: 'Transferência sob custódia declarada',
        message: `Você recebeu uma declaração de transferência de R$ ${(initialAmountCents / 100).toFixed(2)} para sua custódia. Confirme o recebimento na sua conta bancária.`,
        read: false,
        originEventId: transferId,
        createdAt: now,
      }, { merge: true });
    }

    return {
      transfer: transferDoc,
      sourceMovement,
      isIdempotentReplay: false,
    };
  });
}

/**
 * Confirmação de recebimento da custódia pelo custodiante:
 * Credita a conta de destino do custodiante e libera o saldo disponível (availableBalanceCents).
 */
export async function executeServerSideConfirmCustodyReceipt(db, callerUid, payload) {
  if (!callerUid || typeof callerUid !== 'string' || !callerUid.trim()) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória para confirmação de recebimento.');
  }

  const cleanCaller = callerUid.trim();
  const transferId = (payload.transferId || '').trim();
  const cleanDestAcc = (payload.destinationAccountId || '').trim();
  const notes = payload.notes ? String(payload.notes).trim() : null;
  const idemKey = (payload.idempotencyKey || '').trim();

  if (!transferId) {
    throw new HttpsError('invalid-argument', 'ID da transferência é obrigatório.');
  }
  if (!cleanDestAcc) {
    throw new HttpsError('invalid-argument', 'Conta de destino do custodiante é obrigatória.');
  }
  if (!idemKey) {
    throw new HttpsError('invalid-argument', 'Chave de idempotência é obrigatória.');
  }

  return await db.runTransaction(async (tx) => {
    const transferRef = db.collection('transfers').doc(transferId);
    const transferSnap = await tx.get(transferRef);
    if (!transferSnap.exists) {
      throw new HttpsError('not-found', 'Transferência sob custódia não encontrada.');
    }
    const transfer = transferSnap.data();

    if (transfer.custodianUid !== cleanCaller) {
      throw new HttpsError('permission-denied', 'Somente o custodiante legítimo pode confirmar o recebimento da custódia.');
    }

    // Suporte a valor confirmado com divergência comprovada
    const confirmedAmount = payload.confirmedAmountCents !== undefined && payload.confirmedAmountCents !== null
      ? Number(payload.confirmedAmountCents)
      : transfer.initialAmountCents;

    if (!Number.isSafeInteger(confirmedAmount) || confirmedAmount <= 0) {
      throw new HttpsError('invalid-argument', 'O valor confirmado deve ser um inteiro positivo em centavos.');
    }
    if (confirmedAmount > transfer.initialAmountCents) {
      throw new HttpsError('invalid-argument', 'O valor confirmado não pode exceder o valor declarado inicialmente.');
    }

    // Idempotência
    if (transfer.custodyStatus !== 'pending_receipt') {
      if (transfer.destinationAccountId === cleanDestAcc && transfer.confirmedAmountCents === confirmedAmount) {
        const destMovSnap = await tx.get(
          db.collection('accounts').doc(cleanDestAcc).collection('movements').doc(transfer.destinationMovementId)
        );
        return {
          transfer,
          destinationMovement: destMovSnap.exists ? destMovSnap.data() : null,
          isIdempotentReplay: true,
        };
      }
      throw new HttpsError('failed-precondition', `A transferência já se encontra no status "${transfer.custodyStatus}".`);
    }

    // Valida conta de destino
    const destAccRef = db.collection('accounts').doc(cleanDestAcc);
    const destAccSnap = await tx.get(destAccRef);
    if (!destAccSnap.exists || destAccSnap.data().userId !== cleanCaller) {
      throw new HttpsError('permission-denied', 'Conta de destino não encontrada ou não pertence ao custodiante.');
    }
    const destAcc = destAccSnap.data();
    if (isAccountArchivedServer(destAcc)) {
      throw new HttpsError('failed-precondition', 'A conta de destino está arquivada.');
    }
    if (isCreditAccountServer(destAcc)) {
      throw new HttpsError('invalid-argument', 'Não é permitido receber custódia diretamente em conta de cartão de crédito.');
    }

    // Valida espaço se aplicável
    let spaceData = null;
    if (transfer.spaceId) {
      const spaceSnap = await tx.get(db.collection('spaces').doc(transfer.spaceId));
      if (spaceSnap.exists) {
        spaceData = spaceSnap.data();
      }
    }

    const now = new Date().toISOString();
    const movId = serverGenerateMovementDocId(cleanDestAcc, `${idemKey}_in`);
    const movRef = destAccRef.collection('movements').doc(movId);

    const destinationMovement = serverBuildFinancialMovement({
      id: movId,
      accountId: cleanDestAcc,
      userId: cleanCaller,
      direction: 'inflow',
      amountCents: confirmedAmount,
      effectiveDate: now.slice(0, 10),
      originType: 'custody_transfer_in',
      originId: transferId,
      description: `Custódia recebida de ${transfer.senderUid}`,
      notes: notes || `Crédito de recursos para custódia #${transferId}`,
      authorUid: cleanCaller,
      idempotencyKey: `${idemKey}_in`,
    });

    // 1. Efetiva crédito na conta do custodiante
    tx.set(movRef, destinationMovement);
    const currentBal = destAcc.projectedBalanceCents || 0;
    tx.update(destAccRef, {
      projectedBalanceCents: currentBal + confirmedAmount,
      updatedAt: now,
    });

    // 2. Atualiza estado da custódia para available
    const updatedTransfer = {
      ...transfer,
      destinationAccountId: cleanDestAcc,
      destinationMovementId: movId,
      confirmedAmountCents: confirmedAmount,
      availableBalanceCents: confirmedAmount,
      custodyStatus: 'available',
      confirmedAt: now,
      updatedAt: now,
    };
    tx.update(transferRef, {
      destinationAccountId: cleanDestAcc,
      destinationMovementId: movId,
      confirmedAmountCents: confirmedAmount,
      availableBalanceCents: confirmedAmount,
      custodyStatus: 'available',
      confirmedAt: now,
      updatedAt: now,
    });

    // 3. Registra evento de auditoria
    const eventId = serverGenerateCustodyEventDocId(transferId, 'receipt_confirmed', idemKey);
    const eventRef = transferRef.collection('events').doc(eventId);
    tx.set(eventRef, {
      id: eventId,
      transferId,
      eventType: 'receipt_confirmed',
      amountCents: confirmedAmount,
      affectedAccountId: cleanDestAcc,
      financialMovementId: movId,
      performedByUid: cleanCaller,
      justification: notes || null,
      clientTransactionUuid: transferId,
      idempotencyKey: idemKey,
      timestamp: now,
    });

    // 4. Notificação e auditoria no espaço
    if (transfer.spaceId) {
      const auditId = `audit_cust_confirmed_${transferId}`;
      tx.set(db.collection('spaces').doc(transfer.spaceId).collection('audit').doc(auditId), {
        id: auditId,
        spaceId: transfer.spaceId,
        eventType: 'custody_receipt_confirmed',
        performedByUid: cleanCaller,
        performedByName: 'Custodiante',
        targetUid: transfer.senderUid,
        details: { transferId, confirmedAmountCents: confirmedAmount },
        timestamp: now,
      });

      const notifId = `notif_cust_confirmed_${transferId}`;
      tx.set(db.collection('users').doc(transfer.senderUid).collection('notifications').doc(notifId), {
        id: notifId,
        userId: transfer.senderUid,
        spaceId: transfer.spaceId,
        spaceName: spaceData?.name || 'Espaço Compartilhado',
        type: 'custody_receipt_confirmed',
        title: 'Recebimento de custódia confirmado',
        message: `O custodiante confirmou o recebimento de R$ ${(confirmedAmount / 100).toFixed(2)} em sua conta bancária. O saldo está disponível para uso.`,
        read: false,
        originEventId: transferId,
        createdAt: now,
      }, { merge: true });
    }

    return {
      transfer: updatedTransfer,
      destinationMovement,
      isIdempotentReplay: false,
    };
  });
}

/**
 * Utilização dos recursos sob custódia para pagamento de despesa compartilhada:
 * Abate o saldo sob custódia sem gerar débito bancário adicional (recursos já recebidos pelo custodiante).
 */
export async function executeServerSideUseCustodyFundsInExpense(db, callerUid, payload) {
  if (!callerUid || typeof callerUid !== 'string' || !callerUid.trim()) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória para utilização de custódia.');
  }

  const cleanCaller = callerUid.trim();
  const transferId = (payload.transferId || '').trim();
  const expenseId = (payload.expenseId || '').trim();
  const amountCents = Number(payload.amountCents);
  const notes = payload.notes ? String(payload.notes).trim() : null;
  const idemKey = (payload.idempotencyKey || '').trim();

  if (!transferId) {
    throw new HttpsError('invalid-argument', 'ID da transferência é obrigatório.');
  }
  if (!expenseId) {
    throw new HttpsError('invalid-argument', 'ID da despesa compartilhada é obrigatório.');
  }
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new HttpsError('invalid-argument', 'O valor utilizado deve ser um inteiro positivo em centavos.');
  }
  if (!idemKey) {
    throw new HttpsError('invalid-argument', 'Chave de idempotência é obrigatória.');
  }

  const usageId = serverGenerateCustodyUsageDocId(transferId, expenseId, idemKey);

  return await db.runTransaction(async (tx) => {
    const transferRef = db.collection('transfers').doc(transferId);
    const transferSnap = await tx.get(transferRef);
    if (!transferSnap.exists) {
      throw new HttpsError('not-found', 'Transferência sob custódia não encontrada.');
    }
    const transfer = transferSnap.data();

    if (transfer.custodianUid !== cleanCaller) {
      throw new HttpsError('permission-denied', 'Somente o custodiante legítimo pode alocar fundos sob sua custódia.');
    }

    const usageRef = transferRef.collection('usages').doc(usageId);
    const usageSnap = await tx.get(usageRef);
    if (usageSnap.exists) {
      return {
        transfer,
        usage: usageSnap.data(),
        isIdempotentReplay: true,
      };
    }

    if (transfer.custodyStatus !== 'available' && transfer.custodyStatus !== 'partially_used') {
      throw new HttpsError('failed-precondition', `A transferência está com status "${transfer.custodyStatus}" e não permite utilização.`);
    }

    if (amountCents > transfer.availableBalanceCents) {
      throw new HttpsError(
        'invalid-argument',
        `O valor solicitado (${amountCents} centavos) excede o saldo em custódia disponível (${transfer.availableBalanceCents} centavos).`
      );
    }

    // Se vinculada a um espaço, valida que a despesa existe
    let spaceData = null;
    if (transfer.spaceId) {
      const expSnap = await tx.get(db.collection('spaces').doc(transfer.spaceId).collection('shared_expenses').doc(expenseId));
      if (!expSnap.exists) {
        throw new HttpsError('not-found', 'Despesa compartilhada não encontrada.');
      }
      const spaceSnap = await tx.get(db.collection('spaces').doc(transfer.spaceId));
      spaceData = spaceSnap.exists ? spaceSnap.data() : null;
    }

    const now = new Date().toISOString();
    const newAvailable = transfer.availableBalanceCents - amountCents;
    const newUsed = (transfer.usedAmountCents || 0) + amountCents;

    let newStatus = 'partially_used';
    if (newAvailable === 0) {
      newStatus = (transfer.returnedAmountCents || 0) > 0 ? 'settled_by_mixed' : 'settled_by_usage';
    }

    const updatedTransfer = {
      ...transfer,
      availableBalanceCents: newAvailable,
      usedAmountCents: newUsed,
      custodyStatus: newStatus,
      updatedAt: now,
    };
    tx.update(transferRef, {
      availableBalanceCents: newAvailable,
      usedAmountCents: newUsed,
      custodyStatus: newStatus,
      updatedAt: now,
    });

    const usageDoc = {
      id: usageId,
      transferId,
      spaceId: transfer.spaceId || null,
      expenseId,
      amountCents,
      usedByUid: cleanCaller,
      beneficiaryUid: transfer.senderUid,
      notes: notes || null,
      idempotencyKey: idemKey,
      createdAt: now,
    };
    tx.set(usageRef, usageDoc);

    // Registra evento de auditoria
    const eventId = serverGenerateCustodyEventDocId(transferId, 'expense_consumed', idemKey);
    const eventRef = transferRef.collection('events').doc(eventId);
    tx.set(eventRef, {
      id: eventId,
      transferId,
      eventType: 'expense_consumed',
      amountCents,
      targetExpenseId: expenseId,
      performedByUid: cleanCaller,
      justification: notes || null,
      clientTransactionUuid: usageId,
      idempotencyKey: idemKey,
      timestamp: now,
    });

    // Notificação e auditoria do espaço
    if (transfer.spaceId && spaceData) {
      const auditId = `audit_cust_use_${usageId}`;
      tx.set(db.collection('spaces').doc(transfer.spaceId).collection('audit').doc(auditId), {
        id: auditId,
        spaceId: transfer.spaceId,
        eventType: 'custody_consumed',
        performedByUid: cleanCaller,
        performedByName: 'Custodiante',
        targetUid: transfer.senderUid,
        details: { transferId, expenseId, amountCents, remainingAvailableCents: newAvailable },
        timestamp: now,
      });

      const notifId = `notif_cust_use_${usageId}`;
      tx.set(db.collection('users').doc(transfer.senderUid).collection('notifications').doc(notifId), {
        id: notifId,
        userId: transfer.senderUid,
        spaceId: transfer.spaceId,
        spaceName: spaceData.name || 'Espaço Compartilhado',
        type: 'custody_consumed',
        title: 'Recursos sob custódia utilizados em despesa',
        message: `R$ ${(amountCents / 100).toFixed(2)} dos seus fundos sob custódia foram utilizados pelo custodiante para cobrir despesa compartilhada. Saldo restante: R$ ${(newAvailable / 100).toFixed(2)}.`,
        read: false,
        originEventId: usageId,
        createdAt: now,
      }, { merge: true });
    }

    return {
      transfer: updatedTransfer,
      usage: usageDoc,
      isIdempotentReplay: false,
    };
  });
}

/**
 * Devolução de fundos sob custódia (Custody Return):
 * Transfere atomicamente o saldo não utilizado de volta para a conta do remetente original.
 */
export async function executeServerSideReturnCustodyFunds(db, callerUid, payload) {
  if (!callerUid || typeof callerUid !== 'string' || !callerUid.trim()) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória para devolução de custódia.');
  }

  const cleanCaller = callerUid.trim();
  const transferId = (payload.transferId || '').trim();
  const cleanSourceAcc = (payload.sourceAccountId || '').trim();
  const cleanDestAcc = (payload.destinationAccountId || '').trim();
  const amountCents = Number(payload.amountCents);
  const justification = payload.justification ? String(payload.justification).trim() : null;
  const idemKey = (payload.idempotencyKey || '').trim();

  if (!transferId) {
    throw new HttpsError('invalid-argument', 'ID da transferência é obrigatório.');
  }
  if (!cleanSourceAcc) {
    throw new HttpsError('invalid-argument', 'Conta bancária de saída do custodiante é obrigatória.');
  }
  if (!cleanDestAcc) {
    throw new HttpsError('invalid-argument', 'Conta bancária de destino do remetente é obrigatória.');
  }
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new HttpsError('invalid-argument', 'O valor de devolução deve ser um inteiro positivo em centavos.');
  }
  if (!idemKey) {
    throw new HttpsError('invalid-argument', 'Chave de idempotência é obrigatória.');
  }

  const returnId = serverGenerateCustodyReturnDocId(transferId, idemKey);

  return await db.runTransaction(async (tx) => {
    const transferRef = db.collection('transfers').doc(transferId);
    const transferSnap = await tx.get(transferRef);
    if (!transferSnap.exists) {
      throw new HttpsError('not-found', 'Transferência sob custódia não encontrada.');
    }
    const transfer = transferSnap.data();

    if (transfer.custodianUid !== cleanCaller) {
      throw new HttpsError('permission-denied', 'Somente o custodiante legítimo pode autorizar a devolução dos recursos em custódia.');
    }

    const returnRef = transferRef.collection('returns').doc(returnId);
    const returnSnap = await tx.get(returnRef);
    if (returnSnap.exists) {
      const existingRet = returnSnap.data();
      const outMovSnap = await tx.get(
        db.collection('accounts').doc(cleanSourceAcc).collection('movements').doc(existingRet.sourceMovementId)
      );
      const inMovSnap = await tx.get(
        db.collection('accounts').doc(cleanDestAcc).collection('movements').doc(existingRet.destinationMovementId)
      );
      return {
        transfer,
        returnRecord: existingRet,
        sourceMovement: outMovSnap.exists ? outMovSnap.data() : null,
        destinationMovement: inMovSnap.exists ? inMovSnap.data() : null,
        isIdempotentReplay: true,
      };
    }

    if (amountCents > transfer.availableBalanceCents) {
      throw new HttpsError(
        'invalid-argument',
        `O valor de devolução (${amountCents} centavos) excede o saldo disponível sob custódia (${transfer.availableBalanceCents} centavos).`
      );
    }

    // Valida conta do custodiante (saída)
    const srcAccRef = db.collection('accounts').doc(cleanSourceAcc);
    const srcAccSnap = await tx.get(srcAccRef);
    if (!srcAccSnap.exists || srcAccSnap.data().userId !== cleanCaller) {
      throw new HttpsError('permission-denied', 'Conta de saída não encontrada ou não pertence ao custodiante.');
    }
    const srcAcc = srcAccSnap.data();
    if (isAccountArchivedServer(srcAcc)) {
      throw new HttpsError('failed-precondition', 'A conta de saída do custodiante está arquivada.');
    }
    if (isCreditAccountServer(srcAcc)) {
      throw new HttpsError('invalid-argument', 'Devoluções de custódia não podem sair de conta de cartão de crédito.');
    }

    // Valida conta do remetente original (entrada)
    const dstAccRef = db.collection('accounts').doc(cleanDestAcc);
    const dstAccSnap = await tx.get(dstAccRef);
    if (!dstAccSnap.exists || dstAccSnap.data().userId !== transfer.senderUid) {
      throw new HttpsError('permission-denied', 'Conta de destino não encontrada ou não pertence ao remetente original.');
    }
    const dstAcc = dstAccSnap.data();
    if (isAccountArchivedServer(dstAcc)) {
      throw new HttpsError('failed-precondition', 'A conta de destino do remetente está arquivada.');
    }
    if (isCreditAccountServer(dstAcc)) {
      throw new HttpsError('invalid-argument', 'Devoluções de custódia não podem ser recebidas diretamente em conta de cartão.');
    }

    let spaceData = null;
    if (transfer.spaceId) {
      const spaceSnap = await tx.get(db.collection('spaces').doc(transfer.spaceId));
      if (spaceSnap.exists) {
        spaceData = spaceSnap.data();
      }
    }

    const now = new Date().toISOString();
    const effectiveDate = now.slice(0, 10);

    // 1. Movimento de saída do custodiante
    const outMovId = serverGenerateMovementDocId(cleanSourceAcc, `${idemKey}_ret_out`);
    const outMovRef = srcAccRef.collection('movements').doc(outMovId);
    const sourceMovement = serverBuildFinancialMovement({
      id: outMovId,
      accountId: cleanSourceAcc,
      userId: cleanCaller,
      direction: 'outflow',
      amountCents,
      effectiveDate,
      originType: 'custody_return_out',
      originId: returnId,
      description: `Devolução de custódia para ${transfer.senderUid}`,
      notes: justification || `Devolução de recursos não utilizados da custódia #${transferId}`,
      authorUid: cleanCaller,
      idempotencyKey: `${idemKey}_ret_out`,
    });
    tx.set(outMovRef, sourceMovement);
    tx.update(srcAccRef, {
      projectedBalanceCents: (srcAcc.projectedBalanceCents || 0) - amountCents,
      updatedAt: now,
    });

    // 2. Movimento de entrada no remetente
    const inMovId = serverGenerateMovementDocId(cleanDestAcc, `${idemKey}_ret_in`);
    const inMovRef = dstAccRef.collection('movements').doc(inMovId);
    const destinationMovement = serverBuildFinancialMovement({
      id: inMovId,
      accountId: cleanDestAcc,
      userId: transfer.senderUid,
      direction: 'inflow',
      amountCents,
      effectiveDate,
      originType: 'custody_return_in',
      originId: returnId,
      description: `Devolução de custódia de ${cleanCaller}`,
      notes: justification || `Ressarcimento de saldo não utilizado da custódia #${transferId}`,
      authorUid: cleanCaller,
      idempotencyKey: `${idemKey}_ret_in`,
    });
    tx.set(inMovRef, destinationMovement);
    tx.update(dstAccRef, {
      projectedBalanceCents: (dstAcc.projectedBalanceCents || 0) + amountCents,
      updatedAt: now,
    });

    // 3. Atualiza saldos da custódia
    const newAvailable = transfer.availableBalanceCents - amountCents;
    const newReturned = (transfer.returnedAmountCents || 0) + amountCents;

    let newStatus = 'partial_return_confirmed';
    if (newAvailable === 0) {
      newStatus = (transfer.usedAmountCents || 0) > 0 ? 'settled_by_mixed' : 'settled_by_return';
    }

    const updatedTransfer = {
      ...transfer,
      availableBalanceCents: newAvailable,
      returnedAmountCents: newReturned,
      custodyStatus: newStatus,
      updatedAt: now,
    };
    tx.update(transferRef, {
      availableBalanceCents: newAvailable,
      returnedAmountCents: newReturned,
      custodyStatus: newStatus,
      updatedAt: now,
    });

    // 4. Registro canônico de devolução
    const returnRecord = {
      id: returnId,
      transferId,
      spaceId: transfer.spaceId || null,
      amountCents,
      returnedByUid: cleanCaller,
      receivedByUid: transfer.senderUid,
      sourceAccountId: cleanSourceAcc,
      destinationAccountId: cleanDestAcc,
      sourceMovementId: outMovId,
      destinationMovementId: inMovId,
      justification: justification || null,
      idempotencyKey: idemKey,
      createdAt: now,
    };
    tx.set(returnRef, returnRecord);

    // 5. Registra evento de auditoria
    const eventId = serverGenerateCustodyEventDocId(transferId, 'return_confirmed', idemKey);
    const eventRef = transferRef.collection('events').doc(eventId);
    tx.set(eventRef, {
      id: eventId,
      transferId,
      eventType: 'return_confirmed',
      amountCents,
      affectedAccountId: cleanSourceAcc,
      financialMovementId: outMovId,
      performedByUid: cleanCaller,
      justification: justification || null,
      clientTransactionUuid: returnId,
      idempotencyKey: idemKey,
      timestamp: now,
    });

    // 6. Notificação e auditoria no espaço
    if (transfer.spaceId) {
      const auditId = `audit_cust_return_${returnId}`;
      tx.set(db.collection('spaces').doc(transfer.spaceId).collection('audit').doc(auditId), {
        id: auditId,
        spaceId: transfer.spaceId,
        eventType: 'custody_return_confirmed',
        performedByUid: cleanCaller,
        performedByName: 'Custodiante',
        targetUid: transfer.senderUid,
        details: { transferId, returnId, amountCents, remainingAvailableCents: newAvailable },
        timestamp: now,
      });

      const notifId = `notif_cust_return_${returnId}`;
      tx.set(db.collection('users').doc(transfer.senderUid).collection('notifications').doc(notifId), {
        id: notifId,
        userId: transfer.senderUid,
        spaceId: transfer.spaceId,
        spaceName: spaceData?.name || 'Espaço Compartilhado',
        type: 'custody_return_confirmed',
        title: 'Devolução de fundos em custódia confirmada',
        message: `O custodiante devolveu R$ ${(amountCents / 100).toFixed(2)} para sua conta bancária.`,
        read: false,
        originEventId: returnId,
        createdAt: now,
      }, { merge: true });
    }

    return {
      transfer: updatedTransfer,
      returnRecord,
      sourceMovement,
      destinationMovement,
      isIdempotentReplay: false,
    };
  });
}

export const createCustodyTransferOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideCreateCustodyTransfer(
      getAdminDb(),
      request.auth?.uid,
      request.data
    );
  }
);

export const confirmCustodyReceiptOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideConfirmCustodyReceipt(
      getAdminDb(),
      request.auth?.uid,
      request.data
    );
  }
);

export const useCustodyFundsInExpenseOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideUseCustodyFundsInExpense(
      getAdminDb(),
      request.auth?.uid,
      request.data
    );
  }
);

export const returnCustodyFundsOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideReturnCustodyFunds(
      getAdminDb(),
      request.auth?.uid,
      request.data
    );
  }
);

// ==============================================================================
// FASE 8: LISTAS DE AQUISIÇÃO E COPROPRIEDADE DE BENS (ARQUITETURA V3.1)
// ==============================================================================

export function serverGenerateAcquisitionPurchaseDocId(itemId, idempotencyKey) {
  const cleanItem = (itemId || '').trim();
  const cleanKey = (idempotencyKey || '').trim();
  const cleanSlug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  const hash = sha256HexServer(`acq_purch:${cleanItem}:${cleanKey}`);
  return `pur_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function serverGenerateStockMovementDocId(itemId, idempotencyKey) {
  const cleanItem = (itemId || '').trim();
  const cleanKey = (idempotencyKey || '').trim();
  const cleanSlug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
  const hash = sha256HexServer(`acq_stock:${cleanItem}:${cleanKey}`);
  return `smov_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function serverGenerateQuoteDocId(itemId, idempotencyKey) {
  const cleanItem = (itemId || '').trim();
  const cleanKey = (idempotencyKey || '').trim();
  const cleanSlug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
  const hash = sha256HexServer(`acq_quote:${cleanItem}:${cleanKey}`);
  return `quot_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function serverGenerateDepositDocId(itemId, idempotencyKey) {
  const cleanItem = (itemId || '').trim();
  const cleanKey = (idempotencyKey || '').trim();
  const cleanSlug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
  const hash = sha256HexServer(`acq_dep:${cleanItem}:${cleanKey}`);
  return `dep_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

/**
 * Checkout de item de aquisição com registro canônico de copropriedade imutável.
 */
export async function executeServerSideAcquisitionCheckout(db, callerUid, payload) {
  if (!callerUid || typeof callerUid !== 'string' || !callerUid.trim()) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória para checkout de aquisições.');
  }

  const cleanCaller = callerUid.trim();
  const listId = (payload.listId || '').trim();
  const itemId = (payload.itemId || '').trim();
  const physicalBuyerUid = (payload.physicalBuyerUid || cleanCaller).trim();
  const storeName = (payload.storeName || '').trim();
  const brand = payload.brand ? String(payload.brand).trim() : null;
  const quantity = Number(payload.quantity) || 1;
  const unitPriceCents = Number(payload.unitPriceCents);
  const itemsNetCents = Number(payload.itemsNetCents !== undefined ? payload.itemsNetCents : unitPriceCents * quantity);
  const shippingCents = Number(payload.shippingCents || 0);
  const feesCents = Number(payload.feesCents || 0);
  const discountsCents = Number(payload.discountsCents || 0);
  const totalPaidCents = Number(payload.totalPaidCents);
  const purchaseDate = (payload.purchaseDate || new Date().toISOString().slice(0, 10)).trim();
  const receiptUrl = payload.receiptUrl ? String(payload.receiptUrl).trim() : null;
  const ownershipClassification = payload.ownershipClassification || 'individual';
  const linkedExpenseId = (payload.linkedExpenseId || `exp_acq_${Date.now()}`).trim();
  const linkedExpenseType = payload.linkedExpenseType || 'personal';
  const disbursements = Array.isArray(payload.disbursements) ? payload.disbursements : [];
  const idemKey = (payload.idempotencyKey || '').trim();

  if (!listId) throw new HttpsError('invalid-argument', 'listId é obrigatório.');
  if (!itemId) throw new HttpsError('invalid-argument', 'itemId é obrigatório.');
  if (!storeName) throw new HttpsError('invalid-argument', 'storeName é obrigatório.');
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new HttpsError('invalid-argument', 'quantity deve ser um inteiro estritamente positivo.');
  }
  if (!Number.isSafeInteger(totalPaidCents) || totalPaidCents <= 0) {
    throw new HttpsError('invalid-argument', 'totalPaidCents deve ser um inteiro estritamente positivo em centavos.');
  }
  if (itemsNetCents + shippingCents + feesCents - discountsCents !== totalPaidCents) {
    throw new HttpsError(
      'invalid-argument',
      `Inconsistência contábil: itensNet (${itemsNetCents}) + frete (${shippingCents}) + taxas (${feesCents}) - descontos (${discountsCents}) != total (${totalPaidCents}).`
    );
  }
  if (!disbursements.length) {
    throw new HttpsError('invalid-argument', 'Ao menos um desembolso deve ser informado para o checkout.');
  }
  if (!idemKey) {
    throw new HttpsError('invalid-argument', 'Chave de idempotência é obrigatória.');
  }

  // Validação estrita da conservação contábil dos desembolsos
  let sumDisbursements = 0;
  for (const d of disbursements) {
    const dAmount = Number(d.disbursedAmountCents);
    if (!Number.isSafeInteger(dAmount) || dAmount <= 0) {
      throw new HttpsError('invalid-argument', 'Cada valor desembolsado deve ser um inteiro estritamente positivo em centavos.');
    }
    if (!d.funderUid) {
      throw new HttpsError('invalid-argument', 'funderUid é obrigatório em cada desembolso.');
    }
    sumDisbursements += dAmount;
  }
  if (sumDisbursements !== totalPaidCents) {
    throw new HttpsError(
      'invalid-argument',
      `A soma dos desembolsos (${sumDisbursements} centavos) deve ser exatamente igual ao total pago (${totalPaidCents} centavos).`
    );
  }

  // Cálculo proporcional rigoroso da copropriedade patrimonial
  const ownershipShares = disbursements.map((d) => {
    const dAmount = Number(d.disbursedAmountCents);
    const percentage = Math.round(((dAmount / totalPaidCents) * 100) * 10000) / 10000;
    return {
      uid: String(d.funderUid).trim(),
      name: String(d.funderName || 'Participante').trim(),
      disbursedAmountCents: dAmount,
      ownershipPercentage: percentage,
    };
  });

  const purchaseId = serverGenerateAcquisitionPurchaseDocId(itemId, idemKey);

  return await db.runTransaction(async (tx) => {
    // 1. Leituras Firestore antes de escritas
    const listRef = db.collection('acquisition_lists').doc(listId);
    const listSnap = await tx.get(listRef);
    if (!listSnap.exists) {
      throw new HttpsError('not-found', 'Lista de aquisições não encontrada.');
    }
    const listData = listSnap.data();

    // Valida permissão do chamador
    if (listData.scopeType === 'individual') {
      if (listData.ownerUid !== cleanCaller) {
        throw new HttpsError('permission-denied', 'Apenas o proprietário pode realizar checkout na lista individual.');
      }
    } else {
      if (!listData.spaceId) {
        throw new HttpsError('failed-precondition', 'Lista compartilhada sem spaceId associado.');
      }
      const spaceSnap = await tx.get(db.collection('spaces').doc(listData.spaceId));
      if (!spaceSnap.exists) {
        throw new HttpsError('not-found', 'Espaço da lista compartilhada não encontrado.');
      }
      const spaceData = spaceSnap.data();
      if (!spaceData.memberUids?.includes(cleanCaller)) {
        throw new HttpsError('permission-denied', 'Apenas membros do espaço podem realizar checkout na lista.');
      }
    }

    const itemRef = listRef.collection('items').doc(itemId);
    const itemSnap = await tx.get(itemRef);
    if (!itemSnap.exists) {
      throw new HttpsError('not-found', 'Item de aquisição não encontrado na lista.');
    }
    const itemData = itemSnap.data();

    // Idempotência
    const purchaseRef = itemRef.collection('purchases').doc(purchaseId);
    const purchaseSnap = await tx.get(purchaseRef);
    if (purchaseSnap.exists) {
      return {
        purchase: purchaseSnap.data(),
        item: itemData,
        isIdempotentReplay: true,
      };
    }

    const now = new Date().toISOString();

    // 2. Criação do registro de compra com copropriedade
    const purchaseRecord = {
      id: purchaseId,
      itemId,
      listId,
      spaceId: listData.spaceId || null,
      physicalBuyerUid,
      authorUid: cleanCaller,
      storeName,
      brand,
      quantity,
      unitPriceCents,
      itemsNetCents,
      shippingCents,
      feesCents,
      discountsCents,
      totalPaidCents,
      purchaseDate,
      receiptUrl,
      ownershipClassification,
      disbursements: disbursements.map((d) => ({
        funderUid: String(d.funderUid).trim(),
        funderName: String(d.funderName || '').trim(),
        disbursedAmountCents: Number(d.disbursedAmountCents),
        fundingSource: d.fundingSource || 'checking',
        sourceAccountId: d.sourceAccountId || null,
      })),
      ownershipShares,
      linkedExpenseId,
      linkedExpenseType,
      idempotencyKey: idemKey,
      createdAt: now,
    };
    tx.set(purchaseRef, purchaseRecord);

    // 3. Atualização de estado do item
    let newStage = itemData.stage;
    let newStock = itemData.currentStock || 0;
    let finalPaidAmountCents = itemData.finalPaidAmountCents || null;

    if (itemData.listType === 'recorrente') {
      newStock += quantity;
      newStage = 'conferido';

      // Registra evento de movimentação de estoque automática
      const smovId = serverGenerateStockMovementDocId(itemId, `${idemKey}_smov`);
      const smovRef = itemRef.collection('stock_movements').doc(smovId);
      tx.set(smovRef, {
        id: smovId,
        itemId,
        movementType: 'purchase_inflow',
        quantityDelta: quantity,
        previousStock: itemData.currentStock || 0,
        newStock,
        authorUid: cleanCaller,
        justification: `Entrada automática de compra efetuada em ${storeName}`,
        createdAt: now,
      });
    } else if (itemData.listType === 'objetivo') {
      newStage = 'adquirido';
      finalPaidAmountCents = totalPaidCents;
    } else if (itemData.listType === 'desejo') {
      newStage = 'adquirido';
    }

    const updatedItem = {
      ...itemData,
      stage: newStage,
      currentStock: newStock,
      finalPaidAmountCents,
      updatedAt: now,
    };
    tx.update(itemRef, {
      stage: newStage,
      currentStock: newStock,
      finalPaidAmountCents,
      updatedAt: now,
    });

    // 4. Auditoria no espaço se for lista compartilhada
    if (listData.scopeType === 'shared' && listData.spaceId) {
      const auditId = `audit_acq_pur_${purchaseId}`;
      tx.set(db.collection('spaces').doc(listData.spaceId).collection('audit').doc(auditId), {
        id: auditId,
        spaceId: listData.spaceId,
        eventType: 'acquisition_purchased',
        performedByUid: cleanCaller,
        performedByName: 'Participante',
        targetUid: null,
        details: { listId, itemId, purchaseId, totalPaidCents, quantity, storeName },
        timestamp: now,
      });
    }

    return {
      purchase: purchaseRecord,
      item: updatedItem,
      isIdempotentReplay: false,
    };
  });
}

/**
 * Movimentação de estoque de item recorrente.
 */
export async function executeServerSideRecordStockMovement(db, callerUid, payload) {
  if (!callerUid || typeof callerUid !== 'string' || !callerUid.trim()) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória.');
  }

  const cleanCaller = callerUid.trim();
  const listId = (payload.listId || '').trim();
  const itemId = (payload.itemId || '').trim();
  const movementType = payload.movementType || 'manual_adjustment';
  const quantityDelta = Number(payload.quantityDelta);
  const justification = payload.justification ? String(payload.justification).trim() : null;
  const idemKey = (payload.idempotencyKey || '').trim();

  if (!listId) throw new HttpsError('invalid-argument', 'listId é obrigatório.');
  if (!itemId) throw new HttpsError('invalid-argument', 'itemId é obrigatório.');
  if (!Number.isSafeInteger(quantityDelta) || quantityDelta === 0) {
    throw new HttpsError('invalid-argument', 'quantityDelta deve ser um inteiro diferente de zero.');
  }
  if (!idemKey) throw new HttpsError('invalid-argument', 'Chave de idempotência é obrigatória.');

  const smovId = serverGenerateStockMovementDocId(itemId, idemKey);

  return await db.runTransaction(async (tx) => {
    const listRef = db.collection('acquisition_lists').doc(listId);
    const listSnap = await tx.get(listRef);
    if (!listSnap.exists) throw new HttpsError('not-found', 'Lista não encontrada.');

    const itemRef = listRef.collection('items').doc(itemId);
    const itemSnap = await tx.get(itemRef);
    if (!itemSnap.exists) throw new HttpsError('not-found', 'Item não encontrado.');
    const itemData = itemSnap.data();

    const smovRef = itemRef.collection('stock_movements').doc(smovId);
    const smovSnap = await tx.get(smovRef);
    if (smovSnap.exists) {
      return {
        movement: smovSnap.data(),
        item: itemData,
        isIdempotentReplay: true,
      };
    }

    const previousStock = itemData.currentStock || 0;
    const newStock = Math.max(0, previousStock + quantityDelta);
    const now = new Date().toISOString();

    const movementDoc = {
      id: smovId,
      itemId,
      movementType,
      quantityDelta,
      previousStock,
      newStock,
      authorUid: cleanCaller,
      justification,
      createdAt: now,
    };
    tx.set(smovRef, movementDoc);

    const updatedItem = {
      ...itemData,
      currentStock: newStock,
      updatedAt: now,
    };
    tx.update(itemRef, {
      currentStock: newStock,
      updatedAt: now,
    });

    return {
      movement: movementDoc,
      item: updatedItem,
      isIdempotentReplay: false,
    };
  });
}

/**
 * Cotação de preço para item de objetivo.
 */
export async function executeServerSideRecordQuote(db, callerUid, payload) {
  if (!callerUid || typeof callerUid !== 'string' || !callerUid.trim()) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória.');
  }

  const cleanCaller = callerUid.trim();
  const listId = (payload.listId || '').trim();
  const itemId = (payload.itemId || '').trim();
  const storeName = (payload.storeName || '').trim();
  const priceCents = Number(payload.priceCents);
  const url = payload.url ? String(payload.url).trim() : null;
  const validUntil = payload.validUntil ? String(payload.validUntil).trim() : null;
  const idemKey = (payload.idempotencyKey || '').trim();

  if (!listId || !itemId || !storeName) {
    throw new HttpsError('invalid-argument', 'listId, itemId e storeName são obrigatórios.');
  }
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0) {
    throw new HttpsError('invalid-argument', 'priceCents deve ser um inteiro estritamente positivo em centavos.');
  }
  if (!idemKey) throw new HttpsError('invalid-argument', 'Chave de idempotência é obrigatória.');

  const quoteId = serverGenerateQuoteDocId(itemId, idemKey);

  return await db.runTransaction(async (tx) => {
    const listRef = db.collection('acquisition_lists').doc(listId);
    const listSnap = await tx.get(listRef);
    if (!listSnap.exists) throw new HttpsError('not-found', 'Lista não encontrada.');

    const itemRef = listRef.collection('items').doc(itemId);
    const itemSnap = await tx.get(itemRef);
    if (!itemSnap.exists) throw new HttpsError('not-found', 'Item não encontrado.');
    const itemData = itemSnap.data();

    const quoteRef = itemRef.collection('quotes').doc(quoteId);
    const quoteSnap = await tx.get(quoteRef);
    if (quoteSnap.exists) {
      return { quote: quoteSnap.data(), isIdempotentReplay: true };
    }

    const now = new Date().toISOString();
    const quoteDoc = {
      id: quoteId,
      itemId,
      storeName,
      priceCents,
      url,
      validUntil,
      authorUid: cleanCaller,
      createdAt: now,
    };
    tx.set(quoteRef, quoteDoc);

    return { quote: quoteDoc, isIdempotentReplay: false };
  });
}

/**
 * Aporte de poupança (depósito) para meta de objetivo.
 */
export async function executeServerSideRecordDeposit(db, callerUid, payload) {
  if (!callerUid || typeof callerUid !== 'string' || !callerUid.trim()) {
    throw new HttpsError('unauthenticated', 'Autenticação obrigatória.');
  }

  const cleanCaller = callerUid.trim();
  const listId = (payload.listId || '').trim();
  const itemId = (payload.itemId || '').trim();
  const amountCents = Number(payload.amountCents);
  const sourceAccountId = (payload.sourceAccountId || '').trim();
  const depositDate = (payload.depositDate || new Date().toISOString().slice(0, 10)).trim();
  const notes = payload.notes ? String(payload.notes).trim() : null;
  const idemKey = (payload.idempotencyKey || '').trim();

  if (!listId || !itemId) {
    throw new HttpsError('invalid-argument', 'listId e itemId são obrigatórios.');
  }
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new HttpsError('invalid-argument', 'amountCents deve ser um inteiro estritamente positivo em centavos.');
  }
  if (!idemKey) throw new HttpsError('invalid-argument', 'Chave de idempotência é obrigatória.');

  const depositId = serverGenerateDepositDocId(itemId, idemKey);

  return await db.runTransaction(async (tx) => {
    const listRef = db.collection('acquisition_lists').doc(listId);
    const listSnap = await tx.get(listRef);
    if (!listSnap.exists) throw new HttpsError('not-found', 'Lista não encontrada.');

    const itemRef = listRef.collection('items').doc(itemId);
    const itemSnap = await tx.get(itemRef);
    if (!itemSnap.exists) throw new HttpsError('not-found', 'Item não encontrado.');
    const itemData = itemSnap.data();

    const depositRef = itemRef.collection('deposits').doc(depositId);
    const depositSnap = await tx.get(depositRef);
    if (depositSnap.exists) {
      return { deposit: depositSnap.data(), item: itemData, isIdempotentReplay: true };
    }

    const now = new Date().toISOString();
    const depositDoc = {
      id: depositId,
      itemId,
      contributorUid: cleanCaller,
      amountCents,
      sourceAccountId: sourceAccountId || null,
      depositDate,
      notes,
      createdAt: now,
    };
    tx.set(depositRef, depositDoc);

    const newSaved = (itemData.savedAmountCents || 0) + amountCents;
    let newStage = itemData.stage;
    if (itemData.targetAmountCents && newSaved >= itemData.targetAmountCents) {
      newStage = 'pronto';
    } else if (newSaved > 0 && itemData.stage === 'pesquisa') {
      newStage = 'poupando';
    }

    const updatedItem = {
      ...itemData,
      savedAmountCents: newSaved,
      stage: newStage,
      updatedAt: now,
    };
    tx.update(itemRef, {
      savedAmountCents: newSaved,
      stage: newStage,
      updatedAt: now,
    });

    return { deposit: depositDoc, item: updatedItem, isIdempotentReplay: false };
  });
}

// ------------------------------------------------------------------------------
// CALLABLE EXPORTS FASE 8
// ------------------------------------------------------------------------------

export const acquisitionCheckoutOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideAcquisitionCheckout(
      getAdminDb(),
      request.auth?.uid,
      request.data
    );
  }
);

export const recordStockMovementOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideRecordStockMovement(
      getAdminDb(),
      request.auth?.uid,
      request.data
    );
  }
);

export const recordAcquisitionQuoteOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideRecordQuote(
      getAdminDb(),
      request.auth?.uid,
      request.data
    );
  }
);

export const recordAcquisitionDepositOfficial = onCall(
  { region: 'us-central1' },
  async (request) => {
    return await executeServerSideRecordDeposit(
      getAdminDb(),
      request.auth?.uid,
      request.data
    );
  }
);
