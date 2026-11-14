import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from './firebase';
import {
  Account,
  AccountType,
  CentsInteger,
  DateString,
  FinancialMovement,
  FinancialMovementOriginType,
  InternalAccountTransfer,
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
 * Formata uma data ISO YYYY-MM-DD (ou timestamp ISO) para DD/MM/YYYY
 * sem conversão via Date() em UTC, evitando deslocamento de -1 dia no fuso horário.
 */
export function formatIsoDateBR(dateStr?: string | null): string {
  if (!dateStr || typeof dateStr !== 'string') return '—';
  const trimmed = dateStr.trim();
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return `${match[3]}/${match[2]}/${match[1]}`;
  }
  return trimmed;
}

function normalizeTimestampToIso(val: unknown): string {
  if (typeof val === 'string') return val;
  if (val && typeof (val as { toDate?: () => Date }).toDate === 'function') {
    return (val as { toDate: () => Date }).toDate().toISOString();
  }
  return '';
}

function normalizeMovementDoc(
  raw: Partial<FinancialMovement> & Record<string, any>,
  docId: string
): FinancialMovement {
  const regIso =
    normalizeTimestampToIso(raw.registeredAt) ||
    normalizeTimestampToIso(raw.createdAt) ||
    new Date().toISOString();
  const effStr =
    typeof raw.effectiveDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw.effectiveDate)
      ? raw.effectiveDate.slice(0, 10)
      : regIso.slice(0, 10);

  return {
    ...(raw as FinancialMovement),
    id: docId || raw.id || '',
    accountId: raw.accountId || '',
    userId: raw.userId || raw.authorUid || '',
    authorUid: raw.authorUid || raw.userId || '',
    direction: raw.direction === 'inflow' ? 'inflow' : 'outflow',
    amountCents: Number.isFinite(Number(raw.amountCents))
      ? Math.round(Number(raw.amountCents))
      : 0,
    effectiveDate: effStr,
    registeredAt: regIso,
    originType: (raw.originType || 'manual_adjustment') as FinancialMovementOriginType,
    originId: raw.originId || docId || '',
    confirmationStatus: raw.confirmationStatus || 'cleared',
    description:
      typeof raw.description === 'string' && raw.description.trim()
        ? raw.description
        : 'Movimentação sem descrição',
    idempotencyKey: raw.idempotencyKey || docId || '',
  };
}

function compareMovementsDesc(a: FinancialMovement, b: FinancialMovement): number {
  const dateCmp = (b.effectiveDate || '').localeCompare(a.effectiveDate || '');
  if (dateCmp !== 0) return dateCmp;
  const regCmp = (b.registeredAt || '').localeCompare(a.registeredAt || '');
  if (regCmp !== 0) return regCmp;
  return (b.id || '').localeCompare(a.id || '');
}

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
 * Não utiliza orderBy no Firestore para não omitir silenciosamente documentos
 * sem campo effectiveDate indexado; normaliza e ordena cronologicamente em memória.
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
      .filter(
        (m) =>
          m.accountId === accountId &&
          (m.userId === userId || (!m.userId && m.authorUid === userId))
      )
      .map((m) => normalizeMovementDoc(m, m.id))
      .sort(compareMovementsDesc);
  }

  const movementsQuery = query(collection(db, 'accounts', accountId, 'movements'));
  const snap = await getDocs(movementsQuery);
  const movements: FinancialMovement[] = [];

  snap.forEach((d) => {
    const raw = d.data() as Partial<FinancialMovement> & Record<string, any>;
    const m = normalizeMovementDoc({ accountId, ...raw }, d.id || raw.id || '');
    if (m.userId === userId || (!raw.userId && m.authorUid === userId)) {
      movements.push(m);
    }
  });

  return movements.sort(compareMovementsDesc);
}

export type LedgerScopeType = 'individual' | 'shared';

export interface EnrichedLedgerMovement extends FinancialMovement {
  accountName: string;
  accountType: AccountType;
  relatedAccountId?: string;
  relatedAccountName?: string;
  categoryName: string;
  scope: LedgerScopeType;
  runningBalanceCents: CentsInteger;
  isCompensatory: boolean;
  isReversed: boolean;
}

export function resolveMovementScope(originType?: string): LedgerScopeType {
  if (!originType) return 'individual';
  if (
    originType.startsWith('settlement_') ||
    originType.startsWith('custody_') ||
    originType.startsWith('shared_') ||
    originType.startsWith('restitution_') ||
    originType === 'adhoc_receipt'
  ) {
    return 'shared';
  }
  return 'individual';
}

export function resolveFallbackCategoryLabel(originType: FinancialMovementOriginType): string {
  switch (originType) {
    case 'internal_transfer_in':
    case 'internal_transfer_out':
      return 'Transferência entre Contas';
    case 'credit_card_payment':
      return 'Pagamento de Fatura';
    case 'settlement_inflow':
    case 'settlement_outflow':
    case 'shared_settlement':
    case 'shared_reimbursement':
    case 'custody_deposit':
    case 'custody_withdrawal':
    case 'custody_return':
    case 'custody_transfer_out':
    case 'custody_transfer_in':
    case 'custody_return_out':
    case 'custody_return_in':
    case 'restitution_inflow':
    case 'restitution_outflow':
    case 'adhoc_receipt':
      return 'Acerto / Custódia Compartilhada';
    case 'personal_refund':
    case 'supplier_refund':
      return 'Reembolso / Estorno';
    case 'acquisition_checkout':
    case 'acquisition_reversal':
      return 'Aquisições';
    case 'manual_adjustment':
      return 'Ajuste Manual';
    default:
      return 'Geral';
  }
}

/**
 * Calcula o Saldo Resultante acumulado em ordem cronológica (mais antiga -> mais recente)
 * por conta, preservando imutabilidade e retornando ordenado do mais recente para o mais antigo.
 */
export function attachChronologicalRunningBalances<T extends FinancialMovement>(
  movements: T[]
): Array<T & { runningBalanceCents: CentsInteger }> {
  const chronological = [...movements].sort((a, b) => compareMovementsDesc(b, a));
  const runningByAccount: Record<string, number> = {};
  const computed = chronological.map((m) => {
    const delta = m.direction === 'inflow' ? m.amountCents : -m.amountCents;
    const nextBalance = (runningByAccount[m.accountId] || 0) + delta;
    runningByAccount[m.accountId] = nextBalance;
    return {
      ...m,
      runningBalanceCents: nextBalance,
    };
  });
  return computed.sort(compareMovementsDesc);
}

/**
 * Carrega e enriquece todas as movimentações financeiras de contas de caixa/bancárias
 * (excluindo cartões de crédito, que possuem livro-razão próprio de faturas e compras),
 * com categoria, conta relacionada, escopo (Individual/Compartilhado) e Saldo Resultante cronológico.
 */
export async function getEnrichedLedgerMovements(
  userId: string,
  accounts: Account[],
  isDemo = false
): Promise<EnrichedLedgerMovement[]> {
  if (!userId || !accounts || accounts.length === 0) return [];

  const nonCreditAccounts = accounts.filter((a) => a.type !== 'credit');
  if (nonCreditAccounts.length === 0) return [];

  const accountMap = new Map<string, Account>();
  for (const acc of accounts) {
    accountMap.set(acc.id, acc);
  }

  // 1. Carrega movimentos de todas as contas não-crédito em paralelo
  const perAccountMovements = await Promise.all(
    nonCreditAccounts.map((acc) => getAccountMovements(acc.id, userId, isDemo))
  );
  const allMovements = perAccountMovements.flat();

  // 2. Carrega metadados auxiliares (transações individuais e transferências internas) sem acoplamento circular
  const txById = new Map<string, PersonalTransaction>();
  const txByMovementId = new Map<string, PersonalTransaction>();
  const transferById = new Map<string, InternalAccountTransfer>();
  const paymentTxIdById = new Map<string, string>();

  if (isDemo) {
    try {
      const rawTxs = universalStorage.getItem('mpf_v3_demo_personal_transactions');
      const txs: PersonalTransaction[] = rawTxs ? JSON.parse(rawTxs) : [];
      for (const t of txs) {
        if (t.userId !== userId) continue;
        txById.set(t.id, t);
        if (t.financialMovementId) txByMovementId.set(t.financialMovementId, t);
      }
    } catch {}
    try {
      const rawPays = universalStorage.getItem('mpf_v3_demo_transaction_payments');
      const pays: PersonalTransactionPayment[] = rawPays ? JSON.parse(rawPays) : [];
      for (const p of pays) {
        if (p.userId === userId) paymentTxIdById.set(p.id, p.transactionId);
      }
    } catch {}
    try {
      const rawTransfers = universalStorage.getItem('mpf_v3_demo_internal_transfers');
      const xfers: InternalAccountTransfer[] = rawTransfers ? JSON.parse(rawTransfers) : [];
      for (const x of xfers) {
        if (x.userId === userId) transferById.set(x.id, x);
      }
    } catch {}
  } else {
    const [txSnap, xferSnap] = await Promise.all([
      getDocs(collection(db, 'users', userId, 'personal_transactions')).catch(() => null),
      getDocs(collection(db, 'users', userId, 'internal_transfers')).catch(() => null),
    ]);
    if (txSnap) {
      txSnap.forEach((d) => {
        const t = { ...(d.data() as PersonalTransaction), id: d.id };
        txById.set(t.id, t);
        if (t.financialMovementId) txByMovementId.set(t.financialMovementId, t);
      });
    }
    if (xferSnap) {
      xferSnap.forEach((d) => {
        const x = { ...(d.data() as InternalAccountTransfer), id: d.id };
        transferById.set(x.id, x);
      });
    }
  }

  // 3. Mapeia movimentos já compensados por estorno
  const reversedIds = new Set<string>();
  const movementById = new Map<string, FinancialMovement>();
  for (const m of allMovements) {
    movementById.set(m.id, m);
    if (m.reversalOfMovementId) {
      reversedIds.add(m.reversalOfMovementId);
    }
  }

  const withBalances = attachChronologicalRunningBalances(allMovements);

  const creditAccounts = accounts.filter((a) => a.type === 'credit');

  return withBalances.map((m) => {
    const acc = accountMap.get(m.accountId);
    const originMov = m.reversalOfMovementId ? movementById.get(m.reversalOfMovementId) : undefined;
    const lookupOriginType = originMov ? originMov.originType : m.originType;
    const lookupOriginId = originMov ? originMov.originId : m.originId;
    const lookupMovId = originMov ? originMov.id : m.id;

    // Resolve categoria
    let matchedTx = txByMovementId.get(lookupMovId) || txById.get(lookupOriginId);
    if (!matchedTx && paymentTxIdById.has(lookupOriginId)) {
      matchedTx = txById.get(paymentTxIdById.get(lookupOriginId)!);
    }
    if (!matchedTx && m.notes) {
      const noteMatch = m.notes.match(/#([a-zA-Z0-9_-]+)/);
      if (noteMatch?.[1]) {
        matchedTx = txById.get(noteMatch[1]);
      }
    }
    const categoryName = matchedTx?.categoryName || resolveFallbackCategoryLabel(m.originType);

    // Resolve conta relacionada
    let relatedAccountId: string | undefined;
    let relatedAccountName: string | undefined;
    if (
      lookupOriginType === 'internal_transfer_out' ||
      lookupOriginType === 'internal_transfer_in'
    ) {
      const xfer = transferById.get(lookupOriginId);
      if (xfer) {
        const otherId =
          xfer.sourceAccountId === m.accountId
            ? xfer.destinationAccountId
            : xfer.sourceAccountId;
        relatedAccountId = otherId;
        relatedAccountName = accountMap.get(otherId)?.name || otherId;
      }
    } else if (lookupOriginType === 'credit_card_payment') {
      const matchedCard = creditAccounts.find(
        (c) =>
          m.description.toLowerCase().includes(c.name.toLowerCase()) ||
          (m.notes || '').toLowerCase().includes(c.name.toLowerCase())
      );
      if (matchedCard) {
        relatedAccountId = matchedCard.id;
        relatedAccountName = matchedCard.name;
      } else if (creditAccounts.length === 1) {
        relatedAccountId = creditAccounts[0].id;
        relatedAccountName = creditAccounts[0].name;
      } else {
        relatedAccountName = 'Cartão de Crédito';
      }
    }

    return {
      ...m,
      accountName: acc?.name || 'Conta',
      accountType: acc?.type || 'checking',
      relatedAccountId,
      relatedAccountName,
      categoryName,
      scope: resolveMovementScope(lookupOriginType),
      isCompensatory: Boolean(m.reversalOfMovementId),
      isReversed: reversedIds.has(m.id),
    };
  });
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
        if (
          currentAcc.userId !== authorUid &&
          original.userId !== authorUid &&
          original.authorUid !== authorUid
        ) {
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
