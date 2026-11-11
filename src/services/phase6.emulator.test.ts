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
import { createSpace, getSpaceById } from './spaceService';
import { acceptSpaceInvite, createSpaceInvite } from './spaceInviteService';
import { createAccount, getUserAccounts } from './accountService';
import {
  approveExpensePayment,
  createSharedExpense,
  declareExpensePayment,
  getExpenseLiabilities,
  getExpensePaymentDeclarations,
  getSharedExpenses,
  recordSupplierRefund,
  revokeExpensePaymentApproval,
} from './sharedFinanceService';

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

test('FASE 6 — EMULATOR INTEGRATION: Rateios, Validações e Reembolsos no Backend Confiável', async (t) => {
  await clearEmulatorsData();

  let aliceUid = '';
  let bobUid = '';
  let charlieUid = '';
  let spaceId = '';
  let expenseId = '';
  let aliceAccountId = '';

  // ----------------------------------------------------------------------------
  // SETUP: Criação de Usuários e Espaço no Emulator Real
  // ----------------------------------------------------------------------------
  await t.test('1. Setup no Emulator: Registra Alice, Bob, Charlie e configura Espaço Compartilhado', async () => {
    // 1. Alice (Criadora e Responsável Financeira)
    const aliceCred = await createUserWithEmailAndPassword(
      auth,
      'alice.f6@teste.local',
      'SenhaForte123!'
    );
    aliceUid = aliceCred.user.uid;

    const aliceAcc = await createAccount(
      aliceUid,
      {
        name: 'Conta Corrente Alice',
        type: 'checking',
      },
      false
    );
    aliceAccountId = aliceAcc.id;

    const createdSpaceRes = await createSpace(
      aliceUid,
      'Alice Credor',
      'alice.f6@teste.local',
      {
        name: 'República Fase 6',
        description: 'Espaço de teste de rateios reais',
      },
      false
    );
    spaceId = createdSpaceRes.space.id;

    // Gera convites para Bob e Charlie
    const inviteBob = await createSpaceInvite(
      spaceId,
      aliceUid,
      'Alice Credor',
      {
        invitedEmail: 'bob.f6@teste.local',
        invitedRole: 'member',
      },
      false
    );

    const inviteCharlie = await createSpaceInvite(
      spaceId,
      aliceUid,
      'Alice Credor',
      {
        invitedEmail: 'charlie.f6@teste.local',
        invitedRole: 'admin', // Charlie é administrador do espaço!
      },
      false
    );

    await signOut(auth);

    // 2. Bob aceita convite
    const bobCred = await createUserWithEmailAndPassword(
      auth,
      'bob.f6@teste.local',
      'SenhaForte123!'
    );
    bobUid = bobCred.user.uid;
    await acceptSpaceInvite(
      inviteBob.rawToken,
      { uid: bobUid, displayName: 'Bob Devedor', email: 'bob.f6@teste.local' },
      false
    );
    await signOut(auth);

    // 3. Charlie aceita convite (como admin)
    const charlieCred = await createUserWithEmailAndPassword(
      auth,
      'charlie.f6@teste.local',
      'SenhaForte123!'
    );
    charlieUid = charlieCred.user.uid;
    await acceptSpaceInvite(
      inviteCharlie.rawToken,
      { uid: charlieUid, displayName: 'Charlie Admin', email: 'charlie.f6@teste.local' },
      false
    );
    // Valida que todos estão ativos no espaço autenticando como Alice
    await signInWithEmailAndPassword(auth, 'alice.f6@teste.local', 'SenhaForte123!');
    const loadedSpace = await getSpaceById(spaceId, aliceUid, false);
    assert.ok(loadedSpace);
    assert.equal(loadedSpace?.memberUids.length, 3);
    await signOut(auth);
  });

  // ----------------------------------------------------------------------------
  // 2. CRIAÇÃO DE DESPESA COMPARTILHADA COM RATEIO EXATO VIA CLOUD FUNCTION
  // ----------------------------------------------------------------------------
  await t.test('2. Alice cria despesa compartilhada de R$ 120,00 dividida igualmente entre os 3 membros', async () => {
    await signInWithEmailAndPassword(auth, 'alice.f6@teste.local', 'SenhaForte123!');

    const res = await createSharedExpense(
      spaceId,
      {
        spaceId,
        title: 'Energia Elétrica Novembro',
        totalOriginalAmountCents: 12000, // R$ 120,00
        competenceMonth: '2026-11',
        competenceDate: '2026-11-10',
        categoryId: 'cat_util',
        categoryName: 'Utilidades',
        createdByUid: aliceUid,
        responsibleUid: aliceUid,
        splitMethod: 'equal',
        participants: [
          { uid: aliceUid, name: 'Alice Credor' },
          { uid: bobUid, name: 'Bob Devedor' },
          { uid: charlieUid, name: 'Charlie Admin' },
        ],
        idempotencyKey: 'idem_emul_exp_01',
      },
      false
    );

    assert.ok(res.expense.id);
    expenseId = res.expense.id;
    assert.equal(res.expense.totalOriginalAmountCents, 12000);
    assert.equal(res.liabilities.length, 3);

    for (const liab of res.liabilities) {
      assert.equal(liab.assignedShareAmountCents, 4000); // R$ 40,00 cada
      assert.equal(liab.paidAmountCents, 0);
      assert.equal(liab.status, 'pending');
    }

    await signOut(auth);
  });

  // ----------------------------------------------------------------------------
  // 3. DECLARAÇÃO DE PAGAMENTO PELO DEVEDOR
  // ----------------------------------------------------------------------------
  await t.test('3. Bob declara pagamento de R$ 40,00 via Pix; obrigação vai para in_validation', async () => {
    await signInWithEmailAndPassword(auth, 'bob.f6@teste.local', 'SenhaForte123!');

    const decl = await declareExpensePayment(
      {
        spaceId,
        expenseId,
        memberUid: bobUid,
        memberName: 'Bob Devedor',
        amountCents: 4000,
        paymentDate: '2026-11-11',
        paymentMethod: 'pix',
        notes: 'Comprovante Pix #987654',
        idempotencyKey: 'decl_emul_bob_01',
      },
      false
    );

    assert.ok(decl.id);
    assert.equal(decl.status, 'pending_validation');
    assert.equal(decl.amountCents, 4000);

    // Consulta Firestore: obrigação de Bob atualizada para in_validation sem alterar saldo pago
    const liabs = await getExpenseLiabilities(spaceId, expenseId, false);
    const bobLiab = liabs.find((l) => l.memberUid === bobUid)!;
    assert.equal(bobLiab.status, 'in_validation');
    assert.equal(bobLiab.paidAmountCents, 0);
    assert.equal(bobLiab.remainingAmountCents, 4000);

    await signOut(auth);
  });

  // ----------------------------------------------------------------------------
  // 4. AUTORIDADE EXCLUSIVA: CHARLIE (ADMIN) É BLOQUEADO DE VALIDAR
  // ----------------------------------------------------------------------------
  await t.test('4. Princípio da Autoridade Exclusiva: Charlie (Admin do espaço) tenta validar e é rejeitado com permission-denied', async () => {
    await signInWithEmailAndPassword(auth, 'charlie.f6@teste.local', 'SenhaForte123!');

    const decls = await getExpensePaymentDeclarations(spaceId, expenseId, false);
    const bobDecl = decls.find((d) => d.memberUid === bobUid)!;

    await assert.rejects(
      async () =>
        approveExpensePayment(
          {
            spaceId,
            expenseId,
            declarationId: bobDecl.id,
            approverUid: charlieUid,
          },
          false
        ),
      /permission-denied|Acesso negado/
    );

    await signOut(auth);
  });

  // ----------------------------------------------------------------------------
  // 5. APROVAÇÃO OFICIAL POR ALICE (RESPONSÁVEL) COM CRÉDITO BANCÁRIO REAL
  // ----------------------------------------------------------------------------
  let approvalId = '';

  await t.test('5. Alice (Responsável financeira) aprova pagamento de Bob: credita conta Nubank e quita cota', async () => {
    await signInWithEmailAndPassword(auth, 'alice.f6@teste.local', 'SenhaForte123!');

    const decls = await getExpensePaymentDeclarations(spaceId, expenseId, false);
    const bobDecl = decls.find((d) => d.memberUid === bobUid)!;

    const res = await approveExpensePayment(
      {
        spaceId,
        expenseId,
        declarationId: bobDecl.id,
        approverUid: aliceUid,
        destinationAccountId: aliceAccountId,
        idempotencyKey: 'appr_emul_bob_01',
      },
      false
    );

    assert.ok(res.approval.id);
    approvalId = res.approval.id;
    assert.equal(res.approval.amountCents, 4000);
    assert.equal(res.approval.isRevoked, false);
    assert.equal(res.liability.status, 'paid');
    assert.equal(res.liability.paidAmountCents, 4000);
    assert.equal(res.liability.remainingAmountCents, 0);

    // Verifica saldo bancário de Alice no Firestore
    const accs = await getUserAccounts(aliceUid, false, false);
    const aliceAcc = accs.find((a) => a.id === aliceAccountId)!;
    assert.equal(aliceAcc.projectedBalanceCents, 4000);

    // Repetição idempotente
    const replay = await approveExpensePayment(
      {
        spaceId,
        expenseId,
        declarationId: bobDecl.id,
        approverUid: aliceUid,
        destinationAccountId: aliceAccountId,
        idempotencyKey: 'appr_emul_bob_01',
      },
      false
    );
    assert.equal(replay.approval.id, approvalId);

    await signOut(auth);
  });

  // ----------------------------------------------------------------------------
  // 6. REVOGAÇÃO DE APROVAÇÃO (HISTÓRICO IMUTÁVEL E ESTORNO CONTÁBIL)
  // ----------------------------------------------------------------------------
  await t.test('6. Alice revoga aprovação de Bob: gera compensação contábil, debita conta e reabre cota de Bob', async () => {
    await signInWithEmailAndPassword(auth, 'alice.f6@teste.local', 'SenhaForte123!');

    const revRes = await revokeExpensePaymentApproval(
      {
        spaceId,
        expenseId,
        approvalId,
        revokerUid: aliceUid,
        reason: 'Cheque sem fundos compensado indevidamente',
        idempotencyKey: 'revoc_emul_bob_01',
      },
      false
    );

    assert.ok(revRes.revocation.id);
    assert.equal(revRes.revocation.revokedAmountCents, 4000);
    assert.equal(revRes.liability.status, 'pending');
    assert.equal(revRes.liability.paidAmountCents, 0);
    assert.equal(revRes.liability.remainingAmountCents, 4000);

    // Saldo bancário de Alice volta para 0
    const accs = await getUserAccounts(aliceUid, false, false);
    const aliceAcc = accs.find((a) => a.id === aliceAccountId)!;
    assert.equal(aliceAcc.projectedBalanceCents, 0);

    await signOut(auth);
  });

  // ----------------------------------------------------------------------------
  // 7. REEMBOLSO DE FORNECEDOR (SUPPLIER REFUND)
  // ----------------------------------------------------------------------------
  await t.test('7. Reembolso comercial do fornecedor ajusta proporcionalmente as cotas', async () => {
    await signInWithEmailAndPassword(auth, 'alice.f6@teste.local', 'SenhaForte123!');

    const refund = await recordSupplierRefund(
      {
        spaceId,
        expenseId,
        refundType: 'partial_refund',
        amountRefundedCents: 3000, // R$ 30,00 devolvidos pela companhia elétrica
        recipientUid: aliceUid,
        date: '2026-11-12',
        justification: 'Devolução de cobrança indevida por bandeira tarifária',
        idempotencyKey: 'supref_emul_01',
      },
      false
    );

    assert.ok(refund.id);
    assert.equal(refund.amountRefundedCents, 3000);

    const liabs = await getExpenseLiabilities(spaceId, expenseId, false);
    for (const l of liabs) {
      assert.equal(l.assignedShareAmountCents, 4000);
      assert.equal(l.adjustedShareAmountCents, 3000); // 4000 - 1000 = 3000 cada
      assert.equal(l.remainingAmountCents, 3000);
    }

    await signOut(auth);
  });

  t.after(async () => {
    await terminate(db);
  });
});
