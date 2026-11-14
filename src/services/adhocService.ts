import {
  collection,
  onSnapshot,
  query,
  Unsubscribe,
  where,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from './firebase';
import { SplitShare, Transaction } from '../types/finance';
import { universalStorage } from '../utils/universalStorage';

export interface AdhocParticipantSummary {
  uid?: string | null;
  email: string;
  name: string;
  assignedAmountCents: number;
  isOwner: boolean;
  obligationId?: string;
  externalDebtorId?: string;
  status: 'accepted' | 'pending' | 'rejected' | 'disputed';
  proposedAmountCents?: number;
  note?: string;
  updatedAt?: string;
}

export interface AdhocExpenseDoc {
  id: string;
  ownerUid: string;
  ownerName: string;
  ownerEmail: string;
  title: string;
  description?: string;
  totalAmountCents: number;
  ownerShareAmountCents: number;
  totalToReimburseCents: number;
  totalReimbursedCents: number;
  remainingToReimburseCents: number;
  fundingSource: 'personal_checking' | 'credit_card' | 'wallet';
  sourceAccountId: string;
  accountName?: string;
  date: string;
  dueDate: string;
  categoryId?: string;
  categoryName?: string;
  status: 'active' | 'partially_reimbursed' | 'settled' | 'cancelled';
  negotiationStatus?: 'pending' | 'accepted' | 'rejected' | 'disputed';
  registeredDebtorUids: string[];
  hasExternalDebtors?: boolean;
  participantSummaries: AdhocParticipantSummary[];
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdhocObligationDoc {
  id: string;
  adhocExpenseId: string;
  title: string;
  description?: string;
  guestUid: string;
  guestEmail: string;
  guestName: string;
  creditorUid: string;
  creditorName: string;
  creditorEmail: string;
  totalAmountCents: number;
  assignedAmountCents: number;
  paidAmountCents: number;
  remainingBalanceCents: number;
  obligationStatus: 'pending_invite' | 'accepted' | 'rejected' | 'partially_paid' | 'settled';
  proposedAmountCents?: number;
  guestRejectionReason?: string;
  date: string;
  dueDate: string;
  categoryId?: string;
  categoryName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdhocInviteTokenSummary {
  email: string;
  name: string;
  rawToken: string;
  tokenHash: string;
}

export interface CreateAdhocExpenseInput {
  ownerEmail: string;
  ownerName: string;
  title: string;
  description?: string;
  totalAmountCents: number;
  fundingSource?: 'personal_checking' | 'credit_card' | 'wallet';
  sourceAccountId?: string;
  accountName?: string;
  date: string;
  dueDate?: string;
  categoryId?: string;
  categoryName?: string;
  participants: Array<{
    uid?: string;
    email: string;
    name: string;
    assignedAmountCents: number;
    isOwner?: boolean;
  }>;
  idempotencyKey?: string;
}

export interface CreateAdhocExpenseResult {
  expense: AdhocExpenseDoc;
  obligations: AdhocObligationDoc[];
  invites: AdhocInviteTokenSummary[];
  isIdempotentReplay?: boolean;
}

const DEMO_ADHOC_EXPENSES_KEY = 'mpf_v3_demo_adhoc_expenses';
const DEMO_ADHOC_OBLIGATIONS_KEY = 'mpf_v3_demo_adhoc_obligations';

function loadDemoAdhocExpenses(): AdhocExpenseDoc[] {
  try {
    const raw = universalStorage.getItem(DEMO_ADHOC_EXPENSES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDemoAdhocExpenses(list: AdhocExpenseDoc[]): void {
  try {
    universalStorage.setItem(DEMO_ADHOC_EXPENSES_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn('[DemoAdhoc] Erro ao salvar adhoc expenses:', err);
  }
}

function loadDemoAdhocObligations(): AdhocObligationDoc[] {
  try {
    const raw = universalStorage.getItem(DEMO_ADHOC_OBLIGATIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDemoAdhocObligations(list: AdhocObligationDoc[]): void {
  try {
    universalStorage.setItem(DEMO_ADHOC_OBLIGATIONS_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn('[DemoAdhoc] Erro ao salvar adhoc obligations:', err);
  }
}

function computeDemoNegotiationStatus(
  summaries: AdhocParticipantSummary[]
): 'pending' | 'accepted' | 'rejected' | 'disputed' {
  const debtors = summaries.filter((s) => !s.isOwner);
  if (debtors.length === 0) return 'accepted';
  if (debtors.some((d) => d.status === 'disputed')) return 'disputed';
  if (debtors.some((d) => d.status === 'rejected')) return 'rejected';
  if (debtors.some((d) => d.status === 'pending')) return 'pending';
  return 'accepted';
}

export async function createAdhocExpense(
  ownerUid: string,
  input: CreateAdhocExpenseInput,
  isDemo = false
): Promise<CreateAdhocExpenseResult> {
  if (!ownerUid) throw new Error('Usuário autenticado é obrigatório.');
  if (!input.title.trim()) throw new Error('Descrição do rateio avulso é obrigatória.');
  if (!Number.isSafeInteger(input.totalAmountCents) || input.totalAmountCents <= 0) {
    throw new Error('O valor total do rateio avulso deve ser positivo em centavos.');
  }

  if (!isDemo) {
    const callable = httpsCallable<CreateAdhocExpenseInput, CreateAdhocExpenseResult>(
      functions,
      'createAdhocExpenseOfficial'
    );
    const res = await callable({
      ...input,
      idempotencyKey:
        input.idempotencyKey ||
        `adhoc_${ownerUid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    });
    return res.data;
  }

  const nowIso = new Date().toISOString();
  const expenseId = `adhoc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ownerEmailLower = input.ownerEmail.trim().toLowerCase();

  const summaries: AdhocParticipantSummary[] = [];
  const obligations: AdhocObligationDoc[] = [];
  const registeredDebtorUids: string[] = [];

  for (let i = 0; i < input.participants.length; i++) {
    const p = input.participants[i];
    const emailLower = (p.email || '').trim().toLowerCase();
    const isOwner = Boolean(p.isOwner) || (ownerEmailLower && emailLower === ownerEmailLower);

    if (isOwner) {
      summaries.push({
        uid: ownerUid,
        email: ownerEmailLower || emailLower,
        name: input.ownerName || p.name,
        assignedAmountCents: p.assignedAmountCents,
        isOwner: true,
        status: 'accepted',
        updatedAt: nowIso,
      });
    } else {
      const guestUid = p.uid || (emailLower ? `demo_guest_${emailLower}` : '');
      const obId = `adhoc_ob_${expenseId}_${i}`;
      if (guestUid) registeredDebtorUids.push(guestUid);
      summaries.push({
        uid: guestUid || null,
        email: emailLower,
        name: p.name || emailLower || `Participante ${i + 1}`,
        assignedAmountCents: p.assignedAmountCents,
        isOwner: false,
        obligationId: obId,
        status: 'pending',
        updatedAt: nowIso,
      });
      obligations.push({
        id: obId,
        adhocExpenseId: expenseId,
        title: input.title.trim(),
        description: input.description?.trim(),
        guestUid: guestUid || `ext_${i}`,
        guestEmail: emailLower,
        guestName: p.name || emailLower,
        creditorUid: ownerUid,
        creditorName: input.ownerName,
        creditorEmail: ownerEmailLower,
        totalAmountCents: input.totalAmountCents,
        assignedAmountCents: p.assignedAmountCents,
        paidAmountCents: 0,
        remainingBalanceCents: p.assignedAmountCents,
        obligationStatus: 'pending_invite',
        date: input.date,
        dueDate: input.dueDate || input.date,
        categoryId: input.categoryId || 'uncategorized',
        categoryName: input.categoryName || 'Geral',
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }
  }

  const totalToReimburseCents = summaries
    .filter((s) => !s.isOwner)
    .reduce((sum, s) => sum + s.assignedAmountCents, 0);
  const ownerShareAmountCents = Math.max(0, input.totalAmountCents - totalToReimburseCents);

  const expense: AdhocExpenseDoc = {
    id: expenseId,
    ownerUid,
    ownerName: input.ownerName,
    ownerEmail: ownerEmailLower,
    title: input.title.trim(),
    description: input.description?.trim(),
    totalAmountCents: input.totalAmountCents,
    ownerShareAmountCents,
    totalToReimburseCents,
    totalReimbursedCents: 0,
    remainingToReimburseCents: totalToReimburseCents,
    fundingSource: input.fundingSource || 'personal_checking',
    sourceAccountId: input.sourceAccountId || '',
    accountName: input.accountName,
    date: input.date,
    dueDate: input.dueDate || input.date,
    categoryId: input.categoryId || 'uncategorized',
    categoryName: input.categoryName || 'Geral',
    status: 'active',
    negotiationStatus: computeDemoNegotiationStatus(summaries),
    registeredDebtorUids,
    hasExternalDebtors: false,
    participantSummaries: summaries,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const allExp = loadDemoAdhocExpenses();
  allExp.push(expense);
  saveDemoAdhocExpenses(allExp);

  const allObs = loadDemoAdhocObligations();
  allObs.push(...obligations);
  saveDemoAdhocObligations(allObs);

  return { expense, obligations, invites: [] };
}

export async function respondAdhocObligation(
  guestUid: string,
  input: {
    adhocExpenseId: string;
    obligationId?: string;
    action: 'accept' | 'reject' | 'counter_propose';
    reason?: string;
    proposedAmountCents?: number;
  },
  isDemo = false
): Promise<{ obligation: AdhocObligationDoc; expense: AdhocExpenseDoc }> {
  if (!isDemo) {
    const callable = httpsCallable<
      typeof input,
      { obligation: AdhocObligationDoc; expense: AdhocExpenseDoc }
    >(functions, 'respondAdhocObligationOfficial');
    const res = await callable(input);
    return res.data;
  }

  const expenses = loadDemoAdhocExpenses();
  const obs = loadDemoAdhocObligations();
  const expIdx = expenses.findIndex((e) => e.id === input.adhocExpenseId);
  const obIdx = obs.findIndex(
    (o) =>
      o.adhocExpenseId === input.adhocExpenseId &&
      (input.obligationId ? o.id === input.obligationId : o.guestUid === guestUid)
  );
  if (expIdx < 0 || obIdx < 0) {
    throw new Error('Rateio avulso não encontrado para resposta.');
  }

  const nowIso = new Date().toISOString();
  const exp = { ...expenses[expIdx] };
  const ob = { ...obs[obIdx] };
  const summaries = [...exp.participantSummaries];
  const sIdx = summaries.findIndex(
    (s) => s.obligationId === ob.id || s.uid === guestUid || s.email === ob.guestEmail
  );

  if (input.action === 'accept') {
    ob.obligationStatus = 'accepted';
    ob.guestRejectionReason = '';
    if (sIdx >= 0) summaries[sIdx] = { ...summaries[sIdx], status: 'accepted', note: '', updatedAt: nowIso };
  } else if (input.action === 'reject') {
    const reason = input.reason?.trim() || 'Recusado pelo participante.';
    ob.obligationStatus = 'rejected';
    ob.guestRejectionReason = reason;
    if (sIdx >= 0) summaries[sIdx] = { ...summaries[sIdx], status: 'rejected', note: reason, updatedAt: nowIso };
  } else {
    const prop = Math.max(0, Math.round(input.proposedAmountCents || 0));
    const reason = input.reason?.trim() || 'Contraproposta enviada.';
    ob.proposedAmountCents = prop;
    ob.guestRejectionReason = reason;
    if (sIdx >= 0) {
      summaries[sIdx] = {
        ...summaries[sIdx],
        status: 'disputed',
        proposedAmountCents: prop,
        note: reason,
        updatedAt: nowIso,
      };
    }
  }

  ob.updatedAt = nowIso;
  exp.participantSummaries = summaries;
  exp.negotiationStatus = computeDemoNegotiationStatus(summaries);
  exp.updatedAt = nowIso;

  expenses[expIdx] = exp;
  obs[obIdx] = ob;
  saveDemoAdhocExpenses(expenses);
  saveDemoAdhocObligations(obs);

  return { obligation: ob, expense: exp };
}

export async function resolveAdhocCounterProposal(
  input: {
    adhocExpenseId: string;
    guestUid: string;
    acceptCounterProposal: boolean;
  },
  isDemo = false
): Promise<{ ok: boolean }> {
  if (!isDemo) {
    const callable = httpsCallable<typeof input, { ok: boolean }>(
      functions,
      'resolveAdhocCounterProposalOfficial'
    );
    const res = await callable(input);
    return res.data;
  }

  const expenses = loadDemoAdhocExpenses();
  const obs = loadDemoAdhocObligations();
  const expIdx = expenses.findIndex((e) => e.id === input.adhocExpenseId);
  const obIdx = obs.findIndex(
    (o) => o.adhocExpenseId === input.adhocExpenseId && o.guestUid === input.guestUid
  );
  if (expIdx < 0 || obIdx < 0) throw new Error('Contraproposta não encontrada.');

  const nowIso = new Date().toISOString();
  const exp = { ...expenses[expIdx] };
  const ob = { ...obs[obIdx] };
  const summaries = [...exp.participantSummaries];
  const gIdx = summaries.findIndex((s) => s.uid === input.guestUid);

  if (input.acceptCounterProposal) {
    const agreed = ob.proposedAmountCents ?? ob.assignedAmountCents;
    ob.assignedAmountCents = agreed;
    ob.remainingBalanceCents = Math.max(0, agreed - (ob.paidAmountCents || 0));
    ob.obligationStatus = 'accepted';
    if (gIdx >= 0) {
      summaries[gIdx] = { ...summaries[gIdx], assignedAmountCents: agreed, status: 'accepted', updatedAt: nowIso };
    }
  } else {
    ob.obligationStatus = 'rejected';
    ob.guestRejectionReason = 'Contraproposta recusada pelo criador.';
    if (gIdx >= 0) {
      summaries[gIdx] = { ...summaries[gIdx], status: 'rejected', note: ob.guestRejectionReason, updatedAt: nowIso };
    }
  }

  exp.participantSummaries = summaries;
  exp.negotiationStatus = computeDemoNegotiationStatus(summaries);
  exp.updatedAt = nowIso;
  ob.updatedAt = nowIso;

  expenses[expIdx] = exp;
  obs[obIdx] = ob;
  saveDemoAdhocExpenses(expenses);
  saveDemoAdhocObligations(obs);
  return { ok: true };
}

export async function cancelAdhocExpense(
  adhocExpenseId: string,
  reason: string,
  isDemo = false
): Promise<AdhocExpenseDoc> {
  if (!reason.trim()) throw new Error('Motivo do cancelamento é obrigatório.');
  if (!isDemo) {
    const callable = httpsCallable<
      { adhocExpenseId: string; reason: string },
      { expense: AdhocExpenseDoc }
    >(functions, 'cancelAdhocExpenseOfficial');
    const res = await callable({ adhocExpenseId, reason: reason.trim() });
    return res.data.expense;
  }

  const expenses = loadDemoAdhocExpenses();
  const idx = expenses.findIndex((e) => e.id === adhocExpenseId);
  if (idx < 0) throw new Error('Despesa avulsa não encontrada.');
  const nowIso = new Date().toISOString();
  const updated: AdhocExpenseDoc = {
    ...expenses[idx],
    status: 'cancelled',
    description: `${expenses[idx].description ? `${expenses[idx].description} | ` : ''}Cancelado: ${reason.trim()}`,
    updatedAt: nowIso,
  };
  expenses[idx] = updated;
  saveDemoAdhocExpenses(expenses);
  return updated;
}

export function mapAdhocExpenseToTransaction(
  exp: AdhocExpenseDoc,
  currentUserUid: string,
  currentUserEmail: string
): Transaction {
  const splits: SplitShare[] = (exp.participantSummaries || []).map((p) => ({
    email: p.email,
    name: p.name,
    responsibility: (p.assignedAmountCents || 0) / 100,
    paidAmount: p.isOwner ? exp.totalAmountCents / 100 : 0,
    status: p.status,
    proposedAmount:
      p.proposedAmountCents !== undefined ? p.proposedAmountCents / 100 : undefined,
    note: p.note,
  }));

  const isOwner = exp.ownerUid === currentUserUid;
  const mySummary = (exp.participantSummaries || []).find(
    (p) =>
      p.uid === currentUserUid ||
      (currentUserEmail && p.email?.toLowerCase() === currentUserEmail.toLowerCase())
  );

  const hasDisputedGuest =
    isOwner && (exp.participantSummaries || []).some((p) => !p.isOwner && p.status === 'disputed');

  let txStatus: Transaction['status'] = 'pending';
  if (exp.status === 'settled') {
    txStatus = 'paid';
  } else if (exp.status === 'cancelled' || mySummary?.status === 'rejected') {
    txStatus = 'rejected';
  } else if (hasDisputedGuest) {
    txStatus = 'validating';
  } else if (!isOwner && mySummary && (mySummary.status === 'pending' || mySummary.status === 'disputed')) {
    txStatus = 'validating';
  } else {
    // Mesmo após aceitar a cota, o rateio permanece pendente/a pagar até ser liquidado!
    txStatus = 'pending';
  }

  const disputedShare = (exp.participantSummaries || []).find((p) => p.status === 'disputed');

  return {
    id: exp.id,
    userId: exp.ownerUid,
    ownerEmail: exp.ownerEmail,
    ownerName: exp.ownerName,
    description: exp.title,
    amount: exp.totalAmountCents / 100,
    type: 'expense',
    status: txStatus,
    categoryId: exp.categoryId || 'uncategorized',
    categoryName: exp.categoryName || 'Rateio Avulso',
    categoryIcon: 'ph-scales',
    categoryColor: '#f59e0b',
    accountId: exp.sourceAccountId || '',
    accountName: exp.accountName || 'Rateio Avulso',
    accountType: exp.fundingSource === 'credit_card' ? 'credit' : 'checking',
    competenceDate: exp.date,
    dueDate: exp.dueDate || exp.date,
    invoiceMonth: (exp.date || '').slice(0, 7),
    recurrenceType: 'single',
    recurrenceGroupId: '',
    installmentIndex: 1,
    installmentTotal: 1,
    spaceId: '',
    spaceName: 'Rateio Avulso',
    paidByEmail: exp.ownerEmail,
    participantEmails: (exp.participantSummaries || [])
      .map((p) => p.email)
      .filter(Boolean),
    splits,
    disputeReason: disputedShare?.note || mySummary?.note || '',
    proposedAmount:
      disputedShare?.proposedAmountCents !== undefined
        ? disputedShare.proposedAmountCents / 100
        : mySummary?.proposedAmountCents !== undefined
        ? mySummary.proposedAmountCents / 100
        : 0,
    createdAt: exp.createdAt,
    updatedAt: exp.updatedAt,
  };
}

export function mapAdhocObligationToTransaction(
  ob: AdhocObligationDoc,
  linkedExp?: AdhocExpenseDoc
): Transaction {
  if (linkedExp) {
    return mapAdhocExpenseToTransaction(linkedExp, ob.guestUid, ob.guestEmail);
  }

  const txStatus: Transaction['status'] =
    ob.obligationStatus === 'settled'
      ? 'paid'
      : ob.obligationStatus === 'rejected'
      ? 'rejected'
      : ob.obligationStatus === 'accepted'
      ? 'pending'
      : 'validating';

  const guestStatus: SplitShare['status'] =
    ob.obligationStatus === 'rejected'
      ? 'rejected'
      : ob.obligationStatus === 'accepted' || ob.obligationStatus === 'settled'
      ? 'accepted'
      : ob.proposedAmountCents !== undefined
      ? 'disputed'
      : 'pending';

  return {
    id: ob.adhocExpenseId,
    userId: ob.creditorUid,
    ownerEmail: ob.creditorEmail,
    ownerName: ob.creditorName,
    description: ob.title,
    amount: ob.totalAmountCents / 100,
    type: 'expense',
    status: txStatus,
    categoryId: ob.categoryId || 'uncategorized',
    categoryName: ob.categoryName || 'Rateio Avulso',
    categoryIcon: 'ph-scales',
    categoryColor: '#f59e0b',
    accountId: '',
    accountName: 'Rateio Avulso',
    accountType: 'checking',
    competenceDate: ob.date,
    dueDate: ob.dueDate || ob.date,
    invoiceMonth: (ob.date || '').slice(0, 7),
    recurrenceType: 'single',
    recurrenceGroupId: '',
    installmentIndex: 1,
    installmentTotal: 1,
    spaceId: '',
    spaceName: 'Rateio Avulso',
    paidByEmail: ob.creditorEmail,
    participantEmails: [ob.creditorEmail, ob.guestEmail].filter(Boolean),
    splits: [
      {
        email: ob.creditorEmail,
        name: ob.creditorName,
        responsibility: Math.max(0, (ob.totalAmountCents - ob.assignedAmountCents) / 100),
        paidAmount: ob.totalAmountCents / 100,
        status: 'accepted',
      },
      {
        email: ob.guestEmail,
        name: ob.guestName,
        responsibility: ob.assignedAmountCents / 100,
        paidAmount: ob.paidAmountCents / 100,
        status: guestStatus,
        proposedAmount:
          ob.proposedAmountCents !== undefined ? ob.proposedAmountCents / 100 : undefined,
        note: ob.guestRejectionReason,
      },
    ],
    disputeReason: ob.guestRejectionReason || '',
    proposedAmount: ob.proposedAmountCents !== undefined ? ob.proposedAmountCents / 100 : 0,
    createdAt: ob.createdAt,
    updatedAt: ob.updatedAt,
  };
}

export interface AdhocRealtimePayload {
  expenses: AdhocExpenseDoc[];
  obligations: AdhocObligationDoc[];
  transactions: Transaction[];
}

export function subscribeToUserAdhocData(
  userUid: string,
  userEmail: string,
  onUpdate: (data: AdhocRealtimePayload) => void,
  isDemo = false
): Unsubscribe {
  if (!userUid) {
    onUpdate({ expenses: [], obligations: [], transactions: [] });
    return () => {};
  }

  if (isDemo) {
    const owned = loadDemoAdhocExpenses().filter(
      (e) => e.ownerUid === userUid || e.registeredDebtorUids.includes(userUid)
    );
    const obs = loadDemoAdhocObligations().filter(
      (o) => o.guestUid === userUid || (userEmail && o.guestEmail === userEmail.toLowerCase())
    );
    const txs = buildAdhocTransactionsList(owned, obs, userUid, userEmail);
    onUpdate({ expenses: owned, obligations: obs, transactions: txs });
    return () => {};
  }

  let ownedExpenses: AdhocExpenseDoc[] = [];
  let debtorExpenses: AdhocExpenseDoc[] = [];
  let obligations: AdhocObligationDoc[] = [];

  const emit = () => {
    const mergedExpensesMap = new Map<string, AdhocExpenseDoc>();
    for (const e of ownedExpenses) mergedExpensesMap.set(e.id, e);
    for (const e of debtorExpenses) mergedExpensesMap.set(e.id, e);
    const expenses = Array.from(mergedExpensesMap.values());
    const transactions = buildAdhocTransactionsList(expenses, obligations, userUid, userEmail);
    onUpdate({ expenses, obligations, transactions });
  };

  const unsubOwned = onSnapshot(
    query(collection(db, 'adhoc_expenses'), where('ownerUid', '==', userUid)),
    (snap) => {
      ownedExpenses = snap.docs.map((d) => ({ ...(d.data() as AdhocExpenseDoc), id: d.id }));
      emit();
    },
    (err) => {
      console.warn('[adhocService] Erro ao escutar adhoc_expenses (owner):', err);
    }
  );

  const unsubDebtor = onSnapshot(
    query(collection(db, 'adhoc_expenses'), where('registeredDebtorUids', 'array-contains', userUid)),
    (snap) => {
      debtorExpenses = snap.docs.map((d) => ({ ...(d.data() as AdhocExpenseDoc), id: d.id }));
      emit();
    },
    (err) => {
      console.warn('[adhocService] Erro ao escutar adhoc_expenses (debtor):', err);
    }
  );

  const unsubObs = onSnapshot(
    collection(db, 'users', userUid, 'adhoc_obligations'),
    (snap) => {
      obligations = snap.docs.map((d) => ({ ...(d.data() as AdhocObligationDoc), id: d.id }));
      emit();
    },
    (err) => {
      console.warn('[adhocService] Erro ao escutar adhoc_obligations:', err);
    }
  );

  return () => {
    unsubOwned();
    unsubDebtor();
    unsubObs();
  };
}

function buildAdhocTransactionsList(
  expenses: AdhocExpenseDoc[],
  obligations: AdhocObligationDoc[],
  userUid: string,
  userEmail: string
): Transaction[] {
  const byExpId = new Map<string, Transaction>();
  const expMap = new Map<string, AdhocExpenseDoc>(expenses.map((e) => [e.id, e]));

  for (const exp of expenses) {
    byExpId.set(exp.id, mapAdhocExpenseToTransaction(exp, userUid, userEmail));
  }
  for (const ob of obligations) {
    const linked = expMap.get(ob.adhocExpenseId);
    byExpId.set(ob.adhocExpenseId, mapAdhocObligationToTransaction(ob, linked));
  }

  return Array.from(byExpId.values()).sort((a, b) =>
    (b.competenceDate || '').localeCompare(a.competenceDate || '')
  );
}
