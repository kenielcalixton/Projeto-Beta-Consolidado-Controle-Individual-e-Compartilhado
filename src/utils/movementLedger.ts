import {
  CentsInteger,
  DateString,
  FinancialMovement,
  FinancialMovementConfirmationStatus,
  FinancialMovementDirection,
  FinancialMovementOriginType,
} from '../types/financeV3';
import { sha256Hex } from './hashUtils';

/**
 * ==============================================================================
 * MOTOR MATEMÁTICO DO LIVRO DE MOVIMENTAÇÕES (FINANCIAL MOVEMENT LEDGER)
 * ==============================================================================
 * Fonte canônica e determinística de cálculo contábil da arquitetura v3.1.
 * Todas as operações operam estritamente sobre centavos inteiros (CentsInteger).
 */

/**
 * Valida se um montante monetário é um centavo inteiro válido e positivo.
 */
export function validatePositiveCents(amountCents: unknown): amountCents is CentsInteger {
  return (
    typeof amountCents === 'number' &&
    Number.isSafeInteger(amountCents) &&
    amountCents > 0
  );
}

/**
 * Converte qualquer valor em Reais (string ou number) para centavos inteiros,
 * evitando imprecisões de ponto flutuante IEEE 754.
 * Ex: "1250,90" -> 125090 | 12.5 -> 1250 | "10" -> 1000
 */
export function parseBRLToCents(val: string | number): CentsInteger {
  if (typeof val === 'number') {
    if (Number.isSafeInteger(val)) return val;
    return Math.round(val * 100);
  }

  const clean = val
    .trim()
    .replace(/^R\$\s?/, '')
    .replace(/\s+/g, '')
    .replace(/\./g, '')
    .replace(',', '.');

  const parsed = parseFloat(clean);
  if (isNaN(parsed) || !isFinite(parsed)) {
    throw new Error(`Valor monetário inválido: "${val}"`);
  }

  const cents = Math.round(parsed * 100);
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`Montante excede o limite seguro de inteiros: "${val}"`);
  }

  return cents;
}

/**
 * Formata centavos inteiros para representação em moeda corrente BRL.
 * Ex: 125090 -> "R$ 1.250,90" | -5000 -> "-R$ 50,00"
 */
export function formatCentsToBRL(cents: CentsInteger): string {
  if (!Number.isSafeInteger(cents)) {
    cents = Math.round(cents || 0);
  }
  const isNegative = cents < 0;
  const absCents = Math.abs(cents);
  const reais = Math.floor(absCents / 100);
  const remainder = absCents % 100;
  const formattedReais = reais.toLocaleString('pt-BR');
  const formattedCentavos = remainder.toString().padStart(2, '0');
  const prefix = isNegative ? '-R$ ' : 'R$ ';
  return `${prefix}${formattedReais},${formattedCentavos}`;
}

/**
 * Reconcilia e recalcula o saldo oficial de uma conta a partir da totalidade dos seus movimentos históricos.
 * Regra v3.1 (Seção 6.1 e 7.2):
 * Saldo = Soma(Entradas) - Soma(Saídas)
 * Movimentos compensatórios de estorno anulam os movimentos originais diretamente pela álgebra (+V - V = 0).
 */
export function reconcileAccountBalance(movements: FinancialMovement[]): CentsInteger {
  let balance = 0;
  for (const mov of movements) {
    if (!validatePositiveCents(mov.amountCents)) {
      throw new Error(
        `Movimentação "${mov.id}" possui valor inválido em centavos: ${mov.amountCents}`
      );
    }
    if (mov.direction === 'inflow') {
      balance += mov.amountCents;
    } else if (mov.direction === 'outflow') {
      balance -= mov.amountCents;
    } else {
      throw new Error(`Direção desconhecida no movimento "${mov.id}": ${mov.direction}`);
    }
  }

  if (!Number.isSafeInteger(balance)) {
    throw new Error('O saldo reconciliado excedeu o limite seguro de representação numérica.');
  }

  return balance;
}

export interface BuildMovementParams {
  id?: string;
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
  idempotencyKey?: string;
  reversalOfMovementId?: string;
  confirmationStatus?: FinancialMovementConfirmationStatus;
}

/**
 * Gera um ID de documento determinístico e seguro para o Firestore a partir da chave de idempotência
 * e do escopo da conta, utilizando SHA-256 para evitar colisões entre caracteres especiais ou contas distintas.
 */
export function generateMovementDocId(accountIdOrKey: string, idempotencyKey?: string): string {
  let accountId = '';
  let key = '';

  if (idempotencyKey !== undefined) {
    accountId = (accountIdOrKey || '').trim();
    key = (idempotencyKey || '').trim();
  } else {
    key = (accountIdOrKey || '').trim();
  }

  const cleanSlug = key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  const hashInput = accountId ? `${accountId}:${key}` : key;
  const hash = sha256Hex(hashInput);

  return `mov_${cleanSlug ? `${cleanSlug}_` : ''}${hash}`;
}

/**
 * Gera o ID de documento determinístico para o movimento compensatório de um estorno.
 * Garante que somente 1 documento de estorno pode existir fisicamente por movimento original.
 */
export function generateReversalDocId(originalMovementId: string): string {
  const clean = originalMovementId.trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
  const hash = sha256Hex(originalMovementId);
  return `rev_${clean}_${hash}`;
}

/**
 * Gera o ID de documento determinístico para o evento compensatório de estorno de amortização individual.
 * Garante unicidade e idempotência estrita na subcoleção users/{userId}/personal_transactions/{txId}/payment_reversals/{reversalId}.
 */
export function generatePaymentReversalDocId(paymentId: string): string {
  const clean = paymentId.trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
  const hash = sha256Hex(paymentId);
  return `payrev_${clean}_${hash}`;
}

/**
 * Valida se um movimento existente com a mesma chave/ID é compatível com o candidato a ser gravado.
 * Se a mesma chave de idempotência for reutilizada com parâmetros financeiros diferentes (valor, direção, etc.),
 * lança um erro explícito para evitar corrupção silenciosa ou inconsistências contábeis.
 */
export function validateMovementPayloadMatch(
  existing: FinancialMovement,
  candidate: FinancialMovement
): void {
  const mismatches: string[] = [];

  if (existing.accountId !== candidate.accountId) {
    mismatches.push(`accountId (${existing.accountId} vs ${candidate.accountId})`);
  }
  if (existing.userId !== candidate.userId) {
    mismatches.push(`userId (${existing.userId} vs ${candidate.userId})`);
  }
  if (existing.direction !== candidate.direction) {
    mismatches.push(`direction (${existing.direction} vs ${candidate.direction})`);
  }
  if (existing.amountCents !== candidate.amountCents) {
    mismatches.push(`amountCents (${existing.amountCents} vs ${candidate.amountCents})`);
  }
  if (existing.originType !== candidate.originType) {
    mismatches.push(`originType (${existing.originType} vs ${candidate.originType})`);
  }
  if (existing.originId !== candidate.originId) {
    mismatches.push(`originId (${existing.originId} vs ${candidate.originId})`);
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Conflito de idempotência: A chave "${candidate.idempotencyKey || candidate.id}" já foi utilizada para outra operação com parâmetros divergentes: ${mismatches.join(', ')}.`
    );
  }
}

/**
 * Constrói e valida uma movimentação canônica antes da persistência no livro-razão.
 * Se o ID não for explicitamente fornecido, deriva deterministicamente da chave de idempotência,
 * garantindo unicidade atômica na subcoleção do Firestore.
 * Impede que IDs arbitrários burlem o determinismo.
 */
export function buildFinancialMovement(params: BuildMovementParams): FinancialMovement {
  if (!validatePositiveCents(params.amountCents)) {
    throw new Error('O valor do movimento deve ser um inteiro estritamente positivo em centavos.');
  }
  if (!params.accountId || !params.accountId.trim()) {
    throw new Error('Identificador da conta bancária (accountId) é obrigatório.');
  }
  if (!params.userId || !params.userId.trim()) {
    throw new Error('Identificador do titular da conta (userId) é obrigatório.');
  }
  if (!params.authorUid || !params.authorUid.trim()) {
    throw new Error('Identificador do autor da operação (authorUid) é obrigatório.');
  }
  if (params.direction !== 'inflow' && params.direction !== 'outflow') {
    throw new Error(`Direção do movimento inválida: "${params.direction}". Deve ser 'inflow' ou 'outflow'.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.effectiveDate)) {
    throw new Error(`Data efetiva inválida: "${params.effectiveDate}". Deve seguir formato YYYY-MM-DD.`);
  }

  const cleanDescription = (params.description || '').trim();
  if (!cleanDescription) {
    throw new Error('Descrição do movimento é obrigatória.');
  }

  const registeredAt = new Date().toISOString();

  // Chave canônica determinística para garantia de idempotência
  const idempotencyKey =
    params.idempotencyKey ||
    `idem_${params.originType}_${params.originId}_${params.direction}_${params.amountCents}`;

  // ID determinístico vinculado à chave de idempotência e ao escopo da conta (ou ao estorno)
  const expectedDocId = params.reversalOfMovementId
    ? generateReversalDocId(params.reversalOfMovementId)
    : generateMovementDocId(params.accountId, idempotencyKey);

  // Validação estrita do ID: impede burla do determinismo inclusive para estornos
  if (params.id && params.id !== expectedDocId) {
    throw new Error(
      `Identificador de documento inválido: O ID "${params.id}" fornecido não coincide com o ID determinístico esperado ("${expectedDocId}"). Não é permitido burlar o ID determinístico.`
    );
  }
  const id = expectedDocId;

  return {
    id,
    accountId: params.accountId.trim(),
    userId: params.userId.trim(),
    direction: params.direction,
    amountCents: params.amountCents,
    effectiveDate: params.effectiveDate,
    registeredAt,
    originType: params.originType,
    originId: params.originId.trim(),
    confirmationStatus: params.confirmationStatus || 'cleared',
    idempotencyKey,
    reversalOfMovementId: params.reversalOfMovementId,
    description: cleanDescription,
    notes: params.notes?.trim() || undefined,
    authorUid: params.authorUid.trim(),
  };
}

export interface BuildReversalParams {
  originalMovement: FinancialMovement;
  authorUid: string;
  reversalDate?: DateString;
  reason?: string;
}

/**
 * Constrói o movimento compensatório para estorno estrito (append-only).
 * Regras:
 * - ID determinístico: 'rev_' + originalMovement.id (unicidade de documento absoluta).
 * - Direção oposta à do original.
 * - Mesmo montante em centavos.
 * - reversalOfMovementId apontando para o original.
 * - Impede estornar um movimento que já é um estorno compensatório.
 */
export function buildCompensatoryMovement(params: BuildReversalParams): FinancialMovement {
  const orig = params.originalMovement;

  if (orig.reversalOfMovementId) {
    throw new Error(
      `Operação inválida: O movimento "${orig.id}" já é um estorno compensatório e não pode ser re-estornado.`
    );
  }

  const oppositeDirection: FinancialMovementDirection =
    orig.direction === 'inflow' ? 'outflow' : 'inflow';

  const todayDate =
    params.reversalDate || new Date().toISOString().split('T')[0];

  const reasonSuffix = params.reason ? ` - Motivo: ${params.reason.trim()}` : '';
  const description = `Estorno contábil de: ${orig.description}${reasonSuffix}`;
  const reversalDocId = generateReversalDocId(orig.id);
  const reversalIdempotencyKey = `reversal_${orig.id}`;

  return buildFinancialMovement({
    id: reversalDocId,
    accountId: orig.accountId,
    userId: orig.userId,
    direction: oppositeDirection,
    amountCents: orig.amountCents,
    effectiveDate: todayDate,
    originType: 'manual_adjustment',
    originId: reversalDocId,
    description,
    notes: `Movimento compensatório referenciando #${orig.id}.${params.reason ? ` Justificativa: ${params.reason}` : ''}`,
    authorUid: params.authorUid,
    reversalOfMovementId: orig.id,
    idempotencyKey: reversalIdempotencyKey,
    confirmationStatus: 'cleared',
  });
}

/**
 * ==============================================================================
 * GERADORES DETERMINÍSTICOS PARA FASE 6 — RATEIOS E REEMBOLSOS COMPARTILHADOS
 * ==============================================================================
 */

export function generateSharedExpenseDocId(spaceId: string, idempotencyKey: string): string {
  const cleanSpace = (spaceId || '').trim();
  const cleanKey = (idempotencyKey || '').trim();
  const cleanSlug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  const hash = sha256Hex(`exp:${cleanSpace}:${cleanKey}`);
  return `exp_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function generatePaymentDeclarationDocId(expenseId: string, idempotencyKey: string): string {
  const cleanExp = (expenseId || '').trim();
  const cleanKey = (idempotencyKey || '').trim();
  const cleanSlug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  const hash = sha256Hex(`decl:${cleanExp}:${cleanKey}`);
  return `decl_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function generatePaymentApprovalDocId(declarationId: string, _idempotencyKey?: string): string {
  const cleanDecl = (declarationId || '').trim();
  const cleanSlug = cleanDecl.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  const hash = sha256Hex(`appr_canonical:${cleanDecl}`);
  return `appr_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function generatePaymentRejectionDocId(declarationId: string, _idempotencyKey?: string): string {
  const cleanDecl = (declarationId || '').trim();
  const cleanSlug = cleanDecl.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  const hash = sha256Hex(`rej_canonical:${cleanDecl}`);
  return `rej_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function generateApprovalRevocationDocId(approvalId: string, _idempotencyKey?: string): string {
  const cleanAppr = (approvalId || '').trim();
  const cleanSlug = cleanAppr.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  const hash = sha256Hex(`revoc_canonical:${cleanAppr}`);
  return `revoc_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function generateSupplierRefundDocId(expenseId: string, idempotencyKey: string): string {
  const cleanExp = (expenseId || '').trim();
  const cleanKey = (idempotencyKey || '').trim();
  const cleanSlug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  const hash = sha256Hex(`supref:${cleanExp}:${cleanKey}`);
  return `supref_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function generateRestitutionDocId(revocationId: string): string {
  const cleanRevoc = (revocationId || '').trim();
  const cleanSlug = cleanRevoc.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  const hash = sha256Hex(`restit_canonical:${cleanRevoc}`);
  return `restit_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function generateRestitutionDeclarationDocId(restitutionId: string, idempotencyKey: string): string {
  const cleanRestit = (restitutionId || '').trim();
  const cleanKey = (idempotencyKey || '').trim();
  const cleanSlug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  const hash = sha256Hex(`restit_decl:${cleanRestit}:${cleanKey}`);
  return `restit_decl_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function generateRestitutionReceiptDocId(restitutionId: string, idempotencyKey: string): string {
  const cleanRestit = (restitutionId || '').trim();
  const cleanKey = (idempotencyKey || '').trim();
  const cleanSlug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  const hash = sha256Hex(`restit_rec_${cleanRestit}:${cleanKey}`);
  return `restit_rec_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function generateCustodyTransferDocId(senderUid: string, idempotencyKey: string): string {
  const cleanUid = (senderUid || '').trim();
  const cleanKey = (idempotencyKey || '').trim();
  const cleanSlug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  const hash = sha256Hex(`cust_xfer:${cleanUid}:${cleanKey}`);
  return `cust_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function generateCustodyEventDocId(
  transferId: string,
  eventType: string,
  idempotencyKey: string
): string {
  const cleanXfer = (transferId || '').trim();
  const cleanEvt = (eventType || '').trim();
  const cleanKey = (idempotencyKey || '').trim();
  const cleanSlug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
  const hash = sha256Hex(`cust_evt:${cleanXfer}:${cleanEvt}:${cleanKey}`);
  return `cevt_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function generateCustodyUsageDocId(
  transferId: string,
  expenseId: string,
  idempotencyKey: string
): string {
  const cleanXfer = (transferId || '').trim();
  const cleanExp = (expenseId || '').trim();
  const cleanKey = (idempotencyKey || '').trim();
  const cleanSlug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
  const hash = sha256Hex(`cust_use:${cleanXfer}:${cleanExp}:${cleanKey}`);
  return `cuse_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}

export function generateCustodyReturnDocId(transferId: string, idempotencyKey: string): string {
  const cleanXfer = (transferId || '').trim();
  const cleanKey = (idempotencyKey || '').trim();
  const cleanSlug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
  const hash = sha256Hex(`cust_ret:${cleanXfer}:${cleanKey}`);
  return `cret_${cleanSlug ? `${cleanSlug}_` : ''}${hash.slice(0, 32)}`;
}


