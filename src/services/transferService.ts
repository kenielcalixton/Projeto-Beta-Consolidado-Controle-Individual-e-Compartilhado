import {
  collection,
  getDocs,
  query,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from './firebase';
import {
  Account,
  CentsInteger,
  DateString,
  FinancialMovement,
  InternalAccountTransfer,
} from '../types/financeV3';
import { withDemoLock } from './ledgerService';
import { universalStorage } from '../utils/universalStorage';
import {
  buildFinancialMovement,
  validateMovementPayloadMatch,
  validatePositiveCents,
} from '../utils/movementLedger';
import { sha256Hex } from '../utils/hashUtils';

/**
 * ==============================================================================
 * SERVIÇO DE TRANSFERÊNCIAS ENTRE CONTAS PRÓPRIAS (v3.1)
 * ==============================================================================
 * Caminho Canônico: users/{userId}/internal_transfers/{transferId}
 *
 * Princípios Fundamentais:
 * 1. Não é receita nem despesa (não afeta resultado contábil do usuário).
 * 2. Gera 2 movimentos vinculados no Livro Financeiro em TRANSAÇÃO ÚNICA ATÔMICA:
 *    - Saída ('outflow') na conta origem (originType: 'internal_transfer_out').
 *    - Entrada ('inflow') na conta destino (originType: 'internal_transfer_in').
 * 3. Invariância patrimonial: Saldo total consolidado (+V - V = 0) permanece idêntico.
 * 4. Isolamento estrito: Ambas as contas devem pertencer obrigatoriamente ao mesmo usuário.
 * 5. Idempotência por chave determinística com validação estrita de payload.
 */

const DEMO_TRANSFERS_KEY = 'mpf_v3_demo_internal_transfers';
const DEMO_MOVEMENTS_KEY = 'mpf_v3_demo_movements';

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
 * Em ambiente Firestore real/emulador, delega para executeInternalTransferOfficial (Admin SDK)
 * garantindo que saída, entrada, ambos os saldos e o documento de transferência ocorram em
 * uma única transação atômica.
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

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.transferDate || '')) {
    throw new Error('Data de transferência inválida. Use o formato YYYY-MM-DD.');
  }

  const cleanDesc = input.description?.trim() || 'Transferência entre contas próprias';
  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    `idem_xfer_${userId}_${input.sourceAccountId}_${input.destinationAccountId}_${input.amountCents}_${input.transferDate}`;

  if (isDemo) {
    return await withDemoLock(() => {
      const accountsRaw = universalStorage.getItem('mpf_v3_demo_accounts');
      const accounts: Account[] = accountsRaw ? JSON.parse(accountsRaw) : [];
      const srcIdx = accounts.findIndex((a) => a.id === input.sourceAccountId);
      const dstIdx = accounts.findIndex((a) => a.id === input.destinationAccountId);

      const sourceAccount = srcIdx >= 0 ? accounts[srcIdx] : null;
      const destAccount = dstIdx >= 0 ? accounts[dstIdx] : null;

      if (!sourceAccount) {
        throw new Error(`Conta de origem "${input.sourceAccountId}" não encontrada.`);
      }
      if (!destAccount) {
        throw new Error(`Conta de destino "${input.destinationAccountId}" não encontrada.`);
      }

      if (sourceAccount.userId !== userId || destAccount.userId !== userId) {
        throw new Error(
          'Violação de segurança: Transferências entre contas só são permitidas entre contas do mesmo usuário.'
        );
      }

      if (sourceAccount.isArchived) {
        throw new Error(
          `A conta de origem "${sourceAccount.name}" está arquivada e não pode realizar saídas.`
        );
      }
      if (destAccount.isArchived) {
        throw new Error(
          `A conta de destino "${destAccount.name}" está arquivada e não pode receber transferências.`
        );
      }

      if (sourceAccount.type === 'credit' || destAccount.type === 'credit') {
        throw new Error(
          'Transferências diretas não são permitidas para contas de cartão de crédito. Utilize o pagamento de fatura.'
        );
      }

      const cleanSlug = idempotencyKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
      const transferId = `trf_${cleanSlug}_${sha256Hex(`${userId}:${idempotencyKey}`)}`;
      const outIdemKey = `${idempotencyKey}_out`;
      const inIdemKey = `${idempotencyKey}_in`;

      const demoTransfers = loadDemoTransfers();
      const movRaw = universalStorage.getItem(DEMO_MOVEMENTS_KEY);
      const demoMovements: FinancialMovement[] = movRaw ? JSON.parse(movRaw) : [];

      const existingTransfer = demoTransfers.find(
        (t) => t.userId === userId && (t.id === transferId || t.idempotencyKey === idempotencyKey)
      );

      if (existingTransfer) {
        if (
          existingTransfer.sourceAccountId !== input.sourceAccountId ||
          existingTransfer.destinationAccountId !== input.destinationAccountId ||
          existingTransfer.amountCents !== input.amountCents ||
          existingTransfer.transferDate !== input.transferDate
        ) {
          throw new Error(
            `Conflito de idempotência: A chave "${idempotencyKey}" já foi utilizada para uma transferência com parâmetros divergentes.`
          );
        }

        const existingOut = demoMovements.find(
          (m) => m.accountId === sourceAccount.id && m.idempotencyKey === outIdemKey
        );
        const existingIn = demoMovements.find(
          (m) => m.accountId === destAccount.id && m.idempotencyKey === inIdemKey
        );

        if (existingOut && existingIn) {
          return {
            transfer: existingTransfer,
            sourceMovement: existingOut,
            destinationMovement: existingIn,
            isIdempotentReplay: true,
          };
        }
      }

      const candidateOut = buildFinancialMovement({
        accountId: sourceAccount.id,
        userId,
        direction: 'outflow',
        amountCents: input.amountCents,
        effectiveDate: input.transferDate,
        originType: 'internal_transfer_out',
        originId: transferId,
        description: `${cleanDesc} (Para: ${destAccount.name})`,
        notes: `Transferência própria vinculada #${transferId}`,
        authorUid: userId,
        idempotencyKey: outIdemKey,
      });

      const candidateIn = buildFinancialMovement({
        accountId: destAccount.id,
        userId,
        direction: 'inflow',
        amountCents: input.amountCents,
        effectiveDate: input.transferDate,
        originType: 'internal_transfer_in',
        originId: transferId,
        description: `${cleanDesc} (De: ${sourceAccount.name})`,
        notes: `Transferência própria vinculada #${transferId}`,
        authorUid: userId,
        idempotencyKey: inIdemKey,
      });

      const prevOut = demoMovements.find((m) => m.id === candidateOut.id);
      if (prevOut) {
        validateMovementPayloadMatch(prevOut, candidateOut);
      }
      const prevIn = demoMovements.find((m) => m.id === candidateIn.id);
      if (prevIn) {
        validateMovementPayloadMatch(prevIn, candidateIn);
      }

      const nowIso = new Date().toISOString();
      if (!prevOut) {
        demoMovements.push(candidateOut);
        accounts[srcIdx].projectedBalanceCents -= input.amountCents;
        accounts[srcIdx].updatedAt = nowIso;
      }
      if (!prevIn) {
        demoMovements.push(candidateIn);
        accounts[dstIdx].projectedBalanceCents += input.amountCents;
        accounts[dstIdx].updatedAt = nowIso;
      }

      const transferRecord: InternalAccountTransfer = {
        id: transferId,
        userId,
        sourceAccountId: input.sourceAccountId,
        destinationAccountId: input.destinationAccountId,
        amountCents: input.amountCents,
        transferDate: input.transferDate,
        description: cleanDesc,
        idempotencyKey,
        sourceMovementId: candidateOut.id,
        destinationMovementId: candidateIn.id,
        createdAt: existingTransfer ? existingTransfer.createdAt : nowIso,
      };

      if (!existingTransfer) {
        demoTransfers.push(transferRecord);
      }

      universalStorage.setItem(DEMO_MOVEMENTS_KEY, JSON.stringify(demoMovements));
      universalStorage.setItem('mpf_v3_demo_accounts', JSON.stringify(accounts));
      saveDemoTransfers(demoTransfers);

      return {
        transfer: transferRecord,
        sourceMovement: prevOut || candidateOut,
        destinationMovement: prevIn || candidateIn,
        isIdempotentReplay: false,
      };
    });
  }

  // Execução Transacional Autoritativa via Cloud Function (Admin SDK)
  const callable = httpsCallable<
    {
      userId: string;
      sourceAccountId: string;
      destinationAccountId: string;
      amountCents: CentsInteger;
      transferDate: DateString;
      description?: string;
      idempotencyKey: string;
    },
    {
      transfer: InternalAccountTransfer;
      outflowMovement: FinancialMovement;
      inflowMovement: FinancialMovement;
      isIdempotentReplay: boolean;
    }
  >(functions, 'executeInternalTransferOfficial');

  const response = await callable({
    userId,
    sourceAccountId: input.sourceAccountId,
    destinationAccountId: input.destinationAccountId,
    amountCents: input.amountCents,
    transferDate: input.transferDate,
    description: cleanDesc,
    idempotencyKey,
  });

  return {
    transfer: response.data.transfer,
    sourceMovement: response.data.outflowMovement,
    destinationMovement: response.data.inflowMovement,
    isIdempotentReplay: response.data.isIdempotentReplay,
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
