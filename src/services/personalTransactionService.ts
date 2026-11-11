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
  Account,
  CentsInteger,
  CompetenceMonthString,
  DateString,
  FinancialMovement,
  PersonalTransaction,
  PersonalTransactionOriginType,
  PersonalTransactionPayment,
  PersonalTransactionStatus,
  PersonalTransactionType,
} from '../types/financeV3';
import { recordMovement, reverseMovement } from './ledgerService';
import { getUserAccounts } from './accountService';
import { attachPurchaseToInvoice, calculateInvoiceMonth } from './creditCardService';
import { universalStorage } from '../utils/universalStorage';
import { validatePositiveCents } from '../utils/movementLedger';

/**
 * ==============================================================================
 * SERVIÇO DE TRANSAÇÕES INDIVIDUAIS (RECEITAS & DESPESAS) — v3.1
 * ==============================================================================
 * Caminho Canônico: users/{userId}/personal_transactions/{txId}
 *
 * Princípios Fundamentais:
 * 1. O Livro Financeiro v3.1 é a fonte primária de saldos reais:
 *    - Transações previstas ou pendentes NÃO alteram o saldo bancário.
 *    - Transações pagas/recebidas geram FinancialMovement atômico no livro-razão.
 * 2. Compras em cartão de crédito são vinculadas à fatura (CreditCardInvoice)
 *    e NÃO geram débito imediato em conta corrente/carteira.
 * 3. Pagamentos parciais geram eventos independentes de amortização e movimentações
 *    estritamente equivalentes ao valor amortizado.
 * 4. Cancelamentos preservam a rastreabilidade contábil e não apagam histórico.
 */

const DEMO_PERSONAL_TXS_KEY = 'mpf_v3_demo_personal_transactions';
const DEMO_TX_PAYMENTS_KEY = 'mpf_v3_demo_transaction_payments';

function loadDemoTransactions(): PersonalTransaction[] {
  try {
    const raw = universalStorage.getItem(DEMO_PERSONAL_TXS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDemoTransactions(txs: PersonalTransaction[]): void {
  try {
    universalStorage.setItem(DEMO_PERSONAL_TXS_KEY, JSON.stringify(txs));
  } catch (err) {
    console.warn('[DemoTransactions] Erro ao salvar transações:', err);
  }
}

function loadDemoPayments(): PersonalTransactionPayment[] {
  try {
    const raw = universalStorage.getItem(DEMO_TX_PAYMENTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDemoPayments(payments: PersonalTransactionPayment[]): void {
  try {
    universalStorage.setItem(DEMO_TX_PAYMENTS_KEY, JSON.stringify(payments));
  } catch (err) {
    console.warn('[DemoPayments] Erro ao salvar pagamentos:', err);
  }
}

export interface CreatePersonalTransactionInput {
  description: string;
  amountCents: CentsInteger;
  type: PersonalTransactionType;
  status?: PersonalTransactionStatus;
  categoryId: string;
  categoryName: string;
  accountId?: string;
  competenceDate: DateString;
  dueDate?: DateString;
  paymentDate?: DateString;
  notes?: string;
  originType?: PersonalTransactionOriginType;
  originRefId?: string;
  idempotencyKey?: string;
}

/**
 * Cria e registra uma nova receita ou despesa individual.
 * Se criada com status 'paid', gera imediatamente o movimento financeiro ou aloca na fatura.
 */
export async function createPersonalTransaction(
  userId: string,
  input: CreatePersonalTransactionInput,
  isDemo = false
): Promise<PersonalTransaction> {
  if (!validatePositiveCents(input.amountCents)) {
    throw new Error('O valor da transação deve ser um inteiro estritamente positivo em centavos.');
  }
  const cleanDescription = input.description?.trim();
  if (!cleanDescription) {
    throw new Error('A descrição da transação é obrigatória.');
  }

  const txId = `ptx_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const now = new Date().toISOString();
  const initialStatus = input.status || 'pending';
  const dueDate = input.dueDate || input.competenceDate;
  const idempotencyKey =
    input.idempotencyKey || `idem_ptx_${userId}_${txId}_${input.amountCents}`;

  let financialMovementId: string | undefined;
  let invoiceMonth: CompetenceMonthString | undefined;
  let paidAmountCents: CentsInteger = 0;
  let remainingAmountCents: CentsInteger = input.amountCents;

  // Se já for criada como paga/recebida, valida a conta e gera a repercussão contábil
  if (initialStatus === 'paid') {
    if (!input.accountId?.trim()) {
      throw new Error('Uma conta bancária, carteira ou cartão é obrigatório para transações pagas.');
    }

    const accounts = await getUserAccounts(userId, true, isDemo);
    const targetAccount = accounts.find((a) => a.id === input.accountId);
    if (!targetAccount) {
      throw new Error(`Conta "${input.accountId}" não encontrada.`);
    }

    if (targetAccount.isArchived) {
      throw new Error(`A conta "${targetAccount.name}" está arquivada e não recebe lançamentos.`);
    }

    // Se for despesa paga com Cartão de Crédito:
    if (input.type === 'expense' && targetAccount.type === 'credit') {
      const closingDay = targetAccount.closingDay || 20;
      invoiceMonth = calculateInvoiceMonth(input.competenceDate, closingDay);
      await attachPurchaseToInvoice(
        targetAccount,
        input.amountCents,
        input.competenceDate,
        userId,
        isDemo
      );
      // Compras no cartão não debitam conta corrente imediatamente
      paidAmountCents = input.amountCents;
      remainingAmountCents = 0;
    } else {
      // Entrada ou Saída em conta corrente / poupança / carteira
      const direction = input.type === 'income' ? 'inflow' : 'outflow';
      const originType = input.type === 'income' ? 'personal_income' : 'personal_expense';
      const effectiveDate = input.paymentDate || input.competenceDate;

      const mov = await recordMovement(
        {
          accountId: targetAccount.id,
          userId,
          direction,
          amountCents: input.amountCents,
          effectiveDate,
          originType,
          originId: txId,
          description: cleanDescription,
          notes: input.notes || `Lançamento individual (${input.categoryName})`,
          authorUid: userId,
          idempotencyKey: `mov_${idempotencyKey}`,
        },
        isDemo
      );
      financialMovementId = mov.id;
      paidAmountCents = input.amountCents;
      remainingAmountCents = 0;
    }
  }

  const transaction: PersonalTransaction = {
    id: txId,
    userId,
    description: cleanDescription,
    amountCents: input.amountCents,
    type: input.type,
    status: initialStatus,
    categoryId: input.categoryId,
    categoryName: input.categoryName,
    accountId: input.accountId,
    competenceDate: input.competenceDate,
    dueDate,
    paymentDate: initialStatus === 'paid' ? (input.paymentDate || input.competenceDate) : undefined,
    invoiceMonth,
    financialMovementId,
    originType: input.originType || 'manual',
    originRefId: input.originRefId,
    idempotencyKey,
    paidAmountCents,
    remainingAmountCents,
    notes: input.notes?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };

  if (isDemo) {
    const demo = loadDemoTransactions();
    demo.push(transaction);
    saveDemoTransactions(demo);
    return transaction;
  }

  const txRef = doc(db, 'users', userId, 'personal_transactions', txId);
  await setDoc(txRef, transaction);
  return transaction;
}

export interface PartialPaymentInput {
  amountCents: CentsInteger;
  paymentDate: DateString;
  accountId: string;
  notes?: string;
  authorUid: string;
}

export interface PartialPaymentResult {
  transaction: PersonalTransaction;
  paymentRecord: PersonalTransactionPayment;
  movement?: FinancialMovement;
}

/**
 * Registra um pagamento ou recebimento parcial (amortização) de uma despesa ou receita individual.
 */
export async function recordPartialPayment(
  txId: string,
  userId: string,
  input: PartialPaymentInput,
  isDemo = false
): Promise<PartialPaymentResult> {
  if (!validatePositiveCents(input.amountCents)) {
    throw new Error('O valor do pagamento parcial deve ser estritamente positivo em centavos.');
  }

  // 1. Carrega a transação original
  let tx: PersonalTransaction;
  if (isDemo) {
    const list = loadDemoTransactions();
    const found = list.find((t) => t.id === txId && t.userId === userId);
    if (!found) throw new Error(`Transação "${txId}" não encontrada.`);
    tx = { ...found };
  } else {
    const txRef = doc(db, 'users', userId, 'personal_transactions', txId);
    const snap = await getDoc(txRef);
    if (!snap.exists()) throw new Error(`Transação "${txId}" não encontrada.`);
    tx = snap.data() as PersonalTransaction;
  }

  if (tx.status === 'cancelled') {
    throw new Error('Não é permitido registrar pagamentos para uma transação cancelada.');
  }
  if (tx.status === 'paid' && (tx.remainingAmountCents ?? 0) <= 0) {
    throw new Error('Esta obrigação já está integralmente liquidada.');
  }

  const currentRemaining = tx.remainingAmountCents ?? tx.amountCents;
  if (input.amountCents > currentRemaining) {
    throw new Error(
      `O valor informado (${input.amountCents} centavos) ultrapassa o saldo devedor restante (${currentRemaining} centavos). Excedentes não são permitidos sem tratamento explícito.`
    );
  }

  // 2. Carrega conta para verificar arquivamento e tipo
  const accounts = await getUserAccounts(userId, true, isDemo);
  const targetAccount = accounts.find((a) => a.id === input.accountId);
  if (!targetAccount) {
    throw new Error(`Conta bancária "${input.accountId}" não encontrada.`);
  }
  if (targetAccount.isArchived) {
    throw new Error(`A conta "${targetAccount.name}" está arquivada e não recebe lançamentos.`);
  }

  const paymentId = `txpay_${txId}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  let movement: FinancialMovement | undefined;

  // 3. Efeito contábil:
  if (tx.type === 'expense' && targetAccount.type === 'credit') {
    // Se o pagamento parcial for alocado a cartão, adiciona à fatura
    const closingDay = targetAccount.closingDay || 20;
    const invMonth = calculateInvoiceMonth(input.paymentDate, closingDay);
    await attachPurchaseToInvoice(
      targetAccount,
      input.amountCents,
      input.paymentDate,
      userId,
      isDemo
    );
  } else {
    // Efetivação em conta corrente / carteira
    const direction = tx.type === 'income' ? 'inflow' : 'outflow';
    const originType = tx.type === 'income' ? 'personal_income' : 'personal_expense';
    const desc = `${tx.type === 'income' ? 'Recebimento parcial' : 'Pagamento parcial'}: ${tx.description}`;

    movement = await recordMovement(
      {
        accountId: targetAccount.id,
        userId,
        direction,
        amountCents: input.amountCents,
        effectiveDate: input.paymentDate,
        originType,
        originId: paymentId,
        description: desc,
        notes: input.notes || `Amortização de #${tx.id}`,
        authorUid: input.authorUid,
        idempotencyKey: `idem_${paymentId}`,
      },
      isDemo
    );
  }

  // 4. Cria evento de amortização
  const paymentRecord: PersonalTransactionPayment = {
    id: paymentId,
    transactionId: txId,
    userId,
    amountCents: input.amountCents,
    paymentDate: input.paymentDate,
    accountId: input.accountId,
    financialMovementId: movement ? movement.id : paymentId,
    authorUid: input.authorUid,
    notes: input.notes,
    createdAt: new Date().toISOString(),
  };

  // 5. Atualiza a transação principal
  const newPaidAmount = (tx.paidAmountCents || 0) + input.amountCents;
  const newRemaining = tx.amountCents - newPaidAmount;
  const newStatus: PersonalTransactionStatus = newRemaining === 0 ? 'paid' : 'partially_paid';

  const updatedTx: PersonalTransaction = {
    ...tx,
    paidAmountCents: newPaidAmount,
    remainingAmountCents: newRemaining,
    status: newStatus,
    paymentDate: newRemaining === 0 ? input.paymentDate : tx.paymentDate,
    accountId: tx.accountId || input.accountId,
    financialMovementId: tx.financialMovementId || movement?.id,
    updatedAt: new Date().toISOString(),
  };

  if (isDemo) {
    const txs = loadDemoTransactions();
    const idx = txs.findIndex((t) => t.id === txId && t.userId === userId);
    if (idx >= 0) txs[idx] = updatedTx;
    saveDemoTransactions(txs);

    const payments = loadDemoPayments();
    payments.push(paymentRecord);
    saveDemoPayments(payments);
  } else {
    const txRef = doc(db, 'users', userId, 'personal_transactions', txId);
    const payRef = doc(
      db,
      'users',
      userId,
      'personal_transactions',
      txId,
      'payments',
      paymentId
    );
    await setDoc(txRef, updatedTx, { merge: true });
    await setDoc(payRef, paymentRecord);
  }

  return {
    transaction: updatedTx,
    paymentRecord,
    movement,
  };
}

/**
 * Cancela uma transação individual.
 * Regra: Cancelamento não apaga pagamentos ou recebimentos já consolidados.
 * Se houver movimento financeiro já gerado para o valor total, estorna compensatoriamente no livro.
 */
export async function cancelPersonalTransaction(
  txId: string,
  userId: string,
  reason: string,
  isDemo = false
): Promise<PersonalTransaction> {
  const cleanReason = (reason || '').trim();
  if (!cleanReason) {
    throw new Error('Justificativa para cancelamento da transação é obrigatória.');
  }

  let tx: PersonalTransaction;
  if (isDemo) {
    const txs = loadDemoTransactions();
    const found = txs.find((t) => t.id === txId && t.userId === userId);
    if (!found) throw new Error(`Transação "${txId}" não encontrada.`);
    tx = { ...found };
  } else {
    const txRef = doc(db, 'users', userId, 'personal_transactions', txId);
    const snap = await getDoc(txRef);
    if (!snap.exists()) throw new Error(`Transação "${txId}" não encontrada.`);
    tx = snap.data() as PersonalTransaction;
  }

  if (tx.status === 'cancelled') {
    return tx;
  }

  // Se havia movimento contábil único associado ao pagamento total, executa o estorno compensatório
  if (tx.status === 'paid' && tx.financialMovementId && tx.accountId) {
    try {
      await reverseMovement(
        tx.accountId,
        tx.financialMovementId,
        userId,
        `Cancelamento de transação: ${cleanReason}`,
        isDemo,
        { idempotent: true }
      );
    } catch (err) {
      console.warn('[PersonalTransaction] Aviso ao estornar movimento de transação cancelada:', err);
    }
  }

  const updated: PersonalTransaction = {
    ...tx,
    status: 'cancelled',
    notes: `${tx.notes ? `${tx.notes} | ` : ''}Cancelada: ${cleanReason}`,
    updatedAt: new Date().toISOString(),
  };

  if (isDemo) {
    const txs = loadDemoTransactions();
    const idx = txs.findIndex((t) => t.id === txId && t.userId === userId);
    if (idx >= 0) txs[idx] = updated;
    saveDemoTransactions(txs);
    return updated;
  }

  const txRef = doc(db, 'users', userId, 'personal_transactions', txId);
  await updateDoc(txRef, {
    status: 'cancelled',
    notes: updated.notes,
    updatedAt: updated.updatedAt,
  });

  return updated;
}

export interface PersonalTransactionFilters {
  type?: PersonalTransactionType;
  status?: PersonalTransactionStatus;
  competenceMonth?: CompetenceMonthString; // YYYY-MM
  categoryId?: string;
  accountId?: string;
}

/**
 * Consulta transações individuais com suporte a filtros de competência, status e categoria.
 */
export async function getUserPersonalTransactions(
  userId: string,
  filters: PersonalTransactionFilters = {},
  isDemo = false
): Promise<PersonalTransaction[]> {
  if (!userId) return [];

  let list: PersonalTransaction[] = [];
  if (isDemo) {
    list = loadDemoTransactions().filter((t) => t.userId === userId);
  } else {
    const collRef = collection(db, 'users', userId, 'personal_transactions');
    const q = query(collRef);
    const snap = await getDocs(q);
    snap.forEach((d) => list.push({ ...(d.data() as PersonalTransaction), id: d.id }));
  }

  return list
    .filter((t) => {
      if (filters.type && t.type !== filters.type) return false;
      if (filters.status && t.status !== filters.status) return false;
      if (filters.categoryId && t.categoryId !== filters.categoryId) return false;
      if (filters.accountId && t.accountId !== filters.accountId) return false;
      if (filters.competenceMonth) {
        const txMonth = t.competenceDate?.slice(0, 7);
        if (txMonth !== filters.competenceMonth) return false;
      }
      return true;
    })
    .sort((a, b) => b.competenceDate.localeCompare(a.competenceDate));
}

/**
 * Consulta o histórico de pagamentos / amortizações parciais de uma transação.
 */
export async function getPersonalTransactionPayments(
  txId: string,
  userId: string,
  isDemo = false
): Promise<PersonalTransactionPayment[]> {
  if (isDemo) {
    const list = loadDemoPayments();
    return list
      .filter((p) => p.transactionId === txId && p.userId === userId)
      .sort((a, b) => b.paymentDate.localeCompare(a.paymentDate));
  }

  const snap = await getDocs(
    collection(db, 'users', userId, 'personal_transactions', txId, 'payments')
  );
  const list: PersonalTransactionPayment[] = [];
  snap.forEach((d) => list.push({ ...(d.data() as PersonalTransactionPayment), id: d.id }));
  return list.sort((a, b) => b.paymentDate.localeCompare(a.paymentDate));
}
