import {
  collection,
  doc,
  getDocs,
  query,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from './firebase';
import {
  Account,
  CentsInteger,
  CompetenceMonthString,
  DateString,
  FinancialMovement,
  PersonalTransaction,
  PersonalTransactionOriginType,
  PersonalTransactionPayment,
  PersonalTransactionPaymentReversal,
  PersonalTransactionPaymentView,
  PersonalTransactionStatus,
  PersonalTransactionType,
} from '../types/financeV3';
import { recordMovement, reverseMovement, withDemoLock } from './ledgerService';
import { getUserAccounts } from './accountService';
import {
  attachPurchaseToInvoiceDemoSync,
  calculateInvoiceMonth,
  loadDemoInvoices,
  saveDemoInvoices,
} from './creditCardService';
import { universalStorage } from '../utils/universalStorage';
import {
  generateMovementDocId,
  generatePaymentReversalDocId,
  generateReversalDocId,
  validatePositiveCents,
} from '../utils/movementLedger';

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
 * 4. Cancelamentos preservam a rastreabilidade contábil, não apagam histórico
 *    e estornam compensatoriamente TODAS as movimentações associadas (incluindo amortizações parciais).
 */

const DEMO_PERSONAL_TXS_KEY = 'mpf_v3_demo_personal_transactions';
const DEMO_TX_PAYMENTS_KEY = 'mpf_v3_demo_transaction_payments';

export function loadDemoTransactions(): PersonalTransaction[] {
  try {
    const raw = universalStorage.getItem(DEMO_PERSONAL_TXS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveDemoTransactions(txs: PersonalTransaction[]): void {
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

const DEMO_TX_PAYMENT_REVERSALS_KEY = 'mpf_v3_demo_transaction_payment_reversals';

export function loadDemoPaymentReversals(): PersonalTransactionPaymentReversal[] {
  try {
    const raw = universalStorage.getItem(DEMO_TX_PAYMENT_REVERSALS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveDemoPaymentReversals(reversals: PersonalTransactionPaymentReversal[]): void {
  try {
    universalStorage.setItem(DEMO_TX_PAYMENT_REVERSALS_KEY, JSON.stringify(reversals));
  } catch (err) {
    console.warn('[DemoPaymentReversals] Erro ao salvar estornos:', err);
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

  if (!isDemo) {
    const callable = httpsCallable<
      CreatePersonalTransactionInput & { idempotencyKey: string },
      { transaction: PersonalTransaction; movement?: FinancialMovement }
    >(functions, 'createPersonalTransactionOfficial');

    const idempotencyKey =
      input.idempotencyKey?.trim() ||
      `idem_ptx_${userId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const res = await callable({
      ...input,
      idempotencyKey,
    });
    return res.data.transaction;
  }

  return withDemoLock(async () => {
    const idempotencyKey =
      input.idempotencyKey?.trim() ||
      `idem_ptx_${userId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const txId = input.idempotencyKey?.trim()
      ? `ptx_${generateMovementDocId(userId, idempotencyKey)}`
      : `ptx_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const demo = loadDemoTransactions();
    const existing = demo.find(
      (t) =>
        t.userId === userId &&
        (t.id === txId || (input.idempotencyKey && t.idempotencyKey === idempotencyKey))
    );
    if (existing) {
      if (
        existing.amountCents !== input.amountCents ||
        existing.type !== input.type ||
        existing.description !== cleanDescription
      ) {
        throw new Error(
          `Conflito de idempotência: a chave "${idempotencyKey}" já foi utilizada para outra transação.`
        );
      }
      return existing;
    }

    const now = new Date().toISOString();
    const initialStatus = input.status || 'pending';
    const dueDate = input.dueDate || input.competenceDate;

    let financialMovementId: string | undefined;
    let invoiceMonth: CompetenceMonthString | undefined;
    let paidAmountCents: CentsInteger = 0;
    let remainingAmountCents: CentsInteger = input.amountCents;
    let targetAccount: Account | undefined = undefined;

    if (initialStatus === 'paid') {
      if (!input.accountId?.trim()) {
        throw new Error('Uma conta bancária, carteira ou cartão é obrigatório para transações pagas.');
      }

      const accounts = await getUserAccounts(userId, true, true);
      targetAccount = accounts.find((a) => a.id === input.accountId);
      if (!targetAccount) {
        throw new Error(`Conta "${input.accountId}" não encontrada.`);
      }

      if (targetAccount.isArchived) {
        throw new Error(`A conta "${targetAccount.name}" está arquivada e não recebe lançamentos.`);
      }

      if (input.type === 'income' && targetAccount.type === 'credit') {
        throw new Error('Não é permitido receber receitas diretamente em conta de cartão de crédito.');
      }

      if (input.type === 'expense' && targetAccount.type === 'credit') {
        const closingDay = targetAccount.closingDay || 20;
        invoiceMonth = calculateInvoiceMonth(input.competenceDate, closingDay);
        attachPurchaseToInvoiceDemoSync(
          targetAccount,
          input.amountCents,
          input.competenceDate,
          userId
        );
        paidAmountCents = input.amountCents;
        remainingAmountCents = 0;
      } else {
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
          true
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

    if (initialStatus === 'paid' && financialMovementId && targetAccount && targetAccount.type !== 'credit') {
      const currentPayments = loadDemoPayments();
      currentPayments.push({
        id: `txpay_init_${txId}`,
        transactionId: txId,
        userId,
        amountCents: input.amountCents,
        paymentDate: input.paymentDate || input.competenceDate,
        accountId: targetAccount.id,
        financialMovementId,
        authorUid: userId,
        idempotencyKey,
        notes: 'Pagamento integral inicial',
        createdAt: now,
      });
      saveDemoPayments(currentPayments);
    }

    const currentTxs = loadDemoTransactions();
    currentTxs.push(transaction);
    saveDemoTransactions(currentTxs);
    return transaction;
  });
}

export interface PartialPaymentInput {
  amountCents: CentsInteger;
  paymentDate: DateString;
  accountId: string;
  notes?: string;
  authorUid: string;
  idempotencyKey?: string;
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

  if (!isDemo) {
    const callable = httpsCallable<
      {
        txId: string;
        amountCents: number;
        paymentDate: string;
        accountId: string;
        notes?: string;
        idempotencyKey: string;
      },
      PartialPaymentResult
    >(functions, 'recordPersonalTransactionPaymentOfficial');

    const idempotencyKey =
      input.idempotencyKey?.trim() ||
      `idem_txpay_${txId}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    const res = await callable({
      txId,
      amountCents: input.amountCents,
      paymentDate: input.paymentDate,
      accountId: input.accountId,
      notes: input.notes,
      idempotencyKey,
    });
    return res.data;
  }

  return withDemoLock(async () => {
    const idempotencyKey =
      input.idempotencyKey?.trim() ||
      `idem_txpay_${txId}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const paymentId = input.idempotencyKey?.trim()
      ? `txpay_${generateMovementDocId(txId, idempotencyKey)}`
      : `txpay_${txId}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    const payments = loadDemoPayments();
    const existingPay = payments.find(
      (p) =>
        p.transactionId === txId &&
        p.userId === userId &&
        (p.id === paymentId || (input.idempotencyKey && p.idempotencyKey === idempotencyKey))
    );
    if (existingPay) {
      if (
        existingPay.amountCents !== input.amountCents ||
        existingPay.accountId !== input.accountId
      ) {
        throw new Error(
          `Conflito de idempotência: chave "${idempotencyKey}" já utilizada com parâmetros divergentes.`
        );
      }
      const list = loadDemoTransactions();
      const foundTx = list.find((t) => t.id === txId && t.userId === userId)!;
      return {
        transaction: foundTx,
        paymentRecord: existingPay,
      };
    }

    // 1. Carrega a transação original
    const list = loadDemoTransactions();
    const found = list.find((t) => t.id === txId && t.userId === userId);
    if (!found) throw new Error(`Transação "${txId}" não encontrada.`);
    const tx = { ...found };

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
    const accounts = await getUserAccounts(userId, true, true);
    const targetAccount = accounts.find((a) => a.id === input.accountId);
    if (!targetAccount) {
      throw new Error(`Conta bancária "${input.accountId}" não encontrada.`);
    }
    if (targetAccount.isArchived) {
      throw new Error(`A conta "${targetAccount.name}" está arquivada e não recebe lançamentos.`);
    }
    if (tx.type === 'income' && targetAccount.type === 'credit') {
      throw new Error('Não é permitido receber receitas em cartão de crédito.');
    }

    let movement: FinancialMovement | undefined;

    // 3. Efeito contábil:
    if (tx.type === 'expense' && targetAccount.type === 'credit') {
      attachPurchaseToInvoiceDemoSync(
        targetAccount,
        input.amountCents,
        input.paymentDate,
        userId
      );
    } else {
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
          idempotencyKey: `mov_${idempotencyKey}`,
        },
        true
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
      idempotencyKey,
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

    const txs = loadDemoTransactions();
    const idx = txs.findIndex((t) => t.id === txId && t.userId === userId);
    if (idx >= 0) txs[idx] = updatedTx;
    saveDemoTransactions(txs);

    const currentPayments = loadDemoPayments();
    currentPayments.push(paymentRecord);
    saveDemoPayments(currentPayments);

    return {
      transaction: updatedTx,
      paymentRecord,
      movement,
    };
  });
}

/**
 * Cancela uma transação individual.
 * Regra: Cancelamento não apaga pagamentos ou recebimentos já consolidados.
 * Estorna compensatoriamente TODAS as movimentações financeiras geradas (à vista ou parciais)
 * e, em caso de compras de cartão de crédito, abate da fatura correspondente.
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

  if (!isDemo) {
    const callable = httpsCallable<
      { txId: string; reason: string },
      { transaction: PersonalTransaction; reversedMovementIds: string[] }
    >(functions, 'cancelPersonalTransactionOfficial');

    const res = await callable({ txId, reason: cleanReason });
    return res.data.transaction;
  }

  return withDemoLock(async () => {
    const txs = loadDemoTransactions();
    const found = txs.find((t) => t.id === txId && t.userId === userId);
    if (!found) throw new Error(`Transação "${txId}" não encontrada.`);
    const tx = { ...found };

    if (tx.status === 'cancelled') {
      return tx;
    }

    // Coleta todas as movimentações financeiras associadas (pagamento único + pagamentos parciais)
    const movementsToReverse: Array<{ accountId: string; movementId: string }> = [];
    if (
      tx.financialMovementId &&
      tx.accountId &&
      !tx.financialMovementId.startsWith('txpay_')
    ) {
      movementsToReverse.push({
        accountId: tx.accountId,
        movementId: tx.financialMovementId,
      });
    }

    const payments = loadDemoPayments().filter(
      (p) => p.transactionId === txId && p.userId === userId
    );
    for (const p of payments) {
      if (
        p.financialMovementId &&
        p.accountId &&
        !p.financialMovementId.startsWith('txpay_')
      ) {
        if (!movementsToReverse.some((m) => m.movementId === p.financialMovementId)) {
          movementsToReverse.push({
            accountId: p.accountId,
            movementId: p.financialMovementId,
          });
        }
      }
    }

    for (const item of movementsToReverse) {
      await reverseMovement(
        item.accountId,
        item.movementId,
        userId,
        `Cancelamento de transação: ${cleanReason}`,
        true,
        { idempotent: true }
      );
    }

    const paymentsToReverse = loadDemoPayments().filter(
      (p) => p.transactionId === txId && p.userId === userId
    );
    const existingReversals = loadDemoPaymentReversals();
    const existingReversedPaymentIds = new Set(existingReversals.map((r) => r.paymentId));
    let newReversalsCount = 0;
    const nowIso = new Date().toISOString();

    for (const p of paymentsToReverse) {
      if (!existingReversedPaymentIds.has(p.id)) {
        const revId = generatePaymentReversalDocId(p.id);
        const revMovId = p.financialMovementId ? generateReversalDocId(p.financialMovementId) : '';
        const reversalEvent: PersonalTransactionPaymentReversal = {
          id: revId,
          transactionId: p.transactionId,
          paymentId: p.id,
          userId: p.userId,
          amountCents: p.amountCents,
          originalFinancialMovementId: p.financialMovementId || '',
          reversalMovementId: revMovId,
          reversalDate: nowIso.split('T')[0] as DateString,
          reversedAt: nowIso,
          authorUid: userId,
          reason: `Cancelamento de transação: ${cleanReason}`,
          idempotencyKey: `cancel_payrev_${p.id}`,
          createdAt: nowIso,
        };
        existingReversals.push(reversalEvent);
        existingReversedPaymentIds.add(p.id);
        newReversalsCount++;
      }
    }
    if (newReversalsCount > 0) {
      saveDemoPaymentReversals(existingReversals);
    }

    // Se houve compra no cartão de crédito vinculada à fatura, reduz o saldo de compras da fatura
    if (tx.type === 'expense' && tx.invoiceMonth && tx.accountId && (tx.paidAmountCents || 0) > 0) {
      const invoices = loadDemoInvoices();
      const invIdx = invoices.findIndex(
        (inv) => inv.accountId === tx.accountId && inv.invoiceMonth === tx.invoiceMonth
      );
      if (invIdx >= 0) {
        const inv = invoices[invIdx];
        const newPurchases = Math.max(0, inv.totalPurchasesAmountCents - (tx.paidAmountCents || 0));
        const newTotalDue = newPurchases + inv.carriedOverBalanceCents + inv.interestAndFeesCents;
        const newRemaining = Math.max(0, newTotalDue - inv.totalPaidAmountCents);
        invoices[invIdx] = {
          ...inv,
          totalPurchasesAmountCents: newPurchases,
          totalDueAmountCents: newTotalDue,
          remainingBalanceCents: newRemaining,
          updatedAt: new Date().toISOString(),
        };
        saveDemoInvoices(invoices);
      }
    }

    const updated: PersonalTransaction = {
      ...tx,
      status: 'cancelled',
      remainingAmountCents: 0,
      notes: `${tx.notes ? `${tx.notes} | ` : ''}Cancelada: ${cleanReason}`,
      updatedAt: new Date().toISOString(),
    };

    const currentTxs = loadDemoTransactions();
    const idx = currentTxs.findIndex((t) => t.id === txId && t.userId === userId);
    if (idx >= 0) currentTxs[idx] = updated;
    saveDemoTransactions(currentTxs);
    return updated;
  });
}

export interface UpdatePersonalTransactionInput {
  description?: string;
  categoryId?: string;
  categoryName?: string;
  competenceDate?: DateString;
  dueDate?: DateString;
  notes?: string;
  amountCents?: CentsInteger;
}

/**
 * Edita metadados de uma transação pessoal com segurança contábil.
 * Permite alterar valor apenas quando paidAmountCents === 0 e status não pago.
 */
export async function updatePersonalTransaction(
  userId: string,
  txId: string,
  patch: UpdatePersonalTransactionInput,
  isDemo = false
): Promise<PersonalTransaction> {
  if (!userId || !txId) {
    throw new Error('userId e txId são obrigatórios para edição.');
  }

  if (!isDemo) {
    const callable = httpsCallable<
      { userId: string; txId: string; patch: UpdatePersonalTransactionInput },
      { transaction: PersonalTransaction }
    >(functions, 'updatePersonalTransactionOfficial');

    const res = await callable({ userId, txId, patch });
    return res.data.transaction;
  }

  return withDemoLock(async () => {
    const txs = loadDemoTransactions();
    const idx = txs.findIndex((t) => t.id === txId && t.userId === userId);
    if (idx < 0) throw new Error(`Transação "${txId}" não encontrada.`);

    const tx = { ...txs[idx] };
    if (tx.status === 'cancelled') {
      throw new Error('Não é permitido editar uma transação cancelada.');
    }

    if (patch.description !== undefined) {
      const cleanDesc = patch.description.trim();
      if (!cleanDesc) {
        throw new Error('A descrição do lançamento não pode ficar vazia.');
      }
      tx.description = cleanDesc;
    }
    if (patch.categoryId !== undefined) tx.categoryId = patch.categoryId || 'uncategorized';
    if (patch.categoryName !== undefined) tx.categoryName = patch.categoryName || 'Geral';
    if (patch.competenceDate !== undefined) tx.competenceDate = patch.competenceDate;
    if (patch.dueDate !== undefined) tx.dueDate = patch.dueDate;
    if (patch.notes !== undefined) tx.notes = patch.notes.trim() || undefined;

    if (patch.amountCents !== undefined && patch.amountCents !== tx.amountCents) {
      if (!validatePositiveCents(patch.amountCents)) {
        throw new Error('O valor deve ser estritamente positivo em centavos.');
      }
      if ((tx.paidAmountCents || 0) > 0 || tx.status === 'paid' || tx.status === 'partially_paid') {
        throw new Error(
          'Não é permitido alterar o valor de um lançamento que já possui pagamentos/amortizações. Estorne o pagamento antes.'
        );
      }
      tx.amountCents = patch.amountCents;
      tx.remainingAmountCents = patch.amountCents;
    }

    tx.updatedAt = new Date().toISOString();
    txs[idx] = tx;
    saveDemoTransactions(txs);
    return tx;
  });
}

export interface ReversePersonalTransactionPaymentInput {
  paymentId?: string;
  reason: string;
}

export interface ReversePersonalTransactionPaymentResult {
  transaction: PersonalTransaction;
  reversal?: PersonalTransactionPaymentReversal;
  isIdempotentReplay?: boolean;
}

/**
 * Estorna compensatoriamente um pagamento ou amortização de transação individual,
 * sem apagar registros históricos originais, restaurando o saldo a pagar.
 */
export async function reversePersonalTransactionPayment(
  txId: string,
  userId: string,
  input: ReversePersonalTransactionPaymentInput,
  isDemo = false
): Promise<ReversePersonalTransactionPaymentResult> {
  const cleanReason = (input.reason || '').trim();
  if (!cleanReason) {
    throw new Error('Justificativa obrigatória para estornar o pagamento.');
  }

  if (!isDemo) {
    const callable = httpsCallable<
      { userId: string; txId: string; paymentId?: string; reason: string },
      ReversePersonalTransactionPaymentResult
    >(functions, 'reversePersonalTransactionPaymentOfficial');

    const res = await callable({
      userId,
      txId,
      paymentId: input.paymentId,
      reason: cleanReason,
    });
    return res.data;
  }

  return withDemoLock(async () => {
    const txs = loadDemoTransactions();
    const txIdx = txs.findIndex((t) => t.id === txId && t.userId === userId);
    if (txIdx < 0) throw new Error(`Transação "${txId}" não encontrada.`);

    const tx = { ...txs[txIdx] };
    if (tx.status === 'cancelled') {
      throw new Error('Transação cancelada não pode ter pagamentos estornados.');
    }

    const payments = loadDemoPayments().filter((p) => p.transactionId === txId && p.userId === userId);
    const reversals = loadDemoPaymentReversals();
    const reversedIds = new Set(reversals.filter((r) => r.transactionId === txId).map((r) => r.paymentId));

    const activePayments = payments
      .filter((p) => !reversedIds.has(p.id))
      .sort((a, b) => (b.createdAt || b.paymentDate).localeCompare(a.createdAt || a.paymentDate));

    let targetPayment: PersonalTransactionPayment | undefined;
    if (input.paymentId) {
      targetPayment = activePayments.find((p) => p.id === input.paymentId);
      if (!targetPayment && reversedIds.has(input.paymentId)) {
        return { transaction: tx, isIdempotentReplay: true };
      }
    } else if (activePayments.length > 0) {
      targetPayment = activePayments[0];
    } else if ((tx.paidAmountCents || 0) > 0 && tx.accountId) {
      targetPayment = {
        id: `legacy_pay_${txId}`,
        transactionId: txId,
        userId,
        amountCents: tx.paidAmountCents || tx.amountCents,
        paymentDate: tx.paymentDate || tx.competenceDate,
        accountId: tx.accountId,
        financialMovementId: tx.financialMovementId || '',
        authorUid: userId,
        createdAt: tx.createdAt,
      };
    }

    if (!targetPayment) {
      throw new Error('Nenhum pagamento ativo disponível para estorno nesta transação.');
    }

    const revDocId = generatePaymentReversalDocId(targetPayment.id);
    const existingRev = reversals.find((r) => r.id === revDocId);
    if (existingRev) {
      return { transaction: tx, reversal: existingRev, isIdempotentReplay: true };
    }

    let reversalMovementId = '';
    const targetAccId = targetPayment.accountId || tx.accountId;
    if (targetPayment.financialMovementId && targetAccId && !targetPayment.financialMovementId.startsWith('txpay_')) {
      const compMov = await reverseMovement(
        targetAccId,
        targetPayment.financialMovementId,
        userId,
        `Estorno de pagamento: ${cleanReason}`,
        true,
        { idempotent: true }
      );
      reversalMovementId = compMov.compensatoryMovement.id;
    } else if (tx.type === 'expense' && tx.invoiceMonth && targetAccId) {
      const invoices = loadDemoInvoices();
      const invIdx = invoices.findIndex(
        (inv) => inv.accountId === targetAccId && inv.invoiceMonth === tx.invoiceMonth
      );
      if (invIdx >= 0) {
        const inv = invoices[invIdx];
        const newPurchases = Math.max(0, inv.totalPurchasesAmountCents - targetPayment.amountCents);
        const newTotalDue = newPurchases + inv.carriedOverBalanceCents + inv.interestAndFeesCents;
        const newRemaining = Math.max(0, newTotalDue - inv.totalPaidAmountCents);
        invoices[invIdx] = {
          ...inv,
          totalPurchasesAmountCents: newPurchases,
          totalDueAmountCents: newTotalDue,
          remainingBalanceCents: newRemaining,
          updatedAt: new Date().toISOString(),
        };
        saveDemoInvoices(invoices);
      }
    }

    const nowIso = new Date().toISOString();
    const todayStr = nowIso.split('T')[0] as DateString;
    const reversalRecord: PersonalTransactionPaymentReversal = {
      id: revDocId,
      transactionId: txId,
      paymentId: targetPayment.id,
      userId,
      amountCents: targetPayment.amountCents,
      originalFinancialMovementId: targetPayment.financialMovementId || '',
      reversalMovementId,
      reversalDate: todayStr,
      reversedAt: nowIso,
      authorUid: userId,
      reason: cleanReason,
      idempotencyKey: `manual_payrev_${targetPayment.id}`,
      createdAt: nowIso,
    };
    reversals.push(reversalRecord);
    saveDemoPaymentReversals(reversals);

    const newPaidAmount = Math.max(0, (tx.paidAmountCents || 0) - targetPayment.amountCents);
    const newRemaining = Math.max(0, tx.amountCents - newPaidAmount);
    const nextStatus: PersonalTransactionStatus =
      newPaidAmount > 0 ? 'partially_paid' : tx.dueDate && tx.dueDate < todayStr ? 'overdue' : 'pending';

    const noteLine = `Estorno (${todayStr}): ${cleanReason}`;
    const updatedTx: PersonalTransaction = {
      ...tx,
      paidAmountCents: newPaidAmount,
      remainingAmountCents: newRemaining,
      status: nextStatus,
      paymentDate: newPaidAmount === 0 ? undefined : tx.paymentDate,
      notes: tx.notes ? `${tx.notes} | ${noteLine}` : noteLine,
      updatedAt: nowIso,
    };

    txs[txIdx] = updatedTx;
    saveDemoTransactions(txs);

    return {
      transaction: updatedTx,
      reversal: reversalRecord,
      isIdempotentReplay: false,
    };
  });
}

export interface PersonalTransactionFilters {
  type?: PersonalTransactionType;
  status?: PersonalTransactionStatus;
  competenceMonth?: CompetenceMonthString; // YYYY-MM
  categoryId?: string;
  accountId?: string;
}

/**
 * Normaliza documentos de transação individual (incluindo registros antigos ou incompletos)
 * sem alterar os valores originais armazenados.
 */
export function normalizePersonalTransaction(
  raw: Partial<PersonalTransaction> & Record<string, any>,
  docId?: string
): PersonalTransaction {
  const rawCreatedAt = raw.createdAt as unknown;
  const createdAtStr =
    typeof rawCreatedAt === 'string'
      ? rawCreatedAt
      : rawCreatedAt && typeof (rawCreatedAt as { toDate?: () => Date }).toDate === 'function'
      ? (rawCreatedAt as { toDate: () => Date }).toDate().toISOString()
      : '';
  const fallbackDate =
    raw.competenceDate ||
    raw.dueDate ||
    raw.paymentDate ||
    (createdAtStr ? createdAtStr.slice(0, 10) : '');
  const safeAmountCents = Number.isFinite(Number(raw.amountCents))
    ? Math.round(Number(raw.amountCents))
    : Math.round(Number(raw.amount ?? 0) * 100);

  return {
    ...(raw as PersonalTransaction),
    id: raw.id || docId || '',
    userId: raw.userId || '',
    description: typeof raw.description === 'string' && raw.description.trim() ? raw.description : 'Lançamento sem descrição',
    amountCents: Number.isSafeInteger(safeAmountCents) ? safeAmountCents : 0,
    type: raw.type === 'income' ? 'income' : 'expense',
    status: raw.status || 'pending',
    categoryId: raw.categoryId || 'cat_default',
    categoryName: raw.categoryName || 'Geral',
    competenceDate: fallbackDate,
    dueDate: raw.dueDate || fallbackDate,
    originType: raw.originType || 'manual',
    createdAt: createdAtStr || new Date().toISOString(),
    updatedAt:
      typeof raw.updatedAt === 'string'
        ? raw.updatedAt
        : createdAtStr || new Date().toISOString(),
  };
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

  const deduped = new Map<string, PersonalTransaction>();
  if (isDemo) {
    for (const raw of loadDemoTransactions()) {
      if (raw.userId !== userId) continue;
      const norm = normalizePersonalTransaction(raw, raw.id);
      if (norm.id) deduped.set(norm.id, norm);
    }
  } else {
    const collRef = collection(db, 'users', userId, 'personal_transactions');
    const q = query(collRef);
    const snap = await getDocs(q);
    snap.forEach((d) => {
      const norm = normalizePersonalTransaction(d.data() as Partial<PersonalTransaction>, d.id);
      if (norm.id) deduped.set(norm.id, norm);
    });
  }

  return Array.from(deduped.values())
    .filter((t) => {
      if (filters.type && t.type !== filters.type) return false;
      if (filters.status && t.status !== filters.status) return false;
      if (filters.categoryId && t.categoryId !== filters.categoryId) return false;
      if (filters.accountId && t.accountId !== filters.accountId) return false;
      if (filters.competenceMonth) {
        const txMonth = (t.competenceDate || t.dueDate || '').slice(0, 7);
        if (txMonth !== filters.competenceMonth) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const dateCmp = (b.competenceDate || '').localeCompare(a.competenceDate || '');
      if (dateCmp !== 0) return dateCmp;
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });
}

/**
 * Consulta o histórico de eventos de estorno / reversão de pagamentos de uma transação.
 */
export async function getPersonalTransactionPaymentReversals(
  txId: string,
  userId: string,
  isDemo = false
): Promise<PersonalTransactionPaymentReversal[]> {
  if (isDemo) {
    const list = loadDemoPaymentReversals();
    return list
      .filter((r) => r.transactionId === txId && r.userId === userId)
      .sort((a, b) => b.reversedAt.localeCompare(a.reversedAt));
  }

  const snap = await getDocs(
    collection(db, 'users', userId, 'personal_transactions', txId, 'payment_reversals')
  );
  const list: PersonalTransactionPaymentReversal[] = [];
  snap.forEach((d) => list.push({ ...(d.data() as PersonalTransactionPaymentReversal), id: d.id }));
  return list.sort((a, b) => b.reversedAt.localeCompare(a.reversedAt));
}

/**
 * Consulta o histórico de pagamentos / amortizações parciais de uma transação.
 * Preserva o princípio contábil de imutabilidade estrita:
 * Os documentos de pagamento nunca são mutados no armazenamento.
 * O estado de estorno (isReversed e reversal) é derivado dinamicamente a partir da subcoleção payment_reversals.
 */
export async function getPersonalTransactionPayments(
  txId: string,
  userId: string,
  isDemo = false
): Promise<PersonalTransactionPaymentView[]> {
  if (isDemo) {
    const rawPayments = loadDemoPayments().filter(
      (p) => p.transactionId === txId && p.userId === userId
    );
    const reversals = loadDemoPaymentReversals().filter(
      (r) => r.transactionId === txId && r.userId === userId
    );
    const revMap = new Map<string, PersonalTransactionPaymentReversal>();
    for (const r of reversals) {
      revMap.set(r.paymentId, r);
    }
    return rawPayments
      .map((p) => {
        const rev = revMap.get(p.id);
        return {
          ...p,
          isReversed: Boolean(rev),
          reversal: rev,
          reversalMovementId: rev?.reversalMovementId,
          reversalDate: rev?.reversalDate,
          reversedAt: rev?.reversedAt,
          reversalReason: rev?.reason,
        };
      })
      .sort((a, b) => b.paymentDate.localeCompare(a.paymentDate));
  }

  const [paySnap, revSnap] = await Promise.all([
    getDocs(collection(db, 'users', userId, 'personal_transactions', txId, 'payments')),
    getDocs(collection(db, 'users', userId, 'personal_transactions', txId, 'payment_reversals')),
  ]);

  const revMap = new Map<string, PersonalTransactionPaymentReversal>();
  revSnap.forEach((d) => {
    const rev = { ...(d.data() as PersonalTransactionPaymentReversal), id: d.id };
    revMap.set(rev.paymentId, rev);
  });

  const list: PersonalTransactionPaymentView[] = [];
  paySnap.forEach((d) => {
    const p = { ...(d.data() as PersonalTransactionPayment), id: d.id };
    const rev = revMap.get(p.id);
    list.push({
      ...p,
      isReversed: Boolean(rev),
      reversal: rev,
      reversalMovementId: rev?.reversalMovementId,
      reversalDate: rev?.reversalDate,
      reversedAt: rev?.reversedAt,
      reversalReason: rev?.reason,
    });
  });

  return list.sort((a, b) => b.paymentDate.localeCompare(a.paymentDate));
}

/**
 * Calcula o total efetivamente pago a partir dos registros de pagamento não revertidos.
 * Aceita visões derivadas ou pagamentos com lista opcional de eventos de reversão.
 */
export function calculateActivePaidAmountCents(
  payments: (PersonalTransactionPayment | PersonalTransactionPaymentView)[],
  reversals?: PersonalTransactionPaymentReversal[]
): CentsInteger {
  const reversedPaymentIds = new Set<string>();
  if (reversals) {
    for (const r of reversals) {
      reversedPaymentIds.add(r.paymentId);
    }
  }

  return payments
    .filter((p) => {
      if ('isReversed' in p && (p as PersonalTransactionPaymentView).isReversed) {
        return false;
      }
      if (reversedPaymentIds.has(p.id)) {
        return false;
      }
      return true;
    })
    .reduce((sum, p) => sum + p.amountCents, 0);
}
