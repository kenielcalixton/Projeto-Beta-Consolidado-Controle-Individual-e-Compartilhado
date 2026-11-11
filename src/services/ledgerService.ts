import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  runTransaction,
  where,
} from 'firebase/firestore';
import { db } from './firebase';
import { Account, CentsInteger, FinancialMovement } from '../types/financeV3';
import {
  buildCompensatoryMovement,
  buildFinancialMovement,
  BuildMovementParams,
  generateReversalDocId,
  reconcileAccountBalance,
  validateMovementPayloadMatch,
} from '../utils/movementLedger';
import { universalStorage } from '../utils/universalStorage';

/**
 * ==============================================================================
 * SERVIÇO DO LIVRO OFICIAL DE MOVIMENTAÇÕES (FINANCIAL MOVEMENT LEDGER) — v3.1
 * ==============================================================================
 * Caminho Canônico: accounts/{accountId}/movements/{movementId}
 * Princípios Absolutos:
 * 1. Livro-razão estritamente append-only (sem update, sem delete).
 * 2. Imutabilidade e ausência de status 'reversed' mutável.
 * 3. Estornos via movimentos compensatórios de contrapartida.
 * 4. Prevenção de duplicidade e idempotência.
 * 5. Consistência transacional do saldo projetado (projectedBalanceCents).
 */

const DEMO_MOVEMENTS_STORAGE_KEY = 'mpf_v3_demo_movements';

function loadDemoMovements(): FinancialMovement[] {
  try {
    const raw = universalStorage.getItem(DEMO_MOVEMENTS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDemoMovements(movements: FinancialMovement[]): void {
  try {
    universalStorage.setItem(DEMO_MOVEMENTS_STORAGE_KEY, JSON.stringify(movements));
  } catch (err) {
    console.warn('[DemoLedger] Erro ao salvar movimentos demo:', err);
  }
}

/**
 * Registra uma nova movimentação financeira atômica no livro-razão.
 * Atualiza o saldo projetado da conta em transação única ACID.
 */
export async function recordMovement(
  params: BuildMovementParams,
  isDemo = false
): Promise<FinancialMovement> {
  const movement = buildFinancialMovement(params);

  if (isDemo) {
    // Validação de titularidade e estado de arquivamento da conta demo
    const accountsRaw = universalStorage.getItem('mpf_v3_demo_accounts');
    const accounts: Account[] = accountsRaw ? JSON.parse(accountsRaw) : [];
    const targetAccount = accounts.find((a) => a.id === movement.accountId);

    if (targetAccount) {
      if (targetAccount.userId !== movement.userId) {
        throw new Error(
          'Violação de segurança: O titular da conta não coincide com o usuário informado.'
        );
      }
      if (targetAccount.isArchived) {
        throw new Error(
          `A conta "${targetAccount.name}" está arquivada e não pode receber novas movimentações.`
        );
      }
    }

    const demoMovements = loadDemoMovements();

    // Verificação de idempotência no modo demo
    const exists = demoMovements.find(
      (m) =>
        m.accountId === movement.accountId &&
        (m.id === movement.id || m.idempotencyKey === movement.idempotencyKey)
    );
    if (exists) {
      validateMovementPayloadMatch(exists, movement);
      return exists;
    }

    demoMovements.push(movement);
    saveDemoMovements(demoMovements);

    // Atualiza saldo em cache da conta demo
    try {
      const accIdx = accounts.findIndex((a) => a.id === movement.accountId);
      if (accIdx >= 0) {
        const delta =
          movement.direction === 'inflow'
            ? movement.amountCents
            : -movement.amountCents;
        accounts[accIdx].projectedBalanceCents += delta;
        accounts[accIdx].updatedAt = new Date().toISOString();
        universalStorage.setItem('mpf_v3_demo_accounts', JSON.stringify(accounts));
      }
    } catch {}

    return movement;
  }

  // Persistência Transacional no Cloud Firestore
  const accountRef = doc(db, 'accounts', movement.accountId);
  const movementRef = doc(
    db,
    'accounts',
    movement.accountId,
    'movements',
    movement.id
  );

  return await runTransaction(db, async (tx) => {
    const accountSnap = await tx.get(accountRef);
    if (!accountSnap.exists()) {
      throw new Error(`Conta bancária "${movement.accountId}" não encontrada.`);
    }

    const accountData = accountSnap.data() as Account;

    // Isolamento e autorização estrita
    if (accountData.userId !== movement.userId) {
      throw new Error(
        'Violação de segurança: O titular da conta não coincide com o usuário informado.'
      );
    }

    // Regra v3.1: Contas arquivadas não recebem novas operações financeiras
    if (accountData.isArchived) {
      throw new Error(
        `A conta "${accountData.name}" está arquivada e não pode receber novas movimentações.`
      );
    }

    // Checagem de idempotência na subcoleção de movimentos da conta
    const existingSnap = await tx.get(movementRef);
    if (existingSnap.exists()) {
      const existingMovement = existingSnap.data() as FinancialMovement;
      validateMovementPayloadMatch(existingMovement, movement);
      return existingMovement;
    }

    const delta =
      movement.direction === 'inflow'
        ? movement.amountCents
        : -movement.amountCents;

    const newProjectedBalance = (accountData.projectedBalanceCents || 0) + delta;

    // 1. Grava o movimento imutável no livro-razão (subcoleção)
    tx.set(movementRef, movement);

    // 2. Atualiza a projeção de saldo da conta pai atomicamente
    tx.update(accountRef, {
      projectedBalanceCents: newProjectedBalance,
      updatedAt: new Date().toISOString(),
    });

    return movement;
  });
}

/**
 * Consulta todas as movimentações históricas de uma conta bancária.
 */
export async function getAccountMovements(
  accountId: string,
  userId: string,
  isDemo = false
): Promise<FinancialMovement[]> {
  if (!accountId || !userId) return [];

  if (isDemo) {
    const demoMovements = loadDemoMovements();
    return demoMovements
      .filter((m) => m.accountId === accountId && m.userId === userId)
      .sort(
        (a, b) =>
          new Date(b.effectiveDate).getTime() -
          new Date(a.effectiveDate).getTime()
      );
  }

  const movementsQuery = query(
    collection(db, 'accounts', accountId, 'movements'),
    orderBy('effectiveDate', 'desc')
  );

  const snap = await getDocs(movementsQuery);
  const movements: FinancialMovement[] = [];

  snap.forEach((d) => {
    const raw = d.data() as FinancialMovement;
    const m: FinancialMovement = {
      ...raw,
      id: d.id || raw.id,
    };
    if (m.userId === userId) {
      movements.push(m);
    }
  });

  return movements;
}

export interface ReversalResult {
  compensatoryMovement: FinancialMovement;
  newProjectedBalanceCents: CentsInteger;
}

export interface ReverseMovementOptions {
  /**
   * Se true, caso o estorno já tenha sido registrado anteriormente,
   * retorna o resultado existente sem alterar o saldo novamente (idempotência pura).
   * Se false (padrão), lança erro informando que o movimento já possui estorno.
   */
  idempotent?: boolean;
}

/**
 * Registra um estorno contábil estrito (append-only) via movimento compensatório oposto.
 * Utiliza identificador determinístico ('rev_' + movementId) como chave primária no Firestore,
 * garantindo atomicidade transacional e impossibilitando fisicamente duplicações concorrentes.
 */
export async function reverseMovement(
  accountId: string,
  movementId: string,
  authorUid: string,
  reason?: string,
  isDemo = false,
  options: ReverseMovementOptions = {}
): Promise<{
  compensatoryMovement: FinancialMovement;
  newProjectedBalanceCents: CentsInteger;
}> {
  if (!accountId || !movementId || !authorUid) {
    throw new Error('Parâmetros insuficientes para execução de estorno.');
  }

  const compDocId = generateReversalDocId(movementId);

  if (isDemo) {
    const demoMovements = loadDemoMovements();
    const original = demoMovements.find(
      (m) => m.accountId === accountId && m.id === movementId
    );

    if (!original) {
      throw new Error(`Movimento "${movementId}" não encontrado.`);
    }

    if (original.reversalOfMovementId) {
      throw new Error(
        `Operação inválida: O movimento "${movementId}" já é um estorno compensatório e não pode ser re-estornado.`
      );
    }

    // Validação de titularidade e estado de arquivamento da conta demo
    const accountsRaw = universalStorage.getItem('mpf_v3_demo_accounts');
    const accounts: Account[] = accountsRaw ? JSON.parse(accountsRaw) : [];
    const currentAcc = accounts.find((a) => a.id === accountId);
    if (currentAcc) {
      if (currentAcc.userId !== authorUid && original.userId !== authorUid) {
        throw new Error('Permissão negada para estornar este movimento.');
      }
      if (currentAcc.isArchived) {
        throw new Error('Não é possível estornar movimentações em contas arquivadas.');
      }
    }

    // Prevenção de duplicidade de reversão: checagem determinística
    const existingComp = demoMovements.find(
      (m) => m.id === compDocId || m.reversalOfMovementId === movementId
    );
    if (existingComp) {
      if (options.idempotent) {
        let currentBalance = 0;
        try {
          const accountsRaw = universalStorage.getItem('mpf_v3_demo_accounts');
          if (accountsRaw) {
            const accounts: Account[] = JSON.parse(accountsRaw);
            const acc = accounts.find((a) => a.id === accountId);
            if (acc) currentBalance = acc.projectedBalanceCents;
          }
        } catch {}
        return {
          compensatoryMovement: existingComp,
          newProjectedBalanceCents: currentBalance,
        };
      }
      throw new Error(
        `O movimento "${movementId}" já possui um estorno compensatório registrado.`
      );
    }

    const compensatory = buildCompensatoryMovement({
      originalMovement: original,
      authorUid,
      reason,
    });

    demoMovements.push(compensatory);
    saveDemoMovements(demoMovements);

    // Atualiza saldo na conta demo
    let newBalance = 0;
    try {
      const accountsRaw = universalStorage.getItem('mpf_v3_demo_accounts');
      if (accountsRaw) {
        const accounts: Account[] = JSON.parse(accountsRaw);
        const accIdx = accounts.findIndex((a) => a.id === accountId);
        if (accIdx >= 0) {
          const delta =
            compensatory.direction === 'inflow'
              ? compensatory.amountCents
              : -compensatory.amountCents;
          accounts[accIdx].projectedBalanceCents += delta;
          accounts[accIdx].updatedAt = new Date().toISOString();
          newBalance = accounts[accIdx].projectedBalanceCents;
          universalStorage.setItem('mpf_v3_demo_accounts', JSON.stringify(accounts));
        }
      }
    } catch {}

    return {
      compensatoryMovement: compensatory,
      newProjectedBalanceCents: newBalance,
    };
  }

  // Execução Transacional Segura no Cloud Firestore com Chave Primária Determinística
  const accountRef = doc(db, 'accounts', accountId);
  const originalRef = doc(db, 'accounts', accountId, 'movements', movementId);
  const compRef = doc(db, 'accounts', accountId, 'movements', compDocId);

  return await runTransaction(db, async (tx) => {
    // Leituras atômicas na mesma transação ACID
    const [accSnap, origSnap, compSnap] = await Promise.all([
      tx.get(accountRef),
      tx.get(originalRef),
      tx.get(compRef),
    ]);

    if (!accSnap.exists()) {
      throw new Error(`Conta "${accountId}" não encontrada.`);
    }
    if (!origSnap.exists()) {
      throw new Error(`Movimento "${movementId}" não encontrado.`);
    }

    const account = accSnap.data() as Account;
    const original = origSnap.data() as FinancialMovement;

    // Idempotência estrita a nível de documento
    if (compSnap.exists()) {
      if (options.idempotent) {
        return {
          compensatoryMovement: compSnap.data() as FinancialMovement,
          newProjectedBalanceCents: account.projectedBalanceCents || 0,
        };
      }
      throw new Error(
        `O movimento "${movementId}" já possui estorno compensatório registrado.`
      );
    }

    if (account.userId !== authorUid && original.userId !== authorUid) {
      throw new Error('Permissão negada para estornar este movimento.');
    }

    if (account.isArchived) {
      throw new Error('Não é possível estornar movimentações em contas arquivadas.');
    }

    if (original.reversalOfMovementId) {
      throw new Error(
        `Operação inválida: O movimento "${movementId}" já é um estorno compensatório e não pode ser re-estornado.`
      );
    }

    const compensatory = buildCompensatoryMovement({
      originalMovement: original,
      authorUid,
      reason,
    });

    const delta =
      compensatory.direction === 'inflow'
        ? compensatory.amountCents
        : -compensatory.amountCents;

    const newBalance = (account.projectedBalanceCents || 0) + delta;

    // 1. Grava o novo movimento compensatório no caminho determinístico (append-only)
    tx.set(compRef, compensatory);

    // 2. Atualiza saldo da conta na mesma transação
    tx.update(accountRef, {
      projectedBalanceCents: newBalance,
      updatedAt: new Date().toISOString(),
    });

    return {
      compensatoryMovement: compensatory,
      newProjectedBalanceCents: newBalance,
    };
  });
}

export interface AccountBalanceAuditResult {
  accountId: string;
  projectedBalanceCents: CentsInteger;
  reconciledBalanceCents: CentsInteger;
  differenceCents: CentsInteger;
  hasDivergence: boolean;
  movementsCount: number;
  auditedAt: string;
}

/**
 * Audita a consistência contábil de uma conta confrontando o saldo projetado em cache
 * com o saldo reconciliado derivado da totalidade das movimentações históricas.
 * Não altera nenhum dado no banco ou armazenamento (operação de leitura pura).
 */
export async function auditAccountBalance(
  accountId: string,
  userId: string,
  isDemo = false
): Promise<AccountBalanceAuditResult> {
  const movements = await getAccountMovements(accountId, userId, isDemo);
  const reconciledBalanceCents = reconcileAccountBalance(movements);

  let projectedBalanceCents = 0;
  if (isDemo) {
    const accountsRaw = universalStorage.getItem('mpf_v3_demo_accounts');
    if (accountsRaw) {
      const accounts: Account[] = JSON.parse(accountsRaw);
      const acc = accounts.find((a) => a.id === accountId);
      if (acc) projectedBalanceCents = acc.projectedBalanceCents || 0;
    }
  } else {
    const accountRef = doc(db, 'accounts', accountId);
    const snap = await getDoc(accountRef);
    if (!snap.exists()) {
      throw new Error(`Conta "${accountId}" não encontrada.`);
    }
    const acc = snap.data() as Account;
    projectedBalanceCents = acc.projectedBalanceCents || 0;
  }

  const differenceCents = reconciledBalanceCents - projectedBalanceCents;
  const hasDivergence = differenceCents !== 0;

  if (hasDivergence) {
    console.warn(
      `[LedgerAudit] DIVERGÊNCIA DETECTADA na conta "${accountId}": ` +
        `Projetado = ${projectedBalanceCents} centavos, ` +
        `Reconciliado = ${reconciledBalanceCents} centavos ` +
        `(Diferença = ${differenceCents} centavos).`
    );
  }

  return {
    accountId,
    projectedBalanceCents,
    reconciledBalanceCents,
    differenceCents,
    hasDivergence,
    movementsCount: movements.length,
    auditedAt: new Date().toISOString(),
  };
}

export interface ReconcileSyncResult {
  previousBalanceCents: CentsInteger;
  reconciledBalanceCents: CentsInteger;
  differenceCents: CentsInteger;
  hasDivergence: boolean;
}

/**
 * Reconcilia integralmente o saldo de uma conta a partir da totalidade dos seus movimentos,
 * corrigindo qualquer desvio no cache de projeção de saldo.
 */
export async function reconcileAndSyncAccountBalance(
  accountId: string,
  userId: string,
  isDemo = false
): Promise<ReconcileSyncResult> {
  if (isDemo) {
    const demoMovements = loadDemoMovements().filter(
      (m) => m.accountId === accountId && m.userId === userId
    );
    const reconciled = reconcileAccountBalance(demoMovements);
    let prev = 0;

    try {
      const accountsRaw = universalStorage.getItem('mpf_v3_demo_accounts');
      if (accountsRaw) {
        const accounts: Account[] = JSON.parse(accountsRaw);
        const accIdx = accounts.findIndex((a) => a.id === accountId);
        if (accIdx >= 0) {
          prev = accounts[accIdx].projectedBalanceCents;
          accounts[accIdx].projectedBalanceCents = reconciled;
          accounts[accIdx].updatedAt = new Date().toISOString();
          universalStorage.setItem('mpf_v3_demo_accounts', JSON.stringify(accounts));
        }
      }
    } catch {}

    const differenceCents = reconciled - prev;
    const hasDivergence = differenceCents !== 0;

    if (hasDivergence) {
      console.warn(
        `[LedgerSync] Saldo projetado corrigido para conta "${accountId}": ` +
          `Anterior = ${prev} centavos, Reconciliado = ${reconciled} centavos, Desvio = ${differenceCents} centavos.`
      );
    }

    return {
      previousBalanceCents: prev,
      reconciledBalanceCents: reconciled,
      differenceCents,
      hasDivergence,
    };
  }

  const accountRef = doc(db, 'accounts', accountId);
  const movements = await getAccountMovements(accountId, userId, false);
  const reconciled = reconcileAccountBalance(movements);

  const accSnap = await runTransaction(db, async (tx) => {
    const snap = await tx.get(accountRef);
    if (!snap.exists()) {
      throw new Error(`Conta "${accountId}" não encontrada.`);
    }
    const acc = snap.data() as Account;
    const prev = acc.projectedBalanceCents || 0;

    tx.update(accountRef, {
      projectedBalanceCents: reconciled,
      updatedAt: new Date().toISOString(),
    });

    return { prev, reconciled };
  });

  const differenceCents = accSnap.reconciled - accSnap.prev;
  const hasDivergence = differenceCents !== 0;

  if (hasDivergence) {
    console.warn(
      `[LedgerSync] Saldo projetado no Firestore sincronizado para conta "${accountId}": ` +
        `Anterior = ${accSnap.prev} centavos, Reconciliado = ${accSnap.reconciled} centavos, Desvio = ${differenceCents} centavos.`
    );
  }

  return {
    previousBalanceCents: accSnap.prev,
    reconciledBalanceCents: accSnap.reconciled,
    differenceCents,
    hasDivergence,
  };
}
