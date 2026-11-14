import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from './firebase';
import {
  Account,
  CentsInteger,
  CompetenceMonthString,
  CreditCardInvoice,
  CreditCardInvoiceCharge,
  CreditCardInvoiceStatus,
  DateString,
  FinancialMovement,
  InstallmentContract,
  InstallmentOccurrence,
  InvoiceCarryOver,
  InvoicePayment,
  PersonalTransaction,
} from '../types/financeV3';
import { recordMovement, withDemoLock } from './ledgerService';
import { getUserAccounts } from './accountService';
import { universalStorage } from '../utils/universalStorage';
import { generateMovementDocId, validatePositiveCents } from '../utils/movementLedger';

/**
 * ==============================================================================
 * SERVIÇO DE CARTÕES DE CRÉDITO E FATURAS (v3.1)
 * ==============================================================================
 * Caminho Canônico: accounts/{cardAccountId}/invoices/{invoiceMonth}
 *
 * Princípios Fundamentais:
 * 1. Compras no cartão são despesas individuais contabilizadas na competência.
 * 2. O pagamento de fatura é uma transferência de amortização (débito em conta corrente),
 *    NUNCA gerando uma segunda despesa para evitar dupla contagem.
 * 3. Faturas suportam pagamentos parciais com rastreabilidade exata do saldo restante.
 * 4. Saldos residuais podem ser transportados (carry-over/rotativo) para a próxima competência
 *    com separação clara de principal, juros e encargos, zerando o saldo aberto da fatura de origem
 *    para impedir dupla contagem no limite disponível.
 */

const DEMO_INVOICES_KEY = 'mpf_v3_demo_card_invoices';
const DEMO_INVOICE_PAYMENTS_KEY = 'mpf_v3_demo_invoice_payments';
const DEMO_INVOICE_CARRY_OVERS_KEY = 'mpf_v3_demo_invoice_carry_overs';
const DEMO_CARD_CHARGES_KEY = 'mpf_v3_demo_card_charges';

export function loadDemoCardCharges(): CreditCardInvoiceCharge[] {
  try {
    const raw = universalStorage.getItem(DEMO_CARD_CHARGES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveDemoCardCharges(charges: CreditCardInvoiceCharge[]): void {
  try {
    universalStorage.setItem(DEMO_CARD_CHARGES_KEY, JSON.stringify(charges));
  } catch (err) {
    console.warn('[DemoCardCharges] Erro ao salvar compras de cartão:', err);
  }
}

export function cancelDemoCardChargeByTransactionId(
  cardAccountId: string,
  transactionId: string
): void {
  if (!cardAccountId || !transactionId) return;
  const charges = loadDemoCardCharges();
  let modified = false;
  const now = new Date().toISOString();
  const updated = charges.map((c) => {
    if (
      c.accountId === cardAccountId &&
      (c.transactionId === transactionId || c.id === transactionId) &&
      c.status !== 'cancelled'
    ) {
      modified = true;
      return { ...c, status: 'cancelled' as const, updatedAt: now };
    }
    return c;
  });
  if (modified) saveDemoCardCharges(updated);
}

export function cancelDemoCardChargeById(
  cardAccountId: string,
  chargeId: string
): void {
  if (!cardAccountId || !chargeId) return;
  const charges = loadDemoCardCharges();
  let modified = false;
  const now = new Date().toISOString();
  const updated = charges.map((c) => {
    if (c.accountId === cardAccountId && c.id === chargeId && c.status !== 'cancelled') {
      modified = true;
      return { ...c, status: 'cancelled' as const, updatedAt: now };
    }
    return c;
  });
  if (modified) saveDemoCardCharges(updated);
}

export function loadDemoInvoices(): CreditCardInvoice[] {
  try {
    const raw = universalStorage.getItem(DEMO_INVOICES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveDemoInvoices(invoices: CreditCardInvoice[]): void {
  try {
    universalStorage.setItem(DEMO_INVOICES_KEY, JSON.stringify(invoices));
  } catch (err) {
    console.warn('[DemoInvoices] Erro ao salvar faturas:', err);
  }
}

function loadDemoInvoicePayments(): InvoicePayment[] {
  try {
    const raw = universalStorage.getItem(DEMO_INVOICE_PAYMENTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDemoInvoicePayments(payments: InvoicePayment[]): void {
  try {
    universalStorage.setItem(DEMO_INVOICE_PAYMENTS_KEY, JSON.stringify(payments));
  } catch (err) {
    console.warn('[DemoInvoicePayments] Erro ao salvar pagamentos:', err);
  }
}

function loadDemoCarryOvers(): InvoiceCarryOver[] {
  try {
    const raw = universalStorage.getItem(DEMO_INVOICE_CARRY_OVERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDemoCarryOvers(carryOvers: InvoiceCarryOver[]): void {
  try {
    universalStorage.setItem(DEMO_INVOICE_CARRY_OVERS_KEY, JSON.stringify(carryOvers));
  } catch (err) {
    console.warn('[DemoCarryOvers] Erro ao salvar carry overs:', err);
  }
}

/**
 * Calcula a competência da fatura (YYYY-MM) de uma compra com base na data da compra e no dia de fechamento do cartão.
 * Ex: Se fechamento = 20:
 * Compra em 2026-11-15 -> Fatura 2026-11
 * Compra em 2026-11-21 -> Fatura 2026-12 (próxima fatura)
 */
export function calculateInvoiceMonth(purchaseDate: DateString, closingDay: number): CompetenceMonthString {
  const [yearStr, monthStr, dayStr] = purchaseDate.split('-');
  let year = parseInt(yearStr, 10);
  let month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);

  if (day > closingDay) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return `${year}-${month.toString().padStart(2, '0')}`;
}

function buildEmptyCardInvoice(
  cardAccount: Account,
  invoiceMonth: CompetenceMonthString,
  userId: string
): CreditCardInvoice {
  const [yearStr, monthStr] = invoiceMonth.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);

  const closingDay = cardAccount.closingDay || 20;
  const dueDay = cardAccount.dueDay || 28;

  const closingDate = `${invoiceMonth}-${closingDay.toString().padStart(2, '0')}`;
  let dueMonth = month;
  let dueYear = year;
  if (dueDay < closingDay) {
    dueMonth += 1;
    if (dueMonth > 12) {
      dueMonth = 1;
      dueYear += 1;
    }
  }
  const dueDate = `${dueYear}-${dueMonth.toString().padStart(2, '0')}-${dueDay.toString().padStart(2, '0')}`;

  return {
    id: invoiceMonth,
    accountId: cardAccount.id,
    userId,
    invoiceMonth,
    closingDate,
    dueDate,
    totalPurchasesAmountCents: 0,
    carriedOverBalanceCents: 0,
    interestAndFeesCents: 0,
    totalDueAmountCents: 0,
    totalPaidAmountCents: 0,
    remainingBalanceCents: 0,
    invoiceStatus: 'open',
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Obtém ou inicializa a fatura de um cartão de crédito para a competência indicada.
 */
export async function getOrCreateCardInvoice(
  cardAccount: Account,
  invoiceMonth: CompetenceMonthString,
  userId: string,
  isDemo = false
): Promise<CreditCardInvoice> {
  if (cardAccount.type !== 'credit') {
    throw new Error(`A conta "${cardAccount.name}" não é um cartão de crédito.`);
  }

  if (isDemo) {
    const invoices = loadDemoInvoices();
    let invoice = invoices.find(
      (inv) => inv.accountId === cardAccount.id && inv.invoiceMonth === invoiceMonth
    );

    if (!invoice) {
      invoice = buildEmptyCardInvoice(cardAccount, invoiceMonth, userId);
      invoices.push(invoice);
      saveDemoInvoices(invoices);
    }

    return invoice;
  }

  const invoiceRef = doc(db, 'accounts', cardAccount.id, 'invoices', invoiceMonth);
  const snap = await getDoc(invoiceRef);

  if (snap.exists()) {
    return snap.data() as CreditCardInvoice;
  }

  return buildEmptyCardInvoice(cardAccount, invoiceMonth, userId);
}

export interface AttachPurchaseChargeOptions {
  idempotencyKey?: string;
  transactionId?: string;
  description?: string;
  categoryId?: string;
  categoryName?: string;
  installmentNumber?: number;
  totalInstallments?: number;
  contractId?: string;
  chargeId?: string;
}

/**
 * Adiciona compra no cartão à fatura correspondente (interno em demo).
 */
export function attachPurchaseToInvoiceDemoSync(
  cardAccount: Account,
  amountCents: CentsInteger,
  purchaseDate: DateString,
  userId: string,
  options?: AttachPurchaseChargeOptions
): CreditCardInvoice {
  if (cardAccount.type !== 'credit') {
    throw new Error(`A conta "${cardAccount.name}" não é um cartão de crédito.`);
  }
  if (cardAccount.isArchived) {
    throw new Error(`O cartão "${cardAccount.name}" está arquivado.`);
  }

  const closingDay = cardAccount.closingDay || 20;
  const invoiceMonth = calculateInvoiceMonth(purchaseDate, closingDay);
  const invoices = loadDemoInvoices();
  let invoice = invoices.find(
    (inv) => inv.accountId === cardAccount.id && inv.invoiceMonth === invoiceMonth
  );
  if (!invoice) {
    invoice = buildEmptyCardInvoice(cardAccount, invoiceMonth, userId);
    invoices.push(invoice);
  }

  const newPurchasesTotal = invoice.totalPurchasesAmountCents + amountCents;
  const newTotalDue =
    newPurchasesTotal + invoice.carriedOverBalanceCents + invoice.interestAndFeesCents;
  const newRemaining = newTotalDue - invoice.totalPaidAmountCents;

  const todayStr = new Date().toISOString().slice(0, 10);
  let status: CreditCardInvoiceStatus = invoice.invoiceStatus;
  if (invoice.carriedOverToMonth) {
    status = 'carried_over';
  } else if (status === 'paid' && newRemaining > 0) {
    status = invoice.totalPaidAmountCents > 0 ? 'partially_paid' : 'open';
  } else if (status !== 'paid' && status !== 'partially_paid' && status !== 'carried_over') {
    if (todayStr > invoice.closingDate) {
      status = todayStr > invoice.dueDate ? 'overdue' : 'closed';
    } else {
      status = 'open';
    }
  }

  const nowIso = new Date().toISOString();
  const updatedInvoice: CreditCardInvoice = {
    ...invoice,
    totalPurchasesAmountCents: newPurchasesTotal,
    totalDueAmountCents: newTotalDue,
    remainingBalanceCents: newRemaining,
    invoiceStatus: status,
    updatedAt: nowIso,
  };

  const idx = invoices.findIndex(
    (inv) => inv.accountId === cardAccount.id && inv.invoiceMonth === invoiceMonth
  );
  if (idx >= 0) invoices[idx] = updatedInvoice;
  else invoices.push(updatedInvoice);
  saveDemoInvoices(invoices);

  // Persiste lançamento detalhado de compra na fatura em modo demo
  const charges = loadDemoCardCharges();
  const chargeId =
    options?.chargeId ||
    options?.transactionId ||
    `chg_${cardAccount.id}_${invoiceMonth}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  if (!charges.some((c) => c.accountId === cardAccount.id && c.id === chargeId)) {
    charges.push({
      id: chargeId,
      transactionId: options?.transactionId || chargeId,
      accountId: cardAccount.id,
      userId,
      invoiceMonth,
      description: options?.description?.trim() || 'Compra no cartão de crédito',
      amountCents,
      purchaseDate,
      categoryId: options?.categoryId || 'uncategorized',
      categoryName: options?.categoryName || 'Geral',
      status: 'active',
      installmentNumber: options?.installmentNumber,
      totalInstallments: options?.totalInstallments,
      contractId: options?.contractId,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    saveDemoCardCharges(charges);
  }

  return updatedInvoice;
}

/**
 * Adiciona compra no cartão à fatura correspondente.
 */
export async function attachPurchaseToInvoice(
  cardAccount: Account,
  amountCents: CentsInteger,
  purchaseDate: DateString,
  userId: string,
  isDemo = false,
  options?: AttachPurchaseChargeOptions
): Promise<CreditCardInvoice> {
  if (!validatePositiveCents(amountCents)) {
    throw new Error('O valor da compra no cartão deve ser um inteiro positivo em centavos.');
  }

  if (isDemo) {
    return withDemoLock(async () =>
      attachPurchaseToInvoiceDemoSync(cardAccount, amountCents, purchaseDate, userId, options)
    );
  }

  const callable = httpsCallable<
    {
      cardAccountId: string;
      amountCents: number;
      purchaseDate: string;
      transactionId?: string;
      description?: string;
      idempotencyKey?: string;
    },
    { invoice: CreditCardInvoice }
  >(functions, 'attachPurchaseToInvoiceOfficial');

  const res = await callable({
    cardAccountId: cardAccount.id,
    amountCents,
    purchaseDate,
    transactionId: options?.transactionId,
    description: options?.description,
    idempotencyKey: options?.idempotencyKey,
  });

  return res.data.invoice;
}

export interface PayInvoiceInput {
  cardAccountId: string;
  invoiceMonth: CompetenceMonthString;
  sourceAccountId: string;
  amountPaidCents: CentsInteger;
  paymentDate: DateString;
  userId: string;
  notes?: string;
  idempotencyKey?: string;
}

export interface PayInvoiceResult {
  invoice: CreditCardInvoice;
  payment: InvoicePayment;
  movement: FinancialMovement;
}

/**
 * Registra o pagamento total ou parcial de uma fatura de cartão.
 * Debita a conta pagadora (corrente/carteira) sem gerar despesa nova duplicada.
 */
export async function payCardInvoice(
  input: PayInvoiceInput,
  isDemo = false
): Promise<PayInvoiceResult> {
  if (!validatePositiveCents(input.amountPaidCents)) {
    throw new Error('O valor do pagamento da fatura deve ser um inteiro positivo em centavos.');
  }

  if (!isDemo) {
    const callable = httpsCallable<
      {
        cardAccountId: string;
        invoiceMonth: string;
        sourceAccountId: string;
        amountPaidCents: number;
        paymentDate: string;
        notes?: string;
        idempotencyKey: string;
      },
      PayInvoiceResult
    >(functions, 'payCardInvoiceOfficial');

    const idempotencyKey =
      input.idempotencyKey?.trim() ||
      `idem_invpay_${input.cardAccountId}_${input.invoiceMonth}_${input.amountPaidCents}_${input.paymentDate}_${Date.now()}`;

    const res = await callable({
      cardAccountId: input.cardAccountId,
      invoiceMonth: input.invoiceMonth,
      sourceAccountId: input.sourceAccountId,
      amountPaidCents: input.amountPaidCents,
      paymentDate: input.paymentDate,
      notes: input.notes,
      idempotencyKey,
    });
    return res.data;
  }

  return withDemoLock(async () => {
    const idempotencyKey =
      input.idempotencyKey?.trim() ||
      `idem_invpay_${input.cardAccountId}_${input.invoiceMonth}_${input.amountPaidCents}_${input.paymentDate}`;
    const paymentId = `invpay_${generateMovementDocId(input.cardAccountId, idempotencyKey)}`;

    const payments = loadDemoInvoicePayments();
    const existingPay = payments.find(
      (p) => p.id === paymentId || p.idempotencyKey === idempotencyKey
    );
    if (existingPay) {
      if (
        existingPay.amountPaidCents !== input.amountPaidCents ||
        existingPay.sourceAccountId !== input.sourceAccountId ||
        existingPay.invoiceMonth !== input.invoiceMonth
      ) {
        throw new Error(
          `Conflito de idempotência: chave "${idempotencyKey}" já utilizada com parâmetros divergentes.`
        );
      }
      const invoices = loadDemoInvoices();
      const inv = invoices.find(
        (i) => i.accountId === input.cardAccountId && i.invoiceMonth === input.invoiceMonth
      )!;
      const movement = await recordMovement(
        {
          accountId: input.sourceAccountId,
          userId: input.userId,
          direction: 'outflow',
          amountCents: input.amountPaidCents,
          effectiveDate: input.paymentDate,
          originType: 'credit_card_payment',
          originId: existingPay.id,
          description: `Pagamento de Fatura ${input.invoiceMonth}`,
          notes: input.notes || `Amortização de fatura do cartão`,
          authorUid: input.userId,
          idempotencyKey: `mov_${idempotencyKey}`,
        },
        true
      );
      return {
        invoice: inv,
        payment: existingPay,
        movement,
      };
    }

    // 1. Valida conta pagadora
    const accounts = await getUserAccounts(input.userId, true, true);
    const sourceAcc = accounts.find((a) => a.id === input.sourceAccountId);
    if (!sourceAcc) {
      throw new Error(`Conta pagadora "${input.sourceAccountId}" não encontrada.`);
    }
    if (sourceAcc.type === 'credit') {
      throw new Error('Não é permitido pagar uma fatura de cartão utilizando outro cartão de crédito.');
    }
    if (sourceAcc.isArchived) {
      throw new Error(`A conta pagadora "${sourceAcc.name}" está arquivada.`);
    }

    // 2. Carrega fatura
    const invoices = loadDemoInvoices();
    const found = invoices.find(
      (inv) => inv.accountId === input.cardAccountId && inv.invoiceMonth === input.invoiceMonth
    );
    if (!found) {
      throw new Error(`Fatura "${input.invoiceMonth}" do cartão não encontrada.`);
    }
    const invoice = { ...found };

    if (input.amountPaidCents > invoice.remainingBalanceCents) {
      throw new Error(
        `O valor pago (${input.amountPaidCents} centavos) excede o saldo devedor restante da fatura (${invoice.remainingBalanceCents} centavos).`
      );
    }

    // 3. Debita a conta pagadora (checking/wallet) no Livro Financeiro v3.1
    const movement = await recordMovement(
      {
        accountId: input.sourceAccountId,
        userId: input.userId,
        direction: 'outflow',
        amountCents: input.amountPaidCents,
        effectiveDate: input.paymentDate,
        originType: 'credit_card_payment',
        originId: paymentId,
        description: `Pagamento de Fatura ${input.invoiceMonth}`,
        notes: input.notes || `Amortização de fatura do cartão`,
        authorUid: input.userId,
        idempotencyKey: `mov_${idempotencyKey}`,
      },
      true
    );

    // 4. Registra comprovante do pagamento de fatura
    const invoicePayment: InvoicePayment = {
      id: paymentId,
      invoiceMonth: input.invoiceMonth,
      accountId: input.cardAccountId,
      sourceAccountId: input.sourceAccountId,
      amountPaidCents: input.amountPaidCents,
      paymentDate: input.paymentDate,
      financialMovementId: movement.id,
      clientTransactionUuid: paymentId,
      idempotencyKey,
      createdAt: new Date().toISOString(),
    };

    // 5. Atualiza saldos da fatura
    const newTotalPaid = invoice.totalPaidAmountCents + input.amountPaidCents;
    const newRemaining = invoice.totalDueAmountCents - newTotalPaid;
    const newStatus: CreditCardInvoiceStatus = newRemaining === 0 ? 'paid' : 'partially_paid';

    const updatedInvoice: CreditCardInvoice = {
      ...invoice,
      totalPaidAmountCents: newTotalPaid,
      remainingBalanceCents: newRemaining,
      invoiceStatus: newStatus,
      updatedAt: new Date().toISOString(),
    };

    const idx = invoices.findIndex(
      (inv) => inv.accountId === input.cardAccountId && inv.invoiceMonth === input.invoiceMonth
    );
    if (idx >= 0) invoices[idx] = updatedInvoice;
    saveDemoInvoices(invoices);

    payments.push(invoicePayment);
    saveDemoInvoicePayments(payments);

    return {
      invoice: updatedInvoice,
      payment: invoicePayment,
      movement,
    };
  });
}

export interface CarryOverInput {
  cardAccount: Account;
  sourceInvoiceMonth: CompetenceMonthString;
  targetInvoiceMonth: CompetenceMonthString;
  interestRateMonthly?: number; // ex: 0.12 para 12% ao mês
  userId: string;
}

/**
 * Transporta o saldo não pago de uma fatura fechada para a competência seguinte (rotativo).
 */
export async function carryOverInvoiceBalance(
  input: CarryOverInput,
  isDemo = false
): Promise<{
  sourceInvoice: CreditCardInvoice;
  targetInvoice: CreditCardInvoice;
  carryOver: InvoiceCarryOver;
}> {
  const { cardAccount, sourceInvoiceMonth, targetInvoiceMonth, userId } = input;
  const rate = input.interestRateMonthly ?? 0.12;

  if (!isDemo) {
    const callable = httpsCallable<
      {
        cardAccountId: string;
        sourceInvoiceMonth: string;
        targetInvoiceMonth: string;
        interestRateMonthly: number;
      },
      {
        sourceInvoice: CreditCardInvoice;
        targetInvoice: CreditCardInvoice;
        carryOver: InvoiceCarryOver;
      }
    >(functions, 'carryOverInvoiceBalanceOfficial');

    const res = await callable({
      cardAccountId: cardAccount.id,
      sourceInvoiceMonth,
      targetInvoiceMonth,
      interestRateMonthly: rate,
    });
    return res.data;
  }

  return withDemoLock(async () => {
    const invoices = loadDemoInvoices();
    const sIdx = invoices.findIndex(
      (inv) => inv.accountId === cardAccount.id && inv.invoiceMonth === sourceInvoiceMonth
    );
    if (sIdx === -1) {
      throw new Error(`Fatura de origem "${sourceInvoiceMonth}" não encontrada.`);
    }
    const sourceInvoice = { ...invoices[sIdx] };

    const carryId = `carry_${cardAccount.id}_${sourceInvoiceMonth}_to_${targetInvoiceMonth}`;
    const carries = loadDemoCarryOvers();
    const existingCarry = carries.find((c) => c.id === carryId);
    if (existingCarry) {
      const targetInv = invoices.find(
        (inv) => inv.accountId === cardAccount.id && inv.invoiceMonth === targetInvoiceMonth
      )!;
      return {
        sourceInvoice,
        targetInvoice: targetInv,
        carryOver: existingCarry,
      };
    }

    if (sourceInvoice.remainingBalanceCents <= 0) {
      throw new Error('A fatura de origem não possui saldo restante a ser transportado.');
    }

    const unpaidPrincipal = sourceInvoice.remainingBalanceCents;
    const appliedInterest = Math.round(unpaidPrincipal * rate);
    const now = new Date().toISOString();

    const carryOver: InvoiceCarryOver = {
      id: carryId,
      sourceInvoiceMonth,
      targetInvoiceMonth,
      unpaidPrincipalCents: unpaidPrincipal,
      interestRateMonthly: rate,
      appliedInterestCents: appliedInterest,
      status: 'active',
      createdAt: now,
    };

    // Zera o saldo aberto da fatura de origem (transferido para targetInvoiceMonth)
    // impedindo dupla contagem no cálculo de limite disponível!
    const updatedSource: CreditCardInvoice = {
      ...sourceInvoice,
      remainingBalanceCents: 0,
      invoiceStatus: 'carried_over',
      carriedOverToMonth: targetInvoiceMonth,
      updatedAt: now,
    };
    invoices[sIdx] = updatedSource;

    let tIdx = invoices.findIndex(
      (inv) => inv.accountId === cardAccount.id && inv.invoiceMonth === targetInvoiceMonth
    );
    let targetInvoice: CreditCardInvoice;
    if (tIdx === -1) {
      targetInvoice = buildEmptyCardInvoice(cardAccount, targetInvoiceMonth, userId);
      invoices.push(targetInvoice);
      tIdx = invoices.length - 1;
    } else {
      targetInvoice = { ...invoices[tIdx] };
    }

    const newCarriedOver = targetInvoice.carriedOverBalanceCents + unpaidPrincipal;
    const newInterest = targetInvoice.interestAndFeesCents + appliedInterest;
    const newTotalDue =
      targetInvoice.totalPurchasesAmountCents + newCarriedOver + newInterest;
    const newRemaining = Math.max(0, newTotalDue - targetInvoice.totalPaidAmountCents);

    const updatedTarget: CreditCardInvoice = {
      ...targetInvoice,
      carriedOverBalanceCents: newCarriedOver,
      interestAndFeesCents: newInterest,
      totalDueAmountCents: newTotalDue,
      remainingBalanceCents: newRemaining,
      invoiceStatus:
        newRemaining === 0
          ? 'paid'
          : targetInvoice.totalPaidAmountCents > 0
          ? 'partially_paid'
          : 'open',
      updatedAt: now,
    };

    invoices[tIdx] = updatedTarget;
    saveDemoInvoices(invoices);

    carries.push(carryOver);
    saveDemoCarryOvers(carries);

    return {
      sourceInvoice: updatedSource,
      targetInvoice: updatedTarget,
      carryOver,
    };
  });
}

/**
 * Consulta todas as faturas de um cartão de crédito.
 */
export async function getCardInvoices(
  cardAccountId: string,
  userId: string,
  isDemo = false
): Promise<CreditCardInvoice[]> {
  if (isDemo) {
    const invoices = loadDemoInvoices();
    return invoices
      .filter((inv) => inv.accountId === cardAccountId && inv.userId === userId)
      .sort((a, b) => b.invoiceMonth.localeCompare(a.invoiceMonth));
  }

  const q = query(
    collection(db, 'accounts', cardAccountId, 'invoices'),
    where('userId', '==', userId)
  );
  const snap = await getDocs(q);
  const list: CreditCardInvoice[] = [];
  snap.forEach((d) => list.push({ ...(d.data() as CreditCardInvoice), id: d.id }));
  return list.sort((a, b) => b.invoiceMonth.localeCompare(a.invoiceMonth));
}

/**
 * Consulta os pagamentos de uma fatura de cartão.
 */
export async function getInvoicePayments(
  cardAccountId: string,
  invoiceMonth: CompetenceMonthString,
  isDemo = false
): Promise<InvoicePayment[]> {
  if (isDemo) {
    const payments = loadDemoInvoicePayments();
    return payments
      .filter((p) => p.accountId === cardAccountId && p.invoiceMonth === invoiceMonth)
      .sort((a, b) => b.paymentDate.localeCompare(a.paymentDate));
  }

  const snap = await getDocs(
    collection(db, 'accounts', cardAccountId, 'invoices', invoiceMonth, 'payments')
  );
  const list: InvoicePayment[] = [];
  snap.forEach((d) => list.push({ ...(d.data() as InvoicePayment), id: d.id }));
  return list.sort((a, b) => b.paymentDate.localeCompare(a.paymentDate));
}

/**
 * Calcula o limite disponível de um cartão de crédito subtraindo compras abertas e não pagas.
 */
export async function calculateCardAvailableLimit(
  cardAccount: Account,
  userId: string,
  isDemo = false
): Promise<{
  creditLimitCents: CentsInteger;
  usedAmountCents: CentsInteger;
  availableLimitCents: CentsInteger;
}> {
  const totalLimit = cardAccount.creditLimitCents || 0;
  const invoices = await getCardInvoices(cardAccount.id, userId, isDemo);

  const totalUsed = invoices.reduce((acc, curr) => {
    if (curr.invoiceStatus !== 'paid' && curr.invoiceStatus !== 'carried_over') {
      return acc + curr.remainingBalanceCents;
    }
    return acc;
  }, 0);

  const available = Math.max(0, totalLimit - totalUsed);

  return {
    creditLimitCents: totalLimit,
    usedAmountCents: totalUsed,
    availableLimitCents: available,
  };
}

/**
 * Consulta as compras/lançamentos alocados a uma fatura específica do cartão.
 */
export async function getInvoiceCharges(
  cardAccountId: string,
  invoiceMonth: CompetenceMonthString,
  isDemo = false
): Promise<CreditCardInvoiceCharge[]> {
  if (!cardAccountId || !invoiceMonth) return [];

  if (isDemo) {
    return loadDemoCardCharges()
      .filter((c) => c.accountId === cardAccountId && c.invoiceMonth === invoiceMonth)
      .sort((a, b) => (b.purchaseDate || '').localeCompare(a.purchaseDate || ''));
  }

  const snap = await getDocs(
    collection(db, 'accounts', cardAccountId, 'invoices', invoiceMonth, 'charges')
  );
  const list: CreditCardInvoiceCharge[] = [];
  snap.forEach((d) => {
    const raw = d.data() as CreditCardInvoiceCharge;
    list.push({ ...raw, id: d.id || raw.id });
  });
  return list.sort((a, b) => (b.purchaseDate || '').localeCompare(a.purchaseDate || ''));
}

/**
 * Consulta todas as compras alocadas em todas as faturas de um cartão.
 */
export async function getAllCardCharges(
  cardAccountId: string,
  userId: string,
  invoices?: CreditCardInvoice[],
  isDemo = false
): Promise<CreditCardInvoiceCharge[]> {
  if (!cardAccountId || !userId) return [];

  if (isDemo) {
    return loadDemoCardCharges()
      .filter((c) => c.accountId === cardAccountId && c.userId === userId)
      .sort((a, b) => (b.purchaseDate || '').localeCompare(a.purchaseDate || ''));
  }

  const invList = invoices || (await getCardInvoices(cardAccountId, userId, false));
  const perMonth = await Promise.all(
    invList.map((inv) =>
      getInvoiceCharges(cardAccountId, inv.invoiceMonth, false).catch(() => [])
    )
  );
  return perMonth
    .flat()
    .sort((a, b) => (b.purchaseDate || '').localeCompare(a.purchaseDate || ''));
}

/**
 * Consulta todos os pagamentos realizados para todas as faturas de um cartão.
 */
export async function getAllCardPayments(
  cardAccountId: string,
  invoices: CreditCardInvoice[],
  isDemo = false
): Promise<InvoicePayment[]> {
  if (!cardAccountId) return [];

  if (isDemo) {
    return loadDemoInvoicePayments()
      .filter((p) => p.accountId === cardAccountId)
      .sort((a, b) => (b.paymentDate || '').localeCompare(a.paymentDate || ''));
  }

  const perMonth = await Promise.all(
    invoices.map((inv) =>
      getInvoicePayments(cardAccountId, inv.invoiceMonth, false).catch(() => [])
    )
  );
  return perMonth
    .flat()
    .sort((a, b) => (b.paymentDate || '').localeCompare(a.paymentDate || ''));
}

export interface CardLedgerOverview {
  cardAccount: Account;
  limitSummary: {
    creditLimitCents: CentsInteger;
    usedAmountCents: CentsInteger;
    availableLimitCents: CentsInteger;
  };
  invoices: CreditCardInvoice[];
  charges: CreditCardInvoiceCharge[];
  payments: InvoicePayment[];
  contracts: InstallmentContract[];
  occurrencesByContract: Record<string, InstallmentOccurrence[]>;
}

/**
 * Carrega a visão completa e unificada do Livro-Razão do Cartão de Crédito:
 * Limite, Faturas (atual, futuras, pagas), Compras à vista e Parceladas, e Pagamentos realizados.
 */
export async function getCardLedgerOverview(
  cardAccount: Account,
  userId: string,
  isDemo = false
): Promise<CardLedgerOverview> {
  const invoices = await getCardInvoices(cardAccount.id, userId, isDemo);

  const totalLimit = cardAccount.creditLimitCents || 0;
  const totalUsed = invoices.reduce((acc, curr) => {
    if (curr.invoiceStatus !== 'paid' && curr.invoiceStatus !== 'carried_over') {
      return acc + (curr.remainingBalanceCents || 0);
    }
    return acc;
  }, 0);
  const limitSummary = {
    creditLimitCents: totalLimit,
    usedAmountCents: totalUsed,
    availableLimitCents: Math.max(0, totalLimit - totalUsed),
  };

  // Carrega charges, payments, personal_transactions do cartão e contratos de parcelamento em paralelo
  let cardTxs: PersonalTransaction[] = [];
  let cardContracts: InstallmentContract[] = [];
  const occurrencesByContract: Record<string, InstallmentOccurrence[]> = {};

  if (isDemo) {
    try {
      const rawTxs = universalStorage.getItem('mpf_v3_demo_personal_transactions');
      const allTxs: PersonalTransaction[] = rawTxs ? JSON.parse(rawTxs) : [];
      cardTxs = allTxs.filter(
        (t) => t.userId === userId && t.accountId === cardAccount.id && t.type === 'expense'
      );
    } catch {}
    try {
      const rawContracts = universalStorage.getItem('demo_installment_contracts_v3');
      const allContracts: InstallmentContract[] = rawContracts ? JSON.parse(rawContracts) : [];
      cardContracts = allContracts.filter(
        (c) =>
          c.scope === 'personal' &&
          c.userId === userId &&
          c.fundingSource === 'credit_card' &&
          c.sourceCardAccountId === cardAccount.id
      );
      const rawOccs = universalStorage.getItem('demo_installment_occurrences_v3');
      const allOccs: InstallmentOccurrence[] = rawOccs ? JSON.parse(rawOccs) : [];
      for (const c of cardContracts) {
        occurrencesByContract[c.id] = allOccs
          .filter((o) => o.contractId === c.id)
          .sort((a, b) => a.installmentNumber - b.installmentNumber);
      }
    } catch {}
  } else {
    const [txSnap, contractSnap] = await Promise.all([
      getDocs(
        query(
          collection(db, 'users', userId, 'personal_transactions'),
          where('accountId', '==', cardAccount.id)
        )
      ).catch(() => null),
      getDocs(
        query(
          collection(db, 'installment_contracts'),
          where('scope', '==', 'personal'),
          where('userId', '==', userId)
        )
      ).catch(() => null),
    ]);

    if (txSnap) {
      txSnap.forEach((d) => {
        const t = { ...(d.data() as PersonalTransaction), id: d.id };
        if (t.type === 'expense') cardTxs.push(t);
      });
    }

    if (contractSnap) {
      contractSnap.forEach((d) => {
        const c = { ...(d.data() as InstallmentContract), id: d.id };
        if (c.fundingSource === 'credit_card' && c.sourceCardAccountId === cardAccount.id) {
          cardContracts.push(c);
        }
      });
      await Promise.all(
        cardContracts.map(async (c) => {
          const occSnap = await getDocs(
            collection(db, 'installment_contracts', c.id, 'occurrences')
          ).catch(() => null);
          const occs: InstallmentOccurrence[] = [];
          if (occSnap) {
            occSnap.forEach((od) => occs.push(od.data() as InstallmentOccurrence));
          }
          occurrencesByContract[c.id] = occs.sort(
            (a, b) => a.installmentNumber - b.installmentNumber
          );
        })
      );
    }
  }

  const [rawCharges, payments] = await Promise.all([
    getAllCardCharges(cardAccount.id, userId, invoices, isDemo),
    getAllCardPayments(cardAccount.id, invoices, isDemo),
  ]);

  // Enriquece charges com dados de parcelamento e sintetiza fallback para compras legadas sem subdocumento charge
  const contractMap = new Map<string, InstallmentContract>();
  for (const c of cardContracts) contractMap.set(c.id, c);

  const chargeById = new Map<string, CreditCardInvoiceCharge>();
  const chargedTxIds = new Set<string>();

  for (const ch of rawCharges) {
    let enriched: CreditCardInvoiceCharge = { ...ch };
    const matchedContract =
      (ch.contractId && contractMap.get(ch.contractId)) ||
      contractMap.get(ch.transactionId);

    if (matchedContract) {
      enriched.contractId = matchedContract.id;
      enriched.totalInstallments = matchedContract.totalInstallmentsCount;
      const occs = occurrencesByContract[matchedContract.id] || [];
      const matchedOcc = occs.find(
        (o) =>
          ch.id === `chg_${matchedContract.id}_${o.id}` ||
          (o.competenceMonth === ch.invoiceMonth && o.principalAmountCents === ch.amountCents)
      );
      if (matchedOcc) {
        enriched.installmentNumber = matchedOcc.installmentNumber;
      }
    } else if (!enriched.installmentNumber || !enriched.totalInstallments) {
      const m = (ch.description || '').match(/\((\d+)\/(\d+)\)\s*$/);
      if (m) {
        enriched.installmentNumber = parseInt(m[1], 10);
        enriched.totalInstallments = parseInt(m[2], 10);
      }
    }

    chargeById.set(enriched.id, enriched);
    if (enriched.transactionId) chargedTxIds.add(enriched.transactionId);
  }

  // Fallback para compras pessoais legadas no cartão sem documento em charges/
  for (const tx of cardTxs) {
    if (chargedTxIds.has(tx.id) || chargeById.has(tx.id)) continue;
    const invMonth =
      tx.invoiceMonth ||
      calculateInvoiceMonth(tx.competenceDate, cardAccount.closingDay || 20);
    chargeById.set(tx.id, {
      id: tx.id,
      transactionId: tx.id,
      accountId: cardAccount.id,
      userId,
      invoiceMonth: invMonth,
      description: tx.description,
      amountCents: tx.amountCents,
      purchaseDate: tx.competenceDate,
      categoryId: tx.categoryId || 'uncategorized',
      categoryName: tx.categoryName || 'Geral',
      status: tx.status === 'cancelled' ? 'cancelled' : 'active',
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt || tx.createdAt,
    });
  }

  // Fallback para parcelas em ocorrências que ainda não estejam na coleção charges
  for (const contract of cardContracts) {
    const occs = occurrencesByContract[contract.id] || [];
    for (const occ of occs) {
      const chId = `chg_${contract.id}_${occ.id}`;
      if (chargeById.has(chId)) continue;
      chargeById.set(chId, {
        id: chId,
        transactionId: contract.id,
        accountId: cardAccount.id,
        userId,
        invoiceMonth: occ.competenceMonth,
        description: `${contract.title} (${occ.installmentNumber}/${contract.totalInstallmentsCount})`,
        amountCents: occ.totalInstallmentAmountCents,
        purchaseDate: occ.dueDate,
        categoryId: 'installment',
        categoryName: 'Parcelamento',
        status: occ.status === 'cancelled' ? 'cancelled' : 'active',
        installmentNumber: occ.installmentNumber,
        totalInstallments: contract.totalInstallmentsCount,
        contractId: contract.id,
        createdAt: contract.createdAt,
        updatedAt: contract.createdAt,
      });
    }
  }

  const charges = Array.from(chargeById.values()).sort((a, b) => {
    const dateCmp = (b.purchaseDate || '').localeCompare(a.purchaseDate || '');
    if (dateCmp !== 0) return dateCmp;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });

  return {
    cardAccount,
    limitSummary,
    invoices,
    charges,
    payments,
    contracts: cardContracts,
    occurrencesByContract,
  };
}
