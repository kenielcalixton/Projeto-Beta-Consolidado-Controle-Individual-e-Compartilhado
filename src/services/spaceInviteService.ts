import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from './firebase';
import {
  ISO8601String,
  Space,
  SpaceInvite,
  SpaceMember,
  SpaceMemberRole,
} from '../types/financeV3';
import {
  generateDeterministicAuditEventId,
  recordSpaceAuditEvent,
} from './spaceAuditService';
import { sendSpaceNotification } from './spaceNotificationService';
import { getSpaceById, getSpaceMembers } from './spaceService';
import { universalStorage } from '../utils/universalStorage';

/**
 * ==============================================================================
 * SERVIÇO DE CONVITES SEGUROS PARA ESPAÇOS COMPARTILHADOS (v3.1)
 * ==============================================================================
 * Ciclo de vida completo de convites com hash criptográfico SHA-256:
 * 1. O token bruto nunca é salvo no Firestore; armazena-se exclusivamente seu hash.
 * 2. Uso estritamente único e atômico (impossibilidade de dupla aceitação).
 * 3. Validação temporal com prazo configurável (padrão 15 dias, sob aprovação).
 * 4. Bloqueio absoluto de convites para espaços arquivados.
 * 5. Associação atômica e inequívoca do UID autenticado aos membros do espaço.
 * 6. SEGURANÇA (Problema 1): Ex-participantes e terceiros NÃO podem listar convites
 *    do espaço (`getSpaceInvites` exige `allowHistorical = false`).
 */

/** Prazo padrão configurável em dias (regra de 15 dias pendente de homologação definitiva) */
export const DEFAULT_INVITE_EXPIRATION_DAYS = 15;

const DEMO_INVITES_KEY = 'mpf_v3_demo_space_invites';

function loadDemoInvites(): SpaceInvite[] {
  try {
    const raw = universalStorage.getItem(DEMO_INVITES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDemoInvites(invites: SpaceInvite[]): void {
  try {
    universalStorage.setItem(DEMO_INVITES_KEY, JSON.stringify(invites));
  } catch (err) {
    console.warn('[DemoStorage] Erro ao salvar convites:', err);
  }
}

/**
 * Gera um hash SHA-256 hexadecimal a partir do token em texto puro.
 */
export async function hashToken(rawToken: string): Promise<string> {
  if (!rawToken || !rawToken.trim()) {
    throw new Error('Token inválido para hashing.');
  }

  const clean = rawToken.trim();
  const encoder = new TextEncoder();
  const data = encoder.encode(clean);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Gera um token seguro e aleatório de 48 caracteres hexadecimais.
 */
export function generateSecureToken(): string {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const array = new Uint8Array(24);
    crypto.getRandomValues(array);
    return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `tok_${Date.now()}_${Math.random().toString(36).substring(2)}${Math.random().toString(36).substring(2)}`;
}

/**
 * Extrai e normaliza o token bruto de entrada do usuário (texto puro, URL com ?token= ou espaços).
 */
export function extractInviteToken(rawInput: string): string {
  const trimmed = (rawInput || '').trim();
  if (!trimmed) return '';
  const queryMatch = trimmed.match(/[?&](?:token|invite)=([^&#\s]+)/i);
  if (queryMatch && queryMatch[1]) {
    try {
      return decodeURIComponent(queryMatch[1]).trim();
    } catch {
      return queryMatch[1].trim();
    }
  }
  return trimmed.replace(/^['"`]+|['"`]+$/g, '').trim();
}

export type InviteAvailabilityCode =
  | 'valid'
  | 'not_found'
  | 'expired'
  | 'accepted'
  | 'rejected'
  | 'revoked'
  | 'already_member'
  | 'email_mismatch';

export interface InviteAvailabilityEvaluation {
  canAccept: boolean;
  code: InviteAvailabilityCode;
  title: string;
  message: string;
}

/**
 * Avalia detalhadamente a disponibilidade de um convite para exibição clara na interface.
 */
export function evaluateInviteAvailability(
  invite: SpaceInvite | null,
  options: {
    currentUserUid?: string;
    currentUserEmail?: string;
    activeMemberUids?: string[];
  } = {}
): InviteAvailabilityEvaluation {
  if (!invite) {
    return {
      canAccept: false,
      code: 'not_found',
      title: 'Convite não localizado',
      message:
        'Nenhum convite foi encontrado para este token. Verifique se copiou todos os caracteres corretamente.',
    };
  }

  if (invite.tokenStatus === 'accepted') {
    return {
      canAccept: false,
      code: 'accepted',
      title: 'Convite já utilizado',
      message:
        invite.acceptedByUid && options.currentUserUid === invite.acceptedByUid
          ? 'Você já utilizou este convite anteriormente.'
          : 'Este convite já foi aceito e é de uso único.',
    };
  }

  if (invite.tokenStatus === 'revoked') {
    return {
      canAccept: false,
      code: 'revoked',
      title: 'Convite revogado',
      message: 'Este convite foi cancelado/revogado por um administrador do espaço.',
    };
  }

  if (invite.tokenStatus === 'rejected') {
    return {
      canAccept: false,
      code: 'rejected',
      title: 'Convite recusado',
      message: 'Este convite foi recusado anteriormente e não pode ser reutilizado.',
    };
  }

  const isExpired =
    invite.tokenStatus === 'expired' ||
    new Date(invite.expiresAt).getTime() < Date.now();
  if (isExpired) {
    return {
      canAccept: false,
      code: 'expired',
      title: 'Convite expirado',
      message: `O prazo de validade deste convite encerrou em ${new Date(
        invite.expiresAt
      ).toLocaleDateString('pt-BR')}. Solicite um novo token ao criador do espaço.`,
    };
  }

  if (
    options.currentUserUid &&
    Array.isArray(options.activeMemberUids) &&
    options.activeMemberUids.includes(options.currentUserUid)
  ) {
    return {
      canAccept: false,
      code: 'already_member',
      title: 'Você já participa deste espaço',
      message: `Você já é membro ativo do espaço "${invite.spaceName}".`,
    };
  }

  if (
    invite.invitedEmail &&
    options.currentUserEmail &&
    invite.invitedEmail.trim().toLowerCase() !== options.currentUserEmail.trim().toLowerCase()
  ) {
    return {
      canAccept: false,
      code: 'email_mismatch',
      title: 'Convite destinado a outro e-mail',
      message: `Este convite foi emitido especificamente para ${invite.invitedEmail}, mas você está autenticado como ${options.currentUserEmail}.`,
    };
  }

  return {
    canAccept: true,
    code: 'valid',
    title: 'Convite válido para ingresso',
    message: `Convite pendente para ingressar em "${invite.spaceName}".`,
  };
}

export interface CreateSpaceInviteInput {
  invitedEmail?: string;
  invitedRole?: SpaceMemberRole;
  expirationDays?: number;
}

/**
 * Cria um convite seguro para ingresso no espaço compartilhado.
 * Retorna o objeto do convite persistido (com hash) e o token em texto puro para compartilhamento.
 */
export async function createSpaceInvite(
  spaceId: string,
  requesterUid: string,
  requesterName: string,
  input: CreateSpaceInviteInput,
  isDemo = false
): Promise<{ invite: SpaceInvite; rawToken: string }> {
  const space = await getSpaceById(spaceId, requesterUid, isDemo, false);
  if (!space) {
    throw new Error(`Espaço "${spaceId}" não encontrado.`);
  }

  if (space.spaceStatus === 'archived') {
    throw new Error('Não é permitido criar convites para um espaço arquivado.');
  }

  const members = await getSpaceMembers(spaceId, requesterUid, isDemo);
  const requester = members.find((m) => m.uid === requesterUid && m.participationStatus === 'active');
  if (!requester || (requester.role !== 'owner' && requester.role !== 'admin' && space.creatorUid !== requesterUid)) {
    throw new Error('Apenas proprietários ou administradores do espaço podem gerar convites.');
  }

  const rawToken = generateSecureToken();
  const tokenHash = await hashToken(rawToken);

  const days = input.expirationDays && input.expirationDays > 0
    ? input.expirationDays
    : DEFAULT_INVITE_EXPIRATION_DAYS;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

  const invite: SpaceInvite = {
    id: tokenHash,
    spaceId,
    spaceName: space.name,
    invitedEmail: input.invitedEmail?.trim() || undefined,
    invitedRole: input.invitedRole || 'member',
    invitedByUid: requesterUid,
    invitedByName: requesterName,
    tokenStatus: 'pending',
    expiresAt,
    createdAt: now.toISOString(),
  };

  const auditInput = {
    spaceId,
    eventType: 'invite_created' as const,
    performedByUid: requesterUid,
    performedByName: requesterName,
    details: {
      tokenHash,
      invitedEmail: invite.invitedEmail,
      role: invite.invitedRole,
      expiresAt,
    },
    operationKey: `invite_create_${tokenHash}`,
    timestamp: invite.createdAt,
  };

  if (isDemo) {
    const invites = loadDemoInvites();
    invites.push(invite);
    saveDemoInvites(invites);

    await recordSpaceAuditEvent(auditInput, true);

    return { invite, rawToken };
  }

  const firestoreInvite: Record<string, unknown> = { ...invite };
  if (firestoreInvite.invitedEmail === undefined) {
    delete firestoreInvite.invitedEmail;
  }

  await setDoc(doc(db, 'space_invites', tokenHash), firestoreInvite);

  await recordSpaceAuditEvent(auditInput, false);

  return { invite, rawToken };
}

/**
 * Consulta os dados de um convite a partir do token em texto puro (calcula o hash para busca).
 */
export async function getInviteByRawToken(
  rawToken: string,
  isDemo = false
): Promise<SpaceInvite | null> {
  const cleanToken = extractInviteToken(rawToken);
  if (!cleanToken) return null;
  const tokenHash = await hashToken(cleanToken);

  if (isDemo) {
    const invites = loadDemoInvites();
    const found = invites.find((i) => i.id === tokenHash);
    return found || null;
  }

  const snap = await getDoc(doc(db, 'space_invites', tokenHash));
  if (!snap.exists()) return null;
  return snap.data() as SpaceInvite;
}

/**
 * Lista todos os convites emitidos para um espaço.
 * SEGURANÇA (Problema 1): Ex-participantes NÃO têm direito a consultar convites operacionais do espaço.
 */
export async function getSpaceInvites(
  spaceId: string,
  requesterUid: string,
  isDemo = false
): Promise<SpaceInvite[]> {
  if (!requesterUid || !requesterUid.trim()) {
    throw new Error('Identificação do solicitante (requesterUid) é obrigatória para consultar convites.');
  }

  // Exige participação ATIVA no espaço (allowHistorical = false)
  await getSpaceById(spaceId, requesterUid, isDemo, false);

  if (isDemo) {
    return loadDemoInvites().filter((i) => i.spaceId === spaceId);
  }

  const q = query(
    collection(db, 'space_invites'),
    where('spaceId', '==', spaceId)
  );

  const snapshot = await getDocs(q);
  const result: SpaceInvite[] = [];
  snapshot.forEach((d) => {
    result.push({
      ...(d.data() as SpaceInvite),
      id: d.id,
    });
  });

  return result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/**
 * Aceitação atômica de convite por usuário autenticado.
 * REQUISITOS:
 * - O convite deve estar pendente e não expirado.
 * - O espaço não pode estar arquivado.
 * - O usuário não pode ser participante ativo duplicado.
 * - Vinculação atômica do UID real à lista de membros e a memberUids.
 */
export async function acceptSpaceInvite(
  rawToken: string,
  user: { uid: string; displayName?: string; email?: string },
  isDemo = false
): Promise<{ space: Space; member: SpaceMember }> {
  if (!user || !user.uid || !user.uid.trim()) {
    throw new Error('É obrigatório estar autenticado com um UID válido para aceitar o convite.');
  }

  const cleanUid = user.uid.trim();
  const tokenHash = await hashToken(rawToken);
  const operationKey = `invite_accept_${tokenHash}_${cleanUid}`;

  if (isDemo) {
    const invites = loadDemoInvites();
    const inviteIndex = invites.findIndex((i) => i.id === tokenHash);
    if (inviteIndex === -1) {
      throw new Error('Convite não encontrado ou token inválido.');
    }

    const invite = invites[inviteIndex];
    if (invite.tokenStatus !== 'pending') {
      throw new Error(`Este convite não pode ser utilizado pois seu status atual é: ${invite.tokenStatus}.`);
    }

    if (new Date(invite.expiresAt).getTime() < Date.now()) {
      invites[inviteIndex] = { ...invite, tokenStatus: 'expired' };
      saveDemoInvites(invites);
      throw new Error('Este convite expirou e não pode mais ser aceito.');
    }

    const spaces = JSON.parse(universalStorage.getItem('mpf_v3_demo_spaces') || '[]') as Space[];
    const spaceIndex = spaces.findIndex((s) => s.id === invite.spaceId);
    if (spaceIndex === -1) {
      throw new Error('O espaço associado ao convite não foi encontrado.');
    }

    const space = spaces[spaceIndex];
    if (space.spaceStatus === 'archived') {
      throw new Error('Não é possível ingressar em um espaço que se encontra arquivado.');
    }

    if (space.memberUids.includes(cleanUid)) {
      throw new Error('Você já é um participante ativo deste espaço.');
    }

    const now = new Date().toISOString();

    const updatedInvite: SpaceInvite = {
      ...invite,
      tokenStatus: 'accepted',
      acceptedByUid: cleanUid,
      acceptedByName: user.displayName || 'Novo Participante',
      acceptedAt: now,
    };
    invites[inviteIndex] = updatedInvite;
    saveDemoInvites(invites);

    const updatedHistoricalUids = Array.from(
      new Set([...(space.historicalMemberUids || space.memberUids), cleanUid])
    );
    const updatedSpace: Space = {
      ...space,
      memberUids: [...space.memberUids, cleanUid],
      historicalMemberUids: updatedHistoricalUids,
    };
    spaces[spaceIndex] = updatedSpace;
    universalStorage.setItem('mpf_v3_demo_spaces', JSON.stringify(spaces));

    const memberKey = `mpf_v3_demo_space_members_${space.id}`;
    const members = JSON.parse(universalStorage.getItem(memberKey) || '[]') as SpaceMember[];
    const existingMemberIdx = members.findIndex((m) => m.uid === cleanUid);

    const newMember: SpaceMember = {
      id: cleanUid,
      spaceId: space.id,
      uid: cleanUid,
      displayName: user.displayName?.trim() || 'Novo Participante',
      contactEmail: user.email?.trim() || '',
      role: invite.invitedRole || 'member',
      participationStatus: 'active',
      invitedAt: invite.createdAt,
      joinedAt: now,
    };

    if (existingMemberIdx >= 0) {
      members[existingMemberIdx] = newMember;
    } else {
      members.push(newMember);
    }
    universalStorage.setItem(memberKey, JSON.stringify(members));

    const auditInput = {
      spaceId: space.id,
      eventType: 'invite_accepted' as const,
      performedByUid: cleanUid,
      performedByName: newMember.displayName,
      targetUid: cleanUid,
      details: { role: newMember.role, tokenHash },
      operationKey,
      timestamp: now,
    };
    const eventId = generateDeterministicAuditEventId(auditInput);

    await recordSpaceAuditEvent({ ...auditInput, eventId }, true);

    await sendSpaceNotification(
      {
        userId: space.creatorUid,
        spaceId: space.id,
        spaceName: space.name,
        type: 'invite_accepted',
        title: 'Novo Participante no Espaço',
        message: `${newMember.displayName} aceitou o convite e ingressou no espaço "${space.name}".`,
        senderUid: cleanUid,
        originEventId: eventId,
        governanceEventType: 'invite_accepted',
      },
      true
    );

    return { space: updatedSpace, member: newMember };
  }

  // Execução atômica server-side via Cloud Function (Admin SDK) no Functions Emulator / Produção
  const { httpsCallable } = await import('firebase/functions');
  const { functions } = await import('./firebase');

  const callable = httpsCallable<
    {
      rawToken: string;
      tokenHash: string;
      user: { uid: string; displayName?: string; email?: string };
      operationKey: string;
    },
    { space: Space; member: SpaceMember }
  >(functions, 'acceptSpaceInviteOfficial');

  const response = await callable({
    rawToken,
    tokenHash,
    user: {
      uid: cleanUid,
      displayName: user.displayName,
      email: user.email,
    },
    operationKey,
  });

  return response.data;
}

/**
 * Rejeição formal de convite por usuário autenticado.
 */
export async function rejectSpaceInvite(
  rawToken: string,
  user: { uid: string; displayName?: string },
  isDemo = false
): Promise<void> {
  const tokenHash = await hashToken(rawToken);
  const now = new Date().toISOString();
  const operationKey = `invite_reject_${tokenHash}_${user.uid}`;

  if (isDemo) {
    const invites = loadDemoInvites();
    const idx = invites.findIndex((i) => i.id === tokenHash);
    if (idx === -1) throw new Error('Convite não encontrado.');
    const invite = invites[idx];
    if (invite.tokenStatus !== 'pending') {
      throw new Error('Este convite não está pendente.');
    }

    invites[idx] = {
      ...invite,
      tokenStatus: 'rejected',
      rejectedByUid: user.uid,
      rejectedAt: now,
    };
    saveDemoInvites(invites);

    await recordSpaceAuditEvent(
      {
        spaceId: invite.spaceId,
        eventType: 'invite_rejected',
        performedByUid: user.uid,
        performedByName: user.displayName || 'Usuário Convidado',
        details: { tokenHash },
        operationKey,
        timestamp: now,
      },
      true
    );

    return;
  }

  const inviteSnap = await getDoc(doc(db, 'space_invites', tokenHash));
  if (!inviteSnap.exists()) throw new Error('Convite não encontrado.');
  const invite = inviteSnap.data() as SpaceInvite;
  if (invite.tokenStatus !== 'pending') {
    throw new Error('Este convite não está pendente.');
  }

  await updateDoc(doc(db, 'space_invites', tokenHash), {
    tokenStatus: 'rejected',
    rejectedByUid: user.uid,
    rejectedAt: now,
  });

  await recordSpaceAuditEvent(
    {
      spaceId: invite.spaceId,
      eventType: 'invite_rejected',
      performedByUid: user.uid,
      performedByName: user.displayName || 'Usuário Convidado',
      details: { tokenHash },
      operationKey,
      timestamp: now,
    },
    false
  );
}

/**
 * Revogação de convite por participante autorizado antes de sua aceitação.
 */
export async function revokeSpaceInvite(
  tokenHash: string,
  requesterUid: string,
  requesterName: string,
  isDemo = false
): Promise<void> {
  const now = new Date().toISOString();
  const operationKey = `invite_revoke_${tokenHash}`;

  if (isDemo) {
    const invites = loadDemoInvites();
    const idx = invites.findIndex((i) => i.id === tokenHash);
    if (idx === -1) throw new Error('Convite não encontrado.');
    const invite = invites[idx];
    if (invite.tokenStatus !== 'pending') {
      throw new Error('Apenas convites pendentes podem ser revogados.');
    }

    await getSpaceById(invite.spaceId, requesterUid, true, false);

    invites[idx] = {
      ...invite,
      tokenStatus: 'revoked',
      revokedByUid: requesterUid,
      revokedAt: now,
    };
    saveDemoInvites(invites);

    await recordSpaceAuditEvent(
      {
        spaceId: invite.spaceId,
        eventType: 'invite_revoked',
        performedByUid: requesterUid,
        performedByName: requesterName,
        details: { tokenHash },
        operationKey,
        timestamp: now,
      },
      true
    );

    return;
  }

  const inviteSnap = await getDoc(doc(db, 'space_invites', tokenHash));
  if (!inviteSnap.exists()) throw new Error('Convite não encontrado.');
  const invite = inviteSnap.data() as SpaceInvite;
  if (invite.tokenStatus !== 'pending') {
    throw new Error('Apenas convites pendentes podem ser revogados.');
  }

  await getSpaceById(invite.spaceId, requesterUid, false, false);

  await updateDoc(doc(db, 'space_invites', tokenHash), {
    tokenStatus: 'revoked',
    revokedByUid: requesterUid,
    revokedAt: now,
  });

  await recordSpaceAuditEvent(
    {
      spaceId: invite.spaceId,
      eventType: 'invite_revoked',
      performedByUid: requesterUid,
      performedByName: requesterName,
      details: { tokenHash },
      operationKey,
      timestamp: now,
    },
    false
  );
}
