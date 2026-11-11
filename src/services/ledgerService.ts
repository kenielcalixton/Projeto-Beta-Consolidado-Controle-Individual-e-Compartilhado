import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from './firebase';
import {
  Account,
  CentsInteger,
  DateString,
  FinancialMovement,
  PersonalTransaction,
  PersonalTransactionPayment,
  PersonalTransactionPaymentReversal,
} from '../types/financeV3';
import {
  buildCompensatoryMovement,
  buildFinancialMovement,
  BuildMovementParams,
  generatePaymentReversalDocId,
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
 * 5. Consistência transacional do saldo projetado (projectedBalanceCents) via Backend Confiável.
 */

const DEMO_MOVEMENTS_STORAGE_KEY = 'mpf_v3_demo_movements';

// Fila de exclusão mútua em memória para serializar chamadas concorrentes (Promise.all) em modo demo
let demoMutexChain: Promise<unknown> = Promise.resolve();
let demoLockActive = false;

export function withDemoLock<T>(task: () => Promise<T> | T): Promise<T> {
  if (demoLockActive) {
    return Promise.resolve().then(() => task());
  }
  const next = demoMutexChain.then(async () => {
    demoLockActive = true;
    try {
      return await task();
    } finally {
      demoLockActive = false;
    }
  });
  demoMutexChain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

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
 * Em ambiente Firestore real/emulador, delega para a Cloud Function oficial (recordFinancialMovementOfficial)
 * que valida titularidade, estado da conta, idempotência por SHA-256 completo e atualiza projectedBalanceCents
 * via Admin SDK.
 */
export async function recordMovement(
  params: BuildMovementParams,
  isDemo = false
): Promise<FinancialMovement> {
  const movement = buildFinancialMovement(params);

  if (isDemo) {
    return await withDemoLock(() => {
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
    });
  }

  // Persistência Transacional Autoritativa via Cloud Function (Admin SDK)
  const callable = httpsCallable<
    BuildMovementParams,
    {
      movement: FinancialMovement;
      newProjectedBalanceCents: CentsInteger;
      isIdempotentReplay: boolean;
    }
  >(functions, 'recordFinancialMovementOfficial');

  const response = await callable({
    ...params,
    id: movement.id,
    idempotencyKey: movement.idempotencyKey,
  });

  return response.data.movement;
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
    return await withDemoLock(() => {
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

      const existingComp = demoMovements.find(
        (m) => m.id === compDocId || m.reversalOfMovementId === movementId
      );
      if (existingComp) {
        if (options.idempotent) {
          let currentBalance = 0;
          try {
            const acc = accounts.find((a) => a.id === accountId);
            if (acc) currentBalance = acc.projectedBalanceCents;
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

      // Sincroniza o efeito contábil do estorno na transação pessoal (sem cancelar a obrigação)
      try {
        if (original.originType === 'personal_expense' || original.originType === 'personal_income') {
          const txsRaw = universalStorage.getItem('mpf_v3_demo_personal_transactions');
          if (txsRaw) {
            const txs: PersonalTransaction[] = JSON.parse(txsRaw);
            let targetTx = txs.find((t) => t.id === original.originId && t.userId === original.userId);
            const paymentsRaw = universalStorage.getItem('mpf_v3_demo_transaction_payments');
            if (paymentsRaw) {
              const payments: PersonalTransactionPayment[] = JSON.parse(paymentsRaw);
              const pay = payments.find(
                (p) =>
                  p.id === original.originId ||
                  p.financialMovementId === original.id ||
                  p.id === `txpay_init_${original.originId}`
              );
              if (pay) {
                if (!targetTx) {
                  targetTx = txs.find((t) => t.id === pay.transactionId && t.userId === original.userId);
                }
                // Imutabilidade estrita: NÃO altera nem sobrescreve o registro original de pagamento.
                // Cria um evento compensatório append-only em 'mpf_v3_demo_transaction_payment_reversals'.
                const reversalsRaw = universalStorage.getItem('mpf_v3_demo_transaction_payment_reversals');
                const reversals: PersonalTransactionPaymentReversal[] = reversalsRaw ? JSON.parse(reversalsRaw) : [];
                const revId = generatePaymentReversalDocId(pay.id);
                if (!reversals.some((r) => r.id === revId || r.paymentId === pay.id)) {
                  reversals.push({
                    id: revId,
                    transactionId: pay.transactionId,
                    paymentId: pay.id,
                    userId: pay.userId,
                    amountCents: pay.amountCents,
                    originalFinancialMovementId: pay.financialMovementId,
                    reversalMovementId: compensatory.id,
                    reversalDate: (compensatory.effectiveDate || new Date().toISOString().split('T')[0]) as DateString,
                    reversedAt: new Date().toISOString(),
                    authorUid,
                    reason: reason || 'Estorno contábil',
                    idempotencyKey: `payrev_${pay.id}`,
                    createdAt: new Date().toISOString(),
                  });
                  universalStorage.setItem('mpf_v3_demo_transaction_payment_reversals', JSON.stringify(reversals));
                }
              }
            }
            if (!targetTx && original.notes) {
              const match = original.notes.match(/Amortização de #([a-zA-Z0-9_-]+)/);
              if (match && match[1]) {
                targetTx = txs.find((t) => t.id === match[1] && t.userId === original.userId);
              }
            }
            if (targetTx && targetTx.status !== 'cancelled') {
              const currentPaid = targetTx.paidAmountCents !== undefined ? targetTx.paidAmountCents : (targetTx.status === 'paid' ? targetTx.amountCents : 0);
              const newPaid = Math.max(0, currentPaid - original.amountCents);
              const newRemaining = Math.max(0, targetTx.amountCents - newPaid);
              targetTx.paidAmountCents = newPaid;
              targetTx.remainingAmountCents = newRemaining;
              targetTx.status = newPaid === 0 ? 'pending' : 'partially_paid';
              targetTx.updatedAt = new Date().toISOString();
              universalStorage.setItem('mpf_v3_demo_personal_transactions', JSON.stringify(txs));
            }
          }
        }
      } catch (err) {
        console.warn('[DemoReversal] Erro ao sincronizar transação com estorno:', err);
      }

      let newBalance = 0;
      try {
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
      } catch {}

      return {
        compensatoryMovement: compensatory,
        newProjectedBalanceCents: newBalance,
      };
    });
  }

  // Execução Transacional Autoritativa via Cloud Function (Admin SDK)
  const callable = httpsCallable<
    {
      accountId: string;
      movementId: string;
      authorUid: string;
      reason?: string;
      idempotent?: boolean;
    },
    {
      compensatoryMovement: FinancialMovement;
      newProjectedBalanceCents: CentsInteger;
      isIdempotentReplay?: boolean;
    }
  >(functions, 'reverseFinancialMovementOfficial');

  const response = await callable({
    accountId,
    movementId,
    authorUid,
    reason,
    idempotent: options.idempotent,
  });

  return {
    compensatoryMovement: response.data.compensatoryMovement,
    newProjectedBalanceCents: response.data.newProjectedBalanceCents,
  };
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
 * corrigindo qualquer desvio no cache de projeção de saldo via Backend Confiável.
 */
export async function reconcileAndSyncAccountBalance(
  accountId: string,
  userId: string,
  isDemo = false
): Promise<ReconcileSyncResult> {
  if (isDemo) {
    return await withDemoLock(() => {
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

      return {
        previousBalanceCents: prev,
        reconciledBalanceCents: reconciled,
        differenceCents,
        hasDivergence,
      };
    });
  }

  const callable = httpsCallable<
    { accountId: string },
    {
      reconciledBalanceCents: CentsInteger;
      previousProjectedBalanceCents: CentsInteger;
      wasDivergent: boolean;
    }
  >(functions, 'reconcileAccountBalanceOfficial');

  const response = await callable({ accountId });
  const { reconciledBalanceCents, previousProjectedBalanceCents, wasDivergent } = response.data;

  return {
    previousBalanceCents: previousProjectedBalanceCents,
    reconciledBalanceCents,
    differenceCents: reconciledBalanceCents - previousProjectedBalanceCents,
    hasDivergence: wasDivergent,
  };
}
