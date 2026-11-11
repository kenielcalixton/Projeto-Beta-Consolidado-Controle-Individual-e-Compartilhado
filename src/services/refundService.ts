import {
  collection,
  getDocs,
  query,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from './firebase';
import {
  CentsInteger,
  DateString,
  FinancialMovement,
  PersonalRefund,
  PersonalRefundReceipt,
  PersonalRefundStatus,
} from '../types/financeV3';
import { getUserAccounts } from './accountService';
import { recordMovement, withDemoLock } from './ledgerService';
import { loadDemoTransactions } from './personalTransactionService';
import { universalStorage } from '../utils/universalStorage';
import { generateMovementDocId, validatePositiveCents } from '../utils/movementLedger';

/**
 * ==============================================================================
 * SERVIÇO DE REEMBOLSOS INDIVIDUAIS (v3.1)
 * ==============================================================================
 * Caminho Canônico: users/{userId}/personal_refunds/{refundId}
 *
 * Princípios Fundamentais:
 * 1. O reembolso é estritamente vinculado a uma despesa pessoal original (originalTransactionId).
 * 2. Não é receita comum de faturamento: é reposição de desembolso antecipado com originType 'personal_refund'.
 * 3. Quando recebido (total ou parcialmente), gera entrada real ('inflow') na conta/carteira
 *    do credor, recompondo seu saldo disponível.
 * 4. Não altera automaticamente faturas de cartão de crédito se a despesa tiver sido paga com cartão.
 * 5. Impede amortizações que excedam o valor devido e impede crédito em conta de cartão.
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
  idempotencyKey?: string;
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
  const origTxId = input.originalTransactionId?.trim();
  if (!origTxId) {
    throw new Error('O ID da despesa original (originalTransactionId) é obrigatório.');
  }

  if (!isDemo) {
    const callable = httpsCallable<
      CreatePersonalRefundInput & { idempotencyKey: string },
      { refund: PersonalRefund }
    >(functions, 'createPersonalRefundOfficial');

    const idempotencyKey =
      input.idempotencyKey?.trim() ||
      `idem_ref_${userId}_${origTxId}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    const res = await callable({
      ...input,
      idempotencyKey,
    });
    return res.data.refund;
  }

  return withDemoLock(async () => {
    const idempotencyKey =
      input.idempotencyKey?.trim() ||
      `idem_ref_${userId}_${origTxId}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const refundId = input.idempotencyKey?.trim()
      ? `ref_${generateMovementDocId(userId, idempotencyKey)}`
      : `ref_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    const list = loadDemoRefunds();
    const existing = list.find(
      (r) =>
        r.userId === userId &&
        (r.id === refundId || (input.idempotencyKey && r.idempotencyKey === idempotencyKey))
    );
    if (existing) {
      if (
        existing.amountDueCents !== input.amountDueCents ||
        existing.originalTransactionId !== origTxId
      ) {
        throw new Error(
          `Conflito de idempotência: chave "${idempotencyKey}" já utilizada com parâmetros divergentes.`
        );
      }
      return existing;
    }

    // Valida a despesa original
    const txs = loadDemoTransactions();
    const origTx = txs.find((t) => t.id === origTxId && t.userId === userId);
    if (!origTx) {
      throw new Error(`Despesa original "${origTxId}" não encontrada.`);
    }
    if (origTx.type !== 'expense') {
      throw new Error('Reembolsos só podem ser vinculados a transações do tipo despesa (expense).');
    }
    if (origTx.status === 'cancelled') {
      throw new Error('Não é permitido criar reembolso para uma despesa cancelada.');
    }
    if (input.amountDueCents > origTx.amountCents) {
      throw new Error(
        `O valor do reembolso (${input.amountDueCents}) não pode exceder o valor da despesa original (${origTx.amountCents}).`
      );
    }

    const now = new Date().toISOString();

    const refund: PersonalRefund = {
      id: refundId,
      userId,
      originalTransactionId: origTxId,
      debtorName: cleanDebtor,
      amountDueCents: input.amountDueCents,
      amountReceivedCents: 0,
      remainingAmountCents: input.amountDueCents,
      status: 'pending',
      description: input.description?.trim() || `Reembolso de ${cleanDebtor}`,
      notes: input.notes?.trim() || undefined,
      idempotencyKey,
      createdAt: now,
      updatedAt: now,
    };

    list.push(refund);
    saveDemoRefunds(list);
    return refund;
  });
}

export interface RecordRefundReceiptInput {
  refundId: string;
  amountCents: CentsInteger;
  receiptDate: DateString;
  destinationAccountId: string;
  notes?: string;
  authorUid: string;
  idempotencyKey?: string;
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

  if (!isDemo) {
    const callable = httpsCallable<
      {
        refundId: string;
        amountCents: number;
        receiptDate: string;
        destinationAccountId: string;
        notes?: string;
        idempotencyKey: string;
      },
      RefundReceiptResult
    >(functions, 'recordRefundReceiptOfficial');

    const idempotencyKey =
      input.idempotencyKey?.trim() ||
      `idem_refrec_${input.refundId}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    const res = await callable({
      refundId: input.refundId,
      amountCents: input.amountCents,
      receiptDate: input.receiptDate,
      destinationAccountId: input.destinationAccountId,
      notes: input.notes,
      idempotencyKey,
    });
    return res.data;
  }

  return withDemoLock(async () => {
    const idempotencyKey =
      input.idempotencyKey?.trim() ||
      `idem_refrec_${input.refundId}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const receiptId = input.idempotencyKey?.trim()
      ? `rec_${generateMovementDocId(input.refundId, idempotencyKey)}`
      : `rec_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    const receipts = loadDemoRefundReceipts();
    const existingRec = receipts.find(
      (r) =>
        r.refundId === input.refundId &&
        r.userId === userId &&
        (r.id === receiptId || (input.idempotencyKey && r.idempotencyKey === idempotencyKey))
    );
    if (existingRec) {
      if (
        existingRec.amountCents !== input.amountCents ||
        existingRec.destinationAccountId !== input.destinationAccountId
      ) {
        throw new Error(
          `Conflito de idempotência: chave "${idempotencyKey}" já utilizada com parâmetros divergentes.`
        );
      }
      const list = loadDemoRefunds();
      const foundRefund = list.find((r) => r.id === input.refundId && r.userId === userId)!;
      const movement = await recordMovement(
        {
          accountId: input.destinationAccountId,
          userId,
          direction: 'inflow',
          amountCents: input.amountCents,
          effectiveDate: input.receiptDate,
          originType: 'personal_refund',
          originId: existingRec.id,
          description: `Reembolso recebido de ${foundRefund.debtorName}`,
          notes: input.notes || `Reembolso #${foundRefund.id}`,
          authorUid: input.authorUid,
          idempotencyKey: `mov_${idempotencyKey}`,
        },
        true
      );
      return {
        refund: foundRefund,
        receipt: existingRec,
        movement,
      };
    }

    // 1. Carrega o reembolso
    const list = loadDemoRefunds();
    const found = list.find((r) => r.id === input.refundId && r.userId === userId);
    if (!found) throw new Error(`Reembolso "${input.refundId}" não encontrado.`);
    const refund = { ...found };

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
    const accounts = await getUserAccounts(userId, true, true);
    const destAccount = accounts.find((a) => a.id === input.destinationAccountId);
    if (!destAccount) {
      throw new Error(`Conta bancária de destino "${input.destinationAccountId}" não encontrada.`);
    }
    if (destAccount.isArchived) {
      throw new Error(`A conta "${destAccount.name}" está arquivada e não pode receber créditos.`);
    }
    if (destAccount.type === 'credit') {
      throw new Error('Não é permitido creditar recebimento de reembolso em conta de cartão de crédito.');
    }

    // 3. Gera entrada no Livro Financeiro com originType 'personal_refund'
    const movement = await recordMovement(
      {
        accountId: destAccount.id,
        userId,
        direction: 'inflow',
        amountCents: input.amountCents,
        effectiveDate: input.receiptDate,
        originType: 'personal_refund',
        originId: receiptId,
        description: `Reembolso recebido de ${refund.debtorName}`,
        notes: input.notes || `Reembolso #${refund.id} (Despesa #${refund.originalTransactionId})`,
        authorUid: input.authorUid,
        idempotencyKey: `mov_${idempotencyKey}`,
      },
      true
    );

    // 4. Registra evento de recibo
    const receiptRecord: PersonalRefundReceipt = {
      id: receiptId,
      refundId: input.refundId,
      originalTransactionId: refund.originalTransactionId,
      userId,
      amountCents: input.amountCents,
      receiptDate: input.receiptDate,
      destinationAccountId: input.destinationAccountId,
      financialMovementId: movement.id,
      originType: 'personal_refund',
      authorUid: input.authorUid,
      notes: input.notes,
      idempotencyKey,
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

    const currentList = loadDemoRefunds();
    const idx = currentList.findIndex((r) => r.id === input.refundId && r.userId === userId);
    if (idx >= 0) currentList[idx] = updatedRefund;
    saveDemoRefunds(currentList);

    const currentReceipts = loadDemoRefundReceipts();
    currentReceipts.push(receiptRecord);
    saveDemoRefundReceipts(currentReceipts);

    return {
      refund: updatedRefund,
      receipt: receiptRecord,
      movement,
    };
  });
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
