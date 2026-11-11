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
  CentsInteger,
  ISO8601String,
  Space,
  SpaceMember,
  SpaceMemberRole,
  SpaceModuleType,
} from '../types/financeV3';
import { recordSpaceAuditEvent } from './spaceAuditService';
import { notifySpaceMembers, sendSpaceNotification } from './spaceNotificationService';
import { universalStorage } from '../utils/universalStorage';

/**
 * ==============================================================================
 * SERVIÇO DE GOVERNANÇA DE ESPAÇOS COMPARTILHADOS (ARQUITETURA v3.1)
 * ==============================================================================
 * Criação, consulta por membro autenticado, controle de papéis, arquivamento,
 * desarquivamento, saída voluntária e remoção de participantes.
 *
 * Princípios Arquiteturais Obrigatórios:
 * 1. O criador (creatorUid) é a autoridade exclusiva para arquivar, desarquivar e
 *    solicitar dissolução definitiva.
 * 2. Espaço arquivado é estritamente somente leitura (nenhuma mutação permitida).
 * 3. A remoção de participante revoga imediatamente o acesso operacional (removido
 *    de memberUids), mas preserva integralmente seu histórico e autoria de dados.
 * 4. Isolamento estrito: dados individuais nunca são expostos a participantes do espaço.
 */

const DEMO_SPACES_KEY = 'mpf_v3_demo_spaces';
const DEMO_MEMBERS_PREFIX = 'mpf_v3_demo_space_members_';

function loadDemoSpaces(): Space[] {
  try {
    const raw = universalStorage.getItem(DEMO_SPACES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDemoSpaces(spaces: Space[]): void {
  try {
    universalStorage.setItem(DEMO_SPACES_KEY, JSON.stringify(spaces));
  } catch (err) {
    console.warn('[DemoStorage] Erro ao salvar espaços:', err);
  }
}

function loadDemoMembers(spaceId: string): SpaceMember[] {
  try {
    const raw = universalStorage.getItem(`${DEMO_MEMBERS_PREFIX}${spaceId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDemoMembers(spaceId: string, members: SpaceMember[]): void {
  try {
    universalStorage.setItem(
      `${DEMO_MEMBERS_PREFIX}${spaceId}`,
      JSON.stringify(members)
    );
  } catch (err) {
    console.warn('[DemoStorage] Erro ao salvar membros:', err);
  }
}

export interface CreateSpaceInput {
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  enabledModules?: SpaceModuleType[];
  monthlyBudgetCents?: CentsInteger;
}

export interface UpdateSpaceInput {
  name?: string;
  description?: string;
  icon?: string;
  color?: string;
  enabledModules?: SpaceModuleType[];
  monthlyBudgetCents?: CentsInteger;
}

/**
 * Validação rigorosa dos dados cadastrais do espaço.
 */
export function validateSpaceInput(input: CreateSpaceInput | UpdateSpaceInput): void {
  if (input.name !== undefined) {
    const cleanName = input.name.trim();
    if (!cleanName) {
      throw new Error('O nome do espaço é obrigatório.');
    }
    if (cleanName.length > 100) {
      throw new Error('O nome do espaço não pode exceder 100 caracteres.');
    }
  }

  if (input.monthlyBudgetCents !== undefined && input.monthlyBudgetCents !== null) {
    if (
      typeof input.monthlyBudgetCents !== 'number' ||
      !Number.isSafeInteger(input.monthlyBudgetCents) ||
      input.monthlyBudgetCents < 0
    ) {
      throw new Error('O orçamento mensal deve ser um valor inteiro em centavos maior ou igual a zero.');
    }
  }

  if (input.enabledModules !== undefined) {
    if (!Array.isArray(input.enabledModules) || input.enabledModules.length === 0) {
      throw new Error('Ao menos um módulo deve estar habilitado para o espaço.');
    }
    const validModules: SpaceModuleType[] = ['finance', 'acquisitions'];
    for (const mod of input.enabledModules) {
      if (!validModules.includes(mod)) {
        throw new Error(`Módulo inválido: "${mod}". Módulos permitidos: finance, acquisitions.`);
      }
    }
  }
}

/**
 * Cria um novo espaço compartilhado e estabelece o criador como proprietário inicial.
 */
export async function createSpace(
  creatorUid: string,
  creatorName: string,
  creatorEmail: string,
  input: CreateSpaceInput,
  isDemo = false
): Promise<{ space: Space; member: SpaceMember }> {
  if (!creatorUid || !creatorUid.trim()) {
    throw new Error('Identificador de criador inválido. É obrigatório estar autenticado.');
  }

  validateSpaceInput(input);

  const now: ISO8601String = new Date().toISOString();
  const spaceId = `space_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  const newSpace: Space = {
    id: spaceId,
    creatorUid: creatorUid.trim(),
    ownerId: creatorUid.trim(),
    name: input.name.trim(),
    description: input.description?.trim() || '',
    icon: input.icon || 'ph-users-three',
    color: input.color || '#3b82f6',
    spaceStatus: 'active',
    memberUids: [creatorUid.trim()],
    historicalMemberUids: [creatorUid.trim()],
    enabledModules: input.enabledModules || ['finance', 'acquisitions'],
    monthlyBudgetCents: input.monthlyBudgetCents,
    createdAt: now,
  };

  const initialMember: SpaceMember = {
    id: creatorUid.trim(),
    spaceId,
    uid: creatorUid.trim(),
    displayName: creatorName?.trim() || 'Criador do Espaço',
    contactEmail: creatorEmail?.trim() || '',
    role: 'owner',
    participationStatus: 'active',
    invitedAt: now,
    joinedAt: now,
  };

  if (isDemo) {
    const spaces = loadDemoSpaces();
    spaces.unshift(newSpace);
    saveDemoSpaces(spaces);

    const members = [initialMember];
    saveDemoMembers(spaceId, members);

    await recordSpaceAuditEvent(
      {
        spaceId,
        eventType: 'space_created',
        performedByUid: creatorUid,
        performedByName: creatorName,
        details: { name: newSpace.name },
      },
      true
    );

    return { space: newSpace, member: initialMember };
  }

  // Gravação no Firestore
  await setDoc(doc(db, 'spaces', spaceId), newSpace);
  await setDoc(doc(db, 'spaces', spaceId, 'members', creatorUid.trim()), initialMember);

  await recordSpaceAuditEvent(
    {
      spaceId,
      eventType: 'space_created',
      performedByUid: creatorUid,
      performedByName: creatorName,
      details: { name: newSpace.name },
    },
    false
  );

  return { space: newSpace, member: initialMember };
}

export type SpaceViewMode = 'active' | 'historical' | 'all';

/**
 * Consulta espaços aos quais o usuário pertence.
 * - 'active' (padrão): espaços onde o usuário é participante ativo (consta em memberUids).
 * - 'historical': espaços onde o usuário é ex-participante (consta em historicalMemberUids, mas não em memberUids).
 * - 'all': união de espaços ativos e históricos.
 */
export async function getUserSpaces(
  userId: string,
  includeArchived = false,
  isDemo = false,
  viewMode: SpaceViewMode = 'active'
): Promise<Space[]> {
  if (!userId || !userId.trim()) {
    throw new Error('UID do usuário é obrigatório para consultar espaços.');
  }

  const cleanUid = userId.trim();

  if (isDemo) {
    const spaces = loadDemoSpaces();
    return spaces.filter((s) => {
      const isActive = s.memberUids.includes(cleanUid);
      const isHistoricalOnly = !isActive && (s.historicalMemberUids?.includes(cleanUid) ?? false);

      if (viewMode === 'active' && !isActive) return false;
      if (viewMode === 'historical' && !isHistoricalOnly) return false;
      if (viewMode === 'all' && !isActive && !isHistoricalOnly) return false;

      // Filtro de arquivamento
      if (!includeArchived && s.spaceStatus === 'archived') return false;
      // Não exibir espaços dissolvidos
      if (s.spaceStatus === 'dissolved') return false;
      return true;
    });
  }

  let q;
  if (viewMode === 'active') {
    q = query(
      collection(db, 'spaces'),
      where('memberUids', 'array-contains', cleanUid)
    );
  } else {
    // Para 'historical' ou 'all', consultamos historicalMemberUids
    q = query(
      collection(db, 'spaces'),
      where('historicalMemberUids', 'array-contains', cleanUid)
    );
  }

  const snapshot = await getDocs(q);
  const result: Space[] = [];

  snapshot.forEach((d) => {
    const raw = d.data() as Space;
    const space: Space = { ...raw, id: d.id || raw.id };
    if (!includeArchived && space.spaceStatus === 'archived') return;
    if (space.spaceStatus === 'dissolved') return;

    const isActive = space.memberUids.includes(cleanUid);
    const isHistoricalOnly = !isActive && (space.historicalMemberUids?.includes(cleanUid) ?? false);

    if (viewMode === 'active' && !isActive) return;
    if (viewMode === 'historical' && !isHistoricalOnly) return;
    if (viewMode === 'all' && !isActive && !isHistoricalOnly) return;

    result.push(space);
  });

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Obtém os dados de um espaço específico, validando autorização do solicitante.
 * Suporta acesso operacional (membro ativo) e acesso histórico de consulta (ex-membro).
 */
export async function getSpaceById(
  spaceId: string,
  userId: string,
  isDemo = false,
  allowHistorical = true
): Promise<Space | null> {
  if (!spaceId || !userId) return null;
  const cleanUid = userId.trim();

  if (isDemo) {
    const spaces = loadDemoSpaces();
    const found = spaces.find((s) => s.id === spaceId);
    if (!found) return null;

    const isActive = found.memberUids.includes(cleanUid);
    const isHistorical = found.historicalMemberUids?.includes(cleanUid) ?? false;

    if (!isActive && (!allowHistorical || !isHistorical)) {
      throw new Error(
        'Violação de segurança: acesso não autorizado a espaço no qual o usuário não é participante ativo nem histórico.'
      );
    }
    return found;
  }

  const snap = await getDoc(doc(db, 'spaces', spaceId));
  if (!snap.exists()) return null;

  const space = snap.data() as Space;
  const isActive = space.memberUids.includes(cleanUid);
  const isHistorical = space.historicalMemberUids?.includes(cleanUid) ?? false;

  if (!isActive && (!allowHistorical || !isHistorical)) {
    throw new Error(
      'Violação de segurança: acesso não autorizado a espaço no qual o usuário não é participante ativo nem histórico.'
    );
  }

  return space;
}

/**
 * Consulta a lista de participantes de um espaço.
 * - Membros ativos consultam todos os participantes do espaço.
 * - Ex-participantes históricos consultam EXCLUSIVAMENTE o seu próprio registro,
 *   preservando os dados privados dos demais membros.
 */
export async function getSpaceMembers(
  spaceId: string,
  userId: string,
  isDemo = false
): Promise<SpaceMember[]> {
  const space = await getSpaceById(spaceId, userId, isDemo);
  if (!space) return [];

  const isActive = space.memberUids.includes(userId);

  if (isDemo) {
    const all = loadDemoMembers(spaceId);
    if (!isActive) {
      return all.filter((m) => m.uid === userId);
    }
    return all;
  }

  // No Firestore, ex-membro lê estritamente o seu próprio documento (regra isOwner(memberUid))
  if (!isActive) {
    const mySnap = await getDoc(doc(db, 'spaces', spaceId, 'members', userId));
    if (!mySnap.exists()) return [];
    return [{ ...(mySnap.data() as SpaceMember), id: mySnap.id }];
  }

  const snapshot = await getDocs(collection(db, 'spaces', spaceId, 'members'));
  const members: SpaceMember[] = [];
  snapshot.forEach((d) => {
    members.push({
      ...(d.data() as SpaceMember),
      id: d.id,
    });
  });

  return members;
}

/**
 * Atualiza metadados gerais do espaço (bloqueado se o espaço estiver arquivado).
 */
export async function updateSpace(
  spaceId: string,
  userId: string,
  input: UpdateSpaceInput,
  isDemo = false
): Promise<Space> {
  validateSpaceInput(input);

  const space = await getSpaceById(spaceId, userId, isDemo);
  if (!space) {
    throw new Error(`Espaço "${spaceId}" não encontrado.`);
  }

  if (space.spaceStatus === 'archived') {
    throw new Error('Espaço arquivado: modo somente leitura. Não são permitidas alterações cadastrais.');
  }

  const members = await getSpaceMembers(spaceId, userId, isDemo);
  const requester = members.find((m) => m.uid === userId && m.participationStatus === 'active');
  if (!requester || (requester.role !== 'owner' && requester.role !== 'admin')) {
    throw new Error('Apenas proprietários ou administradores podem editar as configurações do espaço.');
  }

  const updated: Space = {
    ...space,
    name: input.name !== undefined ? input.name.trim() : space.name,
    description: input.description !== undefined ? input.description.trim() : space.description,
    icon: input.icon !== undefined ? input.icon : space.icon,
    color: input.color !== undefined ? input.color : space.color,
    enabledModules: input.enabledModules !== undefined ? input.enabledModules : space.enabledModules,
    monthlyBudgetCents:
      input.monthlyBudgetCents !== undefined ? input.monthlyBudgetCents : space.monthlyBudgetCents,
  };

  if (isDemo) {
    const list = loadDemoSpaces().map((s) => (s.id === spaceId ? updated : s));
    saveDemoSpaces(list);
    return updated;
  }

  await updateDoc(doc(db, 'spaces', spaceId), {
    name: updated.name,
    description: updated.description,
    icon: updated.icon,
    color: updated.color,
    enabledModules: updated.enabledModules,
    monthlyBudgetCents: updated.monthlyBudgetCents ?? null,
  });

  return updated;
}

/**
 * Arquiva um espaço compartilhado.
 * REGRA CANÔNICA: Somente o criador do espaço (creatorUid) pode arquivar.
 */
export async function archiveSpace(
  spaceId: string,
  userId: string,
  userName: string,
  isDemo = false
): Promise<Space> {
  const space = await getSpaceById(spaceId, userId, isDemo);
  if (!space) {
    throw new Error(`Espaço "${spaceId}" não encontrado.`);
  }

  if (space.creatorUid !== userId) {
    throw new Error('Violação de autoridade: Somente o criador original do espaço tem autorização para arquivá-lo.');
  }

  if (space.spaceStatus === 'archived') {
    return space;
  }

  const now: ISO8601String = new Date().toISOString();
  const updated: Space = {
    ...space,
    spaceStatus: 'archived',
    archivedAt: now,
    archivedByUid: userId,
  };

  if (isDemo) {
    const list = loadDemoSpaces().map((s) => (s.id === spaceId ? updated : s));
    saveDemoSpaces(list);

    await recordSpaceAuditEvent(
      {
        spaceId,
        eventType: 'space_archived',
        performedByUid: userId,
        performedByName: userName,
      },
      true
    );

    await notifySpaceMembers(
      space.memberUids,
      userId,
      {
        spaceId,
        spaceName: space.name,
        type: 'space_archived',
        title: 'Espaço Arquivado',
        message: `O espaço "${space.name}" foi arquivado pelo criador e entrou em modo somente leitura.`,
      },
      true
    );

    return updated;
  }

  await updateDoc(doc(db, 'spaces', spaceId), {
    spaceStatus: 'archived',
    archivedAt: now,
    archivedByUid: userId,
  });

  await recordSpaceAuditEvent(
    {
      spaceId,
      eventType: 'space_archived',
      performedByUid: userId,
      performedByName: userName,
    },
    false
  );

  await notifySpaceMembers(
    space.memberUids,
    userId,
    {
      spaceId,
      spaceName: space.name,
      type: 'space_archived',
      title: 'Espaço Arquivado',
      message: `O espaço "${space.name}" foi arquivado pelo criador e entrou em modo somente leitura.`,
    },
    false
  );

  return updated;
}

/**
 * Desarquiva um espaço compartilhado restaurando a operação regular.
 * REGRA CANÔNICA: Somente o criador do espaço (creatorUid) pode desarquivar.
 */
export async function unarchiveSpace(
  spaceId: string,
  userId: string,
  userName: string,
  isDemo = false
): Promise<Space> {
  const space = await getSpaceById(spaceId, userId, isDemo);
  if (!space) {
    throw new Error(`Espaço "${spaceId}" não encontrado.`);
  }

  if (space.creatorUid !== userId) {
    throw new Error('Violação de autoridade: Somente o criador original do espaço tem autorização para desarquivá-lo.');
  }

  if (space.spaceStatus !== 'archived') {
    return space;
  }

  const updated: Space = {
    ...space,
    spaceStatus: 'active',
    archivedAt: undefined,
    archivedByUid: undefined,
  };

  if (isDemo) {
    const list = loadDemoSpaces().map((s) => (s.id === spaceId ? updated : s));
    saveDemoSpaces(list);

    await recordSpaceAuditEvent(
      {
        spaceId,
        eventType: 'space_unarchived',
        performedByUid: userId,
        performedByName: userName,
      },
      true
    );

    await notifySpaceMembers(
      space.memberUids,
      userId,
      {
        spaceId,
        spaceName: space.name,
        type: 'space_unarchived',
        title: 'Espaço Reativado',
        message: `O espaço "${space.name}" foi desarquivado pelo criador e suas operações normais foram restabelecidas.`,
      },
      true
    );

    return updated;
  }

  await updateDoc(doc(db, 'spaces', spaceId), {
    spaceStatus: 'active',
    archivedAt: null,
    archivedByUid: null,
  });

  await recordSpaceAuditEvent(
    {
      spaceId,
      eventType: 'space_unarchived',
      performedByUid: userId,
      performedByName: userName,
    },
    false
  );

  await notifySpaceMembers(
    space.memberUids,
    userId,
    {
      spaceId,
      spaceName: space.name,
      type: 'space_unarchived',
      title: 'Espaço Reativado',
      message: `O espaço "${space.name}" foi desarquivado pelo criador e suas operações normais foram restabelecidas.`,
    },
    false
  );

  return updated;
}

/**
 * Atualiza o papel de um participante (apenas por proprietário ou criador).
 */
export async function updateMemberRole(
  spaceId: string,
  requesterUid: string,
  requesterName: string,
  targetUid: string,
  newRole: SpaceMemberRole,
  isDemo = false
): Promise<SpaceMember> {
  const space = await getSpaceById(spaceId, requesterUid, isDemo);
  if (!space) {
    throw new Error(`Espaço "${spaceId}" não encontrado.`);
  }

  if (space.spaceStatus === 'archived') {
    throw new Error('Espaço arquivado: alterações de papéis estão bloqueadas.');
  }

  const members = await getSpaceMembers(spaceId, requesterUid, isDemo);
  const requester = members.find((m) => m.uid === requesterUid && m.participationStatus === 'active');
  if (!requester || (requester.role !== 'owner' && space.creatorUid !== requesterUid)) {
    throw new Error('Apenas o proprietário ou o criador do espaço podem alterar papéis de participantes.');
  }

  const target = members.find((m) => m.uid === targetUid);
  if (!target) {
    throw new Error(`Participante "${targetUid}" não encontrado no espaço.`);
  }

  if (targetUid === space.creatorUid && newRole !== 'owner') {
    throw new Error('O criador original do espaço não pode ter seu papel rebaixado.');
  }

  const updatedTarget: SpaceMember = {
    ...target,
    role: newRole,
  };

  if (isDemo) {
    const list = loadDemoMembers(spaceId).map((m) => (m.uid === targetUid ? updatedTarget : m));
    saveDemoMembers(spaceId, list);

    await recordSpaceAuditEvent(
      {
        spaceId,
        eventType: 'member_role_changed',
        performedByUid: requesterUid,
        performedByName: requesterName,
        targetUid,
        targetName: target.displayName,
        details: { newRole },
      },
      true
    );

    return updatedTarget;
  }

  await updateDoc(doc(db, 'spaces', spaceId, 'members', targetUid), {
    role: newRole,
  });

  await recordSpaceAuditEvent(
    {
      spaceId,
      eventType: 'member_role_changed',
      performedByUid: requesterUid,
      performedByName: requesterName,
      targetUid,
      targetName: target.displayName,
      details: { newRole },
    },
    false
  );

  return updatedTarget;
}

/**
 * Remove um participante do espaço.
 * REGRA DE SEGURANÇA E INTEGRIDADE:
 * - O participante é removido de `memberUids`, revogando acesso imediato às regras do Firestore.
 * - Seu status no registro de membro muda para `'removed_by_admin'`.
 * - Seus registros históricos de despesas, pagamentos e obrigações são 100% PRESERVADOS.
 * - O criador do espaço nunca pode ser removido.
 */
export async function removeMemberFromSpace(
  spaceId: string,
  requesterUid: string,
  requesterName: string,
  targetUid: string,
  isDemo = false
): Promise<void> {
  const space = await getSpaceById(spaceId, requesterUid, isDemo);
  if (!space) {
    throw new Error(`Espaço "${spaceId}" não encontrado.`);
  }

  if (space.spaceStatus === 'archived') {
    throw new Error('Espaço arquivado: remoção de participantes está bloqueada.');
  }

  if (targetUid === space.creatorUid) {
    throw new Error('O criador do espaço não pode ser removido.');
  }

  const members = await getSpaceMembers(spaceId, requesterUid, isDemo);
  const requester = members.find((m) => m.uid === requesterUid && m.participationStatus === 'active');
  if (!requester || (requester.role !== 'owner' && requester.role !== 'admin' && space.creatorUid !== requesterUid)) {
    throw new Error('Apenas proprietários ou administradores podem remover participantes.');
  }

  const target = members.find((m) => m.uid === targetUid);
  if (!target || target.participationStatus !== 'active') {
    throw new Error('O participante selecionado não está ativo no espaço.');
  }

  const now: ISO8601String = new Date().toISOString();
  const updatedMemberUids = space.memberUids.filter((uid) => uid !== targetUid);
  const updatedHistoricalMemberUids = Array.from(
    new Set([...(space.historicalMemberUids || space.memberUids), targetUid])
  );

  if (isDemo) {
    // Atualiza espaço
    const updatedSpace: Space = {
      ...space,
      memberUids: updatedMemberUids,
      historicalMemberUids: updatedHistoricalMemberUids,
    };
    saveDemoSpaces(loadDemoSpaces().map((s) => (s.id === spaceId ? updatedSpace : s)));

    // Atualiza membro
    const updatedMember: SpaceMember = {
      ...target,
      participationStatus: 'removed_by_admin',
      exitedAt: now,
    };
    saveDemoMembers(spaceId, loadDemoMembers(spaceId).map((m) => (m.uid === targetUid ? updatedMember : m)));

    await recordSpaceAuditEvent(
      {
        spaceId,
        eventType: 'member_removed',
        performedByUid: requesterUid,
        performedByName: requesterName,
        targetUid,
        targetName: target.displayName,
      },
      true
    );

    await sendSpaceNotification(
      {
        userId: targetUid,
        spaceId,
        spaceName: space.name,
        type: 'member_removed',
        title: 'Remoção de Espaço',
        message: `Você foi removido do espaço "${space.name}" por ${requesterName}. Seus registros históricos permanecem preservados.`,
      },
      true
    );

    return;
  }

  // Firestore: remoção atômica
  await runTransaction(db, async (tx) => {
    const spaceRef = doc(db, 'spaces', spaceId);
    const memberRef = doc(db, 'spaces', spaceId, 'members', targetUid);

    tx.update(spaceRef, {
      memberUids: updatedMemberUids,
      historicalMemberUids: updatedHistoricalMemberUids,
    });
    tx.update(memberRef, {
      participationStatus: 'removed_by_admin',
      exitedAt: now,
    });
  });

  await recordSpaceAuditEvent(
    {
      spaceId,
      eventType: 'member_removed',
      performedByUid: requesterUid,
      performedByName: requesterName,
      targetUid,
      targetName: target.displayName,
    },
    false
  );

  await sendSpaceNotification(
    {
      userId: targetUid,
      spaceId,
      spaceName: space.name,
      type: 'member_removed',
      title: 'Remoção de Espaço',
      message: `Você foi removido do espaço "${space.name}" por ${requesterName}. Seus registros históricos permanecem preservados.`,
    },
    false
  );
}

/**
 * Saída voluntária do participante do espaço.
 */
export async function leaveSpace(
  spaceId: string,
  memberUid: string,
  memberName: string,
  isDemo = false
): Promise<void> {
  const space = await getSpaceById(spaceId, memberUid, isDemo);
  if (!space) {
    throw new Error(`Espaço "${spaceId}" não encontrado.`);
  }

  if (space.spaceStatus === 'archived') {
    throw new Error('Espaço arquivado: saídas estão bloqueadas enquanto o espaço estiver arquivado.');
  }

  if (memberUid === space.creatorUid) {
    throw new Error('O criador do espaço não pode abandoná-lo voluntariamente. Utilize o fluxo de arquivamento ou solicitação de dissolução definitiva.');
  }

  const members = await getSpaceMembers(spaceId, memberUid, isDemo);
  const member = members.find((m) => m.uid === memberUid);
  if (!member || member.participationStatus !== 'active') {
    throw new Error('Você não é um participante ativo deste espaço.');
  }

  const now: ISO8601String = new Date().toISOString();
  const updatedMemberUids = space.memberUids.filter((uid) => uid !== memberUid);
  const updatedHistoricalMemberUids = Array.from(
    new Set([...(space.historicalMemberUids || space.memberUids), memberUid])
  );

  if (isDemo) {
    const updatedSpace: Space = {
      ...space,
      memberUids: updatedMemberUids,
      historicalMemberUids: updatedHistoricalMemberUids,
    };
    saveDemoSpaces(loadDemoSpaces().map((s) => (s.id === spaceId ? updatedSpace : s)));

    const updatedMember: SpaceMember = {
      ...member,
      participationStatus: 'voluntary_exit',
      exitedAt: now,
    };
    saveDemoMembers(spaceId, loadDemoMembers(spaceId).map((m) => (m.uid === memberUid ? updatedMember : m)));

    await recordSpaceAuditEvent(
      {
        spaceId,
        eventType: 'member_voluntary_exit',
        performedByUid: memberUid,
        performedByName: memberName,
      },
      true
    );

    await notifySpaceMembers(
      updatedMemberUids,
      memberUid,
      {
        spaceId,
        spaceName: space.name,
        type: 'member_exited',
        title: 'Participante Saiu',
        message: `${memberName} retirou-se voluntariamente do espaço "${space.name}".`,
      },
      true
    );

    return;
  }

  await runTransaction(db, async (tx) => {
    const spaceRef = doc(db, 'spaces', spaceId);
    const memberRef = doc(db, 'spaces', spaceId, 'members', memberUid);

    tx.update(spaceRef, {
      memberUids: updatedMemberUids,
      historicalMemberUids: updatedHistoricalMemberUids,
    });
    tx.update(memberRef, {
      participationStatus: 'voluntary_exit',
      exitedAt: now,
    });
  });

  await recordSpaceAuditEvent(
    {
      spaceId,
      eventType: 'member_voluntary_exit',
      performedByUid: memberUid,
      performedByName: memberName,
    },
    false
  );

  await notifySpaceMembers(
    updatedMemberUids,
    memberUid,
    {
      spaceId,
      spaceName: space.name,
      type: 'member_exited',
      title: 'Participante Saiu',
      message: `${memberName} retirou-se voluntariamente do espaço "${space.name}".`,
    },
    false
  );
}
