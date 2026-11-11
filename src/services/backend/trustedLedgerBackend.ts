import {
  Account,
  CentsInteger,
  DateString,
  FinancialMovement,
  FinancialMovementConfirmationStatus,
  FinancialMovementDirection,
  FinancialMovementOriginType,
} from '../../types/financeV3';
import {
  buildCompensatoryMovement,
  buildFinancialMovement,
  generateMovementDocId,
  generateReversalDocId,
  reconcileAccountBalance,
  validateMovementPayloadMatch,
  validatePositiveCents,
} from '../../utils/movementLedger';

/**
 * ==============================================================================
 * BACKEND CONFIÁVEL DO LIVRO FINANCEIRO (TRUSTED FINANCIAL LEDGER BACKEND) — v3.1
 * ==============================================================================
 * Camada de arquitetura preparada para execução no ambiente de backend confiável
 * (Node.js runtime, Firebase Admin SDK, Cloud Functions ou Cloud Run).
 *
 * Princípios de Segurança e Autoridade:
 * 1. O cliente NUNCA calcula nem dita o saldo projetado (projectedBalanceCents).
 * 2. O backend valida a identidade e a titularidade antes de abrir a transação ACID.
 * 3. A chave de idempotência é auditada no backend: payloads divergentes com a
 *    mesma chave são rejeitados com erro explícito de integridade contábil.
 * 4. Os IDs de documentos são estritamente determinísticos e derivados por SHA-256
 *    no escopo da conta, impedindo sobrescrita arbitrária ou duplicação.
 * 5. Estornos ocorrem estritamente via geração de movimento compensatório oposto
 *    (append-only), sem qualquer mutação do registro histórico original.
 */

// ------------------------------------------------------------------------------
// Contratos de Requisição e Resposta de Backend
// ------------------------------------------------------------------------------

export interface RecordMovementBackendRequest {
  accountId: string;
  userId: string;
  direction: FinancialMovementDirection;
  amountCents: CentsInteger;
  effectiveDate: DateString;
  originType: FinancialMovementOriginType;
  originId: string;
  description: string;
  notes?: string;
  authorUid: string;
  idempotencyKey: string;
}

export interface RecordMovementBackendResponse {
  movement: FinancialMovement;
  newProjectedBalanceCents: CentsInteger;
  isIdempotentReplay: boolean;
  executedAt: string;
}

export interface ReverseMovementBackendRequest {
  accountId: string;
  movementId: string;
  authorUid: string;
  reason: string;
  idempotencyKey?: string;
}

export interface ReverseMovementBackendResponse {
  compensatoryMovement: FinancialMovement;
  newProjectedBalanceCents: CentsInteger;
  isIdempotentReplay: boolean;
  executedAt: string;
}

export interface ReconcileAccountBackendRequest {
  accountId: string;
  authorUid: string;
}

export interface ReconcileAccountBackendResponse {
  accountId: string;
  previousBalanceCents: CentsInteger;
  reconciledBalanceCents: CentsInteger;
  differenceCents: CentsInteger;
  hasDivergence: boolean;
  movementsCount: number;
  reconciledAt: string;
}

// ------------------------------------------------------------------------------
// Interface do Provedor de Banco de Dados Confiável (Admin Firestore Adapter)
// ------------------------------------------------------------------------------

export interface TrustedDbAdapter {
  getAccount(accountId: string): Promise<Account | null>;
  getMovement(accountId: string, movementId: string): Promise<FinancialMovement | null>;
  getAllAccountMovements(accountId: string): Promise<FinancialMovement[]>;
  runAcidTransaction<T>(
    updateFunction: (tx: {
      getAccount(accountId: string): Promise<Account | null>;
      getMovement(accountId: string, movementId: string): Promise<FinancialMovement | null>;
      setMovement(accountId: string, movement: FinancialMovement): void;
      updateAccountBalance(accountId: string, newBalanceCents: CentsInteger): void;
    }) => Promise<T>
  ): Promise<T>;
}

// ------------------------------------------------------------------------------
// Classe de Serviço Autorizada para Backend Confiável
// ------------------------------------------------------------------------------

export class TrustedFinancialLedgerBackend {
  constructor(private readonly db: TrustedDbAdapter) {}

  /**
   * Grava uma movimentação financeira de forma estritamente autoritativa no servidor.
   */
  async recordMovement(
    request: RecordMovementBackendRequest
  ): Promise<RecordMovementBackendResponse> {
    if (!validatePositiveCents(request.amountCents)) {
      throw new Error('O valor da movimentação deve ser um inteiro estritamente positivo em centavos.');
    }
    if (!request.accountId?.trim()) {
      throw new Error('Identificador da conta (accountId) é obrigatório.');
    }
    if (!request.authorUid?.trim()) {
      throw new Error('Identificador do autor da operação (authorUid) é obrigatório.');
    }
    if (!request.idempotencyKey?.trim()) {
      throw new Error('Chave de idempotência (idempotencyKey) é obrigatória para operações de backend.');
    }

    const candidateMovement = buildFinancialMovement({
      accountId: request.accountId,
      userId: request.userId,
      direction: request.direction,
      amountCents: request.amountCents,
      effectiveDate: request.effectiveDate,
      originType: request.originType,
      originId: request.originId,
      description: request.description,
      notes: request.notes,
      authorUid: request.authorUid,
      idempotencyKey: request.idempotencyKey,
    });

    return await this.db.runAcidTransaction(async (tx) => {
      const account = await tx.getAccount(request.accountId);
      if (!account) {
        throw new Error(`Conta bancária "${request.accountId}" não encontrada.`);
      }

      if (account.userId !== request.userId) {
        throw new Error('Violação de autorização: Titular da conta diverge do usuário solicitante.');
      }

      if (account.isArchived) {
        throw new Error(`A conta "${account.name}" está arquivada e rejeita novas operações.`);
      }

      // Verificação determinística de idempotência por ID e chave primária
      const existingMovement = await tx.getMovement(request.accountId, candidateMovement.id);
      if (existingMovement) {
        // Valida se o payload repedido confere com o original
        validateMovementPayloadMatch(existingMovement, candidateMovement);
        return {
          movement: existingMovement,
          newProjectedBalanceCents: account.projectedBalanceCents,
          isIdempotentReplay: true,
          executedAt: new Date().toISOString(),
        };
      }

      const delta =
        candidateMovement.direction === 'inflow'
          ? candidateMovement.amountCents
          : -candidateMovement.amountCents;

      const newBalance = (account.projectedBalanceCents || 0) + delta;

      // Gravação atômica: Movimento no livro-razão + Saldo da conta
      tx.setMovement(request.accountId, candidateMovement);
      tx.updateAccountBalance(request.accountId, newBalance);

      return {
        movement: candidateMovement,
        newProjectedBalanceCents: newBalance,
        isIdempotentReplay: false,
        executedAt: new Date().toISOString(),
      };
    });
  }

  /**
   * Executa um estorno compensatório de forma estritamente autoritativa no servidor.
   */
  async reverseMovement(
    request: ReverseMovementBackendRequest
  ): Promise<ReverseMovementBackendResponse> {
    if (!request.accountId?.trim() || !request.movementId?.trim()) {
      throw new Error('Parâmetros insuficientes para execução de estorno.');
    }
    if (!request.reason?.trim()) {
      throw new Error('Justificativa do estorno é obrigatória conforme a arquitetura.');
    }

    const reversalDocId = generateReversalDocId(request.movementId);

    return await this.db.runAcidTransaction(async (tx) => {
      const account = await tx.getAccount(request.accountId);
      if (!account) {
        throw new Error(`Conta "${request.accountId}" não encontrada.`);
      }

      if (account.isArchived) {
        throw new Error('Não é permitido estornar movimentações em contas arquivadas.');
      }

      // Checa idempotência: se o estorno compensatório determinístico já existe
      const existingReversal = await tx.getMovement(request.accountId, reversalDocId);
      if (existingReversal) {
        return {
          compensatoryMovement: existingReversal,
          newProjectedBalanceCents: account.projectedBalanceCents,
          isIdempotentReplay: true,
          executedAt: new Date().toISOString(),
        };
      }

      const original = await tx.getMovement(request.accountId, request.movementId);
      if (!original) {
        throw new Error(`Movimentação original "${request.movementId}" não encontrada.`);
      }

      if (account.userId !== request.authorUid && original.userId !== request.authorUid) {
        throw new Error('Permissão negada para estornar este movimento.');
      }

      if (original.reversalOfMovementId) {
        throw new Error(
          `Operação inválida: O movimento "${request.movementId}" já é um estorno compensatório.`
        );
      }

      const compensatory = buildCompensatoryMovement({
        originalMovement: original,
        authorUid: request.authorUid,
        reason: request.reason,
      });

      const delta =
        compensatory.direction === 'inflow'
          ? compensatory.amountCents
          : -compensatory.amountCents;

      const newBalance = (account.projectedBalanceCents || 0) + delta;

      // Gravação atômica: Estorno no livro-razão + Saldo da conta
      tx.setMovement(request.accountId, compensatory);
      tx.updateAccountBalance(request.accountId, newBalance);

      return {
        compensatoryMovement: compensatory,
        newProjectedBalanceCents: newBalance,
        isIdempotentReplay: false,
        executedAt: new Date().toISOString(),
      };
    });
  }

  /**
   * Reconcilia integralmente o saldo de uma conta a partir da totalidade dos seus movimentos históricos.
   */
  async reconcileAccount(
    request: ReconcileAccountBackendRequest
  ): Promise<ReconcileAccountBackendResponse> {
    const account = await this.db.getAccount(request.accountId);
    if (!account) {
      throw new Error(`Conta "${request.accountId}" não encontrada.`);
    }

    if (account.userId !== request.authorUid) {
      throw new Error('Permissão negada para auditar ou reconciliar esta conta.');
    }

    const movements = await this.db.getAllAccountMovements(request.accountId);
    const reconciledBalanceCents = reconcileAccountBalance(movements);
    const previousBalanceCents = account.projectedBalanceCents || 0;
    const differenceCents = reconciledBalanceCents - previousBalanceCents;
    const hasDivergence = differenceCents !== 0;

    if (hasDivergence) {
      await this.db.runAcidTransaction(async (tx) => {
        tx.updateAccountBalance(request.accountId, reconciledBalanceCents);
      });
    }

    return {
      accountId: request.accountId,
      previousBalanceCents,
      reconciledBalanceCents,
      differenceCents,
      hasDivergence,
      movementsCount: movements.length,
      reconciledAt: new Date().toISOString(),
    };
  }
}
