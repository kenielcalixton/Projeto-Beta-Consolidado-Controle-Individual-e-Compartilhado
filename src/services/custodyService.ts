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
  CustodyBalanceSummary,
  CustodyReturn,
  CustodyTransfer,
  CustodyTransferEvent,
  CustodyTransferScopeType,
  CustodyTransferStatus,
  CustodyTransferType,
  CustodyUsage,
  DateString,
  FinancialMovement,
} from '../types/financeV3';
import { recordMovement, withDemoLock } from './ledgerService';
import { getUserAccounts } from './accountService';
import { universalStorage } from '../utils/universalStorage';
import {
  generateCustodyEventDocId,
  generateCustodyReturnDocId,
  generateCustodyTransferDocId,
  generateCustodyUsageDocId,
  generateMovementDocId,
  validatePositiveCents,
} from '../utils/movementLedger';

/**
 * ==============================================================================
 * SERVIÇO DE TRANSFERÊNCIAS SOB CUSTÓDIA E ADIANTAMENTOS (FASE 7 — v3.1)
 * ==============================================================================
 * Caminho Canônico: transfers/{transferId}
 *
 * Princípios Fundamentais:
 * 1. Não existe caixa coletivo abstrato pertencente ao espaço compartilhado.
 *    Todo recurso financeiro está sob a titularidade e custódia de uma pessoa física.
 * 2. O envio debita a conta do remetente (originType: 'custody_transfer_out').
 * 3. O custodiante confirma o recebimento na sua conta (originType: 'custody_transfer_in').
 * 4. O uso em despesas compartilhadas abate availableBalanceCents sem gerar nova despesa
 *    própria para o custodiante.
 * 5. Devoluções restituem o saldo não utilizado para a conta do remetente original.
 */

const DEMO_CUSTODY_TRANSFERS_KEY = 'mpf_v3_demo_custody_transfers';
const DEMO_CUSTODY_EVENTS_KEY = 'mpf_v3_demo_custody_events';
const DEMO_CUSTODY_USAGES_KEY = 'mpf_v3_demo_custody_usages';
const DEMO_CUSTODY_RETURNS_KEY = 'mpf_v3_demo_custody_returns';

export function loadDemoCustodyTransfers(): CustodyTransfer[] {
  try {
    const raw = universalStorage.getItem(DEMO_CUSTODY_TRANSFERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveDemoCustodyTransfers(transfers: CustodyTransfer[]): void {
  try {
    universalStorage.setItem(DEMO_CUSTODY_TRANSFERS_KEY, JSON.stringify(transfers));
  } catch (err) {
    console.warn('[DemoCustody] Erro ao salvar transferências:', err);
  }
}

function loadDemoCustodyEvents(): CustodyTransferEvent[] {
  try {
    const raw = universalStorage.getItem(DEMO_CUSTODY_EVENTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDemoCustodyEvents(events: CustodyTransferEvent[]): void {
  try {
    universalStorage.setItem(DEMO_CUSTODY_EVENTS_KEY, JSON.stringify(events));
  } catch (err) {
    console.warn('[DemoCustody] Erro ao salvar eventos:', err);
  }
}

function loadDemoCustodyUsages(): CustodyUsage[] {
  try {
    const raw = universalStorage.getItem(DEMO_CUSTODY_USAGES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDemoCustodyUsages(usages: CustodyUsage[]): void {
  try {
    universalStorage.setItem(DEMO_CUSTODY_USAGES_KEY, JSON.stringify(usages));
  } catch (err) {
    console.warn('[DemoCustody] Erro ao salvar utilizações:', err);
  }
}

function loadDemoCustodyReturns(): CustodyReturn[] {
  try {
    const raw = universalStorage.getItem(DEMO_CUSTODY_RETURNS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDemoCustodyReturns(returns: CustodyReturn[]): void {
  try {
    universalStorage.setItem(DEMO_CUSTODY_RETURNS_KEY, JSON.stringify(returns));
  } catch (err) {
    console.warn('[DemoCustody] Erro ao salvar devoluções:', err);
  }
}

export interface CreateCustodyTransferInput {
  spaceId?: string;
  scopeType?: CustodyTransferScopeType;
  custodianUid: string;
  initialAmountCents: CentsInteger;
  sourceAccountId: string;
  transferType?: CustodyTransferType;
  targetExpenseId?: string;
  description?: string;
  notes?: string;
  transferDate?: DateString;
  idempotencyKey?: string;
}

export interface CreateCustodyTransferResult {
  transfer: CustodyTransfer;
  sourceMovement: FinancialMovement;
  isIdempotentReplay: boolean;
}

/**
 * Criação da transferência sob custódia
 */
export async function createCustodyTransfer(
  senderUid: string,
  input: CreateCustodyTransferInput,
  isDemo = false
): Promise<CreateCustodyTransferResult> {
  if (!validatePositiveCents(input.initialAmountCents)) {
    throw new Error('O valor da transferência sob custódia deve ser um inteiro estritamente positivo em centavos.');
  }
  if (!input.custodianUid || input.custodianUid === senderUid) {
    throw new Error('O destinatário da custódia deve ser um participante distinto do remetente.');
  }
  if (!input.sourceAccountId) {
    throw new Error('Conta bancária de origem é obrigatória.');
  }

  const cleanTransferDate = input.transferDate || new Date().toISOString().slice(0, 10);
  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    `idem_cust_${senderUid}_${input.custodianUid}_${input.initialAmountCents}_${cleanTransferDate}_${Date.now()}`;

  if (!isDemo) {
    const callable = httpsCallable<
      CreateCustodyTransferInput & { idempotencyKey: string; transferDate: string },
      CreateCustodyTransferResult
    >(functions, 'createCustodyTransferOfficial');

    const res = await callable({
      ...input,
      transferDate: cleanTransferDate,
      idempotencyKey,
    });
    return res.data;
  }

  return withDemoLock(async () => {
    const transferId = generateCustodyTransferDocId(senderUid, idempotencyKey);
    const transfers = loadDemoCustodyTransfers();
    const existing = transfers.find((t) => t.id === transferId || t.idempotencyKey === idempotencyKey);

    if (existing) {
      if (
        existing.initialAmountCents !== input.initialAmountCents ||
        existing.custodianUid !== input.custodianUid ||
        existing.sourceAccountId !== input.sourceAccountId
      ) {
        throw new Error('Conflito de idempotência: transferência existente com parâmetros divergentes.');
      }
      return {
        transfer: existing,
        sourceMovement: {} as FinancialMovement,
        isIdempotentReplay: true,
      };
    }

    const accounts = await getUserAccounts(senderUid, true, true);
    const sourceAcc = accounts.find((a) => a.id === input.sourceAccountId);
    if (!sourceAcc) {
      throw new Error(`Conta bancária de origem "${input.sourceAccountId}" não encontrada.`);
    }
    if (sourceAcc.type === 'credit') {
      throw new Error('Transferências sob custódia não podem ser debitadas de cartão de crédito.');
    }
    if (sourceAcc.isArchived) {
      throw new Error('A conta de origem está arquivada.');
    }

    const now = new Date().toISOString();
    const mov = await recordMovement(
      {
        accountId: input.sourceAccountId,
        userId: senderUid,
        direction: 'outflow',
        amountCents: input.initialAmountCents,
        effectiveDate: cleanTransferDate,
        originType: 'custody_transfer_out',
        originId: transferId,
        description: input.description?.trim() || `Transferência sob custódia (Custodiante: ${input.custodianUid})`,
        notes: input.notes || `Adiantamento sob custódia #${transferId}`,
        authorUid: senderUid,
        idempotencyKey: `${idempotencyKey}_out`,
      },
      true
    );

    const transferDoc: CustodyTransfer = {
      id: transferId,
      scopeType: input.scopeType || (input.spaceId ? 'shared_space' : 'direct_bilateral'),
      spaceId: input.spaceId,
      transferType: input.transferType || 'free_custody',
      targetExpenseId: input.targetExpenseId,
      senderUid,
      custodianUid: input.custodianUid,
      initialAmountCents: input.initialAmountCents,
      usedAmountCents: 0,
      returnedAmountCents: 0,
      availableBalanceCents: 0,
      sourceAccountId: input.sourceAccountId,
      custodyStatus: 'pending_receipt',
      description: input.description?.trim() || 'Transferência sob custódia',
      notes: input.notes,
      transferDate: cleanTransferDate,
      idempotencyKey,
      sourceMovementId: mov.id,
      createdAt: now,
      updatedAt: now,
    };

    transfers.push(transferDoc);
    saveDemoCustodyTransfers(transfers);

    const eventId = generateCustodyEventDocId(transferId, 'transfer_declared', idempotencyKey);
    const events = loadDemoCustodyEvents();
    events.push({
      id: eventId,
      transferId,
      eventType: 'transfer_declared',
      amountCents: input.initialAmountCents,
      targetExpenseId: input.targetExpenseId,
      affectedAccountId: input.sourceAccountId,
      financialMovementId: mov.id,
      performedByUid: senderUid,
      justification: input.notes,
      clientTransactionUuid: transferId,
      idempotencyKey,
      timestamp: now,
    });
    saveDemoCustodyEvents(events);

    return {
      transfer: transferDoc,
      sourceMovement: mov,
      isIdempotentReplay: false,
    };
  });
}

export interface ConfirmCustodyReceiptInput {
  transferId: string;
  destinationAccountId: string;
  confirmedAmountCents?: CentsInteger;
  notes?: string;
  idempotencyKey?: string;
}

export interface ConfirmCustodyReceiptResult {
  transfer: CustodyTransfer;
  destinationMovement: FinancialMovement;
  isIdempotentReplay: boolean;
}

/**
 * Confirmação de recebimento da custódia pelo custodiante
 */
export async function confirmCustodyReceipt(
  custodianUid: string,
  input: ConfirmCustodyReceiptInput,
  isDemo = false
): Promise<ConfirmCustodyReceiptResult> {
  if (!input.transferId) throw new Error('ID da transferência é obrigatório.');
  if (!input.destinationAccountId) throw new Error('Conta de destino do custodiante é obrigatória.');

  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    `idem_custrec_${input.transferId}_${input.destinationAccountId}_${Date.now()}`;

  if (!isDemo) {
    const callable = httpsCallable<
      ConfirmCustodyReceiptInput & { idempotencyKey: string },
      ConfirmCustodyReceiptResult
    >(functions, 'confirmCustodyReceiptOfficial');

    const res = await callable({
      ...input,
      idempotencyKey,
    });
    return res.data;
  }

  return withDemoLock(async () => {
    const transfers = loadDemoCustodyTransfers();
    const idx = transfers.findIndex((t) => t.id === input.transferId);
    if (idx === -1) throw new Error('Transferência sob custódia não encontrada.');
    const transfer = transfers[idx];

    if (transfer.custodianUid !== custodianUid) {
      throw new Error('Somente o custodiante legítimo pode confirmar o recebimento da custódia.');
    }

    const confirmedAmount = input.confirmedAmountCents !== undefined
      ? input.confirmedAmountCents
      : transfer.initialAmountCents;

    if (!validatePositiveCents(confirmedAmount) || confirmedAmount > transfer.initialAmountCents) {
      throw new Error('Valor confirmado inválido.');
    }

    if (transfer.custodyStatus !== 'pending_receipt') {
      return {
        transfer,
        destinationMovement: {} as FinancialMovement,
        isIdempotentReplay: true,
      };
    }

    const accounts = await getUserAccounts(custodianUid, true, true);
    const destAcc = accounts.find((a) => a.id === input.destinationAccountId);
    if (!destAcc) throw new Error('Conta bancária de destino não encontrada.');
    if (destAcc.type === 'credit') throw new Error('Custódia não pode ser recebida em cartão de crédito.');
    if (destAcc.isArchived) throw new Error('A conta de destino está arquivada.');

    const now = new Date().toISOString();
    const mov = await recordMovement(
      {
        accountId: input.destinationAccountId,
        userId: custodianUid,
        direction: 'inflow',
        amountCents: confirmedAmount,
        effectiveDate: now.slice(0, 10),
        originType: 'custody_transfer_in',
        originId: transfer.id,
        description: `Custódia recebida de ${transfer.senderUid}`,
        notes: input.notes || `Crédito de recursos para custódia #${transfer.id}`,
        authorUid: custodianUid,
        idempotencyKey: `${idempotencyKey}_in`,
      },
      true
    );

    const updated: CustodyTransfer = {
      ...transfer,
      destinationAccountId: input.destinationAccountId,
      destinationMovementId: mov.id,
      confirmedAmountCents: confirmedAmount,
      availableBalanceCents: confirmedAmount,
      custodyStatus: 'available',
      confirmedAt: now,
      updatedAt: now,
    };
    transfers[idx] = updated;
    saveDemoCustodyTransfers(transfers);

    const eventId = generateCustodyEventDocId(transfer.id, 'receipt_confirmed', idempotencyKey);
    const events = loadDemoCustodyEvents();
    events.push({
      id: eventId,
      transferId: transfer.id,
      eventType: 'receipt_confirmed',
      amountCents: confirmedAmount,
      affectedAccountId: input.destinationAccountId,
      financialMovementId: mov.id,
      performedByUid: custodianUid,
      justification: input.notes,
      clientTransactionUuid: transfer.id,
      idempotencyKey,
      timestamp: now,
    });
    saveDemoCustodyEvents(events);

    return {
      transfer: updated,
      destinationMovement: mov,
      isIdempotentReplay: false,
    };
  });
}

export interface UseCustodyFundsInput {
  transferId: string;
  expenseId: string;
  amountCents: CentsInteger;
  notes?: string;
  idempotencyKey?: string;
}

export interface UseCustodyFundsResult {
  transfer: CustodyTransfer;
  usage: CustodyUsage;
  isIdempotentReplay: boolean;
}

/**
 * Utilização dos recursos sob custódia para pagamento de despesa compartilhada
 */
export async function useCustodyFundsInExpense(
  custodianUid: string,
  input: UseCustodyFundsInput,
  isDemo = false
): Promise<UseCustodyFundsResult> {
  if (!validatePositiveCents(input.amountCents)) {
    throw new Error('O valor utilizado deve ser um inteiro positivo em centavos.');
  }

  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    `idem_custuse_${input.transferId}_${input.expenseId}_${input.amountCents}_${Date.now()}`;

  if (!isDemo) {
    const callable = httpsCallable<
      UseCustodyFundsInput & { idempotencyKey: string },
      UseCustodyFundsResult
    >(functions, 'useCustodyFundsInExpenseOfficial');

    const res = await callable({
      ...input,
      idempotencyKey,
    });
    return res.data;
  }

  return withDemoLock(async () => {
    const transfers = loadDemoCustodyTransfers();
    const idx = transfers.findIndex((t) => t.id === input.transferId);
    if (idx === -1) throw new Error('Transferência sob custódia não encontrada.');
    const transfer = transfers[idx];

    if (transfer.custodianUid !== custodianUid) {
      throw new Error('Somente o custodiante legítimo pode alocar fundos sob sua custódia.');
    }

    const usageId = generateCustodyUsageDocId(transfer.id, input.expenseId, idempotencyKey);
    const usages = loadDemoCustodyUsages();
    const existingUsage = usages.find((u) => u.id === usageId || u.idempotencyKey === idempotencyKey);
    if (existingUsage) {
      return {
        transfer,
        usage: existingUsage,
        isIdempotentReplay: true,
      };
    }

    if (transfer.custodyStatus !== 'available' && transfer.custodyStatus !== 'partially_used') {
      throw new Error(`A transferência está no status "${transfer.custodyStatus}" e não permite utilização.`);
    }

    if (input.amountCents > transfer.availableBalanceCents) {
      throw new Error('O valor solicitado excede o saldo disponível sob custódia.');
    }

    const now = new Date().toISOString();
    const newAvailable = transfer.availableBalanceCents - input.amountCents;
    const newUsed = (transfer.usedAmountCents || 0) + input.amountCents;

    let newStatus: CustodyTransferStatus = 'partially_used';
    if (newAvailable === 0) {
      newStatus = (transfer.returnedAmountCents || 0) > 0 ? 'settled_by_mixed' : 'settled_by_usage';
    }

    const updated: CustodyTransfer = {
      ...transfer,
      availableBalanceCents: newAvailable,
      usedAmountCents: newUsed,
      custodyStatus: newStatus,
      updatedAt: now,
    };
    transfers[idx] = updated;
    saveDemoCustodyTransfers(transfers);

    const usageDoc: CustodyUsage = {
      id: usageId,
      transferId: transfer.id,
      spaceId: transfer.spaceId,
      expenseId: input.expenseId,
      amountCents: input.amountCents,
      usedByUid: custodianUid,
      beneficiaryUid: transfer.senderUid,
      notes: input.notes,
      idempotencyKey,
      createdAt: now,
    };
    usages.push(usageDoc);
    saveDemoCustodyUsages(usages);

    const eventId = generateCustodyEventDocId(transfer.id, 'expense_consumed', idempotencyKey);
    const events = loadDemoCustodyEvents();
    events.push({
      id: eventId,
      transferId: transfer.id,
      eventType: 'expense_consumed',
      amountCents: input.amountCents,
      targetExpenseId: input.expenseId,
      performedByUid: custodianUid,
      justification: input.notes,
      clientTransactionUuid: usageId,
      idempotencyKey,
      timestamp: now,
    });
    saveDemoCustodyEvents(events);

    return {
      transfer: updated,
      usage: usageDoc,
      isIdempotentReplay: false,
    };
  });
}

export interface ReturnCustodyFundsInput {
  transferId: string;
  sourceAccountId: string;
  destinationAccountId: string;
  amountCents: CentsInteger;
  justification?: string;
  idempotencyKey?: string;
}

export interface ReturnCustodyFundsResult {
  transfer: CustodyTransfer;
  returnRecord: CustodyReturn;
  sourceMovement: FinancialMovement;
  destinationMovement: FinancialMovement;
  isIdempotentReplay: boolean;
}

/**
 * Devolução de fundos sob custódia não utilizados para o remetente original
 */
export async function returnCustodyFunds(
  custodianUid: string,
  input: ReturnCustodyFundsInput,
  isDemo = false
): Promise<ReturnCustodyFundsResult> {
  if (!validatePositiveCents(input.amountCents)) {
    throw new Error('O valor de devolução deve ser um inteiro positivo em centavos.');
  }

  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    `idem_custret_${input.transferId}_${input.amountCents}_${Date.now()}`;

  if (!isDemo) {
    const callable = httpsCallable<
      ReturnCustodyFundsInput & { idempotencyKey: string },
      ReturnCustodyFundsResult
    >(functions, 'returnCustodyFundsOfficial');

    const res = await callable({
      ...input,
      idempotencyKey,
    });
    return res.data;
  }

  return withDemoLock(async () => {
    const transfers = loadDemoCustodyTransfers();
    const idx = transfers.findIndex((t) => t.id === input.transferId);
    if (idx === -1) throw new Error('Transferência sob custódia não encontrada.');
    const transfer = transfers[idx];

    if (transfer.custodianUid !== custodianUid) {
      throw new Error('Somente o custodiante legítimo pode devolver os recursos.');
    }

    const returnId = generateCustodyReturnDocId(transfer.id, idempotencyKey);
    const returns = loadDemoCustodyReturns();
    const existingReturn = returns.find((r) => r.id === returnId || r.idempotencyKey === idempotencyKey);
    if (existingReturn) {
      return {
        transfer,
        returnRecord: existingReturn,
        sourceMovement: {} as FinancialMovement,
        destinationMovement: {} as FinancialMovement,
        isIdempotentReplay: true,
      };
    }

    if (input.amountCents > transfer.availableBalanceCents) {
      throw new Error('O valor de devolução excede o saldo disponível sob custódia.');
    }

    const now = new Date().toISOString();
    const effectiveDate = now.slice(0, 10);

    const outMov = await recordMovement(
      {
        accountId: input.sourceAccountId,
        userId: custodianUid,
        direction: 'outflow',
        amountCents: input.amountCents,
        effectiveDate,
        originType: 'custody_return_out',
        originId: returnId,
        description: `Devolução de custódia para ${transfer.senderUid}`,
        notes: input.justification || `Ressarcimento de saldo sob custódia #${transfer.id}`,
        authorUid: custodianUid,
        idempotencyKey: `${idempotencyKey}_ret_out`,
      },
      true
    );

    const inMov = await recordMovement(
      {
        accountId: input.destinationAccountId,
        userId: transfer.senderUid,
        direction: 'inflow',
        amountCents: input.amountCents,
        effectiveDate,
        originType: 'custody_return_in',
        originId: returnId,
        description: `Devolução de custódia de ${custodianUid}`,
        notes: input.justification || `Ressarcimento de saldo sob custódia #${transfer.id}`,
        authorUid: custodianUid,
        idempotencyKey: `${idempotencyKey}_ret_in`,
      },
      true
    );

    const newAvailable = transfer.availableBalanceCents - input.amountCents;
    const newReturned = (transfer.returnedAmountCents || 0) + input.amountCents;

    let newStatus: CustodyTransferStatus = 'partial_return_confirmed';
    if (newAvailable === 0) {
      newStatus = (transfer.usedAmountCents || 0) > 0 ? 'settled_by_mixed' : 'settled_by_return';
    }

    const updated: CustodyTransfer = {
      ...transfer,
      availableBalanceCents: newAvailable,
      returnedAmountCents: newReturned,
      custodyStatus: newStatus,
      updatedAt: now,
    };
    transfers[idx] = updated;
    saveDemoCustodyTransfers(transfers);

    const returnRecord: CustodyReturn = {
      id: returnId,
      transferId: transfer.id,
      spaceId: transfer.spaceId,
      amountCents: input.amountCents,
      returnedByUid: custodianUid,
      receivedByUid: transfer.senderUid,
      sourceAccountId: input.sourceAccountId,
      destinationAccountId: input.destinationAccountId,
      sourceMovementId: outMov.id,
      destinationMovementId: inMov.id,
      justification: input.justification,
      idempotencyKey,
      createdAt: now,
    };
    returns.push(returnRecord);
    saveDemoCustodyReturns(returns);

    const eventId = generateCustodyEventDocId(transfer.id, 'return_confirmed', idempotencyKey);
    const events = loadDemoCustodyEvents();
    events.push({
      id: eventId,
      transferId: transfer.id,
      eventType: 'return_confirmed',
      amountCents: input.amountCents,
      affectedAccountId: input.sourceAccountId,
      financialMovementId: outMov.id,
      performedByUid: custodianUid,
      justification: input.justification,
      clientTransactionUuid: returnId,
      idempotencyKey,
      timestamp: now,
    });
    saveDemoCustodyEvents(events);

    return {
      transfer: updated,
      returnRecord,
      sourceMovement: outMov,
      destinationMovement: inMov,
      isIdempotentReplay: false,
    };
  });
}

/**
 * Consulta transferências sob custódia de um espaço compartilhado
 */
export async function getSpaceCustodyTransfers(
  spaceId: string,
  isDemo = false
): Promise<CustodyTransfer[]> {
  if (!spaceId) return [];

  if (isDemo) {
    return loadDemoCustodyTransfers()
      .filter((t) => t.spaceId === spaceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  const q = query(collection(db, 'transfers'), where('spaceId', '==', spaceId));
  const snap = await getDocs(q);
  const list: CustodyTransfer[] = [];
  snap.forEach((d) => list.push(d.data() as CustodyTransfer));
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Consulta transferências sob custódia de um usuário (como remetente ou custodiante)
 */
export async function getUserCustodyTransfers(
  userId: string,
  isDemo = false
): Promise<CustodyTransfer[]> {
  if (!userId) return [];

  if (isDemo) {
    return loadDemoCustodyTransfers()
      .filter((t) => t.senderUid === userId || t.custodianUid === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  const senderQuery = query(collection(db, 'transfers'), where('senderUid', '==', userId));
  const custodianQuery = query(collection(db, 'transfers'), where('custodianUid', '==', userId));

  const [senderSnap, custodianSnap] = await Promise.all([
    getDocs(senderQuery),
    getDocs(custodianQuery),
  ]);

  const map = new Map<string, CustodyTransfer>();
  senderSnap.forEach((d) => map.set(d.id, d.data() as CustodyTransfer));
  custodianSnap.forEach((d) => map.set(d.id, d.data() as CustodyTransfer));

  return Array.from(map.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Calcula os saldos sob custódia consolidados entre pares de participantes em um espaço compartilhado
 */
export async function getSpaceCustodyBalances(
  spaceId: string,
  isDemo = false
): Promise<CustodyBalanceSummary[]> {
  const transfers = await getSpaceCustodyTransfers(spaceId, isDemo);
  const summaryMap = new Map<string, CustodyBalanceSummary>();

  for (const t of transfers) {
    if (t.custodyStatus === 'pending_receipt') continue;

    const key = `${t.senderUid}->${t.custodianUid}`;
    const existing = summaryMap.get(key) || {
      senderUid: t.senderUid,
      custodianUid: t.custodianUid,
      totalInitialCents: 0,
      totalConfirmedCents: 0,
      totalUsedCents: 0,
      totalReturnedCents: 0,
      availableBalanceCents: 0,
    };

    existing.totalInitialCents += t.initialAmountCents;
    existing.totalConfirmedCents += t.confirmedAmountCents || t.initialAmountCents;
    existing.totalUsedCents += t.usedAmountCents || 0;
    existing.totalReturnedCents += t.returnedAmountCents || 0;
    existing.availableBalanceCents += t.availableBalanceCents || 0;

    summaryMap.set(key, existing);
  }

  return Array.from(summaryMap.values());
}
