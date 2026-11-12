import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateExpenseSplit,
  SplitParticipant,
} from '../utils/splitEngine';
import {
  approveExpensePayment,
  createSharedExpense,
  declareExpensePayment,
  getExpenseLiabilities,
  getExpensePaymentDeclarations,
  getSharedExpenses,
  getSpaceFinancialSummary,
  getSpacePendingDeclarations,
  loadDemoApprovalRevocations,
  loadDemoPaymentApprovals,
  loadDemoPaymentDeclarations,
  loadDemoSharedExpenses,
  loadDemoPaymentRejections,
  loadDemoSharedLiabilities,
  recordSupplierRefund,
  rejectExpensePayment,
  revokeExpensePaymentApproval,
  saveDemoApprovalRevocations,
  saveDemoPaymentApprovals,
  saveDemoPaymentDeclarations,
  saveDemoPaymentRejections,
  saveDemoSharedExpenses,
  saveDemoSharedLiabilities,
  saveDemoSupplierRefunds,
} from './sharedFinanceService';
import { createAccount, getUserAccounts } from './accountService';
import { formatCentsToBRL, parseBRLToCents } from '../utils/movementLedger';

function resetSharedDemoStorage() {
  saveDemoSharedExpenses([]);
  saveDemoSharedLiabilities([]);
  saveDemoPaymentDeclarations([]);
  saveDemoPaymentApprovals([]);
  saveDemoPaymentRejections([]);
  saveDemoApprovalRevocations([]);
  saveDemoSupplierRefunds([]);
}

test('FASE 6 — Rateios e Reembolsos Compartilhados (Arquitetura v3.1)', async (t) => {
  resetSharedDemoStorage();

  // ----------------------------------------------------------------------------
  // 1. MOTOR MATEMÁTICO: RATEIO IGUAL (EQUAL) COM ZERO DRIFT
  // ----------------------------------------------------------------------------
  await t.test('1. Rateio Igual: divide R$ 100,00 entre 3 participantes sem perda de centavos (33,34 + 33,33 + 33,33 = 100,00)', () => {
    const participants: SplitParticipant[] = [
      { uid: 'user_c', name: 'Carol' },
      { uid: 'user_a', name: 'Alice' },
      { uid: 'user_b', name: 'Bob' },
    ];

    const splits = calculateExpenseSplit({
      totalAmountCents: 10000, // R$ 100,00
      splitMethod: 'equal',
      participants,
    });

    assert.equal(splits.length, 3);
    const sumCents = splits.reduce((acc, s) => acc + s.assignedShareAmountCents, 0);
    assert.equal(sumCents, 10000, 'A soma das cotas deve ser exatamente 10.000 centavos');

    // Com 10000 / 3 = 3333 resto 1, o primeiro ordenado por UID (user_a) recebe 3334
    const aliceShare = splits.find((s) => s.memberUid === 'user_a')!;
    const bobShare = splits.find((s) => s.memberUid === 'user_b')!;
    const carolShare = splits.find((s) => s.memberUid === 'user_c')!;

    assert.equal(aliceShare.assignedShareAmountCents, 3334);
    assert.equal(bobShare.assignedShareAmountCents, 3333);
    assert.equal(carolShare.assignedShareAmountCents, 3333);
  });

  await t.test('2. Rateio Igual: divide R$ 10,00 entre 7 participantes com conservação estrita (1000 centavos)', () => {
    const participants: SplitParticipant[] = Array.from({ length: 7 }, (_, i) => ({
      uid: `u_${String.fromCharCode(97 + i)}`,
      name: `User ${i + 1}`,
    }));

    const splits = calculateExpenseSplit({
      totalAmountCents: 1000, // R$ 10,00
      splitMethod: 'equal',
      participants,
    });

    const sum = splits.reduce((acc, s) => acc + s.assignedShareAmountCents, 0);
    assert.equal(sum, 1000, 'A soma das cotas deve conservar exatamente 1000 centavos');
    // 1000 / 7 = 142 resto 6 (6 ganham 143, 1 ganha 142)
    const count143 = splits.filter((s) => s.assignedShareAmountCents === 143).length;
    const count142 = splits.filter((s) => s.assignedShareAmountCents === 142).length;
    assert.equal(count143, 6);
    assert.equal(count142, 1);
  });

  // ----------------------------------------------------------------------------
  // 2. MOTOR MATEMÁTICO: RATEIO POR PERCENTUAL COM MAIOR RESTO (HAMILTON)
  // ----------------------------------------------------------------------------
  await t.test('3. Rateio Percentual: 33.33%, 33.33%, 33.34% sobre R$ 100,00 soma exatamente R$ 100,00', () => {
    const participants: SplitParticipant[] = [
      { uid: 'u1', name: 'Alice' },
      { uid: 'u2', name: 'Bob' },
      { uid: 'u3', name: 'Carol' },
    ];

    const splits = calculateExpenseSplit({
      totalAmountCents: 10000,
      splitMethod: 'percentage',
      participants,
      percentages: {
        u1: 33.33,
        u2: 33.33,
        u3: 33.34,
      },
    });

    const sum = splits.reduce((acc, s) => acc + s.assignedShareAmountCents, 0);
    assert.equal(sum, 10000);
  });

  await t.test('4. Rateio Percentual: rejeita soma de percentuais diferente de 100%', () => {
    const participants: SplitParticipant[] = [
      { uid: 'u1', name: 'Alice' },
      { uid: 'u2', name: 'Bob' },
    ];

    assert.throws(
      () =>
        calculateExpenseSplit({
          totalAmountCents: 5000,
          splitMethod: 'percentage',
          participants,
          percentages: { u1: 50, u2: 40 }, // soma 90%
        }),
      /A soma dos percentuais informados é 90.00%, mas deve ser exatamente 100%/
    );
  });

  // ----------------------------------------------------------------------------
  // 3. MOTOR MATEMÁTICO: RATEIO PERSONALIZADO (CUSTOM_VALUE)
  // ----------------------------------------------------------------------------
  await t.test('5. Rateio Personalizado: valida soma exata em centavos e rejeita divergência', () => {
    const participants: SplitParticipant[] = [
      { uid: 'u1', name: 'Alice' },
      { uid: 'u2', name: 'Bob' },
    ];

    // Válido
    const valid = calculateExpenseSplit({
      totalAmountCents: 8550,
      splitMethod: 'custom_value',
      participants,
      customValues: { u1: 5000, u2: 3550 },
    });
    assert.equal(valid.reduce((acc, s) => acc + s.assignedShareAmountCents, 0), 8550);

    // Divergente
    assert.throws(
      () =>
        calculateExpenseSplit({
          totalAmountCents: 8550,
          splitMethod: 'custom_value',
          participants,
          customValues: { u1: 5000, u2: 3500 }, // soma 8500 != 8550
        }),
      /A soma dos valores individuais \(R\$ 85,00\) não confere com o total da despesa/
    );
  });

  // ----------------------------------------------------------------------------
  // 4. CRIAÇÃO DE DESPESA COMPARTILHADA E PERSISTÊNCIA DAS OBRIGAÇÕES
  // ----------------------------------------------------------------------------
  await t.test('6. Criação de despesa compartilhada gera obrigações individuais (liabilities) pendentes', async () => {
    const res = await createSharedExpense(
      'space_alpha',
      {
        spaceId: 'space_alpha',
        title: 'Jantar de Confraternização',
        totalOriginalAmountCents: 15000, // R$ 150,00
        competenceMonth: '2026-11',
        competenceDate: '2026-11-10',
        categoryId: 'cat_food',
        categoryName: 'Alimentação',
        createdByUid: 'alice_uid',
        responsibleUid: 'alice_uid',
        splitMethod: 'equal',
        participants: [
          { uid: 'alice_uid', name: 'Alice' },
          { uid: 'bob_uid', name: 'Bob' },
          { uid: 'carol_uid', name: 'Carol' },
        ],
        idempotencyKey: 'idem_jantar_01',
      },
      true
    );

    assert.equal(res.expense.title, 'Jantar de Confraternização');
    assert.equal(res.expense.responsibleUid, 'alice_uid');
    assert.equal(res.liabilities.length, 3);

    for (const liab of res.liabilities) {
      assert.equal(liab.assignedShareAmountCents, 5000); // R$ 50,00 cada
      assert.equal(liab.paidAmountCents, 0);
      assert.equal(liab.remainingAmountCents, 5000);
      assert.equal(liab.status, 'pending');
    }

    // Idempotência
    const replay = await createSharedExpense(
      'space_alpha',
      {
        spaceId: 'space_alpha',
        title: 'Jantar de Confraternização',
        totalOriginalAmountCents: 15000,
        competenceMonth: '2026-11',
        competenceDate: '2026-11-10',
        categoryId: 'cat_food',
        categoryName: 'Alimentação',
        createdByUid: 'alice_uid',
        responsibleUid: 'alice_uid',
        splitMethod: 'equal',
        participants: [
          { uid: 'alice_uid', name: 'Alice' },
          { uid: 'bob_uid', name: 'Bob' },
          { uid: 'carol_uid', name: 'Carol' },
        ],
        idempotencyKey: 'idem_jantar_01',
      },
      true
    );
    assert.equal(replay.expense.id, res.expense.id);
  });

  // ----------------------------------------------------------------------------
  // 5. DECLARAÇÃO DE PAGAMENTO PELO DEVEDOR
  // ----------------------------------------------------------------------------
  await t.test('7. Devedor declara pagamento de cota: gera declaração e coloca status em in_validation sem alterar saldo ainda', async () => {
    const expenses = await getSharedExpenses('space_alpha', 'bob_uid', true);
    const exp = expenses[0];

    const decl = await declareExpensePayment(
      {
        spaceId: 'space_alpha',
        expenseId: exp.id,
        memberUid: 'bob_uid',
        memberName: 'Bob',
        amountCents: 5000, // R$ 50,00
        paymentDate: '2026-11-11',
        paymentMethod: 'pix',
        notes: 'Chave Pix enviada no WhatsApp',
        idempotencyKey: 'decl_bob_01',
      },
      true
    );

    assert.equal(decl.status, 'pending_validation');
    assert.equal(decl.amountCents, 5000);
    assert.equal(decl.responsibleUid, 'alice_uid');

    // Verifica que a obrigação ficou em in_validation, mas paidAmountCents ainda é 0!
    const liabs = await getExpenseLiabilities('space_alpha', exp.id, true);
    const bobLiab = liabs.find((l) => l.memberUid === 'bob_uid')!;
    assert.equal(bobLiab.status, 'in_validation');
    assert.equal(bobLiab.paidAmountCents, 0, 'O valor pago oficial NÃO deve ser alterado antes da aprovação');
    assert.equal(bobLiab.remainingAmountCents, 5000);
  });

  await t.test('8. Rejeita declaração de pagamento com valor superior ao saldo devedor restante', async () => {
    const expenses = await getSharedExpenses('space_alpha', 'carol_uid', true);
    const exp = expenses[0];

    await assert.rejects(
      async () =>
        declareExpensePayment(
          {
            spaceId: 'space_alpha',
            expenseId: exp.id,
            memberUid: 'carol_uid',
            memberName: 'Carol',
            amountCents: 9000, // Saldo devedor é 5000
            paymentDate: '2026-11-11',
            paymentMethod: 'pix',
            idempotencyKey: 'decl_carol_excess',
          },
          true
        ),
      /excede o saldo devedor restante/
    );
  });

  // ----------------------------------------------------------------------------
  // 6. VALIDAÇÃO DE PAGAMENTO: AUTORIDADE EXCLUSIVA DO RESPONSÁVEL FINANCEIRO
  // ----------------------------------------------------------------------------
  await t.test('9. Princípio da Autoridade Exclusiva: usuário que não é responsibleUid é BLOQUEADO de aprovar ou rejeitar', async () => {
    const expenses = await getSharedExpenses('space_alpha', 'alice_uid', true);
    const exp = expenses[0];
    const decls = await getExpensePaymentDeclarations('space_alpha', exp.id, true);
    const bobDecl = decls.find((d) => d.memberUid === 'bob_uid')!;

    // Carol tenta aprovar o pagamento de Bob (embora Carol seja membro do espaço)
    await assert.rejects(
      async () =>
        approveExpensePayment(
          {
            spaceId: 'space_alpha',
            expenseId: exp.id,
            declarationId: bobDecl.id,
            approverUid: 'carol_uid', // NÃO é a responsável financeira!
          },
          true
        ),
      /Somente o responsável financeiro da despesa \(alice_uid\) pode aprovar pagamentos/
    );

    // Carol tenta rejeitar o pagamento de Bob
    await assert.rejects(
      async () =>
        rejectExpensePayment(
          {
            spaceId: 'space_alpha',
            expenseId: exp.id,
            declarationId: bobDecl.id,
            rejecterUid: 'carol_uid',
            rejectionReason: 'Não vi o dinheiro',
          },
          true
        ),
      /Somente o responsável financeiro da despesa \(alice_uid\) pode rejeitar pagamentos/
    );
  });

  // ----------------------------------------------------------------------------
  // 7. APROVAÇÃO LEGÍTIMA PELO RESPONSÁVEL E CRÉDITO BANCÁRIO REAL
  // ----------------------------------------------------------------------------
  await t.test('10. Responsável financeiro aprova pagamento: atualiza status para pago e credita FinancialMovement', async () => {
    // Cria conta bancária para Alice
    const aliceAcc = await createAccount(
      'alice_uid',
      {
        name: 'Nubank Alice',
        type: 'checking',
      },
      true
    );

    const expenses = await getSharedExpenses('space_alpha', 'alice_uid', true);
    const exp = expenses[0];
    const decls = await getExpensePaymentDeclarations('space_alpha', exp.id, true);
    const bobDecl = decls.find((d) => d.memberUid === 'bob_uid')!;

    const approvalResult = await approveExpensePayment(
      {
        spaceId: 'space_alpha',
        expenseId: exp.id,
        declarationId: bobDecl.id,
        approverUid: 'alice_uid', // Responsável legítima
        destinationAccountId: aliceAcc.id,
        idempotencyKey: 'appr_bob_01',
      },
      true
    );

    assert.equal(approvalResult.approval.amountCents, 5000);
    assert.equal(approvalResult.approval.memberUid, 'bob_uid');
    assert.equal(approvalResult.approval.isRevoked, undefined, 'Documento bruto de aprovação não possui flag mutável isRevoked');
    assert.equal(approvalResult.liability.status, 'paid');
    assert.equal(approvalResult.liability.paidAmountCents, 5000);
    assert.equal(approvalResult.liability.remainingAmountCents, 0);

    // Verifica que gerou FinancialMovement com originType 'shared_reimbursement'
    assert.ok(approvalResult.movement);
    assert.equal(approvalResult.movement?.direction, 'inflow');
    assert.equal(approvalResult.movement?.amountCents, 5000);
    assert.equal(approvalResult.movement?.originType, 'shared_reimbursement');

    // Verifica saldo bancário de Alice atualizado
    const accs = await getUserAccounts('alice_uid', false, true);
    const updatedAcc = accs.find((a) => a.id === aliceAcc.id)!;
    assert.equal(updatedAcc.projectedBalanceCents, 5000);
  });

  // ----------------------------------------------------------------------------
  // 8. REJEIÇÃO COM JUSTIFICATIVA OBRIGATÓRIA
  // ----------------------------------------------------------------------------
  await t.test('11. Responsável financeiro rejeita pagamento com justificativa obrigatória e restaura status pending', async () => {
    const expenses = await getSharedExpenses('space_alpha', 'carol_uid', true);
    const exp = expenses[0];

    // Carol declara pagamento
    const carolDecl = await declareExpensePayment(
      {
        spaceId: 'space_alpha',
        expenseId: exp.id,
        memberUid: 'carol_uid',
        memberName: 'Carol',
        amountCents: 5000,
        paymentDate: '2026-11-11',
        paymentMethod: 'pix',
        idempotencyKey: 'decl_carol_to_reject',
      },
      true
    );

    // Rejeição sem justificativa é bloqueada
    await assert.rejects(
      async () =>
        rejectExpensePayment(
          {
            spaceId: 'space_alpha',
            expenseId: exp.id,
            declarationId: carolDecl.id,
            rejecterUid: 'alice_uid',
            rejectionReason: '   ',
          },
          true
        ),
      /A justificativa da rejeição do pagamento é estritamente obrigatória/
    );

    // Rejeição válida por Alice
    const rejectRes = await rejectExpensePayment(
      {
        spaceId: 'space_alpha',
        expenseId: exp.id,
        declarationId: carolDecl.id,
        rejecterUid: 'alice_uid',
        rejectionReason: 'Comprovante não confere com extrato',
      },
      true
    );

    assert.equal(rejectRes.declaration.status, 'rejected');
    assert.equal(rejectRes.declaration.rejectionReason, 'Comprovante não confere com extrato');
    assert.equal(rejectRes.liability.status, 'pending');
    assert.equal(rejectRes.liability.paidAmountCents, 0);
  });

  // ----------------------------------------------------------------------------
  // 9. HISTÓRICO IMUTÁVEL E REVOGAÇÃO DE APROVAÇÃO (FRENTE A + FRENTE B)
  // ----------------------------------------------------------------------------
  await t.test('12. Revogação de aprovação: preserva aprovação original 100% imutável, gera evento em approval_revocations, estorna movimento contábil e restaura saldo devedor', async () => {
    const approvals = loadDemoPaymentApprovals();
    const bobApproval = approvals.find((a) => a.memberUid === 'bob_uid')!;
    const snapshotBeforeRevoke = JSON.stringify(bobApproval);

    const revokeRes = await revokeExpensePaymentApproval(
      {
        spaceId: 'space_alpha',
        expenseId: bobApproval.expenseId,
        approvalId: bobApproval.id,
        revokerUid: 'alice_uid',
        reason: 'TED devolvido por divergência de agência',
        idempotencyKey: 'revoc_bob_01',
      },
      true
    );

    assert.equal(revokeRes.revocation.approvalId, bobApproval.id);
    assert.equal(revokeRes.revocation.revokedAmountCents, 5000);
    assert.equal(revokeRes.revocation.reason, 'TED devolvido por divergência de agência');

    // Obrigação de Bob volta para pending
    assert.equal(revokeRes.liability.status, 'pending');
    assert.equal(revokeRes.liability.paidAmountCents, 0);
    assert.equal(revokeRes.liability.remainingAmountCents, 5000);

    // O movimento financeiro foi compensado (saldo de Alice voltou para 0)
    assert.ok(revokeRes.compensatoryMovement);
    assert.equal(revokeRes.compensatoryMovement?.direction, 'outflow');
    assert.equal(revokeRes.compensatoryMovement?.amountCents, 5000);
    assert.equal(revokeRes.compensatoryMovement?.reversalOfMovementId, bobApproval.financialMovementId);

    const accs = await getUserAccounts('alice_uid', false, true);
    const aliceAcc = accs.find((a) => a.id === bobApproval.destinationAccountId)!;
    assert.equal(aliceAcc.projectedBalanceCents, 0);

    // PROVA DE IMUTABILIDADE ESTRITA (FRENTE A):
    // O documento bruto de aprovação em storage NÃO sofreu absolutamente nenhuma mutação!
    const reloadedRawApprovals = loadDemoPaymentApprovals();
    const reloadedRawBobAppr = reloadedRawApprovals.find((a) => a.id === bobApproval.id)!;
    assert.equal(JSON.stringify(reloadedRawBobAppr), snapshotBeforeRevoke, 'Documento original de aprovação deve permanecer byte-a-byte imutável');
    assert.equal(reloadedRawBobAppr.isRevoked, undefined);

    // Já a consulta derivada (getExpensePaymentApprovals) reflete isRevoked: true a partir de approval_revocations
    const { getExpensePaymentApprovals } = await import('./sharedFinanceService');
    const derivedApprovals = await getExpensePaymentApprovals('space_alpha', bobApproval.expenseId, true);
    const derivedBobAppr = derivedApprovals.find((a) => a.id === bobApproval.id)!;
    assert.equal(derivedBobAppr.isRevoked, true);
    assert.equal(derivedBobAppr.revocationId, revokeRes.revocation.id);
    assert.ok(derivedBobAppr.revokedAt);
  });

  // ----------------------------------------------------------------------------
  // 10. REEMBOLSO COMERCIAL DE FORNECEDOR (SUPPLIER REFUND)
  // ----------------------------------------------------------------------------
  await t.test('13. Reembolso comercial do fornecedor ajusta proporcionalmente as cotas de todos os participantes', async () => {
    const expenses = await getSharedExpenses('space_alpha', 'alice_uid', true);
    const exp = expenses[0]; // Total 15000 centavos, 3 participantes com 5000 cada

    const refund = await recordSupplierRefund(
      {
        spaceId: 'space_alpha',
        expenseId: exp.id,
        refundType: 'partial_refund',
        amountRefundedCents: 3000, // Devolução de R$ 30,00 (R$ 10,00 para cada um)
        recipientUid: 'alice_uid',
        date: '2026-11-12',
        justification: 'Desconto comercial concedido pelo restaurante após emissão da nota',
        idempotencyKey: 'refund_sup_01',
      },
      true
    );

    assert.equal(refund.amountRefundedCents, 3000);

    // Verifica que as cotas ajustadas de Alice, Bob e Carol foram reduzidas de 5000 para 4000
    const liabs = await getExpenseLiabilities('space_alpha', exp.id, true);
    for (const l of liabs) {
      assert.equal(l.assignedShareAmountCents, 5000); // histórico original intacto
      assert.equal(l.adjustedShareAmountCents, 4000); // reduzido proporcionalmente
      assert.equal(l.remainingAmountCents, 4000);
    }
  });

  // ----------------------------------------------------------------------------
  // 11. RESUMO FINANCEIRO CONSOLIDADO DO ESPAÇO
  // ----------------------------------------------------------------------------
  await t.test('14. Resumo financeiro do espaço calcula totais consolidados sem distorção ou fundos coletivos', async () => {
    const summaryAlice = await getSpaceFinancialSummary('space_alpha', 'alice_uid', true);
    assert.equal(summaryAlice.totalExpensesCents, 15000);
    assert.equal(summaryAlice.totalMyPendingToPayCents, 4000); // cota de Alice reajustada
    assert.equal(summaryAlice.totalMyPendingToReceiveCents, 8000); // 4000 de Bob + 4000 de Carol

    const summaryBob = await getSpaceFinancialSummary('space_alpha', 'bob_uid', true);
    assert.equal(summaryBob.totalMyPendingToPayCents, 4000);
    assert.equal(summaryBob.totalMyPendingToReceiveCents, 0); // Bob não é responsável
  });

  // ----------------------------------------------------------------------------
  // 12. SEPARAÇÃO ENTRE AUTORIDADE DE VALIDAÇÃO E CREDOR BENEFICIÁRIO DO REEMBOLSO
  // ----------------------------------------------------------------------------
  await t.test('15. Segregação: Alice é a responsável pela validação, Bob é quem pagou (payerUid) e recebe o crédito', async () => {
    // Cria contas bancárias para Bob e Alice
    const bobAcc = await createAccount('bob_credor', { name: 'Nubank Bob', type: 'checking' }, true);
    const aliceAcc = await createAccount('alice_validadora', { name: 'Itaú Alice', type: 'checking' }, true);

    // Despesa criada por Alice: Total R$ 300,00. Responsável pela validação: Alice. Quem pagou: Bob!
    const createRes = await createSharedExpense(
      'space_segregation',
      {
        spaceId: 'space_segregation',
        title: 'Supermercado Mensal Pela República',
        totalOriginalAmountCents: 30000,
        competenceMonth: '2026-11',
        competenceDate: '2026-11-10',
        categoryId: 'cat_mercado',
        categoryName: 'Alimentação',
        createdByUid: 'alice_validadora',
        responsibleUid: 'alice_validadora', // Autoridade de validação
        payerUid: 'bob_credor',             // Quem desembolsou os fundos ao fornecedor
        splitMethod: 'equal',
        participants: [
          { uid: 'alice_validadora', name: 'Alice' },
          { uid: 'bob_credor', name: 'Bob' },
          { uid: 'charlie_devedor', name: 'Charlie' },
        ],
      },
      true
    );

    const expId = createRes.expense.id;
    assert.equal(createRes.expense.responsibleUid, 'alice_validadora');
    assert.equal(createRes.expense.payerUid, 'bob_credor');

    // Charlie declara o pagamento de R$ 100,00
    const charlieDecl = await declareExpensePayment(
      {
        spaceId: 'space_segregation',
        expenseId: expId,
        memberUid: 'charlie_devedor',
        memberName: 'Charlie',
        amountCents: 10000,
        paymentDate: '2026-11-11',
        paymentMethod: 'pix',
      },
      true
    );

    // Alice (responsável pela validação) aprova o pagamento
    // O crédito DEVE ir para a conta de Bob (beneficiário), e não de Alice!
    const apprRes = await approveExpensePayment(
      {
        spaceId: 'space_segregation',
        expenseId: expId,
        declarationId: charlieDecl.id,
        approverUid: 'alice_validadora',
        destinationAccountId: bobAcc.id,
      },
      true
    );

    assert.equal(apprRes.approval.approverUid, 'alice_validadora');
    assert.equal(apprRes.approval.responsibleUid, 'alice_validadora');
    assert.equal(apprRes.approval.beneficiaryUid, 'bob_credor');
    assert.ok(apprRes.movement);
    assert.equal(apprRes.movement?.userId, 'bob_credor'); // Creditado no financeiro de Bob!
    assert.equal(apprRes.movement?.authorUid, 'alice_validadora'); // Aprovado por Alice!
    assert.equal(apprRes.movement?.amountCents, 10000);

    // Valida saldos bancários: Bob recebeu R$ 100,00; Alice permaneceu com 0
    const bobAccs = await getUserAccounts('bob_credor', false, true);
    const bobUpdated = bobAccs.find((a) => a.id === bobAcc.id)!;
    assert.equal(bobUpdated.projectedBalanceCents, 10000);

    const aliceAccs = await getUserAccounts('alice_validadora', false, true);
    const aliceUpdated = aliceAccs.find((a) => a.id === aliceAcc.id)!;
    assert.equal(aliceUpdated.projectedBalanceCents, 0);
  });

  // ----------------------------------------------------------------------------
  // 13. PRESERVAÇÃO DE originalAmountCents E NOTA DE CRÉDITO EM DEVOLUÇÃO
  // ----------------------------------------------------------------------------
  await t.test('16. Devolução de fornecedor preserva originalAmountCents e gera creditNoteCents para quem já pagou', async () => {
    // Cria despesa de R$ 300,00 dividida entre Alice, Bob e Charlie (R$ 100,00 cada)
    const createRes = await createSharedExpense(
      'space_refund_note',
      {
        spaceId: 'space_refund_note',
        title: 'Móveis para Sala Compartilhada',
        totalOriginalAmountCents: 30000,
        competenceMonth: '2026-11',
        competenceDate: '2026-11-10',
        categoryId: 'cat_moveis',
        categoryName: 'Casa',
        createdByUid: 'alice_uid',
        responsibleUid: 'alice_uid',
        payerUid: 'alice_uid',
        splitMethod: 'equal',
        participants: [
          { uid: 'alice_uid', name: 'Alice' },
          { uid: 'bob_uid', name: 'Bob' },
          { uid: 'charlie_uid', name: 'Charlie' },
        ],
      },
      true
    );
    const expId = createRes.expense.id;

    // Bob declara e paga R$ 100,00 integralmente
    const bobDecl = await declareExpensePayment(
      {
        spaceId: 'space_refund_note',
        expenseId: expId,
        memberUid: 'bob_uid',
        memberName: 'Bob',
        amountCents: 10000,
        paymentDate: '2026-11-11',
        paymentMethod: 'pix',
      },
      true
    );

    await approveExpensePayment(
      {
        spaceId: 'space_refund_note',
        expenseId: expId,
        declarationId: bobDecl.id,
        approverUid: 'alice_uid',
      },
      true
    );

    // Agora a loja devolve R$ 60,00 (R$ 20,00 por participante)
    await recordSupplierRefund(
      {
        spaceId: 'space_refund_note',
        expenseId: expId,
        refundType: 'partial_refund',
        amountRefundedCents: 6000,
        recipientUid: 'alice_uid',
        date: '2026-11-12',
        justification: 'Devolução de mesa com defeito',
      },
      true
    );

    const liabs = await getExpenseLiabilities('space_refund_note', expId, true);
    const bobLiab = liabs.find((l) => l.memberUid === 'bob_uid')!;
    const charlieLiab = liabs.find((l) => l.memberUid === 'charlie_uid')!;

    // Regra Obrigatória: originalAmountCents e assignedShareAmountCents INTACTOS em R$ 100,00 (10000 centavos)
    assert.equal(bobLiab.originalAmountCents, 10000);
    assert.equal(bobLiab.assignedShareAmountCents, 10000);
    assert.equal(bobLiab.refundAdjustmentCents, 2000);
    assert.equal(bobLiab.adjustedShareAmountCents, 8000);
    // Bob pagou 10000, a nova cota é 8000 -> remaining = 0 e crédito a restituir = 2000 (R$ 20,00)
    assert.equal(bobLiab.paidAmountCents, 10000);
    assert.equal(bobLiab.remainingAmountCents, 0);
    assert.equal(bobLiab.creditNoteCents, 2000);

    // Charlie não havia pago ainda:
    assert.equal(charlieLiab.originalAmountCents, 10000);
    assert.equal(charlieLiab.assignedShareAmountCents, 10000);
    assert.equal(charlieLiab.refundAdjustmentCents, 2000);
    assert.equal(charlieLiab.adjustedShareAmountCents, 8000);
    assert.equal(charlieLiab.remainingAmountCents, 8000);
    assert.equal(charlieLiab.creditNoteCents, 0);
  });

  // ----------------------------------------------------------------------------
  // 14. IMUTABILIDADE DA DECLARAÇÃO E EVENTOS INDEPENDENTES DE REJEIÇÃO
  // ----------------------------------------------------------------------------
  await t.test('17. Declaração original é append-only imutável; rejeição gera evento em payment_rejections', async () => {
    const createRes = await createSharedExpense(
      'space_immutable',
      {
        spaceId: 'space_immutable',
        title: 'Manutenção Hidráulica',
        totalOriginalAmountCents: 10000,
        competenceMonth: '2026-11',
        competenceDate: '2026-11-10',
        categoryId: 'cat_manutencao',
        categoryName: 'Casa',
        createdByUid: 'alice_uid',
        responsibleUid: 'alice_uid',
        payerUid: 'alice_uid',
        splitMethod: 'equal',
        participants: [
          { uid: 'alice_uid', name: 'Alice' },
          { uid: 'bob_uid', name: 'Bob' },
        ],
      },
      true
    );
    const expId = createRes.expense.id;

    // Bob declara pagamento de R$ 50,00
    const decl = await declareExpensePayment(
      {
        spaceId: 'space_immutable',
        expenseId: expId,
        memberUid: 'bob_uid',
        memberName: 'Bob',
        amountCents: 5000,
        paymentDate: '2026-11-11',
        paymentMethod: 'pix',
      },
      true
    );

    // Alice rejeita o pagamento com justificativa
    const rejRes = await rejectExpensePayment(
      {
        spaceId: 'space_immutable',
        expenseId: expId,
        declarationId: decl.id,
        rejecterUid: 'alice_uid',
        rejectionReason: 'Comprovante ilegível e sem autenticação bancária',
      },
      true
    );

    assert.ok(rejRes.rejection);
    assert.equal(rejRes.rejection?.declarationId, decl.id);
    assert.equal(rejRes.rejection?.reason, 'Comprovante ilegível e sem autenticação bancária');
    assert.equal(rejRes.rejection?.rejectedByUid, 'alice_uid');

    // Verifica que no armazenamento bruto de declarações o documento NÃO foi mutado!
    const rawDecls = loadDemoPaymentDeclarations();
    const storedDecl = rawDecls.find((d) => d.id === decl.id)!;
    assert.equal(storedDecl.status, 'pending_validation', 'Documento original bruto não deve ser alterado');

    // Verifica que a rejeição foi persistida na coleção de rejeições
    const rawRejections = loadDemoPaymentRejections();
    assert.ok(rawRejections.length >= 1);
    assert.ok(rawRejections.some((r) => r.declarationId === decl.id));

    // A consulta oficial (getExpensePaymentDeclarations) deriva o status a partir do histórico de eventos
    const queriedDecls = await getExpensePaymentDeclarations('space_immutable', expId, true);
    const queriedBobDecl = queriedDecls.find((d) => d.id === decl.id)!;
    assert.equal(queriedBobDecl.status, 'rejected');
    assert.equal(queriedBobDecl.rejectionReason, 'Comprovante ilegível e sem autenticação bancária');
  });

  // ----------------------------------------------------------------------------
  // 15. CENÁRIO 5: PAGAMENTO PARCIAL ANTERIOR + REVOGAÇÃO DO SEGUNDO PAGAMENTO
  // ----------------------------------------------------------------------------
  await t.test('18. Cenário 5 (Pagamento parcial anterior): Cota de R$ 100,00 com pagamentos de R$ 30,00 e R$ 70,00; revogar R$ 70,00 preserva os R$ 30,00 pagos', async () => {
    const createRes = await createSharedExpense(
      'space_partial_revoc',
      {
        spaceId: 'space_partial_revoc',
        title: 'Internet Fibra Anual',
        totalOriginalAmountCents: 20000, // R$ 100,00 para cada
        competenceMonth: '2026-11',
        competenceDate: '2026-11-10',
        categoryId: 'cat_net',
        categoryName: 'Internet',
        createdByUid: 'alice_uid',
        responsibleUid: 'alice_uid',
        payerUid: 'alice_uid',
        splitMethod: 'equal',
        participants: [
          { uid: 'alice_uid', name: 'Alice' },
          { uid: 'bob_uid', name: 'Bob' },
        ],
      },
      true
    );
    const expId = createRes.expense.id;

    // 1º pagamento parcial de R$ 30,00 (3000 centavos)
    const decl1 = await declareExpensePayment(
      {
        spaceId: 'space_partial_revoc',
        expenseId: expId,
        memberUid: 'bob_uid',
        memberName: 'Bob',
        amountCents: 3000,
        paymentDate: '2026-11-11',
        paymentMethod: 'pix',
        idempotencyKey: 'decl_bob_part_30',
      },
      true
    );
    const appr1 = await approveExpensePayment(
      {
        spaceId: 'space_partial_revoc',
        expenseId: expId,
        declarationId: decl1.id,
        approverUid: 'alice_uid',
      },
      true
    );
    assert.equal(appr1.liability.paidAmountCents, 3000);
    assert.equal(appr1.liability.remainingAmountCents, 7000);
    assert.equal(appr1.liability.status, 'partially_paid');

    // 2º pagamento de R$ 70,00 (7000 centavos)
    const decl2 = await declareExpensePayment(
      {
        spaceId: 'space_partial_revoc',
        expenseId: expId,
        memberUid: 'bob_uid',
        memberName: 'Bob',
        amountCents: 7000,
        paymentDate: '2026-11-12',
        paymentMethod: 'pix',
        idempotencyKey: 'decl_bob_part_70',
      },
      true
    );
    const appr2 = await approveExpensePayment(
      {
        spaceId: 'space_partial_revoc',
        expenseId: expId,
        declarationId: decl2.id,
        approverUid: 'alice_uid',
      },
      true
    );
    assert.equal(appr2.liability.paidAmountCents, 10000);
    assert.equal(appr2.liability.remainingAmountCents, 0);
    assert.equal(appr2.liability.status, 'paid');

    // Revoga apenas a aprovação de R$ 70,00
    const revocRes = await revokeExpensePaymentApproval(
      {
        spaceId: 'space_partial_revoc',
        expenseId: expId,
        approvalId: appr2.approval.id,
        revokerUid: 'alice_uid',
        reason: 'Segundo comprovante Pix foi agendado e cancelado',
      },
      true
    );

    // R$ 30,00 permanece reconhecido! Saldo restante volta para R$ 70,00!
    assert.equal(revocRes.liability.paidAmountCents, 3000);
    assert.equal(revocRes.liability.remainingAmountCents, 7000);
    assert.equal(revocRes.liability.status, 'partially_paid');
  });

  // ----------------------------------------------------------------------------
  // 16. CENÁRIO 6 & 8: REEMBOLSO DE FORNECEDOR + REVOGAÇÃO E DINHEIRO JÁ UTILIZADO
  // ----------------------------------------------------------------------------
  await t.test('19. Cenários 6 e 8: Reembolso de fornecedor + Revogação preserva ajustes e sinaliza restituição quando saldo já foi utilizado', async () => {
    const bobCreditorAcc = await createAccount('bob_credor_c8', { name: 'Conta Bob C8', type: 'checking' }, true);

    const createRes = await createSharedExpense(
      'space_c6_c8',
      {
        spaceId: 'space_c6_c8',
        title: 'Equipamento de Som',
        totalOriginalAmountCents: 20000, // R$ 100,00 cada
        competenceMonth: '2026-11',
        competenceDate: '2026-11-10',
        categoryId: 'cat_lazer',
        categoryName: 'Lazer',
        createdByUid: 'alice_uid',
        responsibleUid: 'alice_uid',
        payerUid: 'bob_credor_c8',
        splitMethod: 'equal',
        participants: [
          { uid: 'alice_uid', name: 'Alice' },
          { uid: 'bob_credor_c8', name: 'Bob' },
        ],
      },
      true
    );
    const expId = createRes.expense.id;

    // Fornecedor devolve R$ 40,00 total -> R$ 20,00 de redução para cada (cota líquida = R$ 80,00)
    await recordSupplierRefund(
      {
        spaceId: 'space_c6_c8',
        expenseId: expId,
        refundType: 'partial_refund',
        amountRefundedCents: 4000,
        recipientUid: 'bob_credor_c8',
        date: '2026-11-11',
        justification: 'Desconto por avaria na caixa',
      },
      true
    );

    // Alice declara e aprova o pagamento da cota líquida de R$ 80,00 (8000 centavos)
    const aliceDecl = await declareExpensePayment(
      {
        spaceId: 'space_c6_c8',
        expenseId: expId,
        memberUid: 'alice_uid',
        memberName: 'Alice',
        amountCents: 8000,
        paymentDate: '2026-11-12',
        paymentMethod: 'pix',
      },
      true
    );

    const appr = await approveExpensePayment(
      {
        spaceId: 'space_c6_c8',
        expenseId: expId,
        declarationId: aliceDecl.id,
        approverUid: 'alice_uid',
        destinationAccountId: bobCreditorAcc.id,
      },
      true
    );
    assert.equal(appr.liability.paidAmountCents, 8000);
    assert.equal(appr.liability.remainingAmountCents, 0);

    // CENÁRIO 8: Bob utiliza R$ 60,00 do saldo da conta (restando apenas R$ 20,00 na conta)
    const { recordMovement } = await import('./ledgerService');
    await recordMovement(
      {
        accountId: bobCreditorAcc.id,
        userId: 'bob_credor_c8',
        direction: 'outflow',
        amountCents: 6000,
        effectiveDate: '2026-11-12',
        originType: 'personal_expense',
        originId: 'tx_personal_bob_spend',
        description: 'Gasto pessoal de Bob utilizando o saldo',
        authorUid: 'bob_credor_c8',
        idempotencyKey: 'idem_bob_spend_6000',
      },
      true
    );

    // Agora Alice revoga a aprovação de R$ 80,00
    const revoc = await revokeExpensePaymentApproval(
      {
        spaceId: 'space_c6_c8',
        expenseId: expId,
        approvalId: appr.approval.id,
        revokerUid: 'alice_uid',
        reason: 'Estorno do pagamento de R$ 80,00',
      },
      true
    );

    // Verifica Cenário 6: restauração respeita a cota líquida ajustada (R$ 80,00) e preserva originalAmountCents (R$ 100,00) e refundAdjustmentCents (R$ 20,00)
    assert.equal(revoc.liability.originalAmountCents, 10000);
    assert.equal(revoc.liability.assignedShareAmountCents, 10000);
    assert.equal(revoc.liability.refundAdjustmentCents, 2000);
    assert.equal(revoc.liability.adjustedShareAmountCents, 8000);
    assert.equal(revoc.liability.paidAmountCents, 0);
    assert.equal(revoc.liability.remainingAmountCents, 8000);
    assert.equal(revoc.liability.creditNoteCents, 0);
    assert.equal(revoc.liability.status, 'pending');

    // Verifica Cenário 8: como Bob tinha apenas R$ 20,00 (2000) quando ocorreu o estorno de R$ 80,00 (8000),
    // requiresRestitution é true e restitutionPendingCents é 6000 (R$ 60,00)
    assert.equal(revoc.revocation.requiresRestitution, true);
    assert.equal(revoc.revocation.restitutionPendingCents, 6000);
    assert.ok(revoc.compensatoryMovement?.description.includes('Estorno contábil'));

    // Verifica Cenário 3: Repetição idempotente retorna o mesmo resultado, mas payload divergente falha
    const replay = await revokeExpensePaymentApproval(
      {
        spaceId: 'space_c6_c8',
        expenseId: expId,
        approvalId: appr.approval.id,
        revokerUid: 'alice_uid',
        reason: 'Estorno do pagamento de R$ 80,00',
      },
      true
    );
    assert.equal(replay.revocation.id, revoc.revocation.id);

    await assert.rejects(
      async () =>
        revokeExpensePaymentApproval(
          {
            spaceId: 'space_c6_c8',
            expenseId: expId,
            approvalId: appr.approval.id,
            revokerUid: 'alice_uid',
            reason: 'Motivo divergente na segunda tentativa',
          },
          true
        ),
      /Conflito de idempotência/
    );
  });
});
