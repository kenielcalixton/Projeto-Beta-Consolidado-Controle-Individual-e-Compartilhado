import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from './firebase';
import { Account, AccountType, CentsInteger } from '../types/financeV3';

/**
 * ==============================================================================
 * SERVIÇO DE CONTAS FINANCEIRAS INDIVIDUAIS (ARQUITETURA v3.1)
 * ==============================================================================
 * Gerencia a entidade canônica Account: criação, consulta por usuário autenticado,
 * edição restrita de campos permitidos e arquivamento (sem deleção física).
 * Isolamento total: usuários acessam exclusivamente suas próprias contas.
 */

export interface CreateAccountInput {
  name: string;
  type: AccountType;
  color?: string;
  icon?: string;
  creditLimitCents?: CentsInteger;
  closingDay?: number;
  dueDay?: number;
}

export interface UpdateAccountInput {
  name?: string;
  type?: AccountType;
  color?: string;
  icon?: string;
  creditLimitCents?: CentsInteger;
  closingDay?: number;
  dueDay?: number;
}

import { universalStorage } from '../utils/universalStorage';

// Armazenamento em memória local exclusivo para o Modo Demonstração (sem chamadas ao Firestore)
const DEMO_ACCOUNTS_STORAGE_KEY = 'mpf_v3_demo_accounts';

function loadDemoAccounts(): Account[] {
  try {
    const raw = universalStorage.getItem(DEMO_ACCOUNTS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDemoAccounts(accounts: Account[]): void {
  try {
    universalStorage.setItem(DEMO_ACCOUNTS_STORAGE_KEY, JSON.stringify(accounts));
  } catch (err) {
    console.warn('[DemoStorage] Erro ao salvar contas demo:', err);
  }
}

/**
 * Validação rigorosa dos campos de uma conta antes da persistência.
 */
export function validateAccountInput(input: CreateAccountInput | UpdateAccountInput): void {
  if (input.name !== undefined) {
    const cleanName = input.name.trim();
    if (!cleanName) {
      throw new Error('O nome da conta bancária é obrigatório.');
    }
    if (cleanName.length > 100) {
      throw new Error('O nome da conta não pode exceder 100 caracteres.');
    }
  }

  if (input.type !== undefined) {
    const validTypes: AccountType[] = ['checking', 'credit', 'wallet', 'savings'];
    if (!validTypes.includes(input.type)) {
      throw new Error(
        `Tipo de conta inválido: "${input.type}". Tipos permitidos: checking, credit, wallet, savings.`
      );
    }
  }

  if (input.creditLimitCents !== undefined && input.creditLimitCents !== null) {
    if (
      typeof input.creditLimitCents !== 'number' ||
      !Number.isSafeInteger(input.creditLimitCents) ||
      input.creditLimitCents < 0
    ) {
      throw new Error('O limite de crédito deve ser um valor inteiro em centavos maior ou igual a zero.');
    }
  }

  if (input.closingDay !== undefined && input.closingDay !== null) {
    if (
      typeof input.closingDay !== 'number' ||
      input.closingDay < 1 ||
      input.closingDay > 31 ||
      !Number.isInteger(input.closingDay)
    ) {
      throw new Error('O dia de fechamento da fatura deve estar entre 1 e 31.');
    }
  }

  if (input.dueDay !== undefined && input.dueDay !== null) {
    if (
      typeof input.dueDay !== 'number' ||
      input.dueDay < 1 ||
      input.dueDay > 31 ||
      !Number.isInteger(input.dueDay)
    ) {
      throw new Error('O dia de vencimento da fatura deve estar entre 1 e 31.');
    }
  }
}

/**
 * Cria uma nova conta financeira vinculada ao UID do usuário autenticado.
 */
export async function createAccount(
  userId: string,
  input: CreateAccountInput,
  isDemo = false
): Promise<Account> {
  if (!userId || !userId.trim()) {
    throw new Error('Identificador de usuário inválido para criação de conta.');
  }

  validateAccountInput(input);

  const now = new Date().toISOString();
  const accountId = `acc_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  const newAccount: Account = {
    id: accountId,
    userId: userId.trim(),
    name: input.name.trim(),
    type: input.type,
    projectedBalanceCents: 0, // Saldo inicial sempre derivado do livro de movimentações (0)
    creditLimitCents: input.creditLimitCents,
    closingDay: input.closingDay,
    dueDay: input.dueDay,
    color: input.color || '#6366f1',
    icon: input.icon || 'ph-bank',
    isArchived: false,
    createdAt: now,
    updatedAt: now,
  };

  if (isDemo) {
    const demoAccounts = loadDemoAccounts();
    demoAccounts.push(newAccount);
    saveDemoAccounts(demoAccounts);
    return newAccount;
  }

  await setDoc(doc(db, 'accounts', accountId), newAccount);
  return newAccount;
}

/**
 * Consulta todas as contas do usuário autenticado, com filtro opcional para incluir arquivadas.
 */
export async function getUserAccounts(
  userId: string,
  includeArchived = false,
  isDemo = false
): Promise<Account[]> {
  if (!userId || !userId.trim()) {
    throw new Error('UID do usuário é obrigatório para consultar contas.');
  }

  if (isDemo) {
    const demoAccounts = loadDemoAccounts();
    return demoAccounts.filter((acc) => {
      if (acc.userId !== userId.trim()) return false;
      return includeArchived ? true : !acc.isArchived;
    });
  }

  const accountsQuery = query(
    collection(db, 'accounts'),
    where('userId', '==', userId.trim())
  );

  const snapshot = await getDocs(accountsQuery);
  const accounts: Account[] = [];

  snapshot.forEach((d) => {
    const raw = d.data() as Account;
    const acc: Account = {
      ...raw,
      id: d.id || raw.id,
    };
    if (includeArchived || !acc.isArchived) {
      accounts.push(acc);
    }
  });

  return accounts.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Obtém os detalhes de uma conta específica, garantindo isolamento por UID.
 */
export async function getAccountById(
  accountId: string,
  userId: string,
  isDemo = false
): Promise<Account | null> {
  if (!accountId || !userId) return null;

  if (isDemo) {
    const demoAccounts = loadDemoAccounts();
    const found = demoAccounts.find((a) => a.id === accountId && a.userId === userId);
    return found || null;
  }

  const snap = await getDoc(doc(db, 'accounts', accountId));
  if (!snap.exists()) return null;

  const account = snap.data() as Account;
  if (account.userId !== userId.trim()) {
    throw new Error('Violação de segurança: acesso não autorizado a conta de outro usuário.');
  }

  return account;
}

/**
 * Edita campos permitidos de uma conta (sem alteração arbitrária de saldo ou titular).
 */
export async function updateAccount(
  accountId: string,
  userId: string,
  input: UpdateAccountInput,
  isDemo = false
): Promise<Account> {
  validateAccountInput(input);

  const existing = await getAccountById(accountId, userId, isDemo);
  if (!existing) {
    throw new Error(`Conta "${accountId}" não encontrada ou não pertence ao usuário.`);
  }

  const now = new Date().toISOString();
  const updated: Account = {
    ...existing,
    name: input.name !== undefined ? input.name.trim() : existing.name,
    type: input.type !== undefined ? input.type : existing.type,
    color: input.color !== undefined ? input.color : existing.color,
    icon: input.icon !== undefined ? input.icon : existing.icon,
    creditLimitCents:
      input.creditLimitCents !== undefined ? input.creditLimitCents : existing.creditLimitCents,
    closingDay: input.closingDay !== undefined ? input.closingDay : existing.closingDay,
    dueDay: input.dueDay !== undefined ? input.dueDay : existing.dueDay,
    updatedAt: now,
  };

  if (isDemo) {
    const demoAccounts = loadDemoAccounts().map((a) => (a.id === accountId ? updated : a));
    saveDemoAccounts(demoAccounts);
    return updated;
  }

  // Apenas campos cadastrais são atualizados. projectedBalanceCents e userId são estritamente preservados.
  await updateDoc(doc(db, 'accounts', accountId), {
    name: updated.name,
    type: updated.type,
    color: updated.color,
    icon: updated.icon,
    creditLimitCents: updated.creditLimitCents ?? null,
    closingDay: updated.closingDay ?? null,
    dueDay: updated.dueDay ?? null,
    updatedAt: now,
  });

  return updated;
}

/**
 * Arquiva ou desarquiva uma conta bancária.
 * A deleção física é permanentemente desativada nas regras do Firestore para proteger o histórico contábil.
 */
export async function archiveAccount(
  accountId: string,
  userId: string,
  isArchived: boolean,
  isDemo = false
): Promise<Account> {
  const existing = await getAccountById(accountId, userId, isDemo);
  if (!existing) {
    throw new Error(`Conta "${accountId}" não encontrada.`);
  }

  const now = new Date().toISOString();
  const updated: Account = {
    ...existing,
    isArchived,
    updatedAt: now,
  };

  if (isDemo) {
    const demoAccounts = loadDemoAccounts().map((a) => (a.id === accountId ? updated : a));
    saveDemoAccounts(demoAccounts);
    return updated;
  }

  await updateDoc(doc(db, 'accounts', accountId), {
    isArchived,
    updatedAt: now,
  });

  return updated;
}
