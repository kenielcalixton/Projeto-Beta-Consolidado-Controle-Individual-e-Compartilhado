/**
 * ==============================================================================
 * TIPAGEM CANÔNICA DEFINITIVA — ARQUITETURA FINANCEIRA v3.1
 * ==============================================================================
 * Sistema Financeiro Individual, Espaços Compartilhados, Rateios Avulsos,
 * Transferências sob Custódia, Listas de Aquisição com Copropriedade e Livro de Movimentações.
 *
 * Referência Oficial: arquitetura_de_dados_definitiva_v3_1.md (Seção 4).
 *
 * REGRAS NORMATIVAS ESTRITAS DESTA TIPAGEM:
 * 1. Todos os valores monetários são expressos em centavos inteiros (SafeInteger).
 * 2. FinancialMovement é um livro-razão estritamente append-only (sem status mutável 'reversed').
 * 3. Segregação rigorosa de papéis: autoria, responsabilidade, financiamento e validação.
 * 4. Isolamento físico de dados bancários privados (PrivatePaymentMetadata).
 * 5. Nenhum acoplamento implícito com os tipos legados (finance.ts / acquisitions.ts).
 */

// ==============================================================================
// TIPOS PRIMITIVOS E FORMATOS CANÔNICOS DE DOMÍNIO
// ==============================================================================

/** Timestamp ISO-8601 com fuso horário (ex: "2026-11-09T18:00:00.000Z") */
export type ISO8601String = string;

/** Data civil no formato YYYY-MM-DD */
export type DateString = string;

/** Competência contábil e fatura no formato YYYY-MM */
export type CompetenceMonthString = string;

/**
 * Montante monetário expresso estritamente em centavos da moeda BRL (R$ 1,00 = 100 centavos).
 * Deve sempre satisfazer Number.isSafeInteger() e ser >= 0 para transações,
 * podendo ser assinado (negativo/positivo) para saldos líquidos consolidados.
 */
export type CentsInteger = number;

// ==============================================================================
// 4.1. LIVRO OFICIAL DE MOVIMENTAÇÕES E CONTAS PESSOAIS
// ==============================================================================

export type FinancialMovementDirection = 'inflow' | 'outflow';

export type FinancialMovementOriginType =
  | 'personal_expense'
  | 'personal_income'
  | 'internal_transfer_in'
  | 'internal_transfer_out'
  | 'credit_card_payment'
  | 'adhoc_receipt'
  | 'personal_refund'
  | 'custody_deposit'
  | 'custody_withdrawal'
  | 'custody_return'
  | 'custody_transfer_out'
  | 'custody_transfer_in'
  | 'custody_return_out'
  | 'custody_return_in'
  | 'settlement_inflow'
  | 'settlement_outflow'
  | 'supplier_refund'
  | 'shared_reimbursement'
  | 'restitution_inflow'
  | 'restitution_outflow'
  | 'manual_adjustment';

/**
 * Status contábil de liquidação ou conciliação bancária do movimento.
 * Imutável após gravação no livro-razão append-only.
 * (A reversão é modelada por um novo movimento compensatório apontando via reversalOfMovementId).
 */
export type FinancialMovementConfirmationStatus = 'cleared' | 'reconciled';

/**
 * Fonte absoluta e canônica da verdade contábil para saldos e conciliações.
 * Caminho Firestore: accounts/{accountId}/movements/{movementId}
 */
export interface FinancialMovement {
  /** UUID v4 do movimento (PK) */
  id: string;
  /** FK accounts/{accountId} */
  accountId: string;
  /** FK users/{uid} — titular da conta */
  userId: string;
  /** Sentido do recurso financeiro na conta */
  direction: FinancialMovementDirection;
  /** Valor estritamente positivo em centavos inteiros */
  amountCents: CentsInteger;
  /** Data do efetivo débito/crédito bancário (YYYY-MM-DD) */
  effectiveDate: DateString;
  /** Timestamp ISO da gravação no sistema */
  registeredAt: ISO8601String;
  /** Tipo de operação geradora */
  originType: FinancialMovementOriginType;
  /** ID do documento que motivou a movimentação (ex: txId, transferId, settlementId, paymentId) */
  originId: string;
  /** Status contábil imutável */
  confirmationStatus: FinancialMovementConfirmationStatus;
  /** Chave canônica de unicidade e idempotência */
  idempotencyKey: string;
  /**
   * Presente exclusivamente em movimentos compensatórios de estorno;
   * referencia o movementId original que está sendo anulado por contrapartida de sinais.
   */
  reversalOfMovementId?: string;
  /** Rótulo explicativo para o extrato da conta */
  description: string;
  /** Justificativa contábil, obrigatória em ajustes manuais */
  notes?: string;
  /** UID de quem comandou a operação */
  authorUid: string;
}

export type AccountType = 'checking' | 'credit' | 'wallet' | 'savings';

/**
 * Representação de contas bancárias correntes, carteiras, cartões e poupanças.
 * Caminho Firestore: accounts/{accountId}
 */
export interface Account {
  id: string;
  /** FK users/{uid} — proprietário da conta */
  userId: string;
  name: string;
  type: AccountType;
  /**
   * Projeção em cache derivada do histórico oficial de FinancialMovement.
   * Nunca mutado manualmente sem um movimento correspondente.
   */
  projectedBalanceCents: CentsInteger;
  /** Limite de crédito contratado para cartões */
  creditLimitCents?: CentsInteger;
  /** Dia de fechamento da fatura (1 a 31) */
  closingDay?: number;
  /** Dia de vencimento da fatura (1 a 31) */
  dueDay?: number;
  /** Hexadecimal da cor para UI */
  color: string;
  icon: string;
  /** Se arquivada, bloqueada para novas movimentações operacionais */
  isArchived: boolean;
  createdAt: ISO8601String;
  updatedAt: ISO8601String;
}

/**
 * Dados bancários privados e comprovantes confidenciais com isolamento físico estrito.
 * Caminho Firestore: accounts/{accountId}/private_payment_metadata/{paymentId}
 */
export interface PrivatePaymentMetadata {
  id: string;
  accountId: string;
  userId: string;
  bankName: string;
  agencyNumber?: string;
  accountNumber?: string;
  pixKey?: string;
  receiptStorageUrl?: string;
  createdAt: ISO8601String;
}

export type CreditCardInvoiceStatus =
  | 'open'
  | 'closed'
  | 'partially_paid'
  | 'paid'
  | 'overdue'
  | 'carried_over';

/**
 * Competência mensal de fatura de cartão de crédito.
 * Caminho Firestore: accounts/{accountId}/invoices/{invoiceMonth}
 */
export interface CreditCardInvoice {
  /** PK: Formato YYYY-MM (ex: "2026-11") */
  id: CompetenceMonthString;
  accountId: string;
  userId: string;
  invoiceMonth: CompetenceMonthString;
  closingDate: DateString;
  dueDate: DateString;
  /** Soma de despesas alocadas a esta fatura */
  totalPurchasesAmountCents: CentsInteger;
  /** Saldo principal não pago transportado da fatura anterior */
  carriedOverBalanceCents: CentsInteger;
  /** Encargos, juros de mora e multas contratuais */
  interestAndFeesCents: CentsInteger;
  /** totalPurchasesAmountCents + carriedOverBalanceCents + interestAndFeesCents */
  totalDueAmountCents: CentsInteger;
  /** Total de amortizações pagas pelo usuário */
  totalPaidAmountCents: CentsInteger;
  /** totalDueAmountCents - totalPaidAmountCents */
  remainingBalanceCents: CentsInteger;
  invoiceStatus: CreditCardInvoiceStatus;
  /** Competência de destino caso o saldo residual tenha sido transportado via carry-over */
  carriedOverToMonth?: CompetenceMonthString;
  updatedAt: ISO8601String;
}

/**
 * Lançamento de compra alocado à fatura de cartão de crédito.
 * Caminho Firestore: accounts/{accountId}/invoices/{invoiceMonth}/charges/{chargeId}
 */
export interface CreditCardInvoiceCharge {
  id: string;
  transactionId: string;
  accountId: string;
  userId: string;
  invoiceMonth: CompetenceMonthString;
  description: string;
  amountCents: CentsInteger;
  purchaseDate: DateString;
  categoryId: string;
  categoryName: string;
  status: 'active' | 'cancelled';
  createdAt: ISO8601String;
  updatedAt: ISO8601String;
}

/**
 * Amortização da fatura de cartão com débito em conta corrente ou carteira.
 * Caminho Firestore: accounts/{accountId}/invoices/{invoiceMonth}/payments/{paymentId}
 */
export interface InvoicePayment {
  id: string;
  invoiceMonth: CompetenceMonthString;
  accountId: string;
  /** FK da conta corrente/carteira debitada */
  sourceAccountId: string;
  amountPaidCents: CentsInteger;
  paymentDate: DateString;
  /** FK FinancialMovement gerado na conta pagadora */
  financialMovementId: string;
  clientTransactionUuid: string;
  idempotencyKey?: string;
  createdAt: ISO8601String;
}

export type InvoiceCarryOverStatus = 'active' | 'settled';

/**
 * Transporte de saldo não pago de fatura para a competência seguinte (rotativo).
 * Caminho Firestore: accounts/{accountId}/invoices/{invoiceMonth}/carry_overs/{carryId}
 */
export interface InvoiceCarryOver {
  id: string;
  sourceInvoiceMonth: CompetenceMonthString;
  targetInvoiceMonth: CompetenceMonthString;
  unpaidPrincipalCents: CentsInteger;
  interestRateMonthly: number;
  appliedInterestCents: CentsInteger;
  status: InvoiceCarryOverStatus;
  createdAt: ISO8601String;
}

export type PersonalTransactionType = 'income' | 'expense';
export type PersonalTransactionStatus =
  | 'forecast'
  | 'pending'
  | 'partially_paid'
  | 'paid'
  | 'overdue'
  | 'cancelled';
export type PersonalTransactionOriginType =
  | 'manual'
  | 'shopping_list'
  | 'recurrence'
  | 'installment';

/**
 * Despesas, receitas e previsões estritamente individuais.
 * Caminho Firestore: users/{userId}/personal_transactions/{txId}
 */
export interface PersonalTransaction {
  id: string;
  userId: string;
  description: string;
  amountCents: CentsInteger;
  type: PersonalTransactionType;
  status: PersonalTransactionStatus;
  categoryId: string;
  categoryName: string;
  /**
   * Opcional enquanto forecast/pending; obrigatório no momento da efetivação (paid/partially_paid),
   * quando gera o FinancialMovement correspondente.
   */
  accountId?: string;
  competenceDate: DateString;
  dueDate: DateString;
  paymentDate?: DateString;
  invoiceMonth?: CompetenceMonthString;
  financialMovementId?: string;
  originType: PersonalTransactionOriginType;
  originRefId?: string;
  idempotencyKey: string;
  /** Total já amortizado por pagamentos parciais em centavos inteiros */
  paidAmountCents?: CentsInteger;
  /** Saldo devedor ou pendente restante em centavos inteiros */
  remainingAmountCents?: CentsInteger;
  notes?: string;
  createdAt: ISO8601String;
  updatedAt?: ISO8601String;
}

/**
 * Evento de amortização / pagamento parcial ou total de obrigação individual.
 * Caminho Firestore: users/{userId}/personal_transactions/{txId}/payments/{paymentId}
 */
export interface PersonalTransactionPayment {
  id: string;
  transactionId: string;
  userId: string;
  amountCents: CentsInteger;
  paymentDate: DateString;
  accountId: string;
  financialMovementId: string;
  authorUid: string;
  idempotencyKey?: string;
  notes?: string;
  createdAt: ISO8601String;
}

/**
 * Evento compensatório de estorno de amortização / pagamento individual.
 * Caminho Firestore: users/{userId}/personal_transactions/{txId}/payment_reversals/{reversalId}
 * Registrado em modelo estritamente append-only sem mutação do pagamento original.
 */
export interface PersonalTransactionPaymentReversal {
  id: string;
  transactionId: string;
  paymentId: string;
  userId: string;
  amountCents: CentsInteger;
  originalFinancialMovementId: string;
  reversalMovementId: string;
  reversalDate: DateString;
  reversedAt: ISO8601String;
  authorUid: string;
  reason: string;
  idempotencyKey?: string;
  createdAt: ISO8601String;
}

/**
 * Visão consolidada de um pagamento individual acompanhado de seu eventual evento de estorno.
 * Obtida via junção dinâmica entre o registro imutável do pagamento e os eventos da subcoleção payment_reversals.
 */
export interface PersonalTransactionPaymentView extends PersonalTransactionPayment {
  isReversed: boolean;
  reversal?: PersonalTransactionPaymentReversal;
  reversalMovementId?: string;
  reversalDate?: DateString;
  reversedAt?: ISO8601String;
  reversalReason?: string;
}

/**
 * Categorias individuais de receitas e despesas.
 * Caminho Firestore: users/{userId}/categories/{categoryId}
 */
export type PersonalCategoryType = 'income' | 'expense' | 'both';

export interface PersonalCategory {
  id: string;
  userId: string;
  name: string;
  type: PersonalCategoryType;
  color: string;
  icon: string;
  isArchived: boolean;
  createdAt: ISO8601String;
  updatedAt: ISO8601String;
}

/**
 * Planejamento de orçamento individual por competência.
 * Caminho Firestore: users/{userId}/budgets/{budgetId}
 */
export type BudgetStatus = 'on_track' | 'warning' | 'exceeded';

export interface PersonalBudget {
  id: string;
  userId: string;
  name: string;
  categoryIds: string[];
  competenceMonth: CompetenceMonthString; // YYYY-MM
  plannedAmountCents: CentsInteger;
  notes?: string;
  createdAt: ISO8601String;
  updatedAt: ISO8601String;
}

export interface PersonalBudgetProgress extends PersonalBudget {
  /** Indicador 1 — Realizado: despesas efetivamente reconhecidas como consumo no período */
  realizedAmountCents: CentsInteger;
  /** Alias de compatibilidade para realizedAmountCents */
  spentAmountCents: CentsInteger;
  /** Indicador 2 — Comprometido: obrigações assumidas (pendentes/vencidas/saldo parcial) ainda não pagas */
  committedAmountCents: CentsInteger;
  /** Parcela estritamente estimada (status 'forecast') no período */
  forecastOnlyAmountCents: CentsInteger;
  /** Indicador 3 — Previsto: projeção total (Realizado + Comprometido + Estimativas futuras) */
  forecastedAmountCents: CentsInteger;
  /** Saldo livre em relação ao realizado (plannedAmountCents - realizedAmountCents) */
  remainingAmountCents: CentsInteger;
  /** Saldo livre projetado considerando o previsto total (plannedAmountCents - forecastedAmountCents) */
  projectedRemainingAmountCents: CentsInteger;
  percentageUsed: number;
  percentageCommitted: number;
  percentageForecasted: number;
  status: BudgetStatus;
}

/**
 * Reembolsos individuais vinculados a despesas pessoais.
 * Caminho Firestore: users/{userId}/personal_refunds/{refundId}
 */
export type PersonalRefundStatus =
  | 'pending'
  | 'partially_received'
  | 'received'
  | 'cancelled';

export interface PersonalRefund {
  id: string;
  userId: string;
  originalTransactionId: string;
  debtorName: string;
  amountDueCents: CentsInteger;
  amountReceivedCents: CentsInteger;
  remainingAmountCents: CentsInteger;
  status: PersonalRefundStatus;
  description: string;
  idempotencyKey?: string;
  notes?: string;
  createdAt: ISO8601String;
  updatedAt: ISO8601String;
}

/**
 * Evento de recebimento de reembolso com crédito em conta/carteira.
 * Caminho Firestore: users/{userId}/personal_refunds/{refundId}/receipts/{receiptId}
 */
export interface PersonalRefundReceipt {
  id: string;
  refundId: string;
  originalTransactionId: string;
  userId: string;
  amountCents: CentsInteger;
  receiptDate: DateString;
  destinationAccountId: string;
  financialMovementId: string;
  originType: 'personal_refund';
  idempotencyKey?: string;
  authorUid: string;
  notes?: string;
  createdAt: ISO8601String;
}

/**
 * Transferências entre contas próprias do mesmo usuário.
 * Caminho Firestore: users/{userId}/internal_transfers/{transferId}
 */
export interface InternalAccountTransfer {
  id: string;
  userId: string;
  sourceAccountId: string;
  destinationAccountId: string;
  sourceMovementId?: string;
  destinationMovementId?: string;
  amountCents: CentsInteger;
  transferDate: DateString;
  description: string;
  idempotencyKey: string;
  createdAt: ISO8601String;
}

// ==============================================================================
// 4.2. RATEIOS AVULSOS E DEVEDORES EXTERNOS
// ==============================================================================

export type AdhocSplitExpenseFundingSource = 'personal_checking' | 'credit_card' | 'wallet';
export type AdhocSplitExpenseStatus = 'active' | 'partially_reimbursed' | 'fully_reimbursed' | 'cancelled';

/**
 * Despesa individual compartilhada pontualmente com terceiros (fora de espaços).
 * Caminho Firestore: adhoc_expenses/{expenseId}
 */
export interface AdhocSplitExpense {
  id: string;
  /** Autor do cadastro e credor primário */
  ownerUid: string;
  ownerName: string;
  title: string;
  description?: string;
  /** Valor bruto original desembolsado */
  totalAmountCents: CentsInteger;
  /** Cota que cabe ao autor */
  ownerShareAmountCents: CentsInteger;
  /** totalAmountCents - ownerShareAmountCents */
  totalToReimburseCents: CentsInteger;
  /** Total de reembolsos recebidos e confirmados */
  totalReimbursedCents: CentsInteger;
  /** totalToReimburseCents - totalReimbursedCents */
  remainingToReimburseCents: CentsInteger;
  fundingSource: AdhocSplitExpenseFundingSource;
  sourceAccountId: string;
  financialMovementId?: string;
  date: DateString;
  status: AdhocSplitExpenseStatus;
  registeredDebtorUids: string[];
  hasExternalDebtors: boolean;
  createdAt: ISO8601String;
}

export type ExternalDebtorIdentificationType = 'name_only' | 'email_invited';
export type ExternalDebtorStatus = 'pending' | 'partially_cleared' | 'cleared' | 'cancelled';

/**
 * Pessoa externa sem conta no app (Exclusivo para rateios avulsos, vedado em espaços).
 * Caminho Firestore: adhoc_expenses/{expenseId}/external_debtors/{debtorId}
 */
export interface ExternalDebtorRecord {
  id: string;
  adhocExpenseId: string;
  name: string;
  identificationType: ExternalDebtorIdentificationType;
  email?: string;
  assignedAmountCents: CentsInteger;
  totalReimbursedCents: CentsInteger;
  remainingBalanceCents: CentsInteger;
  debtorStatus: ExternalDebtorStatus;
  inviteTokenId?: string;
  migratedToUid?: string;
  createdAt: ISO8601String;
}

/**
 * Evento imutável de recebimento manual de devedor externo com impacto bancário real.
 * Caminho Firestore: adhoc_expenses/{expenseId}/external_debtors/{debtorId}/receipt_events/{eventId}
 */
export interface AdhocReceiptEvent {
  id: string;
  debtorId: string;
  adhocExpenseId: string;
  amountCents: CentsInteger;
  receivedDate: DateString;
  /** Conta corrente ou carteira do credor onde entrou o dinheiro real */
  destinationAccountId: string;
  registeredByUid: string;
  /** FK FinancialMovement gerado na conta do credor */
  financialMovementId: string;
  notes?: string;
  createdAt: ISO8601String;
}

export type AdhocInviteTokenStatus = 'pending' | 'accepted' | 'expired' | 'revoked';

/**
 * Token seguro para associação de convidados que se cadastram após o rateio avulso.
 * Caminho Firestore: adhoc_invites/{tokenId}
 */
export interface AdhocInviteToken {
  /** PK: Hash SHA-256 do token criptográfico gerado */
  id: string;
  adhocExpenseId: string;
  debtorRecordId: string;
  invitedEmail: string;
  assignedAmountCents: CentsInteger;
  creatorUid: string;
  expiresAt: ISO8601String;
  tokenStatus: AdhocInviteTokenStatus;
  acceptedByUid?: string;
  acceptedAt?: ISO8601String;
  createdAt: ISO8601String;
}

export type AdhocSplitObligationStatus =
  | 'pending_invite'
  | 'accepted'
  | 'rejected'
  | 'partially_paid'
  | 'payment_informed'
  | 'confirmed_cleared';

/**
 * Conta a pagar visível no painel do convidado autenticado no app.
 * Caminho Firestore: users/{guestUid}/adhoc_obligations/{obligationId}
 */
export interface AdhocSplitObligation {
  id: string;
  adhocExpenseId: string;
  guestUid: string;
  creditorUid: string;
  creditorName: string;
  assignedAmountCents: CentsInteger;
  paidAmountCents: CentsInteger;
  remainingBalanceCents: CentsInteger;
  obligationStatus: AdhocSplitObligationStatus;
  guestRejectionReason?: string;
  paymentDeclarationDate?: DateString;
  paymentProofUrl?: string;
  updatedAt: ISO8601String;
}

export type AdhocReimbursementStatus = 'pending_confirmation' | 'confirmed' | 'rejected';

/**
 * Evento de liquidação de rateio avulso informado por usuário cadastrado.
 * Caminho Firestore: adhoc_expenses/{expenseId}/reimbursements/{reimbursementId}
 */
export interface AdhocReimbursement {
  id: string;
  adhocExpenseId: string;
  obligationId?: string;
  externalDebtorId?: string;
  debtorUid: string;
  creditorUid: string;
  amountCents: CentsInteger;
  paymentDate: DateString;
  paymentProofUrl?: string;
  status: AdhocReimbursementStatus;
  /** Conta bancária selecionada pelo credor para entrada real de caixa */
  destinationAccountId?: string;
  financialMovementId?: string;
  confirmedAt?: ISO8601String;
  rejectionReason?: string;
  clientTransactionUuid: string;
  createdAt: ISO8601String;
}

// ==============================================================================
// 4.3. ESPAÇOS COMPARTILHADOS, GOVERNANÇA E DISSOLUÇÃO DEFINITIVA
// ==============================================================================

export type SpaceStatus = 'active' | 'archived' | 'pending_dissolution' | 'dissolved';
export type SpaceModuleType = 'finance' | 'acquisitions';

/**
 * Entidade central de governança do grupo colaborativo.
 * Caminho Firestore: spaces/{spaceId}
 */
export interface Space {
  id: string;
  /** Autoridade exclusiva para solicitar exclusão definitiva */
  creatorUid: string;
  /** Administrador técnico */
  ownerId: string;
  name: string;
  description?: string;
  icon: string;
  color: string;
  spaceStatus: SpaceStatus;
  archivedAt?: ISO8601String;
  archivedByUid?: string;
  /** Array sincronizado de membros ativos para regras Firestore e autorização operacional */
  memberUids: string[];
  /** Array sincronizado de todos os membros que já participaram do espaço (ativos + egressos) para acesso histórico de consulta */
  historicalMemberUids?: string[];
  enabledModules: SpaceModuleType[];
  monthlyBudgetCents?: CentsInteger;
  createdAt: ISO8601String;
}

export type SpaceMemberRole = 'owner' | 'admin' | 'member';
export type SpaceMemberParticipationStatus =
  | 'invited'
  | 'active'
  | 'voluntary_exit'
  | 'removed_by_admin'
  | 'declined';

/**
 * Registro de participação individual de um membro no espaço.
 * Caminho Firestore: spaces/{spaceId}/members/{memberUid}
 */
export interface SpaceMember {
  id: string;
  spaceId: string;
  uid: string;
  displayName: string;
  contactEmail: string;
  role: SpaceMemberRole;
  participationStatus: SpaceMemberParticipationStatus;
  invitedAt: ISO8601String;
  joinedAt?: ISO8601String;
  exitedAt?: ISO8601String;
}

export type AuthorDataDestinationDecision =
  | 'pending'
  | 'migrate_to_existing_personal_space'
  | 'create_personal_space_and_migrate'
  | 'archive_or_hide'
  | 'delete_permanently';

export type SpaceDissolutionRequestStatus =
  | 'pending_author_responses'
  | 'fully_approved_ready'
  | 'auto_cancelled_timeout'
  | 'cancelled_by_creator'
  | 'executed';

/**
 * Processo formal e restrito de exclusão definitiva com destinação individual.
 * Caminho Firestore: spaces/{spaceId}/dissolution/request
 */
export interface SpaceDissolutionRequest {
  id: 'request';
  spaceId: string;
  /** Restrito exclusivamente ao criador do espaço */
  initiatedByUid: string;
  initiatedAt: ISO8601String;
  /** Prazo improrrogável = initiatedAt + 30 dias */
  deadlineDate: ISO8601String;
  requestStatus: SpaceDissolutionRequestStatus;
  totalRecordsAudit: {
    expensesCount: number;
    paymentsCount: number;
    listsCount: number;
    itemsCount: number;
    custodyTransfersCount: number;
  };
  authorDestinations: Record<
    string,
    {
      decision: AuthorDataDestinationDecision;
      targetSpaceId?: string;
      decidedAt?: ISO8601String;
    }
  >;
  cancelledAt?: ISO8601String;
  cancellationReason?: string;
}

export type SpaceInviteTokenStatus = 'pending' | 'accepted' | 'rejected' | 'expired' | 'revoked';

/**
 * Token e convite seguro para ingresso em espaço compartilhado.
 * O ID do documento é o hash SHA-256 do token criptográfico (nunca o token em texto puro).
 * Caminho Firestore: space_invites/{tokenHash}
 */
export interface SpaceInvite {
  /** PK: Hash SHA-256 do token gerado */
  id: string;
  spaceId: string;
  spaceName: string;
  invitedEmail?: string;
  invitedRole: SpaceMemberRole;
  invitedByUid: string;
  invitedByName: string;
  tokenStatus: SpaceInviteTokenStatus;
  /** Data de expiração ISO-8601 (prazo padrão configurável, ex: 15 dias, aguardando aprovação definitiva) */
  expiresAt: ISO8601String;
  acceptedByUid?: string;
  acceptedByName?: string;
  acceptedAt?: ISO8601String;
  rejectedByUid?: string;
  rejectedAt?: ISO8601String;
  revokedByUid?: string;
  revokedAt?: ISO8601String;
  createdAt: ISO8601String;
}

export type SpaceAuditEventType =
  | 'space_created'
  | 'invite_created'
  | 'invite_accepted'
  | 'invite_rejected'
  | 'invite_revoked'
  | 'member_joined'
  | 'member_role_changed'
  | 'member_voluntary_exit'
  | 'member_removed'
  | 'space_archived'
  | 'space_unarchived'
  | 'dissolution_requested'
  | 'author_destination_decided'
  | 'dissolution_cancelled'
  | 'shared_expense_created'
  | 'payment_declaration_submitted'
  | 'payment_approved'
  | 'payment_rejected'
  | 'payment_approval_revoked'
  | 'supplier_refund_recorded'
  | 'restitution_created'
  | 'restitution_declared'
  | 'restitution_receipt_confirmed'
  | 'custody_transfer_created'
  | 'custody_receipt_confirmed'
  | 'custody_consumed'
  | 'custody_return_requested'
  | 'custody_return_confirmed';

/**
 * Evento imutável de governança e auditoria do espaço.
 * Caminho Firestore: spaces/{spaceId}/audit/{eventId}
 */
export interface SpaceAuditEvent {
  id: string;
  spaceId: string;
  eventType: SpaceAuditEventType;
  performedByUid: string;
  performedByName: string;
  targetUid?: string;
  targetName?: string;
  details?: Record<string, unknown>;
  timestamp: ISO8601String;
}

export type SpaceNotificationType =
  | 'invite_received'
  | 'invite_accepted'
  | 'invite_rejected'
  | 'member_removed'
  | 'member_exited'
  | 'space_archived'
  | 'space_unarchived'
  | 'dissolution_requested'
  | 'dissolution_decision_pending'
  | 'dissolution_cancelled'
  | 'shared_expense_assigned'
  | 'payment_declaration_submitted'
  | 'payment_approved'
  | 'payment_rejected'
  | 'payment_correction_requested'
  | 'payment_approval_revoked'
  | 'supplier_refund_confirmed'
  | 'restitution_created'
  | 'restitution_declared'
  | 'restitution_receipt_confirmed'
  | 'custody_transfer_created'
  | 'custody_receipt_confirmed'
  | 'custody_consumed'
  | 'custody_return_requested'
  | 'custody_return_confirmed'
  | 'liability_settled';

/**
 * Notificação destinada a um usuário sobre fatos relevantes de espaços compartilhados.
 * Caminho Firestore: users/{userId}/notifications/{notificationId}
 */
export interface SpaceNotification {
  id: string;
  userId: string;
  spaceId: string;
  spaceName: string;
  type: SpaceNotificationType;
  title: string;
  message: string;
  read: boolean;
  actionUrl?: string;
  senderUid?: string;
  originEventId?: string;
  createdAt: ISO8601String;
}

export type SharedExpenseValidationStatus = 'pending_validation' | 'approved' | 'rejected' | 'cancelled';
export type SharedExpenseCommitmentStatus = 'active' | 'closed' | 'cancelled_pre_payment' | 'loss_unrecoverable';
export type SharedExpensePaymentExecutionStatus = 'unpaid' | 'partially_paid' | 'fully_paid';
export type SharedExpenseOriginType = 'manual' | 'shopping_list' | 'installment' | 'recurrence';

/**
 * Despesa coletiva com segregação formal de autoria e responsabilidade.
 * Caminho Firestore: spaces/{spaceId}/shared_expenses/{expenseId}
 */
export interface SharedExpense {
  id: string;
  spaceId: string;
  title: string;
  description?: string;
  totalOriginalAmountCents: CentsInteger;
  competenceMonth: CompetenceMonthString;
  competenceDate: DateString;
  dueDate?: DateString;
  categoryId: string;
  categoryName: string;
  /** Quem cadastrou a despesa */
  createdByUid: string;
  /** Responsável financeiro e credor legítimo para validação */
  responsibleUid: string;
  /** Quem efetivamente desembolsou os fundos ao fornecedor (padrão: responsibleUid) */
  payerUid?: string;
  /** UIDs dos participantes incluídos no rateio */
  participantUids?: string[];
  validationStatus: SharedExpenseValidationStatus;
  validatedByUid?: string;
  validatedAt?: ISO8601String;
  rejectionReason?: string;
  commitmentStatus: SharedExpenseCommitmentStatus;
  paymentExecutionStatus: SharedExpensePaymentExecutionStatus;
  totalPaidToSupplierCents: CentsInteger;
  originType: SharedExpenseOriginType;
  originRefId?: string;
  idempotencyKey: string;
  createdAt: ISO8601String;
}

export type ExpenseLiabilitySplitMethod = 'equal' | 'percentage' | 'custom_value';
export type ExpenseLiabilityStatus =
  | 'pending'
  | 'payment_declared'
  | 'in_validation'
  | 'partially_paid'
  | 'paid'
  | 'rejected'
  | 'cancelled';

/**
 * Cota de responsabilidade de cada participante no rateio da despesa.
 * Caminho Firestore: spaces/{spaceId}/shared_expenses/{expenseId}/liabilities/{memberUid}
 */
export interface ExpenseLiability {
  id: string;
  expenseId: string;
  spaceId: string;
  memberUid: string;
  memberName: string;
  /** Cota original atribuída no rateio inicial (imutável) */
  assignedShareAmountCents: CentsInteger;
  /** Alias explícito para o valor original da responsabilidade */
  originalAmountCents?: CentsInteger;
  /** Reduções proporcionais decorrentes de reembolsos/devoluções comerciais do fornecedor */
  refundAdjustmentCents?: CentsInteger;
  /** Cota líquida atualizada = assignedShareAmountCents - (refundAdjustmentCents || 0) */
  adjustedShareAmountCents: CentsInteger;
  paidAmountCents?: CentsInteger;
  remainingAmountCents?: CentsInteger;
  /** Crédito individual gerado quando o valor já pago pelo membro excede a nova cota líquida após reembolso */
  creditNoteCents?: CentsInteger;
  status?: ExpenseLiabilityStatus;
  splitMethod: ExpenseLiabilitySplitMethod;
  splitRatio?: number;
  roundingRemainderRank?: number;
}

export type PaymentDeclarationStatus = 'pending_validation' | 'approved' | 'rejected' | 'cancelled';
export type PaymentDeclarationMethod = 'pix' | 'bank_transfer' | 'cash' | 'credit_card' | 'other';

/**
 * Declaração formal de pagamento pelo devedor perante o credor da despesa.
 * Caminho Firestore: spaces/{spaceId}/shared_expenses/{expenseId}/payment_declarations/{declarationId}
 * Documento append-only e imutável após sua criação. Seu status é derivado dos eventos.
 */
export interface ExpensePaymentDeclaration {
  id: string;
  expenseId: string;
  spaceId: string;
  memberUid: string;
  memberName: string;
  responsibleUid: string;
  payerUid?: string;
  amountCents: CentsInteger;
  paymentDate: DateString;
  paymentMethod: PaymentDeclarationMethod;
  sourceAccountId?: string;
  proofUrl?: string;
  notes?: string;
  status: PaymentDeclarationStatus;
  rejectionReason?: string;
  idempotencyKey: string;
  createdAt: ISO8601String;
  updatedAt: ISO8601String;
}

/**
 * Evento independente e imutável de rejeição de declaração de pagamento.
 * Caminho Firestore: spaces/{spaceId}/shared_expenses/{expenseId}/payment_rejections/{rejectionId}
 */
export interface ExpensePaymentRejection {
  id: string;
  expenseId: string;
  spaceId: string;
  declarationId: string;
  liabilityId: string;
  memberUid: string;
  responsibleUid: string;
  amountCents: CentsInteger;
  reason: string;
  rejectionReason?: string;
  rejectedByUid: string;
  rejectedAt: ISO8601String;
  idempotencyKey: string;
  createdAt: ISO8601String;
}

/**
 * Evento imutável de aprovação de pagamento emitido exclusivamente pelo responsável financeiro.
 * Caminho Firestore: spaces/{spaceId}/shared_expenses/{expenseId}/payment_approvals/{approvalId}
 */
export interface ExpensePaymentApproval {
  id: string;
  expenseId: string;
  spaceId: string;
  declarationId: string;
  liabilityId?: string;
  memberUid: string;
  responsibleUid: string;
  /** Beneficiário legítimo do reembolso (quem desembolsou ao fornecedor: payerUid) */
  beneficiaryUid?: string;
  amountCents: CentsInteger;
  destinationAccountId?: string;
  financialMovementId?: string;
  approvedAt: ISO8601String;
  approverUid: string;
  /**
   * Campo derivado em memória a partir de `approval_revocations` ou compatibilidade legada de leitura.
   * Nunca deve ser mutado no documento original de aprovação no Firestore/Storage.
   */
  isRevoked?: boolean;
  revokedAt?: ISO8601String;
  revocationId?: string;
  idempotencyKey: string;
  createdAt: ISO8601String;
}

/**
 * Evento compensatório independente e imutável de revogação de aprovação pelo responsável financeiro.
 * Caminho Firestore: spaces/{spaceId}/shared_expenses/{expenseId}/approval_revocations/{revocationId}
 */
export interface ExpenseApprovalRevocation {
  id: string;
  expenseId: string;
  spaceId: string;
  approvalId: string;
  declarationId: string;
  liabilityId?: string;
  memberUid: string;
  responsibleUid: string;
  beneficiaryUid?: string;
  revokedAmountCents: CentsInteger;
  compensatoryMovementId?: string;
  /**
   * Indica que a compensação contábil gerou saldo projetado insuficiente na conta onde o crédito foi reconhecido,
   * exigindo restituição real pendente (não é devolução bancária automática).
   */
  requiresRestitution?: boolean;
  restitutionPendingCents?: CentsInteger;
  reason: string;
  revokedByUid: string;
  revokedAt: ISO8601String;
  idempotencyKey: string;
  createdAt: ISO8601String;
}

export type ExpenseRestitutionStatus = 'pending' | 'partial' | 'settled';

/**
 * Obrigação de restituição financeira independente vinculada a uma revogação de aprovação.
 * O valor da obrigação independe do saldo atual da conta e é recomposto conforme recebimentos confirmados.
 * Caminho Firestore: spaces/{spaceId}/shared_expenses/{expenseId}/restitutions/{restitutionId}
 */
export interface ExpenseRestitutionObligation {
  id: string;
  spaceId: string;
  expenseId: string;
  liabilityId: string;
  approvalId: string;
  revocationId: string;
  /** Quem recebeu fundos da aprovação original e tem o dever de restituir */
  debtorUid: string;
  /** Quem tem direito ao crédito/ressarcimento da restituição */
  creditorUid: string;
  amountToRestoreCents: CentsInteger;
  restitutedAmountCents: CentsInteger;
  remainingAmountCents: CentsInteger;
  status: ExpenseRestitutionStatus;
  reason: string;
  createdAt: ISO8601String;
  updatedAt: ISO8601String;
}

/**
 * Declaração unilateral de devolução/restituição de valores pelo devedor da obrigação.
 * Caminho Firestore: spaces/{spaceId}/shared_expenses/{expenseId}/restitutions/{restitutionId}/declarations/{declarationId}
 */
export interface ExpenseRestitutionDeclaration {
  id: string;
  restitutionId: string;
  spaceId: string;
  expenseId: string;
  debtorUid: string;
  amountCents: CentsInteger;
  paymentDate: DateString;
  paymentProofUrl?: string;
  notes?: string;
  idempotencyKey: string;
  createdAt: ISO8601String;
}

/**
 * Confirmação de recebimento real da restituição pelo credor legítimo (reconhece entrada financeira).
 * Imutável após criação (append-only).
 * Caminho Firestore: spaces/{spaceId}/shared_expenses/{expenseId}/restitutions/{restitutionId}/receipts/{receiptId}
 */
export interface ExpenseRestitutionReceipt {
  id: string;
  restitutionId: string;
  spaceId: string;
  expenseId: string;
  declarationId?: string;
  creditorUid: string;
  debtorUid: string;
  amountCents: CentsInteger;
  destinationAccountId: string;
  financialMovementId: string;
  confirmedAt: ISO8601String;
  notes?: string;
  idempotencyKey: string;
  createdAt: ISO8601String;
}

export type ExpensePaymentFundingSource = 'personal_checking' | 'credit_card' | 'wallet' | 'custody_transfer';
export type ExpensePaymentValidationStatus = 'pending_validation' | 'approved' | 'rejected';

/**
 * Desembolso financeiro perante o fornecedor comercial.
 * Caminho Firestore: spaces/{spaceId}/shared_expenses/{expenseId}/payments/{paymentId}
 */
export interface ExpensePayment {
  id: string;
  expenseId: string;
  spaceId: string;
  amountCents: CentsInteger;
  paymentDate: DateString;
  /** Quem entregou o dinheiro ao fornecedor */
  executedByUid: string;
  /** Quem forneceu os fundos (próprios ou de custódia) */
  economicFunderUid: string;
  fundingSource: ExpensePaymentFundingSource;
  custodyTransferId?: string;
  publicPayerLabel: string;
  validationStatus: ExpensePaymentValidationStatus;
  /** O responsibleUid da despesa valida o desembolso */
  validatedByUid?: string;
  financialMovementId?: string;
  clientTransactionUuid: string;
  createdAt: ISO8601String;
}

export type BilateralDebtStatus = 'open' | 'partially_settled' | 'fully_settled';

/**
 * Projeção determinística de créditos bilaterais constituídos por despesa.
 * Caminho Firestore: spaces/{spaceId}/shared_expenses/{expenseId}/bilateral_debts/{debtId}
 */
export interface BilateralDebtLedger {
  id: string;
  expenseId: string;
  spaceId: string;
  competenceMonth: CompetenceMonthString;
  debtorUid: string;
  creditorUid: string;
  originalFinancedAmountCents: CentsInteger;
  liquidatedCents: CentsInteger;
  currentRemainingDebtCents: CentsInteger;
  status: BilateralDebtStatus;
}

export type SettlementRecordStatus = 'pending_confirmation' | 'confirmed' | 'rejected' | 'reverted';

/**
 * Liquidação bilateral de dívidas entre devedor e credor no espaço.
 * Caminho Firestore: spaces/{spaceId}/settlements/{settlementId}
 */
export interface SettlementRecord {
  id: string;
  spaceId: string;
  debtorUid: string;
  creditorUid: string;
  amountSettledCents: CentsInteger;
  settlementDate: DateString;
  paymentDeclarationProofUrl?: string;
  destinationAccountId?: string;
  sourceAccountId?: string;
  status: SettlementRecordStatus;
  confirmedAt?: ISO8601String;
  /** Validação exclusiva pelo credor que recebe os fundos */
  confirmedByUid?: string;
  financialMovementInflowId?: string;
  financialMovementOutflowId?: string;
  clientTransactionUuid: string;
  createdAt: ISO8601String;
}

/**
 * Alocação FIFO de amortização em cada dívida bilateral específica.
 * Caminho Firestore: spaces/{spaceId}/settlements/{settlementId}/allocations/{allocationId}
 */
export interface SettlementAllocation {
  id: string;
  settlementId: string;
  bilateralDebtId: string;
  expenseId: string;
  competenceMonth: CompetenceMonthString;
  amountAllocatedCents: CentsInteger;
}

/**
 * Trilha de estorno contábil de liquidação com preservação do histórico.
 * Caminho Firestore: spaces/{spaceId}/settlements/{settlementId}/reversions/{reversionId}
 */
export interface SettlementReversionEvent {
  id: string;
  settlementId: string;
  requestedByUid: string;
  confirmedByUid: string;
  revertReason: string;
  reversalMovementInflowId?: string;
  reversalMovementOutflowId?: string;
  revertedAt: ISO8601String;
}

export type SupplierRefundType = 'full_refund' | 'partial_refund' | 'unrecoverable_loss';

/**
 * Evento de cancelamento, devolução ou prejuízo comercial por fornecedor.
 * Caminho Firestore: spaces/{spaceId}/shared_expenses/{expenseId}/refunds/{refundId}
 */
export interface SupplierRefundEvent {
  id: string;
  expenseId: string;
  spaceId?: string;
  refundType: SupplierRefundType;
  amountRefundedCents: CentsInteger;
  lossAmountCents: CentsInteger;
  recipientUid: string;
  destinationAccountId?: string;
  date: DateString;
  justification: string;
  createdAt: ISO8601String;
}

// ==============================================================================
// 4.4. TRANSFERÊNCIAS SOB CUSTÓDIA E ADIANTAMENTOS
// ==============================================================================

export type CustodyTransferScopeType = 'shared_space' | 'direct_bilateral';

/**
 * 11 estados explícitos documentados na arquitetura v3.1 (Seção 5 e 7).
 */
export type CustodyTransferStatus =
  | 'pending_receipt'
  | 'available'
  | 'partially_used'
  | 'fully_used'
  | 'partial_return_pending'
  | 'partial_return_confirmed'
  | 'full_return_pending'
  | 'full_return_confirmed'
  | 'settled_by_usage'
  | 'settled_by_return'
  | 'settled_by_mixed';

export type CustodyTransferType = 'linked_to_expense' | 'free_custody';

/**
 * Contrato bilateral de adiantamento e custódia de recursos.
 * Caminho Firestore: transfers/{transferId}
 */
export interface CustodyTransfer {
  id: string;
  scopeType: CustodyTransferScopeType;
  spaceId?: string;
  transferType?: CustodyTransferType;
  targetExpenseId?: string;
  senderUid: string;
  custodianUid: string;
  initialAmountCents: CentsInteger;
  confirmedAmountCents?: CentsInteger;
  usedAmountCents: CentsInteger;
  returnedAmountCents: CentsInteger;
  /** initialAmountCents - (usedAmountCents + returnedAmountCents) >= 0 */
  availableBalanceCents: CentsInteger;
  sourceAccountId: string;
  destinationAccountId?: string;
  custodyStatus: CustodyTransferStatus;
  description?: string;
  notes?: string;
  transferDate?: DateString;
  idempotencyKey?: string;
  sourceMovementId?: string;
  destinationMovementId?: string;
  confirmedAt?: ISO8601String;
  createdAt: ISO8601String;
  updatedAt: ISO8601String;
}

export type CustodyTransferEventType =
  | 'transfer_declared'
  | 'receipt_confirmed'
  | 'expense_consumed'
  | 'return_requested'
  | 'return_confirmed'
  | 'adjustment_reverted';

/**
 * Subcoleção imutável de eventos da custódia com impacto bancário real.
 * Caminho Firestore: transfers/{transferId}/events/{eventId}
 */
export interface CustodyTransferEvent {
  id: string;
  transferId: string;
  eventType: CustodyTransferEventType;
  amountCents: CentsInteger;
  targetExpenseId?: string;
  affectedAccountId?: string;
  financialMovementId?: string;
  performedByUid: string;
  justification?: string;
  clientTransactionUuid: string;
  idempotencyKey?: string;
  timestamp: ISO8601String;
}

/**
 * Registro de utilização de recursos em custódia para pagamento de despesa compartilhada.
 * Caminho Firestore: transfers/{transferId}/usages/{usageId}
 */
export interface CustodyUsage {
  id: string;
  transferId: string;
  spaceId?: string;
  expenseId: string;
  amountCents: CentsInteger;
  usedByUid: string;
  beneficiaryUid: string;
  notes?: string;
  idempotencyKey: string;
  createdAt: ISO8601String;
}

/**
 * Registro de devolução (parcial ou integral) de fundos em custódia para o remetente original.
 * Caminho Firestore: transfers/{transferId}/returns/{returnId}
 */
export interface CustodyReturn {
  id: string;
  transferId: string;
  spaceId?: string;
  amountCents: CentsInteger;
  returnedByUid: string;
  receivedByUid: string;
  sourceAccountId: string;
  destinationAccountId: string;
  sourceMovementId: string;
  destinationMovementId: string;
  justification?: string;
  idempotencyKey: string;
  createdAt: ISO8601String;
}

/**
 * Resumo consolidado de saldos sob custódia entre participantes de um espaço compartilhado.
 */
export interface CustodyBalanceSummary {
  senderUid: string;
  custodianUid: string;
  totalInitialCents: CentsInteger;
  totalConfirmedCents: CentsInteger;
  totalUsedCents: CentsInteger;
  totalReturnedCents: CentsInteger;
  availableBalanceCents: CentsInteger;
}

// ==============================================================================
// 4.5. RECORRÊNCIAS E PARCELAMENTOS DESACOPLADOS
// ==============================================================================

export type RecurrenceRuleScope = 'personal' | 'shared';
export type RecurrenceRuleFrequency = 'monthly' | 'weekly' | 'yearly';
export type RecurrenceRuleStatus = 'active' | 'paused' | 'cancelled';

/**
 * Regra mestra geradora de despesas periódicas (não reescreve histórico passado).
 * Caminho Firestore: recurrence_rules/{ruleId}
 */
export interface RecurrenceRule {
  id: string;
  scope: RecurrenceRuleScope;
  userId: string;
  spaceId?: string;
  title: string;
  description?: string;
  amountCents: CentsInteger;
  frequency: RecurrenceRuleFrequency;
  interval: number;
  startCompetence: CompetenceMonthString;
  endCompetence?: CompetenceMonthString;
  dueDay: number;
  categoryId: string;
  defaultAccountId?: string;
  status: RecurrenceRuleStatus;
  createdAt: ISO8601String;
}

export type RecurrenceInstanceGenerationStatus = 'pending' | 'generated' | 'skipped';

/**
 * Instância concreta gerada para uma competência específica YYYY-MM.
 * Caminho Firestore: recurrence_rules/{ruleId}/instances/{competenceMonth}
 */
export interface RecurrenceInstance {
  id: CompetenceMonthString;
  ruleId: string;
  competenceMonth: CompetenceMonthString;
  generatedTransactionId?: string;
  generatedExpenseId?: string;
  generationStatus: RecurrenceInstanceGenerationStatus;
  actualAmountCents: CentsInteger;
  generatedAt: ISO8601String;
}

export type InstallmentContractScope = 'personal' | 'shared';
export type InstallmentContractFundingSource = 'credit_card' | 'personal_loan';
export type InstallmentContractStatus = 'active' | 'completed' | 'cancelled_early';

/**
 * Contrato mestre de parcelamento de compras ou financiamentos.
 * Caminho Firestore: installment_contracts/{contractId}
 */
export interface InstallmentContract {
  id: string;
  scope: InstallmentContractScope;
  userId: string;
  spaceId?: string;
  title: string;
  totalContractAmountCents: CentsInteger;
  totalInstallmentsCount: number;
  fundingSource: InstallmentContractFundingSource;
  sourceCardAccountId?: string;
  startCompetenceMonth: CompetenceMonthString;
  status: InstallmentContractStatus;
  cancellationReason?: string;
  createdAt: ISO8601String;
}

export type InstallmentOccurrenceStatus = 'scheduled' | 'billed' | 'paid' | 'cancelled';

/**
 * Parcela individual com competência e valores imutáveis após consolidação.
 * Caminho Firestore: installment_contracts/{contractId}/occurrences/{installmentNumber}
 */
export interface InstallmentOccurrence {
  /** PK: número da parcela com dois dígitos (ex: "01", "02") */
  id: string;
  contractId: string;
  installmentNumber: number;
  competenceMonth: CompetenceMonthString;
  principalAmountCents: CentsInteger;
  interestAmountCents: CentsInteger;
  totalInstallmentAmountCents: CentsInteger;
  linkedTransactionId?: string;
  linkedExpenseId?: string;
  status: InstallmentOccurrenceStatus;
  dueDate: DateString;
}

// ==============================================================================
// 4.6. LISTAS DE AQUISIÇÃO E COPROPRIEDADE DE BENS
// ==============================================================================

export type AcquisitionListScopeType = 'individual' | 'shared';
export type AcquisitionListType = 'recorrente' | 'objetivo' | 'desejo';

/**
 * Lista de aquisições categorizada.
 * Caminho Firestore: acquisition_lists/{listId}
 */
export interface AcquisitionList {
  id: string;
  scopeType: AcquisitionListScopeType;
  ownerUid?: string;
  spaceId?: string;
  name: string;
  description?: string;
  type: AcquisitionListType;
  memberUids: string[];
  createdByUid: string;
  createdAt: ISO8601String;
}

export type AcquisitionItemUnit = 'un' | 'kg' | 'L' | 'pct' | 'cx';
export type AcquisitionItemPriority = 'Baixa' | 'Média' | 'Alta';

/**
 * Item catalogado na lista de aquisição.
 * Caminho Firestore: acquisition_lists/{listId}/items/{itemId}
 */
export interface AcquisitionItem {
  id: string;
  listId: string;
  scopeType: AcquisitionListScopeType;
  ownerUid?: string;
  spaceId?: string;
  name: string;
  groupId: string;
  categoryId: string;
  listType: AcquisitionListType;
  stage: string;
  currentStock?: number;
  minStock?: number;
  unit?: AcquisitionItemUnit;
  targetAmountCents?: CentsInteger;
  estimatedPriceCents?: CentsInteger;
  priority?: AcquisitionItemPriority;
  inspirationUrl?: string;
  notes?: string;
  createdByUid: string;
  createdAt: ISO8601String;
  updatedAt: ISO8601String;
}

export type AcquisitionPurchaseOwnershipClassification = 'individual' | 'shared_participants' | 'space_asset';
export type AcquisitionPurchaseLinkedExpenseType = 'personal' | 'shared';

export interface AcquisitionPurchaseDisbursement {
  funderUid: string;
  funderName: string;
  disbursedAmountCents: CentsInteger;
  fundingSource: 'checking' | 'credit_card' | 'wallet' | 'custody';
  sourceAccountId?: string;
}

export interface AcquisitionPurchaseOwnershipShare {
  uid: string;
  name: string;
  disbursedAmountCents: CentsInteger;
  /** (disbursedAmountCents / totalPaidCents) * 100 */
  ownershipPercentage: number;
}

/**
 * Registro de compra efetiva com governança de copropriedade patrimonial imutável.
 * Caminho Firestore: acquisition_lists/{listId}/items/{itemId}/purchases/{purchaseId}
 */
export interface AcquisitionPurchaseRecord {
  id: string;
  itemId: string;
  listId: string;
  spaceId?: string;
  /** Quem realizou a compra física na loja */
  physicalBuyerUid: string;
  /** Quem cadastrou o registro no app */
  authorUid: string;
  storeName: string;
  brand?: string;
  quantity: number;
  unitPriceCents: CentsInteger;
  itemsNetCents: CentsInteger;
  shippingCents: CentsInteger;
  feesCents: CentsInteger;
  discountsCents: CentsInteger;
  /** itemsNetCents + shippingCents + feesCents - discountsCents */
  totalPaidCents: CentsInteger;
  purchaseDate: ISO8601String;
  receiptUrl?: string;
  ownershipClassification: AcquisitionPurchaseOwnershipClassification;
  disbursements: AcquisitionPurchaseDisbursement[];
  ownershipShares: AcquisitionPurchaseOwnershipShare[];
  linkedExpenseId: string;
  linkedExpenseType: AcquisitionPurchaseLinkedExpenseType;
  idempotencyKey: string;
  createdAt: ISO8601String;
}

/**
 * Cotação independente de mercado para itens de objetivo.
 * Caminho Firestore: acquisition_lists/{listId}/items/{itemId}/quotes/{quoteId}
 */
export interface AcquisitionQuoteEvent {
  id: string;
  itemId: string;
  storeName: string;
  priceCents: CentsInteger;
  url?: string;
  validUntil?: DateString;
  authorUid: string;
  createdAt: ISO8601String;
}

/**
 * Depósito ou aporte de poupança para meta de compra.
 * Caminho Firestore: acquisition_lists/{listId}/items/{itemId}/deposits/{depositId}
 */
export interface AcquisitionDepositEvent {
  id: string;
  itemId: string;
  contributorUid: string;
  amountCents: CentsInteger;
  sourceAccountId: string;
  financialMovementId?: string;
  depositDate: DateString;
  notes?: string;
  createdAt: ISO8601String;
}

export type StockMovementEventType = 'purchase_inflow' | 'manual_adjustment' | 'consumption_outflow';

/**
 * Evento imutável de movimentação de estoque para itens recorrentes.
 * Caminho Firestore: acquisition_lists/{listId}/items/{itemId}/stock_movements/{movementId}
 */
export interface StockMovementEvent {
  id: string;
  itemId: string;
  movementType: StockMovementEventType;
  quantityDelta: number;
  previousStock: number;
  newStock: number;
  authorUid: string;
  justification?: string;
  createdAt: ISO8601String;
}
