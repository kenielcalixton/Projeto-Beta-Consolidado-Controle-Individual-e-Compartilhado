import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  deleteDoc,
  where,
} from 'firebase/firestore';
import { db } from './firebase';
import {
  BudgetStatus,
  CentsInteger,
  CompetenceMonthString,
  PersonalBudget,
  PersonalBudgetProgress,
  PersonalTransaction,
} from '../types/financeV3';
import { getUserPersonalTransactions } from './personalTransactionService';
import { universalStorage } from '../utils/universalStorage';
import { validatePositiveCents } from '../utils/movementLedger';

/**
 * ==============================================================================
 * SERVIÇO DE ORÇAMENTOS INDIVIDUAIS (v3.1)
 * ==============================================================================
 * Caminho Canônico: users/{userId}/budgets/{budgetId}
 *
 * Princípios Fundamentais:
 * 1. Orçamento é estritamente instrumento de planejamento (não altera saldos bancários).
 * 2. O consumo é computado diretamente a partir das despesas reconhecidas no período
 *    para as categorias associadas.
 * 3. O status reflete o percentual de consumo:
 *    - 'on_track': < 80% do planejado consumido
 *    - 'warning': >= 80% e <= 100% consumido
 *    - 'exceeded': > 100% consumido
 */

const DEMO_BUDGETS_KEY = 'mpf_v3_demo_budgets';

function loadDemoBudgets(): PersonalBudget[] {
  try {
    const raw = universalStorage.getItem(DEMO_BUDGETS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDemoBudgets(budgets: PersonalBudget[]): void {
  try {
    universalStorage.setItem(DEMO_BUDGETS_KEY, JSON.stringify(budgets));
  } catch (err) {
    console.warn('[DemoBudgets] Erro ao salvar orçamentos:', err);
  }
}

export interface CreateBudgetInput {
  name: string;
  categoryIds: string[];
  competenceMonth: CompetenceMonthString; // YYYY-MM
  plannedAmountCents: CentsInteger;
  notes?: string;
}

export interface UpdateBudgetInput {
  name?: string;
  categoryIds?: string[];
  plannedAmountCents?: CentsInteger;
  notes?: string;
}

/**
 * Cria um novo orçamento individual para uma competência específica.
 */
export async function createPersonalBudget(
  userId: string,
  input: CreateBudgetInput,
  isDemo = false
): Promise<PersonalBudget> {
  const cleanName = input.name?.trim();
  if (!cleanName) {
    throw new Error('O nome do orçamento é obrigatório.');
  }
  if (!validatePositiveCents(input.plannedAmountCents)) {
    throw new Error('O valor planejado do orçamento deve ser um inteiro positivo em centavos.');
  }
  if (!input.categoryIds || input.categoryIds.length === 0) {
    throw new Error('Ao menos uma categoria deve ser vinculada ao orçamento.');
  }

  const budgetId = `bgt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const now = new Date().toISOString();

  const budget: PersonalBudget = {
    id: budgetId,
    userId,
    name: cleanName,
    categoryIds: input.categoryIds,
    competenceMonth: input.competenceMonth,
    plannedAmountCents: input.plannedAmountCents,
    notes: input.notes?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };

  if (isDemo) {
    const list = loadDemoBudgets();
    list.push(budget);
    saveDemoBudgets(list);
    return budget;
  }

  const bgtRef = doc(db, 'users', userId, 'budgets', budgetId);
  await setDoc(bgtRef, budget);
  return budget;
}

/**
 * Atualiza um orçamento existente.
 */
export async function updatePersonalBudget(
  budgetId: string,
  userId: string,
  input: UpdateBudgetInput,
  isDemo = false
): Promise<PersonalBudget> {
  const now = new Date().toISOString();

  if (isDemo) {
    const list = loadDemoBudgets();
    const idx = list.findIndex((b) => b.id === budgetId && b.userId === userId);
    if (idx === -1) throw new Error(`Orçamento "${budgetId}" não encontrado.`);

    const updated: PersonalBudget = {
      ...list[idx],
      name: input.name !== undefined ? input.name.trim() : list[idx].name,
      categoryIds: input.categoryIds !== undefined ? input.categoryIds : list[idx].categoryIds,
      plannedAmountCents:
        input.plannedAmountCents !== undefined
          ? input.plannedAmountCents
          : list[idx].plannedAmountCents,
      notes: input.notes !== undefined ? input.notes.trim() : list[idx].notes,
      updatedAt: now,
    };
    list[idx] = updated;
    saveDemoBudgets(list);
    return updated;
  }

  const bgtRef = doc(db, 'users', userId, 'budgets', budgetId);
  const snap = await getDoc(bgtRef);
  if (!snap.exists()) throw new Error(`Orçamento "${budgetId}" não encontrado.`);

  const existing = snap.data() as PersonalBudget;
  if (existing.userId !== userId) {
    throw new Error('Permissão negada para alterar este orçamento.');
  }

  const patch: Partial<PersonalBudget> = { updatedAt: now };
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.categoryIds !== undefined) patch.categoryIds = input.categoryIds;
  if (input.plannedAmountCents !== undefined) {
    if (!validatePositiveCents(input.plannedAmountCents)) {
      throw new Error('O valor planejado deve ser positivo em centavos.');
    }
    patch.plannedAmountCents = input.plannedAmountCents;
  }
  if (input.notes !== undefined) patch.notes = input.notes.trim();

  await updateDoc(bgtRef, patch);
  return { ...existing, ...patch };
}

/**
 * Exclui um orçamento.
 */
export async function deletePersonalBudget(
  budgetId: string,
  userId: string,
  isDemo = false
): Promise<void> {
  if (isDemo) {
    const list = loadDemoBudgets();
    const filtered = list.filter((b) => !(b.id === budgetId && b.userId === userId));
    saveDemoBudgets(filtered);
    return;
  }

  const bgtRef = doc(db, 'users', userId, 'budgets', budgetId);
  await deleteDoc(bgtRef);
}

/**
 * Consulta os orçamentos do usuário para uma competência, calculando o consumo real a partir das despesas.
 */
export async function getUserBudgetsWithProgress(
  userId: string,
  competenceMonth: CompetenceMonthString,
  isDemo = false
): Promise<PersonalBudgetProgress[]> {
  if (!userId) return [];

  let budgets: PersonalBudget[] = [];
  if (isDemo) {
    budgets = loadDemoBudgets().filter(
      (b) => b.userId === userId && b.competenceMonth === competenceMonth
    );
  } else {
    const q = query(
      collection(db, 'users', userId, 'budgets'),
      where('competenceMonth', '==', competenceMonth)
    );
    const snap = await getDocs(q);
    snap.forEach((d) => budgets.push({ ...(d.data() as PersonalBudget), id: d.id }));
  }

  // Carrega as transações do mês para derivar o consumo
  const transactions = await getUserPersonalTransactions(
    userId,
    { competenceMonth, type: 'expense' },
    isDemo
  );

  return budgets.map((b) => {
    // Soma despesas efetivamente reconhecidas nas categorias deste orçamento
    const catSet = new Set(b.categoryIds);
    let spent = 0;

    for (const tx of transactions) {
      if (catSet.has(tx.categoryId) && tx.status !== 'cancelled') {
        if (tx.status === 'paid') {
          spent += tx.amountCents;
        } else if (tx.status === 'partially_paid') {
          spent += tx.paidAmountCents || 0;
        }
      }
    }

    const remaining = b.plannedAmountCents - spent;
    const percentageUsed =
      b.plannedAmountCents > 0
        ? Math.round((spent / b.plannedAmountCents) * 100)
        : 0;

    let status: BudgetStatus = 'on_track';
    if (percentageUsed > 100) {
      status = 'exceeded';
    } else if (percentageUsed >= 80) {
      status = 'warning';
    }

    return {
      ...b,
      spentAmountCents: spent,
      remainingAmountCents: remaining,
      percentageUsed,
      status,
    };
  });
}
