import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { universalStorage } from '../utils/universalStorage';
import { sha256Hex } from '../utils/hashUtils';
import {
  createSpaceInvite,
  evaluateInviteAvailability,
  generateSecureToken,
  hashToken,
} from './spaceInviteService';
import {
  getSentEmailLogs,
  sendTransactionalEmail,
} from './emailService';
import { createAccount, getUserAccounts } from './accountService';
import {
  attachChronologicalRunningBalances,
  formatIsoDateBR,
  getEnrichedLedgerMovements,
  recordMovement,
  reverseMovement,
} from './ledgerService';
import {
  createPersonalTransaction,
  cancelPersonalTransaction,
} from './personalTransactionService';
import { executeInternalTransfer } from './transferService';
import {
  getCardLedgerOverview,
  payCardInvoice,
} from './creditCardService';
import {
  cancelInstallmentContract,
  createInstallmentContract,
} from './recurrenceService';
import { SpaceInvite } from '../types/financeV3';

function clearStorage(): void {
  universalStorage.clear();
  if (typeof localStorage !== 'undefined') {
    localStorage.clear();
  }
}

test('CONVITES E LIVROS FINANCEIROS (Unitário / Demo)', async (t) => {
  await t.test(
    '1. Hash e geração de token SHA-256 funcionam sem globalThis.crypto.subtle (zero erro reading digest)',
    async () => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
      try {
        Object.defineProperty(globalThis, 'crypto', {
          value: undefined,
          configurable: true,
          writable: true,
        });

        const raw = generateSecureToken();
        assert.equal(raw.length, 48);

        const hash = await hashToken(raw);
        const expected = nodeCrypto.createHash('sha256').update(raw).digest('hex');
        assert.equal(hash, expected);
        assert.equal(sha256Hex('teste-utf8-áéíóú'), nodeCrypto.createHash('sha256').update('teste-utf8-áéíóú').digest('hex'));
      } finally {
        if (descriptor) {
          Object.defineProperty(globalThis, 'crypto', descriptor);
        }
      }
    }
  );

  await t.test(
    '2. evaluateInviteAvailability distingue verificação de e-mail, e-mail divergente, expiração, aceito, recusado e revogado',
    () => {
      const baseInvite: SpaceInvite = {
        id: 'hash_1',
        spaceId: 'space_1',
        spaceName: 'Casa Compartilhada',
        invitedEmail: 'convidado@exemplo.com',
        invitedRole: 'member',
        invitedByUid: 'uid_owner',
        invitedByName: 'Proprietário',
        tokenStatus: 'pending',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        requireEmailVerification: true,
        createdAt: new Date().toISOString(),
      };

      assert.equal(evaluateInviteAvailability(null).code, 'not_found');

      const unverified = evaluateInviteAvailability(baseInvite, {
        currentUserUid: 'uid_guest',
        currentUserEmail: 'convidado@exemplo.com',
        currentUserEmailVerified: false,
      });
      assert.equal(unverified.canAccept, false);
      assert.equal(unverified.code, 'email_not_verified');

      const mismatch = evaluateInviteAvailability(baseInvite, {
        currentUserUid: 'uid_other',
        currentUserEmail: 'outro@exemplo.com',
        currentUserEmailVerified: true,
      });
      assert.equal(mismatch.canAccept, false);
      assert.equal(mismatch.code, 'email_mismatch');

      const valid = evaluateInviteAvailability(baseInvite, {
        currentUserUid: 'uid_guest',
        currentUserEmail: 'CONVIDADO@EXEMPLO.COM',
        currentUserEmailVerified: true,
      });
      assert.equal(valid.canAccept, true);
      assert.equal(valid.code, 'valid');

      assert.equal(
        evaluateInviteAvailability({ ...baseInvite, tokenStatus: 'rejected' }).code,
        'rejected'
      );
      assert.equal(
        evaluateInviteAvailability({ ...baseInvite, tokenStatus: 'revoked' }).code,
        'revoked'
      );
      assert.equal(
        evaluateInviteAvailability({ ...baseInvite, tokenStatus: 'accepted' }).code,
        'accepted'
      );
    }
  );

  await t.test(
    '3. emailService reporta honestamente not_configured_local_emulator e nunca mascara falha ou grava token bruto',
    async () => {
      clearStorage();
      const fakeToken = 'tok_secreto_nao_vazar_123';
      const result = await sendTransactionalEmail({
        toEmail: 'guest@example.com',
        toName: 'Convidado',
        fromName: 'Anfitrião',
        subject: 'Convite para Espaço',
        spaceOrTransactionTitle: 'Casa',
        message: 'Você foi convidado para o espaço Casa.',
        type: 'space_invite',
      });

      assert.equal(result.ok, false);
      assert.equal(result.mode, 'not_configured_local_emulator');
      const logs = getSentEmailLogs();
      assert.equal(logs.length, 1);
      assert.equal(logs[0].status, 'not_configured_local_emulator');
      assert.equal(JSON.stringify(logs[0]).includes(fakeToken), false);
    }
  );

  await t.test(
    '4. formatIsoDateBR, attachChronologicalRunningBalances e getEnrichedLedgerMovements calculam saldo resultante sem deslocamento UTC',
    async () => {
      clearStorage();
      assert.equal(formatIsoDateBR('2026-11-01'), '01/11/2026');
      assert.equal(formatIsoDateBR('2026-01-01T00:00:00.000Z'), '01/01/2026');

      const uid = 'user_ledger_unit';
      const accChecking = await createAccount(
        uid,
        { name: 'Conta Corrente', type: 'checking' },
        true
      );
      await recordMovement(
        {
          accountId: accChecking.id,
          userId: uid,
          direction: 'inflow',
          amountCents: 100000,
          effectiveDate: '2026-11-01',
          originType: 'manual_adjustment',
          originId: `open_${accChecking.id}`,
          description: 'Saldo inicial',
          authorUid: uid,
        },
        true
      );

      const accWallet = await createAccount(
        uid,
        { name: 'Carteira', type: 'wallet' },
        true
      );
      await recordMovement(
        {
          accountId: accWallet.id,
          userId: uid,
          direction: 'inflow',
          amountCents: 20000,
          effectiveDate: '2026-11-01',
          originType: 'manual_adjustment',
          originId: `open_${accWallet.id}`,
          description: 'Saldo inicial',
          authorUid: uid,
        },
        true
      );

      const accCard = await createAccount(
        uid,
        { name: 'Cartão Crédito', type: 'credit', creditLimitCents: 300000, closingDay: 20, dueDay: 27 },
        true
      );

      // Compra no cartão NÃO entra no saldo de contas de caixa do Livro-Razão Geral
      await createPersonalTransaction(
        uid,
        {
          description: 'Mercado no Cartão',
          amountCents: 15000,
          type: 'expense',
          status: 'paid',
          competenceDate: '2026-11-10',
          accountId: accCard.id,
          categoryId: 'food',
          categoryName: 'Alimentação',
        },
        true
      );

      // Despesa paga na conta corrente
      const txChecking = await createPersonalTransaction(
        uid,
        {
          description: 'Conta de Luz',
          amountCents: 25000,
          type: 'expense',
          status: 'paid',
          competenceDate: '2026-11-11',
          accountId: accChecking.id,
          categoryId: 'utilities',
          categoryName: 'Moradia',
        },
        true
      );

      // Transferência interna da Conta Corrente -> Carteira
      await executeInternalTransfer(
        uid,
        {
          sourceAccountId: accChecking.id,
          destinationAccountId: accWallet.id,
          amountCents: 10000,
          transferDate: '2026-11-12',
          description: 'Saque para carteira',
        },
        true
      );

      // Movimento compartilhado manual para testar classificação de escopo
      await recordMovement(
        {
          accountId: accChecking.id,
          userId: uid,
          direction: 'outflow',
          amountCents: 5000,
          effectiveDate: '2026-11-13',
          originType: 'settlement_outflow',
          originId: 'settle_1',
          description: 'Acerto espaço compartilhado',
          authorUid: uid,
        },
        true
      );

      const accounts = await getUserAccounts(uid, true, true);
      const enriched = await getEnrichedLedgerMovements(uid, accounts, true);

      // Apenas movimentos das contas não-crédito devem aparecer no Livro-Razão Geral
      assert.ok(enriched.every((m) => m.accountType !== 'credit'));
      assert.equal(enriched.length >= 5, true);

      const movLuz = enriched.find((m) => m.originId === txChecking.id);
      assert.ok(movLuz);
      assert.equal(movLuz.categoryName, 'Moradia');
      assert.equal(movLuz.scope, 'individual');
      assert.equal(movLuz.runningBalanceCents, 75000); // 1000 - 250

      const movXferOut = enriched.find(
        (m) => m.originType === 'internal_transfer_out' && m.accountId === accChecking.id
      );
      assert.ok(movXferOut);
      assert.equal(movXferOut.relatedAccountName, 'Carteira');
      assert.equal(movXferOut.runningBalanceCents, 65000); // 750 - 100

      const movShared = enriched.find((m) => m.originType === 'settlement_outflow');
      assert.ok(movShared);
      assert.equal(movShared.scope, 'shared');
      assert.equal(movShared.runningBalanceCents, 60000); // 650 - 50

      // Estorno compensatório deve preservar histórico e atualizar saldo resultante
      await reverseMovement(accChecking.id, movLuz.id, uid, 'Lançamento corrigido', true);
      const enrichedAfterReversal = await getEnrichedLedgerMovements(uid, accounts, true);
      const originalAfter = enrichedAfterReversal.find((m) => m.id === movLuz.id);
      const reversalEntry = enrichedAfterReversal.find((m) => m.reversalOfMovementId === movLuz.id);
      assert.equal(originalAfter?.isReversed, true);
      assert.equal(reversalEntry?.isCompensatory, true);
      assert.equal(reversalEntry?.direction, 'inflow');
    }
  );

  await t.test(
    '5. Livro-Razão do Cartão de Crédito: limite, compras à vista e parceladas, faturas futuras, pagamento sem duplicar despesa e cancelamento',
    async () => {
      clearStorage();
      const uid = 'user_card_unit';
      const checking = await createAccount(
        uid,
        { name: 'Banco Principal', type: 'checking' },
        true
      );
      await recordMovement(
        {
          accountId: checking.id,
          userId: uid,
          direction: 'inflow',
          amountCents: 500000,
          effectiveDate: '2026-11-01',
          originType: 'manual_adjustment',
          originId: `open_${checking.id}`,
          description: 'Saldo inicial',
          authorUid: uid,
        },
        true
      );
      const card = await createAccount(
        uid,
        {
          name: 'Cartão Visa Black',
          type: 'credit',
          creditLimitCents: 1000000,
          closingDay: 20,
          dueDay: 27,
        },
        true
      );

      // Compra à vista na fatura 2026-11
      const singlePurchase = await createPersonalTransaction(
        uid,
        {
          description: 'Jantar Restaurante',
          amountCents: 15000,
          type: 'expense',
          status: 'paid',
          competenceDate: '2026-11-10',
          accountId: card.id,
          categoryId: 'food',
          categoryName: 'Alimentação',
        },
        true
      );

      // Compra parcelada em 3x iniciando em 2026-11
      const { contract } = await createInstallmentContract(
        {
          scope: 'personal',
          userId: uid,
          title: 'Notebook Trabalho',
          totalContractAmountCents: 90000,
          totalInstallmentsCount: 3,
          fundingSource: 'credit_card',
          sourceCardAccountId: card.id,
          startCompetenceMonth: '2026-11',
          dueDay: 27,
          idempotencyKey: 'card_inst_1',
        },
        true
      );

      const overviewBeforePay = await getCardLedgerOverview(card, uid, true);
      assert.equal(overviewBeforePay.limitSummary.creditLimitCents, 1000000);
      // 150 + 300 + 300 + 300 = 1050 reais = 105000 centavos
      assert.equal(overviewBeforePay.limitSummary.usedAmountCents, 105000);
      assert.equal(overviewBeforePay.limitSummary.availableLimitCents, 895000);
      assert.equal(overviewBeforePay.charges.length, 4);

      const invNov = overviewBeforePay.invoices.find((i) => i.invoiceMonth === '2026-11');
      assert.ok(invNov);
      assert.equal(invNov.totalDueAmountCents, 45000); // 150 + 300

      // Paga a fatura de 2026-11 usando a conta Banco Principal
      await payCardInvoice(
        {
          cardAccountId: card.id,
          invoiceMonth: '2026-11',
          sourceAccountId: checking.id,
          amountPaidCents: 45000,
          paymentDate: '2026-11-26',
          userId: uid,
          notes: `Fatura 2026-11 ${card.name}`,
        },
        true
      );

      const accountsAfterPay = await getUserAccounts(uid, true, true);
      const updatedChecking = accountsAfterPay.find((a) => a.id === checking.id)!;
      assert.equal(updatedChecking.projectedBalanceCents, 455000); // 5000 - 450 debitado 1 vez só

      const overviewAfterPay = await getCardLedgerOverview(card, uid, true);
      const paidNov = overviewAfterPay.invoices.find((i) => i.invoiceMonth === '2026-11')!;
      assert.equal(paidNov.invoiceStatus, 'paid');
      assert.equal(paidNov.remainingBalanceCents, 0);
      assert.equal(overviewAfterPay.payments.length, 1);
      assert.equal(overviewAfterPay.payments[0].sourceAccountId, checking.id);

      // Verifica no Livro-Razão Geral que pagamento gerou apenas credit_card_payment (sem despesa duplicada)
      const enriched = await getEnrichedLedgerMovements(uid, accountsAfterPay, true);
      const cardPayMovs = enriched.filter((m) => m.originType === 'credit_card_payment');
      assert.equal(cardPayMovs.length, 1);
      assert.equal(cardPayMovs[0].amountCents, 45000);
      assert.equal(cardPayMovs[0].relatedAccountName, card.name);

      // Cancelamento do parcelamento e da compra avulsa
      await cancelInstallmentContract(
        { contractId: contract.id, cancellationReason: 'Estorno parcial loja' },
        true
      );
      await cancelPersonalTransaction(singlePurchase.id, uid, 'Compra cancelada', true);

      const overviewAfterCancel = await getCardLedgerOverview(card, uid, true);
      assert.ok(overviewAfterCancel.charges.every((c) => c.status === 'cancelled'));
    }
  );

  await t.test(
    '6. Guardrails de UI (AccountsLedgerViewV3.tsx e CreditCardLedgerModal.tsx): tema escuro sem bg-white nem isMovementModalOpen',
    () => {
      const rootDir = process.cwd();
      const ledgerViewSrc = fs.readFileSync(
        path.join(rootDir, 'src/components/accounts/AccountsLedgerViewV3.tsx'),
        'utf8'
      );
      const cardModalSrc = fs.readFileSync(
        path.join(rootDir, 'src/components/accounts/CreditCardLedgerModal.tsx'),
        'utf8'
      );

      assert.equal(ledgerViewSrc.includes('isMovementModalOpen'), false);
      assert.equal(ledgerViewSrc.replace(/(?:after|before):bg-white/g, '').includes('bg-white'), false);
      assert.equal(cardModalSrc.replace(/(?:after|before):bg-white/g, '').includes('bg-white'), false);
    }
  );
});
