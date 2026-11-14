import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { terminate } from 'firebase/firestore';
import { auth, db } from './firebase';
import { LOCAL_EMULATOR_PROJECT_ID } from '../config/environment';
import {
  registerWithEmailPassword,
  reloadCurrentUserSession,
  sendCurrentUserVerificationEmail,
} from './authService';
import { createSpace, getUserSpaces } from './spaceService';
import {
  acceptSpaceInviteByTokenHash,
  createSpaceInvite,
  getPendingInvitesForUser,
} from './spaceInviteService';
import { getUserSpaceNotifications } from './spaceNotificationService';
import { createSpaceAttemptKey } from '../utils/spaceCreationFlow';
import { createAccount, getUserAccounts } from './accountService';
import {
  getEnrichedLedgerMovements,
  recordMovement,
  reverseMovement,
} from './ledgerService';
import {
  cancelPersonalTransaction,
  createPersonalTransaction,
  getUserPersonalTransactions,
} from './personalTransactionService';
import { executeInternalTransfer } from './transferService';
import { getCardLedgerOverview, payCardInvoice } from './creditCardService';
import {
  cancelInstallmentContract,
  createInstallmentContract,
} from './recurrenceService';

async function clearEmulatorsData(): Promise<void> {
  await fetch(
    `http://127.0.0.1:8080/emulator/v1/projects/${LOCAL_EMULATOR_PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' }
  );
  await fetch(
    `http://127.0.0.1:9099/emulator/v1/projects/${LOCAL_EMULATOR_PROJECT_ID}/accounts`,
    { method: 'DELETE' }
  );
}

async function createAndLoginUser(email: string, password: string): Promise<string> {
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    return cred.user.uid;
  } catch {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    return cred.user.uid;
  }
}

async function verifyEmailViaEmulatorOob(email: string): Promise<void> {
  const res = await fetch(
    `http://127.0.0.1:9099/emulator/v1/projects/${LOCAL_EMULATOR_PROJECT_ID}/oobCodes`
  );
  assert.equal(res.ok, true);
  const data = (await res.json()) as {
    oobCodes?: Array<{ email?: string; requestType?: string; oobLink?: string }>;
  };
  const codes = (data.oobCodes || []).filter(
    (c) =>
      (c.email || '').toLowerCase() === email.toLowerCase() &&
      c.requestType === 'VERIFY_EMAIL' &&
      c.oobLink
  );
  assert.ok(codes.length > 0, `Nenhum oobCode VERIFY_EMAIL encontrado para ${email}`);
  const latest = codes[codes.length - 1];
  const verifyResp = await fetch(latest.oobLink!);
  assert.equal(verifyResp.ok, true);
}

test('EMULATOR — Convites (Situação A/B + Verificação E-mail), Livro-Razão Geral e Livro-Razão do Cartão', async (t) => {
  t.after(async () => {
    try {
      await signOut(auth);
      await terminate(db);
    } catch {
      // ignora erro de teardown
    }
  });

  await t.test(
    '1. Convites para Espaços: Situação A (conta existente recebe notificação e aceita) e Situação B (sem auto-join + verificação de e-mail obrigatória)',
    async () => {
      await clearEmulatorsData();

      const aliceUid = await createAndLoginUser('alice.conv@emulator.local', 'Senha@123');
      const bobUid = await createAndLoginUser('bob.conv@emulator.local', 'Senha@123');

      // Alice cria espaço compartilhado
      await signInWithEmailAndPassword(auth, 'alice.conv@emulator.local', 'Senha@123');
      const { space } = await createSpace(
        aliceUid,
        'Alice Anfitriã',
        'alice.conv@emulator.local',
        { name: 'Apartamento Central', idempotencyKey: createSpaceAttemptKey() },
        false
      );

      // SITUAÇÃO A: Convite para e-mail que JÁ possui conta (Bob)
      const invA = await createSpaceInvite(
        space.id,
        aliceUid,
        'Alice Anfitriã',
        {
          invitedEmail: 'bob.conv@emulator.local',
          invitedRole: 'member',
        },
        false
      );

      assert.equal(invA.invite.accountExists, true);
      assert.equal(invA.invite.recipientUid, bobUid);
      assert.equal(invA.invite.emailDeliveryStatus, 'not_configured_local_emulator');
      assert.ok(invA.rawToken.length >= 32);

      // Bob entra e enxerga notificação + convite pendente, e aceita via Caixa de Entrada
      await signInWithEmailAndPassword(auth, 'bob.conv@emulator.local', 'Senha@123');
      const bobNotifs = await getUserSpaceNotifications(bobUid, false);
      assert.ok(bobNotifs.some((n) => n.type === 'invite_received' && n.spaceId === space.id));

      const bobPending = await getPendingInvitesForUser('bob.conv@emulator.local', false);
      assert.equal(bobPending.length, 1);
      assert.equal(bobPending[0].spaceId, space.id);

      await acceptSpaceInviteByTokenHash(
        bobPending[0].id,
        { uid: bobUid, displayName: 'Bob Convidado', email: 'bob.conv@emulator.local', emailVerified: false },
        false
      );
      const bobSpaces = await getUserSpaces(bobUid, false, false, 'active');
      assert.equal(bobSpaces.length, 1);
      assert.equal(bobSpaces[0].id, space.id);

      // SITUAÇÃO B: Convite para e-mail que AINDA NÃO possui cadastro (Carol)
      await signInWithEmailAndPassword(auth, 'alice.conv@emulator.local', 'Senha@123');
      const invB = await createSpaceInvite(
        space.id,
        aliceUid,
        'Alice Anfitriã',
        {
          invitedEmail: 'carol.conv@emulator.local',
          invitedRole: 'admin',
        },
        false
      );
      assert.equal(invB.invite.accountExists, false);
      assert.equal(invB.invite.recipientUid, undefined);
      assert.equal(invB.invite.requireEmailVerification, true);
      assert.equal(invB.invite.emailDeliveryStatus, 'not_configured_local_emulator');

      // Carol se cadastra: NÃO entra automaticamente no espaço
      const carolUser = await registerWithEmailPassword(
        'Carol Nova',
        'carol.conv@emulator.local',
        'Senha@123'
      );
      assert.equal(carolUser.emailVerified, false);

      const spacesRightAfterSignup = await getUserSpaces(carolUser.uid, false, false, 'active');
      assert.equal(spacesRightAfterSignup.length, 0);

      // Convite pendente fica visível para Carol pelo e-mail normalizado
      const carolPending = await getPendingInvitesForUser(
        'carol.conv@emulator.local',
        false
      );
      assert.equal(carolPending.length, 1);
      assert.equal(carolPending[0].id, invB.invite.id);

      // Sem verificar e-mail, o backend BLOQUEIA o aceite
      await assert.rejects(async () => {
        await acceptSpaceInviteByTokenHash(
          invB.invite.id,
          {
            uid: carolUser.uid,
            displayName: 'Carol Nova',
            email: 'carol.conv@emulator.local',
            emailVerified: false,
          },
          false
        );
      });

      // Terceiro usuário tentando aceitar o convite nominal de Carol também é bloqueado
      await createAndLoginUser('intruso@emulator.local', 'Senha@123');
      await sendCurrentUserVerificationEmail();
      await verifyEmailViaEmulatorOob('intruso@emulator.local');
      const intrusoReloaded = await reloadCurrentUserSession();
      assert.equal(intrusoReloaded?.emailVerified, true);

      await assert.rejects(async () => {
        await acceptSpaceInviteByTokenHash(
          invB.invite.id,
          {
            uid: intrusoReloaded!.uid,
            displayName: 'Intruso',
            email: 'intruso@emulator.local',
            emailVerified: true,
          },
          false
        );
      });

      // Carol verifica o próprio e-mail pelo fluxo oficial OOB e aceita o convite
      await signInWithEmailAndPassword(auth, 'carol.conv@emulator.local', 'Senha@123');
      await verifyEmailViaEmulatorOob('carol.conv@emulator.local');
      const carolVerified = await reloadCurrentUserSession();
      assert.equal(carolVerified?.emailVerified, true);

      await acceptSpaceInviteByTokenHash(
        invB.invite.id,
        {
          uid: carolVerified!.uid,
          displayName: 'Carol Nova',
          email: 'carol.conv@emulator.local',
          emailVerified: true,
        },
        false
      );

      const carolSpacesAfterAccept = await getUserSpaces(carolVerified!.uid, false, false, 'active');
      assert.equal(carolSpacesAfterAccept.length, 1);
      assert.equal(carolSpacesAfterAccept[0].id, space.id);
    }
  );

  await t.test(
    '2. Livro-Razão Geral e Livro-Razão do Cartão de Crédito no Firestore + Cloud Functions',
    async () => {
      await clearEmulatorsData();
      const aliceUid = await createAndLoginUser('alice.books@emulator.local', 'Senha@123');

      const checking = await createAccount(
        aliceUid,
        { name: 'Itaú Corrente', type: 'checking' },
        false
      );
      await recordMovement(
        {
          accountId: checking.id,
          userId: aliceUid,
          direction: 'inflow',
          amountCents: 200000,
          effectiveDate: '2026-11-01',
          originType: 'manual_adjustment',
          originId: `open_${checking.id}`,
          description: 'Saldo inicial',
          authorUid: aliceUid,
        },
        false
      );

      const wallet = await createAccount(
        aliceUid,
        { name: 'Carteira', type: 'wallet' },
        false
      );
      const card = await createAccount(
        aliceUid,
        {
          name: 'Nubank Ultravioleta',
          type: 'credit',
          creditLimitCents: 600000,
          closingDay: 20,
          dueDay: 27,
        },
        false
      );

      // Despesa paga na conta corrente
      const txChecking = await createPersonalTransaction(
        aliceUid,
        {
          description: 'Internet Fibra',
          amountCents: 15000,
          type: 'expense',
          status: 'paid',
          competenceDate: '2026-11-05',
          accountId: checking.id,
          categoryId: 'internet',
          categoryName: 'Internet',
        },
        false
      );

      // Transferência interna para Carteira
      await executeInternalTransfer(
        aliceUid,
        {
          sourceAccountId: checking.id,
          destinationAccountId: wallet.id,
          amountCents: 30000,
          transferDate: '2026-11-06',
          description: 'Reserva em espécie',
        },
        false
      );

      // Compra à vista no cartão (2026-11)
      const singleCardTx = await createPersonalTransaction(
        aliceUid,
        {
          description: 'Farmácia Central',
          amountCents: 20000,
          type: 'expense',
          status: 'paid',
          competenceDate: '2026-11-10',
          accountId: card.id,
          categoryId: 'health',
          categoryName: 'Saúde',
        },
        false
      );

      // Parcelamento em 3x no cartão iniciando em 2026-11
      const { contract } = await createInstallmentContract(
        {
          scope: 'personal',
          userId: aliceUid,
          title: 'Monitor 4K',
          totalContractAmountCents: 90000,
          totalInstallmentsCount: 3,
          fundingSource: 'credit_card',
          sourceCardAccountId: card.id,
          startCompetenceMonth: '2026-11',
          dueDay: 27,
          idempotencyKey: 'emul_card_inst_1',
        },
        false
      );

      // Verifica Livro-Razão do Cartão antes do pagamento
      const cardOverviewBefore = await getCardLedgerOverview(card, aliceUid, false);
      assert.equal(cardOverviewBefore.limitSummary.creditLimitCents, 600000);
      assert.equal(cardOverviewBefore.limitSummary.usedAmountCents, 110000); // 200 + 900
      assert.equal(cardOverviewBefore.limitSummary.availableLimitCents, 490000);
      assert.equal(cardOverviewBefore.charges.length, 4);

      const novInvoice = cardOverviewBefore.invoices.find((i) => i.invoiceMonth === '2026-11');
      assert.ok(novInvoice);
      assert.equal(novInvoice.totalDueAmountCents, 50000); // 200 + 300

      // Paga a fatura de 2026-11 debitando o Itaú Corrente sem duplicar despesa
      const txsBeforeInvoicePay = await getUserPersonalTransactions(aliceUid, undefined, false);
      await payCardInvoice(
        {
          cardAccountId: card.id,
          invoiceMonth: '2026-11',
          sourceAccountId: checking.id,
          amountPaidCents: 50000,
          paymentDate: '2026-11-26',
          userId: aliceUid,
          notes: `Pagamento fatura 2026-11 - ${card.name}`,
        },
        false
      );
      const txsAfterInvoicePay = await getUserPersonalTransactions(aliceUid, undefined, false);
      assert.equal(txsAfterInvoicePay.length, txsBeforeInvoicePay.length);

      // Verifica Livro-Razão do Cartão após pagamento
      const cardOverviewAfterPay = await getCardLedgerOverview(card, aliceUid, false);
      const paidNov = cardOverviewAfterPay.invoices.find((i) => i.invoiceMonth === '2026-11')!;
      assert.equal(paidNov.invoiceStatus, 'paid');
      assert.equal(paidNov.remainingBalanceCents, 0);
      assert.equal(cardOverviewAfterPay.payments.length, 1);
      assert.equal(cardOverviewAfterPay.payments[0].sourceAccountId, checking.id);
      assert.equal(cardOverviewAfterPay.limitSummary.usedAmountCents, 60000); // 2026-12 + 2027-01

      // Cancela compra à vista e cancela parcelamento futuro
      await cancelPersonalTransaction(singleCardTx.id, aliceUid, 'Estorno loja', false);
      await cancelInstallmentContract(
        { contractId: contract.id, cancellationReason: 'Devolução do produto' },
        false
      );

      const cardOverviewAfterCancel = await getCardLedgerOverview(card, aliceUid, false);
      assert.ok(cardOverviewAfterCancel.charges.every((c) => c.status === 'cancelled'));
      assert.equal(cardOverviewAfterCancel.limitSummary.usedAmountCents, 0);

      // Verifica Livro-Razão Geral (contas não-crédito) + Saldo Resultante + Estorno
      const accounts = await getUserAccounts(aliceUid, true, false);
      const enriched = await getEnrichedLedgerMovements(aliceUid, accounts, false);

      // Todos os movimentos pertencem exclusivamente a contas não-crédito
      assert.ok(enriched.every((m) => m.accountType !== 'credit'));
      const checkingMovs = enriched.filter((m) => m.accountId === checking.id);
      // 1) Saldo Inicial (+2000), 2) Internet (-150), 3) Transferência (-300), 4) Pagamento Fatura (-500)
      assert.equal(checkingMovs.length, 4);
      // Mais recente no topo: Saldo resultante após pagar fatura = 2000 - 150 - 300 - 500 = 1050 (105000)
      assert.equal(checkingMovs[0].originType, 'credit_card_payment');
      assert.equal(checkingMovs[0].runningBalanceCents, 105000);
      assert.equal(checkingMovs[0].relatedAccountName, card.name);

      const internetMov = checkingMovs.find((m) => m.originId === txChecking.id);
      assert.ok(internetMov);
      assert.equal(internetMov.categoryName, 'Internet');

      // Executa estorno compensatório da Internet Fibra (+150) -> Saldo final = 1200 (120000)
      await reverseMovement(checking.id, internetMov.id, aliceUid, 'Cobrança indevida', false);
      const enrichedAfterRev = await getEnrichedLedgerMovements(aliceUid, accounts, false);
      const checkingAfterRev = enrichedAfterRev.filter((m) => m.accountId === checking.id);
      assert.equal(checkingAfterRev.length, 5);
      const revMov = checkingAfterRev.find((m) => m.reversalOfMovementId === internetMov.id);
      assert.ok(revMov);
      assert.equal(revMov.isCompensatory, true);
      assert.equal(revMov.direction, 'inflow');
    }
  );
});
