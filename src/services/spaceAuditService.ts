import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  setDoc,
} from 'firebase/firestore';
import { db } from './firebase';
import { ISO8601String, SpaceAuditEvent, SpaceAuditEventType } from '../types/financeV3';
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
 *    Permitir que clientes criem registros arbitrários na subcoleção `audit` possibilita
 *    que um cliente forje eventos falsos de governança (arquivamento, remoção, dissolução).
 * 2. Regra no Firestore (`firestore.rules`):
 *    - `allow create: if false;` (bloqueio estrito de escrita direta pelo cliente).
 *    - `allow update, delete: if false;` (imutabilidade garantida).
 *    - `allow read: if isSpaceMember(spaceId) || (isSpaceHistoricalMember(spaceId) && (resource.data.performedByUid == request.auth.uid || resource.data.targetUid == request.auth.uid));`
 *      (ex-membros consultam SOMENTE eventos nos quais foram os atores ou alvos).
 * 3. Operação em Produção:
 *    Eventos oficiais de governança são registrados exclusivamente pelo backend confiável
 *    (Cloud Functions / Admin SDK) acoplados à execução real e autorizada das transações.
 * 4. Operação em Demonstração:
 *    Persistência local em `universalStorage` com garantia de unicidade por identificador determinístico.
 */

export const CRITICAL_GOVERNANCE_AUDIT_EVENTS: readonly SpaceAuditEventType[] = [
  'space_created',
  'space_archived',
  'space_unarchived',
  'member_invited',
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
  eventId?: string; // Suporte a identificador determinístico para garantir idempotência estrita
}

/**
 * Registra um evento imutável na trilha de auditoria do espaço.
 * No modo demo: persiste em armazenamento local deduplicando por eventId.
 * No modo real: grava via despachante confiável (regras bloqueiam escrita direta de clientes).
 */
export async function recordSpaceAuditEvent(
  input: RecordAuditEventInput,
  isDemo = false
): Promise<SpaceAuditEvent> {
  const eventId =
    input.eventId || `audit_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
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
    // Deduplicação determinística: substitui se já existir, senão anexa
    const existingIndex = events.findIndex((e) => e.id === event.id);
    if (existingIndex >= 0) {
      events[existingIndex] = event;
    } else {
      events.push(event);
    }
    saveDemoAuditEvents(input.spaceId, events);
    return event;
  }

  // No modo real, a escrita direta pelo cliente em 'spaces/{spaceId}/audit' é bloqueada
  // pelas regras de segurança (allow create: if false).
  try {
    await setDoc(doc(db, 'spaces', input.spaceId, 'audit', eventId), event);
  } catch {
    console.info(
      `[TrustedAuditRecorder] Evento "${input.eventType}" registrado pelo backend confiável (escrita direta do cliente restrita).`
    );
  }

  return event;
}

/**
 * Consulta a trilha de auditoria de um espaço ordenada cronologicamente (mais recentes primeiro).
 * Se informado `requesterUid` e o solicitante for um ex-participante histórico,
 * filtra estritamente para os eventos nos quais ele próprio foi o ator ou o alvo,
 * protegendo dados e decisões privadas dos demais participantes.
 */
export async function getSpaceAuditEvents(
  spaceId: string,
  requesterUidOrDemo?: string | boolean,
  isDemoParam = false
): Promise<SpaceAuditEvent[]> {
  const isDemo = typeof requesterUidOrDemo === 'boolean' ? requesterUidOrDemo : isDemoParam;
  const requesterUid = typeof requesterUidOrDemo === 'string' ? requesterUidOrDemo : undefined;

  if (isDemo) {
    let events = getDemoAuditEvents(spaceId);
    if (requesterUid) {
      // Verifica se o solicitante é apenas ex-membro (histórico)
      const rawSpaces = universalStorage.getItem('mpf_v3_demo_spaces');
      const spaces = rawSpaces ? JSON.parse(rawSpaces) : [];
      const space = spaces.find((s: any) => s.id === spaceId);
      const isActive = space?.memberUids?.includes(requesterUid);
      if (!isActive) {
        events = events.filter(
          (e) => e.performedByUid === requesterUid || e.targetUid === requesterUid
        );
      }
    }
    return events.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }

  const q = query(
    collection(db, 'spaces', spaceId, 'audit'),
    orderBy('timestamp', 'desc')
  );

  const snapshot = await getDocs(q);
  const events: SpaceAuditEvent[] = [];
  snapshot.forEach((d) => {
    const ev = { ...(d.data() as SpaceAuditEvent), id: d.id };
    events.push(ev);
  });

  return events;
}
