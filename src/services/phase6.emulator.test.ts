import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { collection, doc, getDoc, getDocs, terminate } from 'firebase/firestore';
import { auth, db } from './firebase';
import { LOCAL_EMULATOR_PROJECT_ID } from '../config/environment';
import { createSpace, getSpaceById } from './spaceService';
import { acceptSpaceInvite, createSpaceInvite } from './spaceInviteService';
import { createAccount, getUserAccounts } from './accountService';
import {
  approveExpensePayment,
  confirmRestitutionReceipt,
  createSharedExpense,
  declareExpensePayment,
  declareRestitutionPayment,
  getExpenseLiabilities,
  getExpensePaymentDeclarations,
  getExpenseRestitutions,
  getSharedExpenses,
  recordSupplierRefund,
  rejectExpensePayment,
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

test('FASE 6 — EMULATOR INTEGRATION: Rateios, Segregação de Autoridade vs Beneficiário, Imutabilidade e Notificações', async (t) => {
  await clearEmulatorsData();

  let aliceUid = '';
  let bobUid = '';
  let charlieUid = '';
  let spaceId = '';
  let expenseId = '';
  let aliceAccountId = '';
  let bobAccountId = '';
  let charlieAccountId = '';
  let charlieDeclId = '';
  let approvalId = '';

  // ----------------------------------------------------------------------------
  // SETUP: Criação de Usuários e Espaço no Emulator Real
  // ----------------------------------------------------------------------------
  await t.test('1. Setup no Emulator: Registra Alice (Validadora), Bob (Pagador/Credor) e Charlie (Membro)', async () => {
    // 1. Alice (Criadora e Responsável pela Validação)
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
      'Alice Validadora',
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
      'Alice Validadora',
      {
        invitedEmail: 'bob.f6@teste.local',
        invitedRole: 'member',
      },
      false
    );

    const inviteCharlie = await createSpaceInvite(
      spaceId,
      aliceUid,
      'Alice Validadora',
      {
        invitedEmail: 'charlie.f6@teste.local',
        invitedRole: 'admin', // Charlie é administrador do espaço
      },
      false
    );

    await signOut(auth);

    // 2. Bob aceita convite e cria sua conta bancária oficial
    const bobCred = await createUserWithEmailAndPassword(
      auth,
      'bob.f6@teste.local',
      'SenhaForte123!'
    );
    bobUid = bobCred.user.uid;
    await acceptSpaceInvite(
      inviteBob.rawToken,
      { uid: bobUid, displayName: 'Bob Credor', email: 'bob.f6@teste.local' },
      false
    );
    const bobAcc = await createAccount(
      bobUid,
      {
        name: 'Conta Nubank Bob',
        type: 'checking',
      },
      false
    );
    bobAccountId = bobAcc.id;
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
    const charlieAcc = await createAccount(
      charlieUid,
      {
        name: 'Conta Inter Charlie',
        type: 'checking',
      },
      false
    );
    charlieAccountId = charlieAcc.id;
    await signOut(auth);

    // Valida que todos estão ativos no espaço autenticando como Alice
    await signInWithEmailAndPassword(auth, 'alice.f6@teste.local', 'SenhaForte123!');
    const loadedSpace = await getSpaceById(spaceId, aliceUid, false);
    assert.ok(loadedSpace);
    assert.equal(loadedSpace?.memberUids.length, 3);
    await signOut(auth);
  });

  // ----------------------------------------------------------------------------
  // 2. CRIAÇÃO DE DESPESA: SEGREGAÇÃO ENTRE RESPONSÁVEL (ALICE) E PAGADOR (BOB)
  // ----------------------------------------------------------------------------
  await t.test('2. Alice cria despesa de R$ 120,00 paga por Bob: segregação entre Validadora e Credor', async () => {
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
        responsibleUid: aliceUid, // Autoridade de validação
        payerUid: bobUid,         // Beneficiário do reembolso (desembolsou o dinheiro)
        splitMethod: 'equal',
        participants: [
          { uid: aliceUid, name: 'Alice Validadora' },
          { uid: bobUid, name: 'Bob Credor' },
          { uid: charlieUid, name: 'Charlie Admin' },
        ],
        idempotencyKey: 'idem_emul_exp_01',
      },
      false
    );

    assert.ok(res.expense.id);
    expenseId = res.expense.id;
    assert.equal(res.expense.totalOriginalAmountCents, 12000);
    assert.equal(res.expense.responsibleUid, aliceUid);
    assert.equal(res.expense.payerUid, bobUid);
    assert.equal(res.liabilities.length, 3);

    for (const liab of res.liabilities) {
      assert.equal(liab.originalAmountCents, 4000);
      assert.equal(liab.assignedShareAmountCents, 4000); // R$ 40,00 cada
      assert.equal(liab.refundAdjustmentCents, 0);
      assert.equal(liab.paidAmountCents, 0);
      assert.equal(liab.status, 'pending');
    }

    await signOut(auth);
  });

  // ----------------------------------------------------------------------------
  // 3. DECLARAÇÃO DE PAGAMENTO PELO DEVEDOR
  // ----------------------------------------------------------------------------
  await t.test('3. Charlie declara pagamento de R$ 40,00 via Pix; obrigação vai para in_validation', async () => {
    await signInWithEmailAndPassword(auth, 'charlie.f6@teste.local', 'SenhaForte123!');

    const decl = await declareExpensePayment(
      {
        spaceId,
        expenseId,
        memberUid: charlieUid,
        memberName: 'Charlie Admin',
        amountCents: 4000,
        paymentDate: '2026-11-11',
        paymentMethod: 'pix',
        notes: 'Comprovante Pix #987654',
        idempotencyKey: 'decl_emul_charlie_01',
      },
      false
    );

    assert.ok(decl.id);
    charlieDeclId = decl.id;
    assert.equal(decl.status, 'pending_validation');
    assert.equal(decl.amountCents, 4000);
    assert.equal(decl.payerUid, bobUid);

    // Consulta Firestore: obrigação de Charlie atualizada para in_validation sem alterar saldo pago
    const liabs = await getExpenseLiabilities(spaceId, expenseId, false);
    const charlieLiab = liabs.find((l) => l.memberUid === charlieUid)!;
    assert.equal(charlieLiab.status, 'in_validation');
    assert.equal(charlieLiab.paidAmountCents, 0);
    assert.equal(charlieLiab.remainingAmountCents, 4000);

    await signOut(auth);
  });

  // ----------------------------------------------------------------------------
  // 4. AUTORIDADE EXCLUSIVA: CHARLIE (ADMIN) É BLOQUEADO DE VALIDAR
  // ----------------------------------------------------------------------------
  await t.test('4. Princípio da Autoridade Exclusiva: Charlie (Admin do espaço) tenta validar e é rejeitado com permission-denied', async () => {
    await signInWithEmailAndPassword(auth, 'charlie.f6@teste.local', 'SenhaForte123!');

    await assert.rejects(
      async () =>
        approveExpensePayment(
          {
            spaceId,
            expenseId,
            declarationId: charlieDeclId,
            approverUid: charlieUid,
          },
          false
        ),
      /permission-denied|Acesso negado/
    );

    await signOut(auth);
  });

  // ----------------------------------------------------------------------------
  // 5. SEGREGAÇÃO DE AUTORIDADE VS BENEFICIÁRIO & IMUTABILIDADE DA DECLARAÇÃO
  // ----------------------------------------------------------------------------
  await t.test('5. Alice tenta creditar sua própria conta (rejeitado); credita conta de Bob com sucesso (beneficiário legítimo)', async () => {
    await signInWithEmailAndPassword(auth, 'alice.f6@teste.local', 'SenhaForte123!');

    // 5.1. Alice tenta creditar aliceAccountId (não é o payerUid da despesa) -> REJEITADO
    await assert.rejects(
      async () =>
        approveExpensePayment(
          {
            spaceId,
            expenseId,
            declarationId: charlieDeclId,
            approverUid: aliceUid,
            destinationAccountId: aliceAccountId, // Conta de Alice, mas Bob é quem pagou!
            idempotencyKey: 'appr_emul_spoofed_acc',
          },
          false
        ),
      /permission-denied|não pertence ao credor\/beneficiário/
    );

    // 5.2. Alice aprova direcionando o crédito para bobAccountId (conta do beneficiário legítimo) -> SUCESSO
    const res = await approveExpensePayment(
      {
        spaceId,
        expenseId,
        declarationId: charlieDeclId,
        approverUid: aliceUid,
        destinationAccountId: bobAccountId,
        idempotencyKey: 'appr_emul_charlie_01',
      },
      false
    );

    assert.ok(res.approval.id);
    approvalId = res.approval.id;
    assert.equal(res.approval.amountCents, 4000);
    assert.equal(res.approval.isRevoked, undefined, 'Documento bruto de aprovação não possui campo mutável isRevoked');
    assert.equal(res.approval.beneficiaryUid, bobUid);
    assert.equal(res.liability.status, 'paid');
    assert.equal(res.liability.paidAmountCents, 4000);
    assert.equal(res.liability.remainingAmountCents, 0);

    // 5.3. Verifica saldo bancário no Firestore: Alice permaneceu em R$ 0,00
    const aliceAccs = await getUserAccounts(aliceUid, false, false);
    const aliceAcc = aliceAccs.find((a) => a.id === aliceAccountId)!;
    assert.equal(aliceAcc.projectedBalanceCents, 0);

    // 5.4. Imutabilidade da declaração: o documento raw de declaração NÃO é alterado
    const rawDeclSnap = await getDoc(
      doc(db, 'spaces', spaceId, 'shared_expenses', expenseId, 'payment_declarations', charlieDeclId)
    );
    assert.ok(rawDeclSnap.exists());
    assert.equal(rawDeclSnap.data().status, 'pending_validation'); // Raw nunca é mutado

    // Repetição idempotente
    const replay = await approveExpensePayment(
      {
        spaceId,
        expenseId,
        declarationId: charlieDeclId,
        approverUid: aliceUid,
        destinationAccountId: bobAccountId,
        idempotencyKey: 'appr_emul_charlie_01',
      },
      false
    );
    assert.equal(replay.approval.id, approvalId);

    // Conflito de idempotência na aprovação (conta de destino divergente)
    await assert.rejects(
      async () =>
        approveExpensePayment(
          {
            spaceId,
            expenseId,
            declarationId: charlieDeclId,
            approverUid: aliceUid,
            destinationAccountId: undefined,
            idempotencyKey: 'appr_emul_charlie_01',
          },
          false
        ),
      /already-exists|Conflito de idempotência/
    );

    await signOut(auth);

    // Verifica que Bob (beneficiário legítimo) recebeu o crédito de R$ 40,00 em sua conta
    await signInWithEmailAndPassword(auth, 'bob.f6@teste.local', 'SenhaForte123!');
    const bobAccs = await getUserAccounts(bobUid, false, false);
    const bobAcc = bobAccs.find((a) => a.id === bobAccountId)!;
    assert.equal(bobAcc.projectedBalanceCents, 4000);
    await signOut(auth);
  });

  // ----------------------------------------------------------------------------
  // 6. HISTÓRICO IMUTÁVEL DE REJEIÇÃO (SUBCOLEÇÃO PAYMENT_REJECTIONS)
  // ----------------------------------------------------------------------------
  let aliceDeclId = '';

  await t.test('6. Alice rejeita declaração: gera evento append-only em payment_rejections sem mutar documento original', async () => {
    // 6.1. Alice declara pagamento da sua cota (R$ 40,00)
    await signInWithEmailAndPassword(auth, 'alice.f6@teste.local', 'SenhaForte123!');

    const decl = await declareExpensePayment(
      {
        spaceId,
        expenseId,
        memberUid: aliceUid,
        memberName: 'Alice Validadora',
        amountCents: 4000,
        paymentDate: '2026-11-11',
        paymentMethod: 'pix',
        notes: 'Declaração para teste de rejeição',
        idempotencyKey: 'decl_emul_alice_01',
      },
      false
    );
    aliceDeclId = decl.id;

    // 6.2. Alice rejeita a própria declaração com motivo obrigatório
    const rejRes = await rejectExpensePayment(
      {
        spaceId,
        expenseId,
        declarationId: aliceDeclId,
        rejecterUid: aliceUid,
        rejectionReason: 'Comprovante ilegível ou incorreto',
        idempotencyKey: 'rej_emul_alice_01',
      },
      false
    );

    assert.ok(rejRes.rejection.id);
    assert.equal(rejRes.rejection.declarationId, aliceDeclId);
    assert.equal(rejRes.rejection.rejectionReason || rejRes.rejection.reason, 'Comprovante ilegível ou incorreto');
    assert.equal(rejRes.rejection.rejectedByUid, aliceUid);
    assert.equal(rejRes.liability.status, 'pending');

    // 6.3. Verifica no Firestore: documento criado em payment_rejections e declaração raw inalterada
    const rejSnap = await getDoc(
      doc(db, 'spaces', spaceId, 'shared_expenses', expenseId, 'payment_rejections', rejRes.rejection.id)
    );
    assert.ok(rejSnap.exists());
    assert.equal(rejSnap.data().rejectionReason || rejSnap.data().reason, 'Comprovante ilegível ou incorreto');

    const rawDeclSnap = await getDoc(
      doc(db, 'spaces', spaceId, 'shared_expenses', expenseId, 'payment_declarations', aliceDeclId)
    );
    assert.ok(rawDeclSnap.exists());
    assert.equal(rawDeclSnap.data().status, 'pending_validation'); // Raw nunca é mutado

    // Consulta derivada pelo serviço
    const decls = await getExpensePaymentDeclarations(spaceId, expenseId, false);
    const aliceDeclDerived = decls.find((d) => d.id === aliceDeclId)!;
    assert.equal(aliceDeclDerived.status, 'rejected');
    assert.equal(aliceDeclDerived.rejectionReason, 'Comprovante ilegível ou incorreto');

    await signOut(auth);
  });

  // ----------------------------------------------------------------------------
  // 7. REEMBOLSO DE FORNECEDOR (SUPPLIER REFUND): PRESERVAÇÃO E CREDIT NOTE
  // ----------------------------------------------------------------------------
  await t.test('7. Reembolso comercial do fornecedor: preserva originalAmountCents e calcula creditNoteCents para Charlie', async () => {
    await signInWithEmailAndPassword(auth, 'alice.f6@teste.local', 'SenhaForte123!');

    const refund = await recordSupplierRefund(
      {
        spaceId,
        expenseId,
        refundType: 'partial_refund',
        amountRefundedCents: 3000, // R$ 30,00 devolvidos pela companhia elétrica (R$ 10,00 para cada um dos 3)
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
      // PRESERVAÇÃO ESTRITA: Cota original nunca é reduzida
      assert.equal(l.originalAmountCents, 4000);
      assert.equal(l.assignedShareAmountCents, 4000);
      assert.equal(l.refundAdjustmentCents, 1000);
      assert.equal(l.adjustedShareAmountCents, 3000); // 4000 - 1000 = 3000

      if (l.memberUid === charlieUid) {
        // Charlie já havia pago 4000. Sua cota ajustada é 3000. Logo, possui creditNote de 1000!
        assert.equal(l.paidAmountCents, 4000);
        assert.equal(l.remainingAmountCents, 0);
        assert.equal(l.creditNoteCents, 1000);
        assert.equal(l.status, 'paid');
      } else {
        assert.equal(l.paidAmountCents, 0);
        assert.equal(l.remainingAmountCents, 3000);
        assert.equal(l.creditNoteCents, 0);
      }
    }

    await signOut(auth);
  });

  // ----------------------------------------------------------------------------
  // 8. CONCORRÊNCIA REAL (CENÁRIO 4) + IMUTABILIDADE DO DOCUMENTO DE APROVAÇÃO (FRENTE A)
  // ----------------------------------------------------------------------------
  await t.test('8. Concorrência Real (6 chamadas simultâneas via Promise.all) e Imutabilidade Estrita de payment_approvals no Firestore', async () => {
    await signInWithEmailAndPassword(auth, 'alice.f6@teste.local', 'SenhaForte123!');

    // Captura o documento bruto de aprovação ANTES da revogação para provar imutabilidade byte-a-byte
    const rawApprRef = doc(db, 'spaces', spaceId, 'shared_expenses', expenseId, 'payment_approvals', approvalId);
    const rawApprBeforeSnap = await getDoc(rawApprRef);
    assert.ok(rawApprBeforeSnap.exists());
    const rawApprBeforeJson = JSON.stringify(rawApprBeforeSnap.data());

    // Dispara 6 chamadas concorrentes de revogação da mesma aprovação contra o Firebase Emulator
    const concurrentCalls = Array.from({ length: 6 }, (_, idx) =>
      revokeExpensePaymentApproval(
        {
          spaceId,
          expenseId,
          approvalId,
          revokerUid: aliceUid,
          reason: 'Estorno administrativo para reprocessamento',
          idempotencyKey: `revoc_emul_charlie_concurrent_${idx}`,
        },
        false
      )
    );

    const results = await Promise.all(concurrentCalls);
    for (const revRes of results) {
      assert.ok(revRes.revocation.id);
      assert.equal(revRes.revocation.id, results[0].revocation.id);
      assert.equal(revRes.revocation.revokedAmountCents, 4000);
      assert.equal(revRes.liability.status, 'pending');
      assert.equal(revRes.liability.paidAmountCents, 0);
      assert.equal(revRes.liability.remainingAmountCents, 3000); // Saldo devedor ajustado (pós-refund)
      assert.equal(revRes.liability.creditNoteCents, 0);
      assert.equal(revRes.liability.originalAmountCents, 4000);
      assert.equal(revRes.liability.assignedShareAmountCents, 4000);
      assert.equal(revRes.liability.refundAdjustmentCents, 1000);
      assert.equal(revRes.liability.adjustedShareAmountCents, 3000);
    }

    // PROVA DE IMUTABILIDADE ESTRITA (FRENTE A):
    // O documento bruto em payment_approvals/{approvalId} NÃO sofreu update (nenhum campo adicionado ou modificado)
    const rawApprAfterSnap = await getDoc(rawApprRef);
    assert.ok(rawApprAfterSnap.exists());
    assert.equal(
      JSON.stringify(rawApprAfterSnap.data()),
      rawApprBeforeJson,
      'O documento original em payment_approvals deve permanecer 100% imutável após a revogação'
    );
    assert.equal(rawApprAfterSnap.data().isRevoked, undefined);

    // PROVA DE CONCORRÊNCIA E UNICIDADE (CENÁRIO 4):
    // Apenas 1 documento em approval_revocations
    const revocsSnap = await getDocs(
      collection(db, 'spaces', spaceId, 'shared_expenses', expenseId, 'approval_revocations')
    );
    assert.equal(revocsSnap.size, 1, 'Apenas 1 evento de revogação deve existir após 6 chamadas concorrentes');

    // Apenas 1 registro de auditoria de revogação em spaces/{spaceId}/audit
    const auditSnap = await getDocs(collection(db, 'spaces', spaceId, 'audit'));
    const revocAudits = auditSnap.docs
      .map((d) => d.data())
      .filter((a) => a.eventType === 'payment_approval_revoked');
    assert.equal(revocAudits.length, 1, 'Apenas 1 evento de auditoria de revogação deve existir');

    // Teste de conflito de idempotência (Cenário 3): motivo divergente para a mesma aprovação deve falhar
    await assert.rejects(
      async () =>
        revokeExpensePaymentApproval(
          {
            spaceId,
            expenseId,
            approvalId,
            revokerUid: aliceUid,
            reason: 'Motivo divergente para forçar conflito',
          },
          false
        ),
      /already-exists|Conflito de idempotência/
    );

    await signOut(auth);

    // Verifica que na conta de Bob há apenas 1 movimento de entrada e 1 movimento compensatório de saída (saldo = 0)
    await signInWithEmailAndPassword(auth, 'bob.f6@teste.local', 'SenhaForte123!');
    const bobAccs = await getUserAccounts(bobUid, false, false);
    const bobAcc = bobAccs.find((a) => a.id === bobAccountId)!;
    assert.equal(bobAcc.projectedBalanceCents, 0);

    const bobMovsSnap = await getDocs(collection(db, 'accounts', bobAccountId, 'movements'));
    const bobMovs = bobMovsSnap.docs.map((d) => d.data());
    const inflowMovs = bobMovs.filter((m) => m.direction === 'inflow');
    const outflowReversals = bobMovs.filter(
      (m) => m.direction === 'outflow' && m.reversalOfMovementId === inflowMovs[0]?.id
    );
    assert.equal(inflowMovs.length, 1);
    assert.equal(outflowReversals.length, 1, 'Apenas 1 movimento compensatório deve existir após 6 chamadas concorrentes');
    await signOut(auth);
  });

  // ----------------------------------------------------------------------------
  // 9. CENÁRIOS 5 E 8 NO EMULATOR REAL: PAGAMENTO PARCIAL + DINHEIRO JÁ UTILIZADO
  // ----------------------------------------------------------------------------
  await t.test('9. Cenários 5 e 8 no Emulator: Pagamento parcial preservado na revogação + Restituição sinalizada quando o saldo já foi utilizado', async () => {
    // Charlie declara 1º pagamento parcial de R$ 10,00 (1000 centavos) e 2º pagamento parcial de R$ 20,00 (2000 centavos)
    await signInWithEmailAndPassword(auth, 'charlie.f6@teste.local', 'SenhaForte123!');
    const declPart1 = await declareExpensePayment(
      {
        spaceId,
        expenseId,
        memberUid: charlieUid,
        memberName: 'Charlie Admin',
        amountCents: 1000,
        paymentDate: '2026-11-13',
        paymentMethod: 'pix',
        idempotencyKey: 'decl_emul_charlie_part_1000',
      },
      false
    );
    const declPart2 = await declareExpensePayment(
      {
        spaceId,
        expenseId,
        memberUid: charlieUid,
        memberName: 'Charlie Admin',
        amountCents: 2000,
        paymentDate: '2026-11-14',
        paymentMethod: 'pix',
        idempotencyKey: 'decl_emul_charlie_part_2000',
      },
      false
    );
    await signOut(auth);

    // Alice aprova ambos os pagamentos creditando a conta de Bob
    await signInWithEmailAndPassword(auth, 'alice.f6@teste.local', 'SenhaForte123!');
    const apprPart1 = await approveExpensePayment(
      {
        spaceId,
        expenseId,
        declarationId: declPart1.id,
        approverUid: aliceUid,
        destinationAccountId: bobAccountId,
      },
      false
    );
    assert.equal(apprPart1.liability.paidAmountCents, 1000);
    assert.equal(apprPart1.liability.remainingAmountCents, 2000);
    assert.equal(apprPart1.liability.status, 'partially_paid');

    const apprPart2 = await approveExpensePayment(
      {
        spaceId,
        expenseId,
        declarationId: declPart2.id,
        approverUid: aliceUid,
        destinationAccountId: bobAccountId,
      },
      false
    );
    assert.equal(apprPart2.liability.paidAmountCents, 3000);
    assert.equal(apprPart2.liability.remainingAmountCents, 0);
    assert.equal(apprPart2.liability.status, 'paid');
    await signOut(auth);

    // CENÁRIO 8: Bob utiliza R$ 25,00 (2500 centavos) do seu saldo de R$ 30,00 (restando apenas R$ 5,00 na conta)
    await signInWithEmailAndPassword(auth, 'bob.f6@teste.local', 'SenhaForte123!');
    const { recordMovement } = await import('./ledgerService');
    await recordMovement(
      {
        accountId: bobAccountId,
        userId: bobUid,
        direction: 'outflow',
        amountCents: 2500,
        effectiveDate: '2026-11-14',
        originType: 'personal_expense',
        originId: 'tx_bob_spend_2500',
        description: 'Saque/Gasto pessoal de Bob no Emulator',
        authorUid: bobUid,
        idempotencyKey: 'idem_emul_bob_spend_2500',
      },
      false
    );
    await signOut(auth);

    // Agora Alice revoga a 2ª aprovação (de R$ 20,00 / 2000 centavos)
    await signInWithEmailAndPassword(auth, 'alice.f6@teste.local', 'SenhaForte123!');
    const revocPart2 = await revokeExpensePaymentApproval(
      {
        spaceId,
        expenseId,
        approvalId: apprPart2.approval.id,
        revokerUid: aliceUid,
        reason: 'Estorno do segundo pagamento parcial',
      },
      false
    );

    // Valida Cenário 5: O 1º pagamento parcial de R$ 10,00 (1000) permanece reconhecido!
    assert.equal(revocPart2.liability.paidAmountCents, 1000);
    assert.equal(revocPart2.liability.remainingAmountCents, 2000);
    assert.equal(revocPart2.liability.status, 'partially_paid');

    // Valida Cenário 8: Como Bob tinha apenas R$ 5,00 (500) na conta quando R$ 20,00 (2000) foi estornado contabilmente,
    // requiresRestitution é true e restitutionPendingCents é 1500 (R$ 15,00)
    assert.equal(revocPart2.revocation.requiresRestitution, true);
    assert.equal(revocPart2.revocation.restitutionPendingCents, 1500);
    assert.ok(
      revocPart2.compensatoryMovement?.description.includes('Restituição financeira pendente'),
      'Descrição do movimento compensatório deve explicitar a restituição financeira pendente'
    );
    await signOut(auth);
  });

  // ----------------------------------------------------------------------------
  // 10. AUDITORIA DE NOTIFICAÇÕES NO FIRESTORE (SEM DUPLICIDADE)
  // ----------------------------------------------------------------------------
  await t.test('10. Validação de Notificações no Firestore para Alice, Bob e Charlie sem duplicações por evento', async () => {
    // 10.1. Notificações de Alice (Validadora)
    await signInWithEmailAndPassword(auth, 'alice.f6@teste.local', 'SenhaForte123!');
    const aliceNotifsSnap = await getDocs(collection(db, 'users', aliceUid, 'notifications'));
    const aliceNotifs = aliceNotifsSnap.docs.map((d) => d.data());
    assert.ok(aliceNotifs.length > 0);
    assert.ok(aliceNotifs.some((n) => n.type === 'shared_expense_assigned'));
    assert.ok(aliceNotifs.some((n) => n.type === 'payment_declaration_submitted'));
    await signOut(auth);

    // 10.2. Notificações de Bob (Credor)
    await signInWithEmailAndPassword(auth, 'bob.f6@teste.local', 'SenhaForte123!');
    const bobNotifsSnap = await getDocs(collection(db, 'users', bobUid, 'notifications'));
    const bobNotifs = bobNotifsSnap.docs.map((d) => d.data());
    assert.ok(bobNotifs.length > 0);
    assert.ok(bobNotifs.some((n) => n.type === 'shared_expense_assigned'));
    assert.ok(bobNotifs.some((n) => n.type === 'payment_approved'));
    assert.ok(bobNotifs.some((n) => n.type === 'payment_approval_revoked'));
    await signOut(auth);

    // 10.3. Notificações de Charlie (Membro devedor)
    await signInWithEmailAndPassword(auth, 'charlie.f6@teste.local', 'SenhaForte123!');
    const charlieNotifsSnap = await getDocs(collection(db, 'users', charlieUid, 'notifications'));
    const charlieNotifs = charlieNotifsSnap.docs.map((d) => d.data());
    assert.ok(charlieNotifs.length > 0);
    assert.ok(charlieNotifs.some((n) => n.type === 'shared_expense_assigned'));
    assert.ok(charlieNotifs.some((n) => n.type === 'payment_approved'));
    assert.ok(charlieNotifs.some((n) => n.type === 'supplier_refund_confirmed'));
    assert.ok(charlieNotifs.some((n) => n.type === 'payment_approval_revoked'));
    await signOut(auth);
  });

  // ----------------------------------------------------------------------------
  // 11. OBRIGAÇÃO DE RESTITUIÇÃO REAL NO FIRESTORE + CLOUD FUNCTIONS (ETAPA 1)
  // ----------------------------------------------------------------------------
  await t.test('11. Validação de Restituição Real no Firestore Emulator com liquidação e movimento de entrada', async () => {
    // 11.1. Buscar a obrigação de restituição gerada pela revogação da cota de Charlie em sharedExpenseId
    await signInWithEmailAndPassword(auth, 'alice.f6@teste.local', 'SenhaForte123!');
    const restits = await getExpenseRestitutions(spaceId, expenseId, false);
    assert.ok(restits.length > 0, 'Deve existir pelo menos uma restituição gerada na despesa');
    const restitution = restits[0];
    assert.equal(restitution.debtorUid, bobUid);
    assert.equal(restitution.creditorUid, charlieUid);
    assert.equal(restitution.status, 'pending');
    await signOut(auth);

    // 11.2. Bob declara pagamento de restituição de R$ 10,00 (1000 centavos)
    await signInWithEmailAndPassword(auth, 'bob.f6@teste.local', 'SenhaForte123!');
    const { declaration: rstDecl } = await declareRestitutionPayment(
      {
        spaceId,
        expenseId,
        restitutionId: restitution.id,
        debtorUid: bobUid,
        amountCents: 1000,
        notes: 'Devolução parcial via PIX direto a Charlie',
        idempotencyKey: 'idem_emul_rst_decl_1000',
      },
      false
    );
    assert.ok(rstDecl);
    assert.equal(rstDecl.amountCents, 1000);

    // Tentativa de Bob (devedor) confirmar o próprio recebimento deve ser rejeitada com erro
    await assert.rejects(
      async () =>
        confirmRestitutionReceipt(
          {
            spaceId,
            expenseId,
            restitutionId: restitution.id,
            declarationId: rstDecl.id,
            creditorUid: bobUid, // Tentativa ilegítima
            amountCents: 1000,
            destinationAccountId: bobAccountId,
            idempotencyKey: 'idem_emul_rst_rec_bob_fail',
          },
          false
        ),
      /(permission-denied|403|Somente o credor legítimo)/
    );
    await signOut(auth);

    // 11.3. Charlie (credor legítimo) confirma o recebimento na sua conta
    await signInWithEmailAndPassword(auth, 'charlie.f6@teste.local', 'SenhaForte123!');
    const charlieAccSnapBefore = await getDoc(doc(db, 'accounts', charlieAccountId));
    const balBefore = charlieAccSnapBefore.data()?.projectedBalanceCents || 0;

    const { receipt, restitution: updatedRestit, movement } = await confirmRestitutionReceipt(
      {
        spaceId,
        expenseId,
        restitutionId: restitution.id,
        declarationId: rstDecl.id,
        creditorUid: charlieUid,
        amountCents: 1000,
        destinationAccountId: charlieAccountId,
        notes: 'Recebimento de R$ 10,00 confirmado por Charlie',
        idempotencyKey: 'idem_emul_rst_rec_charlie_1000',
      },
      false
    );

    assert.ok(receipt);
    assert.ok(movement);
    assert.equal(receipt.amountCents, 1000);
    assert.equal(updatedRestit.restitutedAmountCents, 1000);
    assert.equal(updatedRestit.remainingAmountCents, restitution.amountToRestoreCents - 1000);
    assert.equal(updatedRestit.status, 'partial');

    // Confere que o saldo da conta de Charlie no Firestore foi creditado
    const charlieAccSnapAfter = await getDoc(doc(db, 'accounts', charlieAccountId));
    assert.equal(charlieAccSnapAfter.data()?.projectedBalanceCents, balBefore + 1000);

    // Confere que o movimento contábil de entrada foi gravado no Firestore
    const movSnap = await getDoc(doc(db, 'accounts', charlieAccountId, 'movements', movement.id));
    assert.ok(movSnap.exists());
    assert.equal(movSnap.data()?.direction, 'inflow');
    assert.equal(movSnap.data()?.amountCents, 1000);

    await signOut(auth);
  });

  t.after(async () => {
    await terminate(db);
  });
});
