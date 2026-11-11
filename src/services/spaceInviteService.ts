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
import { recordSpaceAuditEvent } from './spaceAuditService';
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
  const space = await getSpaceById(spaceId, requesterUid, isDemo);
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

  if (isDemo) {
    const invites = loadDemoInvites();
    invites.push(invite);
    saveDemoInvites(invites);

    await recordSpaceAuditEvent(
      {
        spaceId,
        eventType: 'invite_created',
        performedByUid: requesterUid,
        performedByName: requesterName,
        details: {
          invitedEmail: invite.invitedEmail,
          role: invite.invitedRole,
          expiresAt,
        },
      },
      true
    );

    return { invite, rawToken };
  }

  await setDoc(doc(db, 'space_invites', tokenHash), invite);

  await recordSpaceAuditEvent(
    {
      spaceId,
      eventType: 'invite_created',
      performedByUid: requesterUid,
      performedByName: requesterName,
      details: {
        invitedEmail: invite.invitedEmail,
        role: invite.invitedRole,
        expiresAt,
      },
    },
    false
  );

  return { invite, rawToken };
}

/**
 * Consulta os dados de um convite a partir do token em texto puro (calcula o hash para busca).
 */
export async function getInviteByRawToken(
  rawToken: string,
  isDemo = false
): Promise<SpaceInvite | null> {
  if (!rawToken || !rawToken.trim()) return null;
  const tokenHash = await hashToken(rawToken);

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
 */
export async function getSpaceInvites(
  spaceId: string,
  requesterUid: string,
  isDemo = false
): Promise<SpaceInvite[]> {
  await getSpaceById(spaceId, requesterUid, isDemo);

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

    // Atualiza status do convite
    const updatedInvite: SpaceInvite = {
      ...invite,
      tokenStatus: 'accepted',
      acceptedByUid: cleanUid,
      acceptedByName: user.displayName || 'Novo Participante',
      acceptedAt: now,
    };
    invites[inviteIndex] = updatedInvite;
    saveDemoInvites(invites);

    // Atualiza espaço (mantendo membro ativo e histórico)
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

    // Cria/atualiza registro de membro
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

    await recordSpaceAuditEvent(
      {
        spaceId: space.id,
        eventType: 'invite_accepted',
        performedByUid: cleanUid,
        performedByName: newMember.displayName,
        targetUid: cleanUid,
        details: { role: newMember.role },
      },
      true
    );

    await sendSpaceNotification(
      {
        userId: space.creatorUid,
        spaceId: space.id,
        spaceName: space.name,
        type: 'invite_accepted',
        title: 'Novo Participante no Espaço',
        message: `${newMember.displayName} aceitou o convite e ingressou no espaço "${space.name}".`,
      },
      true
    );

    return { space: updatedSpace, member: newMember };
  }

  // Execução atômica no Firestore via transação
  return await runTransaction(db, async (tx) => {
    const inviteRef = doc(db, 'space_invites', tokenHash);
    const inviteSnap = await tx.get(inviteRef);

    if (!inviteSnap.exists()) {
      throw new Error('Convite não encontrado ou token inválido.');
    }

    const invite = inviteSnap.data() as SpaceInvite;
    if (invite.tokenStatus !== 'pending') {
      throw new Error(`Este convite não pode ser aceito pois seu status é: ${invite.tokenStatus}.`);
    }

    if (new Date(invite.expiresAt).getTime() < Date.now()) {
      tx.update(inviteRef, { tokenStatus: 'expired' });
      throw new Error('Este convite expirou e não pode mais ser aceito.');
    }

    const spaceRef = doc(db, 'spaces', invite.spaceId);
    const spaceSnap = await tx.get(spaceRef);
    if (!spaceSnap.exists()) {
      throw new Error('O espaço associado a este convite não foi encontrado.');
    }

    const space = spaceSnap.data() as Space;
    if (space.spaceStatus === 'archived') {
      throw new Error('Não é possível ingressar em um espaço que se encontra arquivado.');
    }

    if (space.memberUids.includes(cleanUid)) {
      throw new Error('Você já é um participante ativo deste espaço.');
    }

    const now = new Date().toISOString();

    // 1. Marca convite como aceito
    tx.update(inviteRef, {
      tokenStatus: 'accepted',
      acceptedByUid: cleanUid,
      acceptedByName: user.displayName || 'Novo Participante',
      acceptedAt: now,
    });

    // 2. Adiciona à lista canônica de membros ativos e membros históricos
    const updatedMemberUids = [...space.memberUids, cleanUid];
    const updatedHistoricalUids = Array.from(
      new Set([...(space.historicalMemberUids || space.memberUids), cleanUid])
    );
    tx.update(spaceRef, {
      memberUids: updatedMemberUids,
      historicalMemberUids: updatedHistoricalUids,
    });

    // 3. Cria documento de membro
    const memberRef = doc(db, 'spaces', invite.spaceId, 'members', cleanUid);
    const newMember: SpaceMember = {
      id: cleanUid,
      spaceId: invite.spaceId,
      uid: cleanUid,
      displayName: user.displayName?.trim() || 'Novo Participante',
      contactEmail: user.email?.trim() || '',
      role: invite.invitedRole || 'member',
      participationStatus: 'active',
      invitedAt: invite.createdAt,
      joinedAt: now,
    };
    tx.set(memberRef, newMember);

    const updatedSpace: Space = {
      ...space,
      memberUids: updatedMemberUids,
      historicalMemberUids: updatedHistoricalUids,
    };
    return { space: updatedSpace, member: newMember };
  }).then(async (res) => {
    await recordSpaceAuditEvent(
      {
        spaceId: res.space.id,
        eventType: 'invite_accepted',
        performedByUid: cleanUid,
        performedByName: res.member.displayName,
        targetUid: cleanUid,
        details: { role: res.member.role },
      },
      false
    );

    await sendSpaceNotification(
      {
        userId: res.space.creatorUid,
        spaceId: res.space.id,
        spaceName: res.space.name,
        type: 'invite_accepted',
        title: 'Novo Participante no Espaço',
        message: `${res.member.displayName} aceitou o convite e ingressou no espaço "${res.space.name}".`,
      },
      false
    );

    return res;
  });
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
      },
      true
    );

    return;
  }

  await updateDoc(doc(db, 'space_invites', tokenHash), {
    tokenStatus: 'rejected',
    rejectedByUid: user.uid,
    rejectedAt: now,
  });
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

  if (isDemo) {
    const invites = loadDemoInvites();
    const idx = invites.findIndex((i) => i.id === tokenHash);
    if (idx === -1) throw new Error('Convite não encontrado.');
    const invite = invites[idx];
    if (invite.tokenStatus !== 'pending') {
      throw new Error('Apenas convites pendentes podem ser revogados.');
    }

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
      },
      true
    );

    return;
  }

  await updateDoc(doc(db, 'space_invites', tokenHash), {
    tokenStatus: 'revoked',
    revokedByUid: requesterUid,
    revokedAt: now,
  });
}
