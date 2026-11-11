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
  FinancialMovement,
  ISO8601String,
  PaymentDeclarationMethod,
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
  generateSharedExpenseDocId,
  generateSupplierRefundDocId,
  validatePositiveCents,
} from '../utils/movementLedger';
import { recordMovement, reverseMovement, withDemoLock } from './ledgerService';
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
 * - Revogações: spaces/{spaceId}/shared_expenses/{expenseId}/approval_revocations/{revocationId}
 * - Reembolsos: spaces/{spaceId}/shared_expenses/{expenseId}/refunds/{refundId}
 *
 * Princípios Fundamentais da Fase 6:
 * 1. Segregação Absoluta de Papéis:
 *    - createdByUid: Autor do cadastro
 *    - responsibleUid: Responsável financeiro e credor legítimo para validações
 *    - payerUid: Quem desembolsou ao fornecedor comercial
 * 2. Princípio da Autoridade Exclusiva de Validação:
 *    - SOMENTE o responsibleUid da despesa tem competência para aprovar, rejeitar ou revogar pagamentos.
 *    - Administradores e proprietários do espaço NÃO possuem autoridade universal de aprovação.
 * 3. Conservação Contábil Estrita (Zero Drift):
 *    - A soma das cotas de rateio é exatamente igual ao total da despesa (algoritmo de Maior Resto).
 * 4. Declaração vs Aprovação:
 *    - Declarações pendentes NÃO alteram o saldo oficial da obrigação nem registram créditos na conta.
 *    - Somente a aprovação do credor reconhece a quitação e gera o FinancialMovement na conta bancária.
 * 5. Histórico Imutável e Append-Only:
 *    - Aprovações nunca são deletadas ou alteradas retroativamente.
 *    - Revogações são novos eventos compensatórios que restabelecem o saldo da cota e estornam movimentos.
 */

export const DEMO_SHARED_EXPENSES_KEY = 'mpf_v3_demo_shared_expenses';
export const DEMO_SHARED_LIABILITIES_KEY = 'mpf_v3_demo_shared_liabilities';
export const DEMO_PAYMENT_DECLARATIONS_KEY = 'mpf_v3_demo_payment_declarations';
export const DEMO_PAYMENT_APPROVALS_KEY = 'mpf_v3_demo_payment_approvals';
export const DEMO_APPROVAL_REVOCATIONS_KEY = 'mpf_v3_demo_approval_revocations';
export const DEMO_SUPPLIER_REFUNDS_KEY = 'mpf_v3_demo_supplier_refunds';

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
    `idem_exp_${spaceId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

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
      adjustedShareAmountCents: cs.adjustedShareAmountCents,
      paidAmountCents: 0,
      remainingAmountCents: cs.adjustedShareAmountCents,
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
    `idem_decl_${input.expenseId}_${input.memberUid}_${Date.now()}`;

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

    const remaining = liability.remainingAmountCents ?? liability.adjustedShareAmountCents;
    if (input.amountCents > remaining) {
      throw new Error(
        `Valor declarado (R$ ${(input.amountCents / 100).toFixed(2)}) excede o saldo devedor restante (R$ ${(remaining / 100).toFixed(2)}).`
      );
    }

    const declarations = loadDemoPaymentDeclarations();
    const declId = generatePaymentDeclarationDocId(input.expenseId, idempotencyKey);
    const existing = declarations.find(
      (d) => d.id === declId || d.idempotencyKey === idempotencyKey
    );
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const newDecl: ExpensePaymentDeclaration = {
      id: declId,
      expenseId: input.expenseId,
      spaceId: input.spaceId,
      memberUid: input.memberUid,
      memberName: input.memberName,
      responsibleUid: expense.responsibleUid,
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

    return newDecl;
  });
}

export async function getExpensePaymentDeclarations(
  spaceId: string,
  expenseId: string,
  isDemo = false
): Promise<ExpensePaymentDeclaration[]> {
  if (!isDemo) {
    const colRef = collection(
      db,
      'spaces',
      spaceId,
      'shared_expenses',
      expenseId,
      'payment_declarations'
    );
    const snap = await getDocs(colRef);
    return snap.docs.map((d) => d.data() as ExpensePaymentDeclaration);
  }

  const all = loadDemoPaymentDeclarations();
  return all.filter((d) => d.spaceId === spaceId && d.expenseId === expenseId);
}

export async function getSpacePendingDeclarations(
  spaceId: string,
  responsibleUid: string,
  isDemo = false
): Promise<ExpensePaymentDeclaration[]> {
  if (!isDemo) {
    const expenses = await getSharedExpenses(spaceId, responsibleUid, isDemo);
    const myExpenses = expenses.filter((e) => e.responsibleUid === responsibleUid);
    const results: ExpensePaymentDeclaration[] = [];
    for (const exp of myExpenses) {
      const decls = await getExpensePaymentDeclarations(spaceId, exp.id, isDemo);
      results.push(...decls.filter((d) => d.status === 'pending_validation'));
    }
    return results;
  }

  const all = loadDemoPaymentDeclarations();
  return all.filter(
    (d) =>
      d.spaceId === spaceId &&
      d.responsibleUid === responsibleUid &&
      d.status === 'pending_validation'
  );
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
    `idem_appr_${input.declarationId}_${Date.now()}`;

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

    const approvals = loadDemoPaymentApprovals();
    const approvalId = generatePaymentApprovalDocId(input.declarationId, idempotencyKey);
    const existing = approvals.find((a) => a.id === approvalId || a.idempotencyKey === idempotencyKey);
    if (existing) {
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

    const now = new Date().toISOString();
    let financialMovement: FinancialMovement | undefined;

    // Se uma conta de destino foi fornecida, registra o crédito contábil real para o responsável
    if (input.destinationAccountId) {
      financialMovement = await recordMovement(
        {
          accountId: input.destinationAccountId,
          userId: expense.responsibleUid,
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

    const approval: ExpensePaymentApproval = {
      id: approvalId,
      expenseId: input.expenseId,
      spaceId: input.spaceId,
      declarationId: input.declarationId,
      memberUid: decl.memberUid,
      responsibleUid: expense.responsibleUid,
      amountCents: decl.amountCents,
      destinationAccountId: input.destinationAccountId,
      financialMovementId: financialMovement?.id,
      approvedAt: now,
      approverUid: input.approverUid,
      isRevoked: false,
      idempotencyKey,
      createdAt: now,
    };

    approvals.push(approval);
    saveDemoPaymentApprovals(approvals);

    decl.status = 'approved';
    decl.updatedAt = now;
    saveDemoPaymentDeclarations(declarations);

    // Atualiza saldo da obrigação
    const currentPaid = liability.paidAmountCents || 0;
    const newPaid = currentPaid + decl.amountCents;
    const remaining = liability.adjustedShareAmountCents - newPaid;
    liability.paidAmountCents = newPaid;
    liability.remainingAmountCents = Math.max(0, remaining);
    liability.status = remaining <= 0 ? 'paid' : 'partially_paid';
    saveDemoSharedLiabilities(liabilities);

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
}

export async function rejectExpensePayment(
  input: RejectExpensePaymentInput,
  isDemo = false
): Promise<{
  declaration: ExpensePaymentDeclaration;
  liability: ExpenseLiability;
}> {
  if (!input.rejectionReason || !input.rejectionReason.trim()) {
    throw new Error('A justificativa da rejeição do pagamento é estritamente obrigatória.');
  }

  if (!isDemo) {
    const callable = httpsCallable<
      RejectExpensePaymentInput & { decision: 'rejected' },
      { declaration: ExpensePaymentDeclaration; liability: ExpenseLiability }
    >(functions, 'validateExpensePaymentOfficial');

    const res = await callable({
      ...input,
      decision: 'rejected',
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

    const liabilities = loadDemoSharedLiabilities();
    const liability = liabilities.find(
      (l) => l.expenseId === input.expenseId && l.memberUid === decl.memberUid
    );
    if (!liability) {
      throw new Error('Obrigação do membro não encontrada.');
    }

    const now = new Date().toISOString();
    decl.status = 'rejected';
    decl.rejectionReason = input.rejectionReason.trim();
    decl.updatedAt = now;
    saveDemoPaymentDeclarations(declarations);

    // Restabelece o status da obrigação sem alterar valores pagos
    const currentPaid = liability.paidAmountCents || 0;
    liability.status = currentPaid > 0 ? 'partially_paid' : 'pending';
    saveDemoSharedLiabilities(liabilities);

    return { declaration: decl, liability };
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
    `idem_revoc_${input.approvalId}_${Date.now()}`;

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
    if (approval.isRevoked) {
      throw new Error('Esta aprovação de pagamento já se encontra revogada.');
    }

    const revocations = loadDemoApprovalRevocations();
    const revocationId = generateApprovalRevocationDocId(input.approvalId, idempotencyKey);
    const existing = revocations.find(
      (r) => r.id === revocationId || r.idempotencyKey === idempotencyKey
    );
    if (existing) {
      const liabs = loadDemoSharedLiabilities();
      const liab = liabs.find((l) => l.expenseId === input.expenseId && l.memberUid === approval.memberUid)!;
      return { revocation: existing, liability: liab };
    }

    const liabilities = loadDemoSharedLiabilities();
    const liability = liabilities.find(
      (l) => l.expenseId === input.expenseId && l.memberUid === approval.memberUid
    );
    if (!liability) {
      throw new Error('Obrigação do membro não encontrada.');
    }

    let compensatoryMovement: FinancialMovement | undefined;
    if (approval.financialMovementId && approval.destinationAccountId) {
      const res = await reverseMovement(
        approval.destinationAccountId,
        approval.financialMovementId,
        input.revokerUid,
        `Revogação de aprovação de reembolso: ${input.reason.trim()}`,
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
      memberUid: approval.memberUid,
      responsibleUid: expense.responsibleUid,
      revokedAmountCents: approval.amountCents,
      compensatoryMovementId: compensatoryMovement?.id,
      reason: input.reason.trim(),
      revokedByUid: input.revokerUid,
      revokedAt: now,
      idempotencyKey,
      createdAt: now,
    };

    revocations.push(revocation);
    saveDemoApprovalRevocations(revocations);

    // Marca a aprovação como revogada sem alterar o documento histórico original de declaração
    approval.isRevoked = true;
    approval.revokedAt = now;
    approval.revocationId = revocationId;
    saveDemoPaymentApprovals(approvals);

    // Restaura o saldo da obrigação
    const currentPaid = liability.paidAmountCents || 0;
    const restoredPaid = Math.max(0, currentPaid - approval.amountCents);
    const remaining = liability.adjustedShareAmountCents - restoredPaid;
    liability.paidAmountCents = restoredPaid;
    liability.remainingAmountCents = remaining;
    liability.status = restoredPaid === 0 ? 'pending' : 'partially_paid';
    saveDemoSharedLiabilities(liabilities);

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
    `idem_supref_${input.expenseId}_${Date.now()}`;

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

    // Ajusta proporcionalmente as cotas das obrigações se for reembolso
    if (input.amountRefundedCents > 0) {
      const expenses = loadDemoSharedExpenses();
      const expense = expenses.find((e) => e.id === input.expenseId);
      if (expense && expense.totalOriginalAmountCents > 0) {
        const liabilities = loadDemoSharedLiabilities();
        const expenseLiabs = liabilities.filter((l) => l.expenseId === input.expenseId);
        for (const liab of expenseLiabs) {
          const ratio = liab.assignedShareAmountCents / expense.totalOriginalAmountCents;
          const reduction = Math.round(input.amountRefundedCents * ratio);
          liab.adjustedShareAmountCents = Math.max(0, liab.assignedShareAmountCents - reduction);
          const paid = liab.paidAmountCents || 0;
          liab.remainingAmountCents = Math.max(0, liab.adjustedShareAmountCents - paid);
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

  // Valores a receber: quando o usuário é responsibleUid da despesa
  let totalMyPendingToReceiveCents = 0;
  const myResponsibleExpenseIds = new Set(
    expenses.filter((e) => e.responsibleUid === userId).map((e) => e.id)
  );

  for (const l of allLiabilities) {
    if (myResponsibleExpenseIds.has(l.expenseId) && l.memberUid !== userId) {
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
