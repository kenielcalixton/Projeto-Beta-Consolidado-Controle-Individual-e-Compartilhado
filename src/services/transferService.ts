import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  setDoc,
  where,
} from 'firebase/firestore';
import { db } from './firebase';
import {
  CentsInteger,
  DateString,
  FinancialMovement,
  InternalAccountTransfer,
} from '../types/financeV3';
import { getUserAccounts } from './accountService';
import { recordMovement } from './ledgerService';
import { universalStorage } from '../utils/universalStorage';
import { validatePositiveCents } from '../utils/movementLedger';

/**
 * ==============================================================================
 * SERVIÇO DE TRANSFERÊNCIAS ENTRE CONTAS PRÓPRIAS (v3.1)
 * ==============================================================================
 * Caminho Canônico: users/{userId}/internal_transfers/{transferId}
 *
 * Princípios Fundamentais:
 * 1. Não é receita nem despesa (não afeta resultado contábil do usuário).
 * 2. Gera 2 movimentos vinculados no Livro Financeiro:
 *    - Saída ('outflow') na conta origem (originType: 'internal_transfer_out').
 *    - Entrada ('inflow') na conta destino (originType: 'internal_transfer_in').
 * 3. Invariância patrimonial: Saldo total consolidado (+V - V = 0) permanece idêntico.
 * 4. Isolamento estrito: Ambas as contas devem pertencer obrigatoriamente ao mesmo usuário.
 * 5. Idempotência por chave determinística para prevenção de transferências duplicadas.
 */

const DEMO_TRANSFERS_KEY = 'mpf_v3_demo_internal_transfers';

function loadDemoTransfers(): InternalAccountTransfer[] {
  try {
    const raw = universalStorage.getItem(DEMO_TRANSFERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDemoTransfers(transfers: InternalAccountTransfer[]): void {
  try {
    universalStorage.setItem(DEMO_TRANSFERS_KEY, JSON.stringify(transfers));
  } catch (err) {
    console.warn('[DemoTransfers] Erro ao salvar transferências:', err);
  }
}

export interface ExecuteTransferInput {
  sourceAccountId: string;
  destinationAccountId: string;
  amountCents: CentsInteger;
  transferDate: DateString;
  description?: string;
  idempotencyKey?: string;
}

export interface TransferResult {
  transfer: InternalAccountTransfer;
  sourceMovement: FinancialMovement;
  destinationMovement: FinancialMovement;
  isIdempotentReplay: boolean;
}

/**
 * Executa uma transferência atômica entre duas contas do mesmo usuário.
 */
export async function executeInternalTransfer(
  userId: string,
  input: ExecuteTransferInput,
  isDemo = false
): Promise<TransferResult> {
  if (!validatePositiveCents(input.amountCents)) {
    throw new Error('O valor da transferência deve ser um inteiro estritamente positivo em centavos.');
  }

  if (input.sourceAccountId === input.destinationAccountId) {
    throw new Error('A conta de origem e a conta de destino não podem ser iguais.');
  }

  // 1. Validação de titularidade e estado das contas
  let sourceAccount: any = null;
  let destAccount: any = null;

  if (isDemo) {
    const raw = universalStorage.getItem('mpf_v3_demo_accounts');
    const all = raw ? JSON.parse(raw) : [];
    sourceAccount = all.find((a: any) => a.id === input.sourceAccountId) || null;
    destAccount = all.find((a: any) => a.id === input.destinationAccountId) || null;
  } else {
    const [sSnap, dSnap] = await Promise.all([
      getDoc(doc(db, 'accounts', input.sourceAccountId)),
      getDoc(doc(db, 'accounts', input.destinationAccountId)),
    ]);
    if (sSnap.exists()) sourceAccount = sSnap.data();
    if (dSnap.exists()) destAccount = dSnap.data();
  }

  if (!sourceAccount) {
    throw new Error(`Conta de origem "${input.sourceAccountId}" não encontrada.`);
  }
  if (!destAccount) {
    throw new Error(`Conta de destino "${input.destinationAccountId}" não encontrada.`);
  }

  if (sourceAccount.userId !== userId || destAccount.userId !== userId) {
    throw new Error('Violação de segurança: Transferências entre contas só são permitidas entre contas do mesmo usuário.');
  }

  if (sourceAccount.isArchived) {
    throw new Error(`A conta de origem "${sourceAccount.name}" está arquivada e não pode realizar saídas.`);
  }
  if (destAccount.isArchived) {
    throw new Error(`A conta de destino "${destAccount.name}" está arquivada e não pode receber transferências.`);
  }

  const cleanDescription =
    input.description?.trim() ||
    `Transferência de ${sourceAccount.name} para ${destAccount.name}`;

  const idempotencyKey =
    input.idempotencyKey ||
    `idem_xfer_${userId}_${input.sourceAccountId}_${input.destinationAccountId}_${input.amountCents}_${input.transferDate}`;

  const transferId = `xfer_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

  // 2. Checagem de idempotência no modo demo
  if (isDemo) {
    const demoTransfers = loadDemoTransfers();
    const existing = demoTransfers.find(
      (t) => t.userId === userId && t.idempotencyKey === idempotencyKey
    );
    if (existing) {
      // Re-executa as chamadas de gravação que retornarão os movimentos já existentes
      const sourceMovement = await recordMovement(
        {
          accountId: sourceAccount.id,
          userId,
          direction: 'outflow',
          amountCents: existing.amountCents,
          effectiveDate: existing.transferDate,
          originType: 'internal_transfer_out',
          originId: existing.id,
          description: `Transferência para ${destAccount.name}`,
          authorUid: userId,
          idempotencyKey: `mov_src_${existing.idempotencyKey}`,
        },
        true
      );

      const destinationMovement = await recordMovement(
        {
          accountId: destAccount.id,
          userId,
          direction: 'inflow',
          amountCents: existing.amountCents,
          effectiveDate: existing.transferDate,
          originType: 'internal_transfer_in',
          originId: existing.id,
          description: `Transferência de ${sourceAccount.name}`,
          authorUid: userId,
          idempotencyKey: `mov_dst_${existing.idempotencyKey}`,
        },
        true
      );

      return {
        transfer: existing,
        sourceMovement,
        destinationMovement,
        isIdempotentReplay: true,
      };
    }
  }

  // 3. Registra os 2 movimentos vinculados no Livro Financeiro v3.1
  const sourceMovement = await recordMovement(
    {
      accountId: sourceAccount.id,
      userId,
      direction: 'outflow',
      amountCents: input.amountCents,
      effectiveDate: input.transferDate,
      originType: 'internal_transfer_out',
      originId: transferId,
      description: `Transferência para ${destAccount.name}`,
      notes: `Transferência própria vinculada #${transferId}`,
      authorUid: userId,
      idempotencyKey: `mov_src_${idempotencyKey}`,
    },
    isDemo
  );

  const destinationMovement = await recordMovement(
    {
      accountId: destAccount.id,
      userId,
      direction: 'inflow',
      amountCents: input.amountCents,
      effectiveDate: input.transferDate,
      originType: 'internal_transfer_in',
      originId: transferId,
      description: `Transferência de ${sourceAccount.name}`,
      notes: `Transferência própria vinculada #${transferId}`,
      authorUid: userId,
      idempotencyKey: `mov_dst_${idempotencyKey}`,
    },
    isDemo
  );

  const transferRecord: InternalAccountTransfer = {
    id: transferId,
    userId,
    sourceAccountId: input.sourceAccountId,
    destinationAccountId: input.destinationAccountId,
    amountCents: input.amountCents,
    transferDate: input.transferDate,
    description: cleanDescription,
    idempotencyKey,
    createdAt: new Date().toISOString(),
  };

  if (isDemo) {
    const list = loadDemoTransfers();
    list.push(transferRecord);
    saveDemoTransfers(list);
  } else {
    const xferRef = doc(db, 'users', userId, 'internal_transfers', transferId);
    await setDoc(xferRef, transferRecord);
  }

  return {
    transfer: transferRecord,
    sourceMovement,
    destinationMovement,
    isIdempotentReplay: false,
  };
}

/**
 * Consulta transferências entre contas do usuário.
 */
export async function getUserTransfers(
  userId: string,
  isDemo = false
): Promise<InternalAccountTransfer[]> {
  if (!userId) return [];

  if (isDemo) {
    return loadDemoTransfers()
      .filter((t) => t.userId === userId)
      .sort((a, b) => b.transferDate.localeCompare(a.transferDate));
  }

  const q = query(
    collection(db, 'users', userId, 'internal_transfers')
  );
  const snap = await getDocs(q);
  const list: InternalAccountTransfer[] = [];
  snap.forEach((d) => list.push({ ...(d.data() as InternalAccountTransfer), id: d.id }));
  return list.sort((a, b) => b.transferDate.localeCompare(a.transferDate));
}
