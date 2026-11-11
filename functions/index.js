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


