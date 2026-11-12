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
  CentsInteger,
  CompetenceMonthString,
  DateString,
  ExpenseApprovalRevocation,
  ExpenseLiability,
  ExpenseLiabilitySplitMethod,
  ExpensePaymentApproval,
  ExpensePaymentDeclaration,
  ExpensePaymentRejection,
  FinancialMovement,
  ISO8601String,
  PaymentDeclarationMethod,
  PaymentDeclarationStatus,
  SharedExpense,
  SharedExpenseCommitmentStatus,
  SharedExpenseOriginType,
  SharedExpensePaymentExecutionStatus,
  SharedExpenseValidationStatus,
  SupplierRefundEvent,
  SupplierRefundType,
} from '../types/financeV3';
import { calculateExpenseSplit, SplitParticipant } from '../utils/splitEngine';
import {
  generateApprovalRevocationDocId,
  generatePaymentApprovalDocId,
  generatePaymentDeclarationDocId,
  generatePaymentRejectionDocId,
  generateSharedExpenseDocId,
  generateSupplierRefundDocId,
  validatePositiveCents,
} from '../utils/movementLedger';
import { recordMovement, reverseMovement, withDemoLock } from './ledgerService';
import { sendSpaceNotification } from './spaceNotificationService';
import { universalStorage } from '../utils/universalStorage';

/**
 * ==============================================================================
 * SERVIÇO DE FINANÇAS COMPARTILHADAS (RATEIOS E REEMBOLSOS) — FASE 6 (v3.1)
 * ==============================================================================
 * Caminhos Canônicos no Firestore:
 * - Despesas: spaces/{spaceId}/shared_expenses/{expenseId}
 * - Obrigações: spaces/{spaceId}/shared_expenses/{expenseId}/liabilities/{memberUid}
 * - Declarações: spaces/{spaceId}/shared_expenses/{expenseId}/payment_declarations/{declarationId}
 * - Aprovações: spaces/{spaceId}/shared_expenses/{expenseId}/payment_approvals/{approvalId}
 * - Rejeições: spaces/{spaceId}/shared_expenses/{expenseId}/payment_rejections/{rejectionId}
 * - Revogações: spaces/{spaceId}/shared_expenses/{expenseId}/approval_revocations/{revocationId}
 * - Reembolsos: spaces/{spaceId}/shared_expenses/{expenseId}/refunds/{refundId}
 *
 * Princípios Fundamentais da Fase 6:
 * 1. Segregação Absoluta de Papéis:
 *    - createdByUid: Autor do cadastro
 *    - responsibleUid: Responsável financeiro e credor legítimo para validações
 *    - payerUid: Quem desembolsou ao fornecedor comercial (beneficiário do reembolso)
 * 2. Princípio da Autoridade Exclusiva de Validação:
 *    - SOMENTE o responsibleUid da despesa tem competência para aprovar, rejeitar ou revogar pagamentos.
 *    - Administradores e proprietários do espaço NÃO possuem autoridade universal de aprovação.
 * 3. Conservação Contábil Estrita (Zero Drift):
 *    - A soma das cotas de rateio é exatamente igual ao total da despesa (algoritmo de Maior Resto).
 * 4. Declaração vs Aprovação:
 *    - Declarações pendentes NÃO alteram o saldo oficial da obrigação nem registram créditos na conta.
 *    - Somente a aprovação do credor reconhece a quitação e gera o FinancialMovement na conta bancária do beneficiário (payerUid).
 * 5. Histórico Imutável e Append-Only:
 *    - Declarações, aprovações e rejeições nunca são sobrescritas ou alteradas retroativamente.
 *    - Revogações são novos eventos compensatórios que restabelecem o saldo da cota e estornam movimentos.
 */

export const DEMO_SHARED_EXPENSES_KEY = 'mpf_v3_demo_shared_expenses';
export const DEMO_SHARED_LIABILITIES_KEY = 'mpf_v3_demo_shared_liabilities';
export const DEMO_PAYMENT_DECLARATIONS_KEY = 'mpf_v3_demo_payment_declarations';
export const DEMO_PAYMENT_APPROVALS_KEY = 'mpf_v3_demo_payment_approvals';
export const DEMO_PAYMENT_REJECTIONS_KEY = 'mpf_v3_demo_payment_rejections';
export const DEMO_APPROVAL_REVOCATIONS_KEY = 'mpf_v3_demo_approval_revocations';
export const DEMO_SUPPLIER_REFUNDS_KEY = 'mpf_v3_demo_supplier_refunds';

export function loadDemoPaymentRejections(): ExpensePaymentRejection[] {
  try {
    const raw = universalStorage.getItem(DEMO_PAYMENT_REJECTIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveDemoPaymentRejections(data: ExpensePaymentRejection[]): void {
  universalStorage.setItem(DEMO_PAYMENT_REJECTIONS_KEY, JSON.stringify(data));
}

// ==============================================================================
// HELPERS DE ARMAZENAMENTO DEMO
// ==============================================================================

export function loadDemoSharedExpenses(): SharedExpense[] {
  try {
    const raw = universalStorage.getItem(DEMO_SHARED_EXPENSES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveDemoSharedExpenses(data: SharedExpense[]): void {
  universalStorage.setItem(DEMO_SHARED_EXPENSES_KEY, JSON.stringify(data));
}

export function loadDemoSharedLiabilities(): ExpenseLiability[] {
  try {
    const raw = universalStorage.getItem(DEMO_SHARED_LIABILITIES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveDemoSharedLiabilities(data: ExpenseLiability[]): void {
  universalStorage.setItem(DEMO_SHARED_LIABILITIES_KEY, JSON.stringify(data));
}

export function loadDemoPaymentDeclarations(): ExpensePaymentDeclaration[] {
  try {
    const raw = universalStorage.getItem(DEMO_PAYMENT_DECLARATIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveDemoPaymentDeclarations(data: ExpensePaymentDeclaration[]): void {
  universalStorage.setItem(DEMO_PAYMENT_DECLARATIONS_KEY, JSON.stringify(data));
}

export function loadDemoPaymentApprovals(): ExpensePaymentApproval[] {
  try {
    const raw = universalStorage.getItem(DEMO_PAYMENT_APPROVALS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveDemoPaymentApprovals(data: ExpensePaymentApproval[]): void {
  universalStorage.setItem(DEMO_PAYMENT_APPROVALS_KEY, JSON.stringify(data));
}

export function loadDemoApprovalRevocations(): ExpenseApprovalRevocation[] {
  try {
    const raw = universalStorage.getItem(DEMO_APPROVAL_REVOCATIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveDemoApprovalRevocations(data: ExpenseApprovalRevocation[]): void {
  universalStorage.setItem(DEMO_APPROVAL_REVOCATIONS_KEY, JSON.stringify(data));
}

export function loadDemoSupplierRefunds(): SupplierRefundEvent[] {
  try {
    const raw = universalStorage.getItem(DEMO_SUPPLIER_REFUNDS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveDemoSupplierRefunds(data: SupplierRefundEvent[]): void {
  universalStorage.setItem(DEMO_SUPPLIER_REFUNDS_KEY, JSON.stringify(data));
}

// ==============================================================================
// 1. CRIAÇÃO DE DESPESA COMPARTILHADA E CÁLCULO DE RATEIO
// ==============================================================================

export interface CreateSharedExpenseInput {
  spaceId: string;
  title: string;
  description?: string;
  totalOriginalAmountCents: CentsInteger;
  competenceMonth: CompetenceMonthString;
  competenceDate: DateString;
  dueDate?: DateString;
  categoryId: string;
  categoryName: string;
  createdByUid: string;
  responsibleUid: string;
  payerUid?: string;
  originType?: SharedExpenseOriginType;
  originRefId?: string;
  splitMethod: ExpenseLiabilitySplitMethod;
  participants: SplitParticipant[];
  percentages?: Record<string, number>;
  customValues?: Record<string, CentsInteger>;
  idempotencyKey?: string;
}

import { recordSpaceAuditEvent } from './spaceAuditService';
import { getAccountById } from './accountService';

export async function createSharedExpense(
  spaceId: string,
  input: CreateSharedExpenseInput,
  isDemo = false
): Promise<{ expense: SharedExpense; liabilities: ExpenseLiability[] }> {
  if (!validatePositiveCents(input.totalOriginalAmountCents)) {
    throw new Error('O valor da despesa compartilhada deve ser um inteiro positivo em centavos.');
  }
  if (!input.title || !input.title.trim()) {
    throw new Error('O título da despesa compartilhada é obrigatório.');
  }
  if (!input.competenceMonth || !input.competenceMonth.match(/^\d{4}-\d{2}$/)) {
    throw new Error('O mês de competência deve estar no formato YYYY-MM.');
  }
  if (!input.competenceDate || !input.competenceDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
    throw new Error('A data de competência deve estar no formato YYYY-MM-DD.');
  }
  if (!input.createdByUid || !input.responsibleUid) {
    throw new Error('createdByUid e responsibleUid são obrigatórios.');
  }

  // Calcula a divisão estrita de centavos
  const calculatedSplits = calculateExpenseSplit({
    totalAmountCents: input.totalOriginalAmountCents,
    splitMethod: input.splitMethod,
    participants: input.participants,
    percentages: input.percentages,
    customValues: input.customValues,
  });

  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    `idem_exp_${spaceId}_${input.createdByUid}_${input.title.trim()}_${input.totalOriginalAmountCents}_${input.competenceDate}`;

  if (!isDemo) {
    const callable = httpsCallable<
      CreateSharedExpenseInput & { idempotencyKey: string; calculatedSplits: typeof calculatedSplits },
      { expense: SharedExpense; liabilities: ExpenseLiability[] }
    >(functions, 'createSharedExpenseOfficial');

    const res = await callable({
      ...input,
      spaceId,
      idempotencyKey,
      calculatedSplits,
    });
    return res.data;
  }

  return withDemoLock(() => {
    const expenseId = generateSharedExpenseDocId(spaceId, idempotencyKey);
    const existingExpenses = loadDemoSharedExpenses();
    const existing = existingExpenses.find(
      (e) => e.spaceId === spaceId && (e.id === expenseId || e.idempotencyKey === idempotencyKey)
    );

    if (existing) {
      if (
        existing.totalOriginalAmountCents !== input.totalOriginalAmountCents ||
        existing.title !== input.title.trim()
      ) {
        throw new Error(
          'Conflito de idempotência: Chave já utilizada para uma despesa com parâmetros divergentes.'
        );
      }
      const existingLiabs = loadDemoSharedLiabilities().filter((l) => l.expenseId === existing.id);
      return { expense: existing, liabilities: existingLiabs };
    }

    const now = new Date().toISOString();
    const newExpense: SharedExpense = {
      id: expenseId,
      spaceId,
      title: input.title.trim(),
      description: input.description?.trim() || undefined,
      totalOriginalAmountCents: input.totalOriginalAmountCents,
      competenceMonth: input.competenceMonth,
      competenceDate: input.competenceDate,
      dueDate: input.dueDate || undefined,
      categoryId: input.categoryId,
      categoryName: input.categoryName,
      createdByUid: input.createdByUid,
      responsibleUid: input.responsibleUid,
      payerUid: input.payerUid || input.responsibleUid,
      participantUids: input.participants.map((p) => p.uid),
      validationStatus: 'approved',
      validatedByUid: input.responsibleUid,
      validatedAt: now,
      commitmentStatus: 'active',
      paymentExecutionStatus: 'unpaid',
      totalPaidToSupplierCents: 0,
      originType: input.originType || 'manual',
      originRefId: input.originRefId,
      idempotencyKey,
      createdAt: now,
    };

    const newLiabilities: ExpenseLiability[] = calculatedSplits.map((cs) => ({
      id: cs.memberUid,
      expenseId,
      spaceId,
      memberUid: cs.memberUid,
      memberName: cs.memberName,
      assignedShareAmountCents: cs.assignedShareAmountCents,
      originalAmountCents: cs.assignedShareAmountCents,
      refundAdjustmentCents: 0,
      adjustedShareAmountCents: cs.adjustedShareAmountCents,
      paidAmountCents: 0,
      remainingAmountCents: cs.adjustedShareAmountCents,
      creditNoteCents: 0,
      status: 'pending',
      splitMethod: cs.splitMethod,
      splitRatio: cs.splitRatio,
      roundingRemainderRank: cs.roundingRemainderRank,
    }));

    existingExpenses.push(newExpense);
    saveDemoSharedExpenses(existingExpenses);

    const allLiabs = loadDemoSharedLiabilities();
    allLiabs.push(...newLiabilities);
    saveDemoSharedLiabilities(allLiabs);

    // Notificações em modo demo para participantes
    for (const cs of calculatedSplits) {
      if (cs.memberUid !== input.createdByUid) {
        sendSpaceNotification(
          {
            userId: cs.memberUid,
            spaceId,
            spaceName: 'Espaço Compartilhado',
            type: 'shared_expense_assigned',
            title: 'Nova despesa compartilhada',
            message: `Você possui uma cota de R$ ${(cs.assignedShareAmountCents / 100).toFixed(2)} referente a "${input.title}".`,
            originEventId: expenseId,
          },
          true
        ).catch(() => {});
      }
    }

    return { expense: newExpense, liabilities: newLiabilities };
  });
}

// ==============================================================================
// 2. CONSULTAS DE DESPESAS E OBRIGAÇÕES
// ==============================================================================

export async function getSharedExpenses(
  spaceId: string,
  userId: string,
  isDemo = false
): Promise<SharedExpense[]> {
  if (!isDemo) {
    const colRef = collection(db, 'spaces', spaceId, 'shared_expenses');
    const snap = await getDocs(colRef);
    return snap.docs.map((d) => d.data() as SharedExpense);
  }

  const all = loadDemoSharedExpenses();
  return all.filter((e) => e.spaceId === spaceId);
}

export async function getExpenseById(
  spaceId: string,
  expenseId: string,
  userId: string,
  isDemo = false
): Promise<SharedExpense | null> {
  if (!isDemo) {
    const docRef = doc(db, 'spaces', spaceId, 'shared_expenses', expenseId);
    const snap = await getDoc(docRef);
    return snap.exists() ? (snap.data() as SharedExpense) : null;
  }

  const all = loadDemoSharedExpenses();
  return all.find((e) => e.spaceId === spaceId && e.id === expenseId) || null;
}

export async function getExpenseLiabilities(
  spaceId: string,
  expenseId: string,
  isDemo = false
): Promise<ExpenseLiability[]> {
  if (!isDemo) {
    const colRef = collection(db, 'spaces', spaceId, 'shared_expenses', expenseId, 'liabilities');
    const snap = await getDocs(colRef);
    return snap.docs.map((d) => d.data() as ExpenseLiability);
  }

  const all = loadDemoSharedLiabilities();
  return all.filter((l) => l.spaceId === spaceId && l.expenseId === expenseId);
}

export async function getUserSpaceLiabilities(
  spaceId: string,
  userId: string,
  isDemo = false
): Promise<ExpenseLiability[]> {
  if (!isDemo) {
    const expenses = await getSharedExpenses(spaceId, userId, isDemo);
    const results: ExpenseLiability[] = [];
    for (const exp of expenses) {
      const liabRef = doc(db, 'spaces', spaceId, 'shared_expenses', exp.id, 'liabilities', userId);
      const snap = await getDoc(liabRef);
      if (snap.exists()) {
        results.push(snap.data() as ExpenseLiability);
      }
    }
    return results;
  }

  const all = loadDemoSharedLiabilities();
  return all.filter((l) => l.spaceId === spaceId && l.memberUid === userId);
}

// ==============================================================================
// 3. DECLARAÇÃO DE PAGAMENTO PELO DEVEDOR
// ==============================================================================

export interface DeclareExpensePaymentInput {
  spaceId: string;
  expenseId: string;
  memberUid: string;
  memberName: string;
  amountCents: CentsInteger;
  paymentDate: DateString;
  paymentMethod: PaymentDeclarationMethod;
  sourceAccountId?: string;
  proofUrl?: string;
  notes?: string;
  idempotencyKey?: string;
}

export async function declareExpensePayment(
  input: DeclareExpensePaymentInput,
  isDemo = false
): Promise<ExpensePaymentDeclaration> {
  if (!validatePositiveCents(input.amountCents)) {
    throw new Error('O valor do pagamento declarado deve ser um inteiro positivo em centavos.');
  }
  if (!input.paymentDate || !input.paymentDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
    throw new Error('A data do pagamento deve estar no formato YYYY-MM-DD.');
  }

  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    `idem_decl_${input.expenseId}_${input.memberUid}_${input.amountCents}_${input.paymentDate}`;

  if (!isDemo) {
    const callable = httpsCallable<
      DeclareExpensePaymentInput & { idempotencyKey: string },
      ExpensePaymentDeclaration
    >(functions, 'declareExpensePaymentOfficial');

    const res = await callable({
      ...input,
      idempotencyKey,
    });
    return res.data;
  }

  return withDemoLock(() => {
    const expenses = loadDemoSharedExpenses();
    const expense = expenses.find((e) => e.id === input.expenseId && e.spaceId === input.spaceId);
    if (!expense) {
      throw new Error(`Despesa "${input.expenseId}" não encontrada no espaço "${input.spaceId}".`);
    }

    const liabilities = loadDemoSharedLiabilities();
    const liability = liabilities.find(
      (l) => l.expenseId === input.expenseId && l.memberUid === input.memberUid
    );
    if (!liability) {
      throw new Error(
        `O participante "${input.memberUid}" não possui cota de responsabilidade nesta despesa.`
      );
    }

    const declarations = loadDemoPaymentDeclarations();
    const declId = generatePaymentDeclarationDocId(input.expenseId, idempotencyKey);
    const existing = declarations.find(
      (d) => d.id === declId || d.idempotencyKey === idempotencyKey
    );
    if (existing) {
      if (
        existing.amountCents !== input.amountCents ||
        existing.paymentDate !== input.paymentDate
      ) {
        throw new Error(
          'Conflito de idempotência: Declaração já registrada com parâmetros divergentes.'
        );
      }
      return existing;
    }

    const remaining = liability.remainingAmountCents ?? liability.adjustedShareAmountCents;
    if (input.amountCents > remaining) {
      throw new Error(
        `Valor declarado (R$ ${(input.amountCents / 100).toFixed(2)}) excede o saldo devedor restante (R$ ${(remaining / 100).toFixed(2)}).`
      );
    }

    const now = new Date().toISOString();
    const newDecl: ExpensePaymentDeclaration = {
      id: declId,
      expenseId: input.expenseId,
      spaceId: input.spaceId,
      memberUid: input.memberUid,
      memberName: input.memberName,
      responsibleUid: expense.responsibleUid,
      payerUid: expense.payerUid || expense.responsibleUid,
      amountCents: input.amountCents,
      paymentDate: input.paymentDate,
      paymentMethod: input.paymentMethod || 'pix',
      sourceAccountId: input.sourceAccountId,
      proofUrl: input.proofUrl,
      notes: input.notes?.trim() || undefined,
      status: 'pending_validation',
      idempotencyKey,
      createdAt: now,
      updatedAt: now,
    };

    declarations.push(newDecl);
    saveDemoPaymentDeclarations(declarations);

    // Atualiza status da obrigação para 'in_validation' sem alterar o paidAmountCents ainda
    liability.status = 'in_validation';
    saveDemoSharedLiabilities(liabilities);

    // Notificação em modo demo ao responsável financeiro
    sendSpaceNotification(
      {
        userId: expense.responsibleUid,
        spaceId: input.spaceId,
        spaceName: 'Espaço Compartilhado',
        type: 'payment_declaration_submitted',
        title: 'Nova declaração de pagamento',
        message: `${input.memberName} declarou o pagamento de R$ ${(input.amountCents / 100).toFixed(2)} referente à cota de "${expense.title}".`,
        originEventId: declId,
      },
      true
    ).catch(() => {});

    return newDecl;
  });
}

export async function getExpensePaymentDeclarations(
  spaceId: string,
  expenseId: string,
  isDemo = false
): Promise<ExpensePaymentDeclaration[]> {
  if (!isDemo) {
    const colRef = collection(db, 'spaces', spaceId, 'shared_expenses', expenseId, 'payment_declarations');
    const apprRef = collection(db, 'spaces', spaceId, 'shared_expenses', expenseId, 'payment_approvals');
    const rejRef = collection(db, 'spaces', spaceId, 'shared_expenses', expenseId, 'payment_rejections');
    const revocRef = collection(db, 'spaces', spaceId, 'shared_expenses', expenseId, 'approval_revocations');

    const [declSnap, apprSnap, rejSnap, revocSnap] = await Promise.all([
      getDocs(colRef),
      getDocs(apprRef),
      getDocs(rejRef),
      getDocs(revocRef),
    ]);

    const approvals = apprSnap.docs.map((d) => d.data() as ExpensePaymentApproval);
    const rejections = rejSnap.docs.map((d) => d.data() as ExpensePaymentRejection);
    const revocations = revocSnap.docs.map((d) => d.data() as ExpenseApprovalRevocation);

    return declSnap.docs.map((d) => {
      const decl = d.data() as ExpensePaymentDeclaration;
      const rej = rejections.find((r) => r.declarationId === decl.id);
      if (rej) {
        return { ...decl, status: 'rejected' as const, rejectionReason: rej.reason };
      }
      const appr = approvals.find((a) => a.declarationId === decl.id);
      if (appr) {
        const hasRevoc = revocations.some((rev) => rev.approvalId === appr.id) || Boolean(appr.isRevoked);
        return { ...decl, status: (hasRevoc ? 'cancelled' : 'approved') as PaymentDeclarationStatus };
      }
      return { ...decl, status: 'pending_validation' as const };
    });
  }

  const allDecls = loadDemoPaymentDeclarations().filter((d) => d.spaceId === spaceId && d.expenseId === expenseId);
  const approvals = loadDemoPaymentApprovals().filter((a) => a.spaceId === spaceId && a.expenseId === expenseId);
  const rejections = loadDemoPaymentRejections().filter((r) => r.spaceId === spaceId && r.expenseId === expenseId);
  const revocations = loadDemoApprovalRevocations().filter((rev) => rev.spaceId === spaceId && rev.expenseId === expenseId);

  return allDecls.map((decl) => {
    const rej = rejections.find((r) => r.declarationId === decl.id);
    if (rej) {
      return { ...decl, status: 'rejected', rejectionReason: rej.reason };
    }
    const appr = approvals.find((a) => a.declarationId === decl.id);
    if (appr) {
      const hasRevoc = revocations.some((rev) => rev.approvalId === appr.id) || Boolean(appr.isRevoked);
      return { ...decl, status: hasRevoc ? 'cancelled' : 'approved' };
    }
    return { ...decl, status: 'pending_validation' };
  });
}

export async function getSpacePendingDeclarations(
  spaceId: string,
  responsibleUid: string,
  isDemo = false
): Promise<ExpensePaymentDeclaration[]> {
  const expenses = await getSharedExpenses(spaceId, responsibleUid, isDemo);
  const myExpenses = expenses.filter((e) => e.responsibleUid === responsibleUid);
  const results: ExpensePaymentDeclaration[] = [];
  for (const exp of myExpenses) {
    const decls = await getExpensePaymentDeclarations(spaceId, exp.id, isDemo);
    results.push(...decls.filter((d) => d.status === 'pending_validation'));
  }
  return results;
}

/**
 * Consulta aprovações de uma despesa derivando o estado `isRevoked` em memória
 * a partir dos eventos independentes em `approval_revocations`, mantendo
 * o documento armazenado de `ExpensePaymentApproval` 100% imutável.
 */
export async function getExpensePaymentApprovals(
  spaceId: string,
  expenseId: string,
  isDemo = false
): Promise<ExpensePaymentApproval[]> {
  if (!isDemo) {
    const apprRef = collection(db, 'spaces', spaceId, 'shared_expenses', expenseId, 'payment_approvals');
    const revocRef = collection(db, 'spaces', spaceId, 'shared_expenses', expenseId, 'approval_revocations');
    const [apprSnap, revocSnap] = await Promise.all([getDocs(apprRef), getDocs(revocRef)]);
    const revocations = revocSnap.docs.map((d) => d.data() as ExpenseApprovalRevocation);

    return apprSnap.docs.map((d) => {
      const appr = d.data() as ExpensePaymentApproval;
      const revoc = revocations.find((r) => r.approvalId === appr.id);
      return {
        ...appr,
        isRevoked: Boolean(revoc) || Boolean(appr.isRevoked),
        revokedAt: revoc?.revokedAt || appr.revokedAt,
        revocationId: revoc?.id || appr.revocationId,
      };
    });
  }

  const approvals = loadDemoPaymentApprovals().filter((a) => a.spaceId === spaceId && a.expenseId === expenseId);
  const revocations = loadDemoApprovalRevocations().filter((r) => r.spaceId === spaceId && r.expenseId === expenseId);

  return approvals.map((appr) => {
    const revoc = revocations.find((r) => r.approvalId === appr.id);
    return {
      ...appr,
      isRevoked: Boolean(revoc) || Boolean(appr.isRevoked),
      revokedAt: revoc?.revokedAt || appr.revokedAt,
      revocationId: revoc?.id || appr.revocationId,
    };
  });
}

export async function getExpenseApprovalRevocations(
  spaceId: string,
  expenseId: string,
  isDemo = false
): Promise<ExpenseApprovalRevocation[]> {
  if (!isDemo) {
    const revocRef = collection(db, 'spaces', spaceId, 'shared_expenses', expenseId, 'approval_revocations');
    const snap = await getDocs(revocRef);
    return snap.docs.map((d) => d.data() as ExpenseApprovalRevocation);
  }
  return loadDemoApprovalRevocations().filter((r) => r.spaceId === spaceId && r.expenseId === expenseId);
}

export async function getExpensePaymentRejections(
  spaceId: string,
  expenseId: string,
  isDemo = false
): Promise<ExpensePaymentRejection[]> {
  if (!isDemo) {
    const rejRef = collection(db, 'spaces', spaceId, 'shared_expenses', expenseId, 'payment_rejections');
    const snap = await getDocs(rejRef);
    return snap.docs.map((d) => d.data() as ExpensePaymentRejection);
  }
  return loadDemoPaymentRejections().filter((r) => r.spaceId === spaceId && r.expenseId === expenseId);
}

export async function getSpacePaymentApprovals(
  spaceId: string,
  userId: string,
  isDemo = false
): Promise<ExpensePaymentApproval[]> {
  const expenses = await getSharedExpenses(spaceId, userId, isDemo);
  const results: ExpensePaymentApproval[] = [];
  for (const exp of expenses) {
    const apprs = await getExpensePaymentApprovals(spaceId, exp.id, isDemo);
    results.push(...apprs);
  }
  return results;
}

export async function getSpaceApprovalRevocations(
  spaceId: string,
  userId: string,
  isDemo = false
): Promise<ExpenseApprovalRevocation[]> {
  const expenses = await getSharedExpenses(spaceId, userId, isDemo);
  const results: ExpenseApprovalRevocation[] = [];
  for (const exp of expenses) {
    const revocs = await getExpenseApprovalRevocations(spaceId, exp.id, isDemo);
    results.push(...revocs);
  }
  return results;
}

// ==============================================================================
// 4. APROVAÇÃO DE PAGAMENTO PELO RESPONSÁVEL FINANCEIRO (CREDOR)
// ==============================================================================

export interface ApproveExpensePaymentInput {
  spaceId: string;
  expenseId: string;
  declarationId: string;
  approverUid: string;
  destinationAccountId?: string;
  idempotencyKey?: string;
}

export async function approveExpensePayment(
  input: ApproveExpensePaymentInput,
  isDemo = false
): Promise<{
  approval: ExpensePaymentApproval;
  liability: ExpenseLiability;
  movement?: FinancialMovement;
}> {
  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    `idem_val_${input.declarationId}_approved`;

  if (!isDemo) {
    const callable = httpsCallable<
      ApproveExpensePaymentInput & { decision: 'approved'; idempotencyKey: string },
      {
        approval: ExpensePaymentApproval;
        liability: ExpenseLiability;
        movement?: FinancialMovement;
      }
    >(functions, 'validateExpensePaymentOfficial');

    const res = await callable({
      ...input,
      decision: 'approved',
      idempotencyKey,
    });
    return res.data;
  }

  return withDemoLock(async () => {
    const expenses = loadDemoSharedExpenses();
    const expense = expenses.find((e) => e.id === input.expenseId && e.spaceId === input.spaceId);
    if (!expense) {
      throw new Error(`Despesa "${input.expenseId}" não encontrada.`);
    }

    // REGRA DE SEGURANÇA ABSOLUTA: Somente responsibleUid pode validar
    if (expense.responsibleUid !== input.approverUid) {
      throw new Error(
        `Acesso negado: Somente o responsável financeiro da despesa (${expense.responsibleUid}) pode aprovar pagamentos.`
      );
    }

    const declarations = loadDemoPaymentDeclarations();
    const decl = declarations.find((d) => d.id === input.declarationId);
    if (!decl) {
      throw new Error(`Declaração de pagamento "${input.declarationId}" não encontrada.`);
    }
    if (decl.expenseId !== input.expenseId || decl.spaceId !== input.spaceId) {
      throw new Error('Declaração não pertence à despesa ou ao espaço informados.');
    }

    const rejections = loadDemoPaymentRejections();
    if (rejections.some((r) => r.declarationId === input.declarationId)) {
      throw new Error('Esta declaração de pagamento já foi rejeitada e não pode ser aprovada.');
    }

    const approvals = loadDemoPaymentApprovals();
    const revocations = loadDemoApprovalRevocations();
    const approvalId = generatePaymentApprovalDocId(input.declarationId, idempotencyKey);
    const existing = approvals.find((a) => a.id === approvalId || a.declarationId === input.declarationId);
    if (existing) {
      if (revocations.some((r) => r.approvalId === existing.id) || existing.isRevoked) {
        throw new Error('A aprovação desta declaração já foi revogada anteriormente.');
      }
      if ((existing.destinationAccountId || undefined) !== (input.destinationAccountId || undefined)) {
        throw new Error(
          'Conflito de idempotência: Aprovação já registrada com conta de destino divergente.'
        );
      }
      const liabs = loadDemoSharedLiabilities();
      const liab = liabs.find((l) => l.expenseId === input.expenseId && l.memberUid === decl.memberUid)!;
      return { approval: existing, liability: liab };
    }

    if (decl.status === 'approved') {
      throw new Error('Esta declaração de pagamento já foi previamente aprovada.');
    }

    const liabilities = loadDemoSharedLiabilities();
    const liability = liabilities.find(
      (l) => l.expenseId === input.expenseId && l.memberUid === decl.memberUid
    );
    if (!liability) {
      throw new Error('Obrigação do membro não encontrada.');
    }

    const beneficiaryUid = expense.payerUid || expense.responsibleUid;
    const now = new Date().toISOString();
    let financialMovement: FinancialMovement | undefined;

    // Se uma conta de destino foi fornecida, registra o crédito contábil real para o beneficiário (payerUid)
    if (input.destinationAccountId) {
      financialMovement = await recordMovement(
        {
          accountId: input.destinationAccountId,
          userId: beneficiaryUid,
          direction: 'inflow',
          amountCents: decl.amountCents,
          effectiveDate: decl.paymentDate,
          originType: 'shared_reimbursement',
          originId: approvalId,
          description: `Reembolso de rateio recebido: ${expense.title} (${decl.memberName})`,
          notes: `Aprovação de pagamento da cota de ${decl.memberName} no espaço ${input.spaceId}.`,
          authorUid: input.approverUid,
          idempotencyKey: `reimb_mov_${approvalId}`,
        },
        true
      );
    }

    // REGRA DE IMUTABILIDADE ESTRITA (FRENTE A):
    // O registro de ExpensePaymentApproval é criado sem flags mutáveis e NUNCA é editado posteriormente.
    const approval: ExpensePaymentApproval = {
      id: approvalId,
      expenseId: input.expenseId,
      spaceId: input.spaceId,
      declarationId: input.declarationId,
      liabilityId: decl.memberUid,
      memberUid: decl.memberUid,
      responsibleUid: expense.responsibleUid,
      beneficiaryUid,
      amountCents: decl.amountCents,
      destinationAccountId: input.destinationAccountId,
      financialMovementId: financialMovement?.id,
      approvedAt: now,
      approverUid: input.approverUid,
      idempotencyKey,
      createdAt: now,
    };

    approvals.push(approval);
    saveDemoPaymentApprovals(approvals);

    // REGRA DE IMUTABILIDADE: O documento da declaração original NÃO é alterado em disco/storage!

    // Atualiza saldo da obrigação
    const currentPaid = liability.paidAmountCents || 0;
    const newPaid = currentPaid + decl.amountCents;
    const adjusted = liability.adjustedShareAmountCents;
    const remaining = Math.max(0, adjusted - newPaid);
    const creditNote = Math.max(0, newPaid - adjusted);
    liability.paidAmountCents = newPaid;
    liability.remainingAmountCents = remaining;
    liability.creditNoteCents = creditNote;
    const newStatus = remaining === 0 ? 'paid' : 'partially_paid';
    liability.status = newStatus;
    saveDemoSharedLiabilities(liabilities);

    recordSpaceAuditEvent(
      {
        spaceId: input.spaceId,
        eventType: 'payment_approved',
        performedByUid: input.approverUid,
        performedByName: 'Responsável Financeiro',
        targetUid: decl.memberUid,
        targetName: decl.memberName,
        eventId: `audit_appr_${approvalId}`,
        details: {
          expenseId: input.expenseId,
          declarationId: input.declarationId,
          approvalId,
          beneficiaryUid,
          amountCents: decl.amountCents,
          financialMovementId: financialMovement?.id || null,
        },
      },
      true
    ).catch(() => {});

    // Notificação ao devedor
    sendSpaceNotification(
      {
        userId: decl.memberUid,
        spaceId: input.spaceId,
        spaceName: 'Espaço Compartilhado',
        type: 'payment_approved',
        title: 'Pagamento aprovado!',
        message: `Seu pagamento de R$ ${(decl.amountCents / 100).toFixed(2)} referente a "${expense.title}" foi aprovado pelo responsável.`,
        originEventId: approvalId,
      },
      true
    ).catch(() => {});

    if (newStatus === 'paid') {
      sendSpaceNotification(
        {
          userId: decl.memberUid,
          spaceId: input.spaceId,
          spaceName: 'Espaço Compartilhado',
          type: 'liability_settled',
          title: 'Cota quitada integralmente!',
          message: `Sua participação na despesa "${expense.title}" foi totalmente liquidada.`,
          originEventId: approvalId,
        },
        true
      ).catch(() => {});
    }

    if (beneficiaryUid !== input.approverUid) {
      sendSpaceNotification(
        {
          userId: beneficiaryUid,
          spaceId: input.spaceId,
          spaceName: 'Espaço Compartilhado',
          type: 'payment_approved',
          title: 'Reembolso creditado',
          message: `Foi aprovado o reembolso de R$ ${(decl.amountCents / 100).toFixed(2)} de ${decl.memberName} referente a "${expense.title}".`,
          originEventId: approvalId,
        },
        true
      ).catch(() => {});
    }

    return { approval, liability, movement: financialMovement };
  });
}

// ==============================================================================
// 5. REJEIÇÃO DE PAGAMENTO PELO RESPONSÁVEL FINANCEIRO (COM JUSTIFICATIVA)
// ==============================================================================

export interface RejectExpensePaymentInput {
  spaceId: string;
  expenseId: string;
  declarationId: string;
  rejecterUid: string;
  rejectionReason: string;
  idempotencyKey?: string;
}

export async function rejectExpensePayment(
  input: RejectExpensePaymentInput,
  isDemo = false
): Promise<{
  rejection: ExpensePaymentRejection;
  declaration: ExpensePaymentDeclaration;
  liability: ExpenseLiability;
}> {
  if (!input.rejectionReason || !input.rejectionReason.trim()) {
    throw new Error('A justificativa da rejeição do pagamento é estritamente obrigatória.');
  }

  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    `idem_val_${input.declarationId}_rejected`;

  if (!isDemo) {
    const callable = httpsCallable<
      RejectExpensePaymentInput & { decision: 'rejected'; idempotencyKey: string },
      { rejection: ExpensePaymentRejection; declaration: ExpensePaymentDeclaration; liability: ExpenseLiability }
    >(functions, 'validateExpensePaymentOfficial');

    const res = await callable({
      ...input,
      decision: 'rejected',
      idempotencyKey,
    });
    return res.data;
  }

  return withDemoLock(() => {
    const expenses = loadDemoSharedExpenses();
    const expense = expenses.find((e) => e.id === input.expenseId && e.spaceId === input.spaceId);
    if (!expense) {
      throw new Error(`Despesa "${input.expenseId}" não encontrada.`);
    }

    if (expense.responsibleUid !== input.rejecterUid) {
      throw new Error(
        `Acesso negado: Somente o responsável financeiro da despesa (${expense.responsibleUid}) pode rejeitar pagamentos.`
      );
    }

    const declarations = loadDemoPaymentDeclarations();
    const decl = declarations.find((d) => d.id === input.declarationId);
    if (!decl) {
      throw new Error(`Declaração de pagamento "${input.declarationId}" não encontrada.`);
    }

    const approvals = loadDemoPaymentApprovals();
    if (approvals.some((a) => a.declarationId === input.declarationId)) {
      throw new Error('Esta declaração já foi aprovada e não pode ser rejeitada diretamente.');
    }

    const liabilities = loadDemoSharedLiabilities();
    const liability = liabilities.find(
      (l) => l.expenseId === input.expenseId && l.memberUid === decl.memberUid
    );
    if (!liability) {
      throw new Error('Obrigação do membro não encontrada.');
    }

    const rejections = loadDemoPaymentRejections();
    const rejectionId = generatePaymentRejectionDocId(input.declarationId, idempotencyKey);
    const existing = rejections.find((r) => r.id === rejectionId || r.declarationId === input.declarationId);
    if (existing) {
      if (existing.reason !== input.rejectionReason.trim()) {
        throw new Error('Conflito de idempotência: Rejeição já registrada com justificativa divergente.');
      }
      return {
        rejection: existing,
        declaration: { ...decl, status: 'rejected', rejectionReason: existing.reason },
        liability,
      };
    }

    const now = new Date().toISOString();
    const rejection: ExpensePaymentRejection = {
      id: rejectionId,
      expenseId: input.expenseId,
      spaceId: input.spaceId,
      declarationId: input.declarationId,
      liabilityId: decl.memberUid,
      memberUid: decl.memberUid,
      responsibleUid: expense.responsibleUid,
      amountCents: decl.amountCents,
      reason: input.rejectionReason.trim(),
      rejectionReason: input.rejectionReason.trim(),
      rejectedByUid: input.rejecterUid,
      rejectedAt: now,
      idempotencyKey,
      createdAt: now,
    };

    rejections.push(rejection);
    saveDemoPaymentRejections(rejections);

    // REGRA DE IMUTABILIDADE: O documento da declaração original NÃO é alterado em disco!

    // Restabelece o status da obrigação sem alterar valores pagos
    const currentPaid = liability.paidAmountCents || 0;
    liability.status = currentPaid > 0 ? 'partially_paid' : 'pending';
    saveDemoSharedLiabilities(liabilities);

    recordSpaceAuditEvent(
      {
        spaceId: input.spaceId,
        eventType: 'payment_rejected',
        performedByUid: input.rejecterUid,
        performedByName: 'Responsável Financeiro',
        targetUid: decl.memberUid,
        targetName: decl.memberName,
        eventId: `audit_rej_${rejectionId}`,
        details: {
          expenseId: input.expenseId,
          declarationId: input.declarationId,
          rejectionId,
          amountCents: decl.amountCents,
          reason: input.rejectionReason.trim(),
        },
      },
      true
    ).catch(() => {});

    // Notificação ao devedor
    sendSpaceNotification(
      {
        userId: decl.memberUid,
        spaceId: input.spaceId,
        spaceName: 'Espaço Compartilhado',
        type: 'payment_rejected',
        title: 'Pagamento de rateio recusado',
        message: `O pagamento de R$ ${(decl.amountCents / 100).toFixed(2)} em "${expense.title}" foi recusado pelo responsável. Motivo: ${input.rejectionReason.trim()}`,
        originEventId: rejectionId,
      },
      true
    ).catch(() => {});

    return {
      rejection,
      declaration: { ...decl, status: 'rejected', rejectionReason: input.rejectionReason.trim() },
      liability,
    };
  });
}

// ==============================================================================
// 6. REVOGAÇÃO DE APROVAÇÃO PELO RESPONSÁVEL (HISTÓRICO IMUTÁVEL APPEND-ONLY)
// ==============================================================================

export interface RevokeExpensePaymentApprovalInput {
  spaceId: string;
  expenseId: string;
  approvalId: string;
  revokerUid: string;
  reason: string;
  idempotencyKey?: string;
}

export async function revokeExpensePaymentApproval(
  input: RevokeExpensePaymentApprovalInput,
  isDemo = false
): Promise<{
  revocation: ExpenseApprovalRevocation;
  liability: ExpenseLiability;
  compensatoryMovement?: FinancialMovement;
}> {
  if (!input.reason || !input.reason.trim()) {
    throw new Error('O motivo da revogação da aprovação é obrigatório.');
  }

  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    `idem_revoc_${input.approvalId}`;

  if (!isDemo) {
    const callable = httpsCallable<
      RevokeExpensePaymentApprovalInput & { idempotencyKey: string },
      {
        revocation: ExpenseApprovalRevocation;
        liability: ExpenseLiability;
        compensatoryMovement?: FinancialMovement;
      }
    >(functions, 'revokeExpensePaymentApprovalOfficial');

    const res = await callable({
      ...input,
      idempotencyKey,
    });
    return res.data;
  }

  return withDemoLock(async () => {
    const expenses = loadDemoSharedExpenses();
    const expense = expenses.find((e) => e.id === input.expenseId && e.spaceId === input.spaceId);
    if (!expense) {
      throw new Error(`Despesa "${input.expenseId}" não encontrada.`);
    }

    if (expense.responsibleUid !== input.revokerUid) {
      throw new Error(
        `Acesso negado: Somente o responsável financeiro da despesa (${expense.responsibleUid}) pode revogar aprovações.`
      );
    }

    const approvals = loadDemoPaymentApprovals();
    const approval = approvals.find((a) => a.id === input.approvalId);
    if (!approval) {
      throw new Error(`Aprovação "${input.approvalId}" não encontrada.`);
    }
    if (approval.expenseId !== input.expenseId || approval.spaceId !== input.spaceId) {
      throw new Error('A aprovação informada não pertence à despesa ou ao espaço especificados.');
    }

    const revocations = loadDemoApprovalRevocations();
    const revocationId = generateApprovalRevocationDocId(input.approvalId, idempotencyKey);
    const existing = revocations.find(
      (r) => r.id === revocationId || r.approvalId === input.approvalId
    );
    if (existing) {
      if (existing.reason !== input.reason.trim()) {
        throw new Error(
          'Conflito de idempotência: Aprovação já revogada com motivo divergente.'
        );
      }
      const liabs = loadDemoSharedLiabilities();
      const liab = liabs.find((l) => l.expenseId === input.expenseId && l.memberUid === approval.memberUid)!;
      return { revocation: existing, liability: liab };
    }

    if (approval.isRevoked) {
      throw new Error('Esta aprovação de pagamento já se encontra revogada.');
    }

    const liabilities = loadDemoSharedLiabilities();
    const liability = liabilities.find(
      (l) => l.expenseId === input.expenseId && l.memberUid === approval.memberUid
    );
    if (!liability) {
      throw new Error('Obrigação do membro não encontrada.');
    }

    const beneficiaryUid = approval.beneficiaryUid || expense.payerUid || expense.responsibleUid;
    let compensatoryMovement: FinancialMovement | undefined;
    let requiresRestitution = false;
    let restitutionPendingCents = 0;

    if (approval.financialMovementId && approval.destinationAccountId) {
      const acc = await getAccountById(approval.destinationAccountId, beneficiaryUid, true);
      if (acc) {
        const currentBal = acc.projectedBalanceCents || 0;
        if (currentBal < approval.amountCents) {
          requiresRestitution = true;
          restitutionPendingCents = approval.amountCents - Math.max(0, currentBal);
        }
      }

      const reasonSummary = requiresRestitution
        ? `Revogação de aprovação (Estorno contábil — Restituição financeira pendente de R$ ${(restitutionPendingCents / 100).toFixed(2)} pois o saldo já foi utilizado): ${input.reason.trim()}`
        : `Revogação de aprovação (Ajuste exclusivamente contábil, não representa transferência bancária automática): ${input.reason.trim()}`;

      const res = await reverseMovement(
        approval.destinationAccountId,
        approval.financialMovementId,
        input.revokerUid,
        reasonSummary,
        true
      );
      compensatoryMovement = res.compensatoryMovement;
    }

    const now = new Date().toISOString();
    const revocation: ExpenseApprovalRevocation = {
      id: revocationId,
      expenseId: input.expenseId,
      spaceId: input.spaceId,
      approvalId: input.approvalId,
      declarationId: approval.declarationId,
      liabilityId: approval.liabilityId || approval.memberUid,
      memberUid: approval.memberUid,
      responsibleUid: expense.responsibleUid,
      beneficiaryUid,
      revokedAmountCents: approval.amountCents,
      compensatoryMovementId: compensatoryMovement?.id,
      requiresRestitution,
      restitutionPendingCents,
      reason: input.reason.trim(),
      revokedByUid: input.revokerUid,
      revokedAt: now,
      idempotencyKey,
      createdAt: now,
    };

    revocations.push(revocation);
    saveDemoApprovalRevocations(revocations);

    // REGRA DE IMUTABILIDADE ESTRITA (FRENTE A):
    // O registro original em `payment_approvals` NUNCA sofre mutação (não escrevemos `isRevoked = true` no storage).
    // O estado revogado é derivado exclusivamente da presença de `revocation` em `approval_revocations`.

    // Restaura o saldo da obrigação preservando pagamentos parciais anteriores e ajustes de reembolso comercial (Frentes B e D)
    const currentPaid = liability.paidAmountCents || 0;
    const restoredPaid = Math.max(0, currentPaid - approval.amountCents);
    const original = liability.originalAmountCents ?? liability.assignedShareAmountCents;
    const assigned = liability.assignedShareAmountCents ?? original;
    const refundAdj = liability.refundAdjustmentCents || 0;
    const adjusted = liability.adjustedShareAmountCents ?? Math.max(0, original - refundAdj);
    const remaining = Math.max(0, adjusted - restoredPaid);
    const restoredCreditNote = Math.max(0, restoredPaid - adjusted);

    liability.originalAmountCents = original;
    liability.assignedShareAmountCents = assigned;
    liability.refundAdjustmentCents = refundAdj;
    liability.adjustedShareAmountCents = adjusted;
    liability.paidAmountCents = restoredPaid;
    liability.remainingAmountCents = remaining;
    liability.creditNoteCents = restoredCreditNote;
    liability.status = remaining === 0 ? 'paid' : restoredPaid > 0 ? 'partially_paid' : 'pending';
    saveDemoSharedLiabilities(liabilities);

    recordSpaceAuditEvent(
      {
        spaceId: input.spaceId,
        eventType: 'payment_approval_revoked',
        performedByUid: input.revokerUid,
        performedByName: 'Responsável Financeiro',
        targetUid: approval.memberUid,
        eventId: `audit_revoc_${revocationId}`,
        details: {
          expenseId: input.expenseId,
          approvalId: input.approvalId,
          revocationId,
          declarationId: approval.declarationId,
          beneficiaryUid,
          revokedAmountCents: approval.amountCents,
          compensatoryMovementId: compensatoryMovement?.id || null,
          requiresRestitution,
          restitutionPendingCents,
          reason: input.reason.trim(),
        },
      },
      true
    ).catch(() => {});

    // Notificações
    sendSpaceNotification(
      {
        userId: approval.memberUid,
        spaceId: input.spaceId,
        spaceName: 'Espaço Compartilhado',
        type: 'payment_approval_revoked',
        title: 'Aprovação de pagamento revogada',
        message: `A aprovação do pagamento em "${expense.title}" foi cancelada pelo responsável. Motivo: ${input.reason.trim()}`,
        originEventId: revocationId,
      },
      true
    ).catch(() => {});

    if (beneficiaryUid && beneficiaryUid !== input.revokerUid) {
      sendSpaceNotification(
        {
          userId: beneficiaryUid,
          spaceId: input.spaceId,
          spaceName: 'Espaço Compartilhado',
          type: 'payment_approval_revoked',
          title: 'Reembolso estornado contabilmente',
          message: `O crédito de reembolso referente a "${expense.title}" foi estornado contabilmente pelo responsável. Motivo: ${input.reason.trim()}`,
          originEventId: revocationId,
        },
        true
      ).catch(() => {});
    }

    return { revocation, liability, compensatoryMovement };
  });
}

// ==============================================================================
// 7. REEMBOLSOS E DEVOLUÇÕES DE FORNECEDORES (SUPPLIER REFUNDS)
// ==============================================================================

export interface RecordSupplierRefundInput {
  spaceId: string;
  expenseId: string;
  refundType: SupplierRefundType;
  amountRefundedCents: CentsInteger;
  lossAmountCents?: CentsInteger;
  recipientUid: string;
  destinationAccountId?: string;
  date: DateString;
  justification: string;
  idempotencyKey?: string;
}

export async function recordSupplierRefund(
  input: RecordSupplierRefundInput,
  isDemo = false
): Promise<SupplierRefundEvent> {
  if (!input.justification || !input.justification.trim()) {
    throw new Error('A justificativa da devolução/reembolso do fornecedor é obrigatória.');
  }

  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    `idem_supref_${input.expenseId}_${input.refundType}_${input.amountRefundedCents}_${input.date}`;

  if (!isDemo) {
    const callable = httpsCallable<
      RecordSupplierRefundInput & { idempotencyKey: string },
      SupplierRefundEvent
    >(functions, 'recordSharedRefundOfficial');

    const res = await callable({
      ...input,
      idempotencyKey,
    });
    return res.data;
  }

  return withDemoLock(() => {
    const refunds = loadDemoSupplierRefunds();
    const refundId = generateSupplierRefundDocId(input.expenseId, idempotencyKey);
    const existing = refunds.find((r) => r.id === refundId);
    if (existing) {
      if (existing.amountRefundedCents !== input.amountRefundedCents) {
        throw new Error(
          'Conflito de idempotência: Reembolso comercial já registrado com valor divergente.'
        );
      }
      return existing;
    }

    const now = new Date().toISOString();
    const event: SupplierRefundEvent = {
      id: refundId,
      expenseId: input.expenseId,
      spaceId: input.spaceId,
      refundType: input.refundType,
      amountRefundedCents: input.amountRefundedCents,
      lossAmountCents: input.lossAmountCents || 0,
      recipientUid: input.recipientUid,
      destinationAccountId: input.destinationAccountId,
      date: input.date,
      justification: input.justification.trim(),
      createdAt: now,
    };

    refunds.push(event);
    saveDemoSupplierRefunds(refunds);

    // Ajusta proporcionalmente as cotas das obrigações se for reembolso com Maior Resto
    if (input.amountRefundedCents > 0) {
      const expenses = loadDemoSharedExpenses();
      const expense = expenses.find((e) => e.id === input.expenseId);
      if (expense && expense.totalOriginalAmountCents > 0) {
        const liabilities = loadDemoSharedLiabilities();
        const expenseLiabs = liabilities.filter((l) => l.expenseId === input.expenseId);

        let allocatedReduction = 0;
        const reductions = expenseLiabs.map((liab) => {
          const orig = liab.originalAmountCents || liab.assignedShareAmountCents || 0;
          const exact = (input.amountRefundedCents * orig) / expense.totalOriginalAmountCents;
          const floor = Math.floor(exact);
          const remainder = exact - floor;
          allocatedReduction += floor;
          return { liab, floor, remainder, reduction: floor };
        });

        let remainderToDistribute = input.amountRefundedCents - allocatedReduction;
        reductions.sort((a, b) => b.remainder - a.remainder);
        for (let i = 0; i < remainderToDistribute; i++) {
          reductions[i].reduction += 1;
        }

        for (const red of reductions) {
          const { liab, reduction } = red;
          const original = liab.originalAmountCents || liab.assignedShareAmountCents;
          const prevRefund = liab.refundAdjustmentCents || 0;
          const newRefund = prevRefund + reduction;
          const newAdjusted = Math.max(0, original - newRefund);
          const paid = liab.paidAmountCents || 0;

          let remaining = 0;
          let creditNote = 0;
          if (paid > newAdjusted) {
            remaining = 0;
            creditNote = paid - newAdjusted;
          } else {
            remaining = newAdjusted - paid;
            creditNote = 0;
          }

          liab.originalAmountCents = original;
          liab.refundAdjustmentCents = newRefund;
          liab.adjustedShareAmountCents = newAdjusted;
          liab.remainingAmountCents = remaining;
          liab.creditNoteCents = creditNote;
          liab.status = remaining === 0 && paid > 0 ? 'paid' : paid > 0 ? 'partially_paid' : liab.status;

          sendSpaceNotification(
            {
              userId: liab.memberUid,
              spaceId: input.spaceId,
              spaceName: 'Espaço Compartilhado',
              type: 'supplier_refund_confirmed',
              title: 'Reembolso comercial confirmado',
              message: `O fornecedor devolveu R$ ${(input.amountRefundedCents / 100).toFixed(2)} em "${expense.title}". Sua cota líquida foi reduzida em R$ ${(reduction / 100).toFixed(2)}.${creditNote > 0 ? ` Você possui um crédito de R$ ${(creditNote / 100).toFixed(2)} a receber.` : ''}`,
              originEventId: refundId,
            },
            true
          ).catch(() => {});
        }
        saveDemoSharedLiabilities(liabilities);
      }
    }

    return event;
  });
}

export async function getExpenseSupplierRefunds(
  spaceId: string,
  expenseId: string,
  isDemo = false
): Promise<SupplierRefundEvent[]> {
  if (!isDemo) {
    const colRef = collection(db, 'spaces', spaceId, 'shared_expenses', expenseId, 'refunds');
    const snap = await getDocs(colRef);
    return snap.docs.map((d) => d.data() as SupplierRefundEvent);
  }

  const all = loadDemoSupplierRefunds();
  return all.filter((r) => r.spaceId === spaceId && r.expenseId === expenseId);
}

// ==============================================================================
// 8. RESUMO FINANCEIRO DO ESPAÇO
// ==============================================================================

export interface SpaceFinancialSummary {
  totalExpensesCents: CentsInteger;
  totalMyPendingToPayCents: CentsInteger;
  totalMyPaidCents: CentsInteger;
  totalMyPendingToReceiveCents: CentsInteger;
  pendingValidationsCount: number;
}

export async function getSpaceFinancialSummary(
  spaceId: string,
  userId: string,
  isDemo = false
): Promise<SpaceFinancialSummary> {
  const expenses = await getSharedExpenses(spaceId, userId, isDemo);
  const totalExpensesCents = expenses.reduce((acc, e) => acc + e.totalOriginalAmountCents, 0);

  let myLiabilities: ExpenseLiability[] = [];
  let allLiabilities: ExpenseLiability[] = [];

  if (isDemo) {
    allLiabilities = loadDemoSharedLiabilities().filter((l) => l.spaceId === spaceId);
    myLiabilities = allLiabilities.filter((l) => l.memberUid === userId);
  } else {
    myLiabilities = await getUserSpaceLiabilities(spaceId, userId, isDemo);
    for (const exp of expenses) {
      const liabs = await getExpenseLiabilities(spaceId, exp.id, isDemo);
      allLiabilities.push(...liabs);
    }
  }

  let totalMyPendingToPayCents = 0;
  let totalMyPaidCents = 0;
  for (const l of myLiabilities) {
    totalMyPaidCents += l.paidAmountCents || 0;
    totalMyPendingToPayCents += l.remainingAmountCents ?? l.adjustedShareAmountCents;
  }

  // Valores a receber: quando o usuário é o credor/beneficiário (payerUid || responsibleUid) da despesa
  let totalMyPendingToReceiveCents = 0;
  const myCreditorExpenseIds = new Set(
    expenses
      .filter((e) => (e.payerUid || e.responsibleUid) === userId)
      .map((e) => e.id)
  );

  for (const l of allLiabilities) {
    if (myCreditorExpenseIds.has(l.expenseId) && l.memberUid !== userId) {
      totalMyPendingToReceiveCents += l.remainingAmountCents ?? l.adjustedShareAmountCents;
    }
  }

  const pendingDeclarations = await getSpacePendingDeclarations(spaceId, userId, isDemo);

  return {
    totalExpensesCents,
    totalMyPendingToPayCents,
    totalMyPaidCents,
    totalMyPendingToReceiveCents,
    pendingValidationsCount: pendingDeclarations.length,
  };
}
