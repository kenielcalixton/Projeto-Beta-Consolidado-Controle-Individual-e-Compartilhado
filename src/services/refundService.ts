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
  DateString,
  FinancialMovement,
  PersonalRefund,
  PersonalRefundReceipt,
  PersonalRefundStatus,
  PersonalTransaction,
} from '../types/financeV3';
import { getUserAccounts } from './accountService';
import { recordMovement } from './ledgerService';
import { universalStorage } from '../utils/universalStorage';
import { validatePositiveCents } from '../utils/movementLedger';

/**
 * ==============================================================================
 * SERVIÇO DE REEMBOLSOS INDIVIDUAIS (v3.1)
 * ==============================================================================
 * Caminho Canônico: users/{userId}/personal_refunds/{refundId}
 *
 * Princípios Fundamentais:
 * 1. O reembolso é estritamente vinculado a uma despesa pessoal original (originalTransactionId).
 * 2. Não é receita comum de faturamento: é reposição de desembolso antecipado.
 * 3. Quando recebido (total ou parcialmente), gera entrada real ('inflow') na conta/carteira
 *    do credor, recompondo seu saldo disponível.
 * 4. Não altera automaticamente faturas de cartão de crédito se a despesa tiver sido paga com cartão.
 * 5. Impede amortizações que excedam o valor devido.
 */

const DEMO_REFUNDS_KEY = 'mpf_v3_demo_personal_refunds';
const DEMO_REFUND_RECEIPTS_KEY = 'mpf_v3_demo_refund_receipts';

function loadDemoRefunds(): PersonalRefund[] {
  try {
    const raw = universalStorage.getItem(DEMO_REFUNDS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDemoRefunds(refunds: PersonalRefund[]): void {
  try {
    universalStorage.setItem(DEMO_REFUNDS_KEY, JSON.stringify(refunds));
  } catch (err) {
    console.warn('[DemoRefunds] Erro ao salvar reembolsos:', err);
  }
}

function loadDemoRefundReceipts(): PersonalRefundReceipt[] {
  try {
    const raw = universalStorage.getItem(DEMO_REFUND_RECEIPTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDemoRefundReceipts(receipts: PersonalRefundReceipt[]): void {
  try {
    universalStorage.setItem(DEMO_REFUND_RECEIPTS_KEY, JSON.stringify(receipts));
  } catch (err) {
    console.warn('[DemoRefundReceipts] Erro ao salvar recibos de reembolso:', err);
  }
}

export interface CreatePersonalRefundInput {
  originalTransactionId: string;
  debtorName: string;
  amountDueCents: CentsInteger;
  description?: string;
  notes?: string;
}

/**
 * Cria o registro de um reembolso a ser recebido vinculado a uma despesa pessoal.
 */
export async function createPersonalRefund(
  userId: string,
  input: CreatePersonalRefundInput,
  isDemo = false
): Promise<PersonalRefund> {
  if (!validatePositiveCents(input.amountDueCents)) {
    throw new Error('O valor do reembolso deve ser um inteiro estritamente positivo em centavos.');
  }
  const cleanDebtor = input.debtorName?.trim();
  if (!cleanDebtor) {
    throw new Error('O nome do devedor/reembolsador é obrigatório.');
  }

  const refundId = `ref_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const now = new Date().toISOString();

  const refund: PersonalRefund = {
    id: refundId,
    userId,
    originalTransactionId: input.originalTransactionId,
    debtorName: cleanDebtor,
    amountDueCents: input.amountDueCents,
    amountReceivedCents: 0,
    remainingAmountCents: input.amountDueCents,
    status: 'pending',
    description: input.description?.trim() || `Reembolso de ${cleanDebtor}`,
    notes: input.notes?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };

  if (isDemo) {
    const list = loadDemoRefunds();
    list.push(refund);
    saveDemoRefunds(list);
    return refund;
  }

  const refDoc = doc(db, 'users', userId, 'personal_refunds', refundId);
  await setDoc(refDoc, refund);
  return refund;
}

export interface RecordRefundReceiptInput {
  refundId: string;
  amountCents: CentsInteger;
  receiptDate: DateString;
  destinationAccountId: string;
  notes?: string;
  authorUid: string;
}

export interface RefundReceiptResult {
  refund: PersonalRefund;
  receipt: PersonalRefundReceipt;
  movement: FinancialMovement;
}

/**
 * Registra o recebimento (total ou parcial) de um reembolso com crédito em conta bancária/carteira.
 */
export async function recordRefundReceipt(
  userId: string,
  input: RecordRefundReceiptInput,
  isDemo = false
): Promise<RefundReceiptResult> {
  if (!validatePositiveCents(input.amountCents)) {
    throw new Error('O valor do recebimento deve ser um inteiro positivo em centavos.');
  }

  // 1. Carrega o reembolso
  let refund: PersonalRefund;
  if (isDemo) {
    const list = loadDemoRefunds();
    const found = list.find((r) => r.id === input.refundId && r.userId === userId);
    if (!found) throw new Error(`Reembolso "${input.refundId}" não encontrado.`);
    refund = { ...found };
  } else {
    const refDoc = doc(db, 'users', userId, 'personal_refunds', input.refundId);
    const snap = await getDoc(refDoc);
    if (!snap.exists()) throw new Error(`Reembolso "${input.refundId}" não encontrado.`);
    refund = snap.data() as PersonalRefund;
  }

  if (refund.status === 'cancelled') {
    throw new Error('Não é permitido receber valores de um reembolso cancelado.');
  }
  if (refund.status === 'received' && refund.remainingAmountCents <= 0) {
    throw new Error('Este reembolso já foi totalmente quitado.');
  }

  if (input.amountCents > refund.remainingAmountCents) {
    throw new Error(
      `O valor recebido (${input.amountCents} centavos) excede o saldo devedor restante do reembolso (${refund.remainingAmountCents} centavos).`
    );
  }

  // 2. Valida conta de destino
  const accounts = await getUserAccounts(userId, true, isDemo);
  const destAccount = accounts.find((a) => a.id === input.destinationAccountId);
  if (!destAccount) {
    throw new Error(`Conta bancária de destino "${input.destinationAccountId}" não encontrada.`);
  }
  if (destAccount.isArchived) {
    throw new Error(`A conta "${destAccount.name}" está arquivada e não pode receber créditos.`);
  }

  const receiptId = `rec_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const idempotencyKey = `idem_refrec_${input.refundId}_${receiptId}_${input.amountCents}`;

  // 3. Gera entrada no Livro Financeiro (recompondo o caixa do credor)
  const movement = await recordMovement(
    {
      accountId: destAccount.id,
      userId,
      direction: 'inflow',
      amountCents: input.amountCents,
      effectiveDate: input.receiptDate,
      originType: 'adhoc_receipt',
      originId: receiptId,
      description: `Reembolso recebido de ${refund.debtorName}`,
      notes: input.notes || `Reembolso #${refund.id}`,
      authorUid: input.authorUid,
      idempotencyKey,
    },
    isDemo
  );

  // 4. Registra evento de recibo
  const receiptRecord: PersonalRefundReceipt = {
    id: receiptId,
    refundId: input.refundId,
    userId,
    amountCents: input.amountCents,
    receiptDate: input.receiptDate,
    destinationAccountId: input.destinationAccountId,
    financialMovementId: movement.id,
    authorUid: input.authorUid,
    notes: input.notes,
    createdAt: new Date().toISOString(),
  };

  // 5. Atualiza o status do reembolso
  const newReceived = refund.amountReceivedCents + input.amountCents;
  const newRemaining = refund.amountDueCents - newReceived;
  const newStatus: PersonalRefundStatus = newRemaining === 0 ? 'received' : 'partially_received';

  const updatedRefund: PersonalRefund = {
    ...refund,
    amountReceivedCents: newReceived,
    remainingAmountCents: newRemaining,
    status: newStatus,
    updatedAt: new Date().toISOString(),
  };

  if (isDemo) {
    const list = loadDemoRefunds();
    const idx = list.findIndex((r) => r.id === input.refundId && r.userId === userId);
    if (idx >= 0) list[idx] = updatedRefund;
    saveDemoRefunds(list);

    const receipts = loadDemoRefundReceipts();
    receipts.push(receiptRecord);
    saveDemoRefundReceipts(receipts);
  } else {
    const refDoc = doc(db, 'users', userId, 'personal_refunds', input.refundId);
    const recDoc = doc(
      db,
      'users',
      userId,
      'personal_refunds',
      input.refundId,
      'receipts',
      receiptId
    );
    await setDoc(refDoc, updatedRefund, { merge: true });
    await setDoc(recDoc, receiptRecord);
  }

  return {
    refund: updatedRefund,
    receipt: receiptRecord,
    movement,
  };
}

/**
 * Consulta reembolsos individuais do usuário.
 */
export async function getUserRefunds(
  userId: string,
  isDemo = false
): Promise<PersonalRefund[]> {
  if (!userId) return [];

  if (isDemo) {
    return loadDemoRefunds()
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  const q = query(
    collection(db, 'users', userId, 'personal_refunds')
  );
  const snap = await getDocs(q);
  const list: PersonalRefund[] = [];
  snap.forEach((d) => list.push({ ...(d.data() as PersonalRefund), id: d.id }));
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Consulta os recibos de um reembolso específico.
 */
export async function getRefundReceipts(
  refundId: string,
  userId: string,
  isDemo = false
): Promise<PersonalRefundReceipt[]> {
  if (isDemo) {
    return loadDemoRefundReceipts()
      .filter((rec) => rec.refundId === refundId && rec.userId === userId)
      .sort((a, b) => b.receiptDate.localeCompare(a.receiptDate));
  }

  const snap = await getDocs(
    collection(db, 'users', userId, 'personal_refunds', refundId, 'receipts')
  );
  const list: PersonalRefundReceipt[] = [];
  snap.forEach((d) => list.push({ ...(d.data() as PersonalRefundReceipt), id: d.id }));
  return list.sort((a, b) => b.receiptDate.localeCompare(a.receiptDate));
}
