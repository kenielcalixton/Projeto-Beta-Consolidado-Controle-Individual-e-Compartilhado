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
  CreditCardInvoice,
  CreditCardInvoiceStatus,
  DateString,
  FinancialMovement,
  InvoiceCarryOver,
  InvoicePayment,
  PersonalTransaction,
} from '../types/financeV3';
import { recordMovement } from './ledgerService';
import { universalStorage } from '../utils/universalStorage';
import { validatePositiveCents } from '../utils/movementLedger';

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
 *    com separação clara de principal, juros e encargos.
 */

const DEMO_INVOICES_KEY = 'mpf_v3_demo_card_invoices';
const DEMO_INVOICE_PAYMENTS_KEY = 'mpf_v3_demo_invoice_payments';
const DEMO_INVOICE_CARRY_OVERS_KEY = 'mpf_v3_demo_invoice_carry_overs';

function loadDemoInvoices(): CreditCardInvoice[] {
  try {
    const raw = universalStorage.getItem(DEMO_INVOICES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDemoInvoices(invoices: CreditCardInvoice[]): void {
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

  if (isDemo) {
    const invoices = loadDemoInvoices();
    let invoice = invoices.find(
      (inv) => inv.accountId === cardAccount.id && inv.invoiceMonth === invoiceMonth
    );

    if (!invoice) {
      invoice = {
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

  const newInvoice: CreditCardInvoice = {
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

  await setDoc(invoiceRef, newInvoice);
  return newInvoice;
}

/**
 * Adiciona compra no cartão à fatura correspondente.
 */
export async function attachPurchaseToInvoice(
  cardAccount: Account,
  amountCents: CentsInteger,
  purchaseDate: DateString,
  userId: string,
  isDemo = false
): Promise<CreditCardInvoice> {
  const closingDay = cardAccount.closingDay || 20;
  const invoiceMonth = calculateInvoiceMonth(purchaseDate, closingDay);
  const invoice = await getOrCreateCardInvoice(cardAccount, invoiceMonth, userId, isDemo);

  const newPurchasesTotal = invoice.totalPurchasesAmountCents + amountCents;
  const newTotalDue =
    newPurchasesTotal + invoice.carriedOverBalanceCents + invoice.interestAndFeesCents;
  const newRemaining = newTotalDue - invoice.totalPaidAmountCents;

  const todayStr = new Date().toISOString().slice(0, 10);
  let status: CreditCardInvoiceStatus = invoice.invoiceStatus;
  if (status !== 'paid' && status !== 'partially_paid') {
    if (todayStr > invoice.closingDate) {
      status = todayStr > invoice.dueDate ? 'overdue' : 'closed';
    } else {
      status = 'open';
    }
  }

  const updatedInvoice: CreditCardInvoice = {
    ...invoice,
    totalPurchasesAmountCents: newPurchasesTotal,
    totalDueAmountCents: newTotalDue,
    remainingBalanceCents: newRemaining,
    invoiceStatus: status,
    updatedAt: new Date().toISOString(),
  };

  if (isDemo) {
    const invoices = loadDemoInvoices();
    const idx = invoices.findIndex(
      (inv) => inv.accountId === cardAccount.id && inv.invoiceMonth === invoiceMonth
    );
    if (idx >= 0) invoices[idx] = updatedInvoice;
    else invoices.push(updatedInvoice);
    saveDemoInvoices(invoices);
    return updatedInvoice;
  }

  const invoiceRef = doc(db, 'accounts', cardAccount.id, 'invoices', invoiceMonth);
  await setDoc(invoiceRef, updatedInvoice, { merge: true });
  return updatedInvoice;
}

export interface PayInvoiceInput {
  cardAccountId: string;
  invoiceMonth: CompetenceMonthString;
  sourceAccountId: string;
  amountPaidCents: CentsInteger;
  paymentDate: DateString;
  userId: string;
  notes?: string;
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

  // 1. Carrega fatura
  let invoice: CreditCardInvoice;
  if (isDemo) {
    const invoices = loadDemoInvoices();
    const found = invoices.find(
      (inv) => inv.accountId === input.cardAccountId && inv.invoiceMonth === input.invoiceMonth
    );
    if (!found) {
      throw new Error(`Fatura "${input.invoiceMonth}" do cartão não encontrada.`);
    }
    invoice = { ...found };
  } else {
    const invoiceRef = doc(db, 'accounts', input.cardAccountId, 'invoices', input.invoiceMonth);
    const snap = await getDoc(invoiceRef);
    if (!snap.exists()) {
      throw new Error(`Fatura "${input.invoiceMonth}" do cartão não encontrada.`);
    }
    invoice = snap.data() as CreditCardInvoice;
  }

  if (input.amountPaidCents > invoice.remainingBalanceCents) {
    throw new Error(
      `O valor pago (${input.amountPaidCents} centavos) excede o saldo devedor restante da fatura (${invoice.remainingBalanceCents} centavos).`
    );
  }

  const paymentId = `invpay_${input.cardAccountId}_${input.invoiceMonth}_${Date.now()}`;
  const idempotencyKey = `idem_invpay_${input.cardAccountId}_${input.invoiceMonth}_${input.amountPaidCents}_${input.paymentDate}`;

  // 2. Debita a conta pagadora (checking/wallet) no Livro Financeiro v3.1
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
      idempotencyKey,
    },
    isDemo
  );

  // 3. Registra comprovante do pagamento de fatura
  const invoicePayment: InvoicePayment = {
    id: paymentId,
    invoiceMonth: input.invoiceMonth,
    accountId: input.cardAccountId,
    sourceAccountId: input.sourceAccountId,
    amountPaidCents: input.amountPaidCents,
    paymentDate: input.paymentDate,
    financialMovementId: movement.id,
    clientTransactionUuid: paymentId,
    createdAt: new Date().toISOString(),
  };

  // 4. Atualiza saldos da fatura
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

  if (isDemo) {
    const invoices = loadDemoInvoices();
    const idx = invoices.findIndex(
      (inv) => inv.accountId === input.cardAccountId && inv.invoiceMonth === input.invoiceMonth
    );
    if (idx >= 0) invoices[idx] = updatedInvoice;
    saveDemoInvoices(invoices);

    const payments = loadDemoInvoicePayments();
    payments.push(invoicePayment);
    saveDemoInvoicePayments(payments);
  } else {
    const invoiceRef = doc(db, 'accounts', input.cardAccountId, 'invoices', input.invoiceMonth);
    const payRef = doc(
      db,
      'accounts',
      input.cardAccountId,
      'invoices',
      input.invoiceMonth,
      'payments',
      paymentId
    );
    await setDoc(invoiceRef, updatedInvoice, { merge: true });
    await setDoc(payRef, invoicePayment);
  }

  return {
    invoice: updatedInvoice,
    payment: invoicePayment,
    movement,
  };
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

  const sourceInvoice = await getOrCreateCardInvoice(cardAccount, sourceInvoiceMonth, userId, isDemo);
  if (sourceInvoice.remainingBalanceCents <= 0) {
    throw new Error('A fatura de origem não possui saldo restante a ser transportado.');
  }

  const unpaidPrincipal = sourceInvoice.remainingBalanceCents;
  const appliedInterest = Math.round(unpaidPrincipal * rate);

  const carryId = `carry_${cardAccount.id}_${sourceInvoiceMonth}_to_${targetInvoiceMonth}`;
  const carryOver: InvoiceCarryOver = {
    id: carryId,
    sourceInvoiceMonth,
    targetInvoiceMonth,
    unpaidPrincipalCents: unpaidPrincipal,
    interestRateMonthly: rate,
    appliedInterestCents: appliedInterest,
    status: 'active',
    createdAt: new Date().toISOString(),
  };

  // Carrega e atualiza a fatura de destino
  const targetInvoice = await getOrCreateCardInvoice(cardAccount, targetInvoiceMonth, userId, isDemo);
  const updatedTarget: CreditCardInvoice = {
    ...targetInvoice,
    carriedOverBalanceCents: targetInvoice.carriedOverBalanceCents + unpaidPrincipal,
    interestAndFeesCents: targetInvoice.interestAndFeesCents + appliedInterest,
    totalDueAmountCents:
      targetInvoice.totalPurchasesAmountCents +
      (targetInvoice.carriedOverBalanceCents + unpaidPrincipal) +
      (targetInvoice.interestAndFeesCents + appliedInterest),
    remainingBalanceCents:
      targetInvoice.totalPurchasesAmountCents +
      (targetInvoice.carriedOverBalanceCents + unpaidPrincipal) +
      (targetInvoice.interestAndFeesCents + appliedInterest) -
      targetInvoice.totalPaidAmountCents,
    updatedAt: new Date().toISOString(),
  };

  if (isDemo) {
    const carries = loadDemoCarryOvers();
    carries.push(carryOver);
    saveDemoCarryOvers(carries);

    const invoices = loadDemoInvoices();
    const tIdx = invoices.findIndex(
      (inv) => inv.accountId === cardAccount.id && inv.invoiceMonth === targetInvoiceMonth
    );
    if (tIdx >= 0) invoices[tIdx] = updatedTarget;
    saveDemoInvoices(invoices);
  } else {
    const carryRef = doc(
      db,
      'accounts',
      cardAccount.id,
      'invoices',
      sourceInvoiceMonth,
      'carry_overs',
      carryId
    );
    const targetRef = doc(db, 'accounts', cardAccount.id, 'invoices', targetInvoiceMonth);
    await setDoc(carryRef, carryOver);
    await setDoc(targetRef, updatedTarget, { merge: true });
  }

  return {
    sourceInvoice,
    targetInvoice: updatedTarget,
    carryOver,
  };
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
    if (curr.invoiceStatus !== 'paid') {
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
