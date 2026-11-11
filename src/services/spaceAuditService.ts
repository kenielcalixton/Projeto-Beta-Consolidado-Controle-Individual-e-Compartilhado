import {
  collection,
  getDocs,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from './firebase';
import { ISO8601String, SpaceAuditEvent, SpaceAuditEventType } from '../types/financeV3';
import { sha256Hex } from '../utils/hashUtils';
import { universalStorage } from '../utils/universalStorage';

/**
 * ==============================================================================
 * SERVIÇO DE AUDITORIA E HISTÓRICO DE ESPAÇOS COMPARTILHADOS (v3.1)
 * ==============================================================================
 * Trilha de auditoria e governança imutável para espaços compartilhados.
 * Caminho Firestore: spaces/{spaceId}/audit/{eventId}
 *
 * CONTRATO DE SEGURANÇA E ARQUITETURA — AUDITORIA CONFIÁVEL (TRUSTED AUDIT RECORDER):
 * 1. Vulnerabilidade mitigada:
 *    Clientes nunca escrevem diretamente em `spaces/{spaceId}/audit` (`allow create: if false` em firestore.rules).
 * 2. Backend Server-Side Real:
 *    Em ambiente Firebase (Emulator / Produção), eventos oficiais de governança são gravados
 *    exclusivamente pela Cloud Function `recordOfficialSpaceGovernanceEvent` (que utiliza o
 *    Firebase Admin SDK após validar a identidade e a autoridade do solicitante no espaço).
 * 3. Idempotência Determinística:
 *    Todos os eventos utilizam `eventId` determinístico derivado por SHA-256 dos parâmetros
 *    canônicos da operação, impedindo duplicações em reprocessamentos.
 * 4. Consulta Histórica Restrita:
 *    Ex-participantes consultam exclusivamente os eventos onde `performedByUid == requesterUid`
 *    ou `targetUid == requesterUid`, utilizando filtros `where` compatíveis com `firestore.rules`.
 */

export const CRITICAL_GOVERNANCE_AUDIT_EVENTS: readonly SpaceAuditEventType[] = [
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
] as const;

export interface TrustedAuditRecorderContract {
  recordOfficialEvent(input: RecordAuditEventInput): Promise<SpaceAuditEvent>;
}

const DEMO_SPACE_AUDIT_PREFIX = 'mpf_v3_demo_space_audit_';

function getDemoAuditEvents(spaceId: string): SpaceAuditEvent[] {
  try {
    const raw = universalStorage.getItem(`${DEMO_SPACE_AUDIT_PREFIX}${spaceId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDemoAuditEvents(spaceId: string, events: SpaceAuditEvent[]): void {
  try {
    universalStorage.setItem(
      `${DEMO_SPACE_AUDIT_PREFIX}${spaceId}`,
      JSON.stringify(events)
    );
  } catch (err) {
    console.warn('[SpaceAuditDemo] Erro ao salvar auditoria:', err);
  }
}

export interface RecordAuditEventInput {
  spaceId: string;
  eventType: SpaceAuditEventType;
  performedByUid: string;
  performedByName: string;
  targetUid?: string;
  targetName?: string;
  details?: Record<string, unknown>;
  timestamp?: ISO8601String;
  /** Identificador determinístico explícito ou chave de operação para derivação SHA-256 */
  eventId?: string;
  operationKey?: string;
}

/**
 * Gera um identificador determinístico SHA-256 para eventos de auditoria.
 */
export function generateDeterministicAuditEventId(input: RecordAuditEventInput): string {
  if (input.eventId && input.eventId.trim()) {
    return input.eventId.trim();
  }
  const canonicalKey =
    input.operationKey ||
    [
      input.spaceId,
      input.eventType,
      input.performedByUid,
      input.targetUid || '',
      JSON.stringify(input.details || {}),
    ].join('|');

  const digest = sha256Hex(`${input.spaceId}|${input.eventType}|${canonicalKey}`).slice(0, 32);
  return `audit_${digest}`;
}

/**
 * Registra um evento imutável na trilha de auditoria do espaço.
 * - Modo demo: persiste em `universalStorage` deduplicando pelo ID determinístico.
 * - Modo real/emulador: invoca a Cloud Function `recordOfficialSpaceGovernanceEvent` (Admin SDK).
 */
export async function recordSpaceAuditEvent(
  input: RecordAuditEventInput,
  isDemo = false
): Promise<SpaceAuditEvent> {
  if (!input.spaceId?.trim()) {
    throw new Error('spaceId é obrigatório para registrar auditoria.');
  }
  if (!input.performedByUid?.trim()) {
    throw new Error('performedByUid é obrigatório para registrar auditoria.');
  }

  const eventId = generateDeterministicAuditEventId(input);
  const timestamp = input.timestamp || new Date().toISOString();

  const event: SpaceAuditEvent = {
    id: eventId,
    spaceId: input.spaceId,
    eventType: input.eventType,
    performedByUid: input.performedByUid,
    performedByName: input.performedByName,
    targetUid: input.targetUid,
    targetName: input.targetName,
    details: input.details,
    timestamp,
  };

  if (isDemo) {
    const events = getDemoAuditEvents(input.spaceId);
    const existingIndex = events.findIndex((e) => e.id === event.id);
    if (existingIndex >= 0) {
      return events[existingIndex];
    }
    events.push(event);
    saveDemoAuditEvents(input.spaceId, events);
    return event;
  }

  // Invoca a Cloud Function server-side confiável (Admin SDK) no Functions Emulator / Produção
  const callable = httpsCallable<
    RecordAuditEventInput & { eventId: string },
    { auditEvent: SpaceAuditEvent }
  >(functions, 'recordOfficialSpaceGovernanceEvent');

  const response = await callable({
    ...input,
    eventId,
    timestamp,
  });

  return response.data.auditEvent;
}

/**
 * Consulta a trilha de auditoria de um espaço ordenada cronologicamente (mais recentes primeiro).
 * REQUISITO DE SEGURANÇA (Problema 1 - Acesso Histórico):
 * - Exige `requesterUid` válido para verificar se o solicitante é participante ativo ou ex-participante.
 * - Não retorna todos os eventos quando `requesterUid` estiver ausente.
 * - Para ex-participantes históricos, executa consultas filtradas (`performedByUid == requesterUid`
 *   e `targetUid == requesterUid`) compatíveis com `firestore.rules`, nunca uma consulta irrestrita.
 */
export async function getSpaceAuditEvents(
  spaceId: string,
  requesterUid: string,
  isDemo = false
): Promise<SpaceAuditEvent[]> {
  if (!spaceId || !spaceId.trim()) {
    throw new Error('O identificador do espaço (spaceId) é obrigatório para consultar a auditoria.');
  }
  if (typeof requesterUid !== 'string' || !requesterUid.trim()) {
    throw new Error(
      'Identidade do solicitante (requesterUid) é obrigatória para consultar eventos de auditoria.'
    );
  }

  const cleanUid = requesterUid.trim();

  if (isDemo) {
    const rawSpaces = universalStorage.getItem('mpf_v3_demo_spaces');
    const spaces = rawSpaces ? JSON.parse(rawSpaces) : [];
    const space = spaces.find((s: { id: string }) => s.id === spaceId);
    if (!space) return [];

    const isActive = Array.isArray(space.memberUids) && space.memberUids.includes(cleanUid);
    const isHistorical =
      Array.isArray(space.historicalMemberUids) && space.historicalMemberUids.includes(cleanUid);

    if (!isActive && !isHistorical) {
      throw new Error('Violação de segurança: usuário sem vínculo ativo ou histórico com o espaço.');
    }

    let events = getDemoAuditEvents(spaceId);
    if (!isActive) {
      events = events.filter(
        (e) => e.performedByUid === cleanUid || e.targetUid === cleanUid
      );
    }

    return events.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }

  // No Firestore, verifica se o solicitante é membro ativo consultando seu registro de membro
  const { getDoc, doc: firestoreDoc } = await import('firebase/firestore');
  const memberSnap = await getDoc(firestoreDoc(db, 'spaces', spaceId, 'members', cleanUid));
  if (!memberSnap.exists()) {
    throw new Error('Violação de segurança: solicitante não possui registro de participação neste espaço.');
  }

  const memberData = memberSnap.data();
  const isActiveMember = memberData.participationStatus === 'active';

  const auditCol = collection(db, 'spaces', spaceId, 'audit');

  if (isActiveMember) {
    const q = query(auditCol, orderBy('timestamp', 'desc'));
    const snapshot = await getDocs(q);
    const events: SpaceAuditEvent[] = [];
    snapshot.forEach((d) => {
      events.push({ ...(d.data() as SpaceAuditEvent), id: d.id });
    });
    return events;
  }

  // Ex-participante histórico: executa queries com filtros explícitos exigidos pelas Security Rules
  const [byActorSnap, byTargetSnap] = await Promise.all([
    getDocs(query(auditCol, where('performedByUid', '==', cleanUid))),
    getDocs(query(auditCol, where('targetUid', '==', cleanUid))),
  ]);

  const mergedMap = new Map<string, SpaceAuditEvent>();
  byActorSnap.forEach((d) => {
    mergedMap.set(d.id, { ...(d.data() as SpaceAuditEvent), id: d.id });
  });
  byTargetSnap.forEach((d) => {
    mergedMap.set(d.id, { ...(d.data() as SpaceAuditEvent), id: d.id });
  });

  return Array.from(mergedMap.values()).sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}
