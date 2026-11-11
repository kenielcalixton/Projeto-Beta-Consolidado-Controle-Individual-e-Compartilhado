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
  loadDemoSharedLiabilities,
  recordSupplierRefund,
  rejectExpensePayment,
  revokeExpensePaymentApproval,
  saveDemoApprovalRevocations,
  saveDemoPaymentApprovals,
  saveDemoPaymentDeclarations,
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
    assert.equal(approvalResult.approval.isRevoked, false);
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
  // 9. HISTÓRICO IMUTÁVEL E REVOGAÇÃO DE APROVAÇÃO
  // ----------------------------------------------------------------------------
  await t.test('12. Revogação de aprovação: gera evento compensatório, estorna movimento contábil e restaura saldo devedor', async () => {
    const approvals = loadDemoPaymentApprovals();
    const bobApproval = approvals.find((a) => a.memberUid === 'bob_uid')!;

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

    const accs = await getUserAccounts('alice_uid', false, true);
    const aliceAcc = accs.find((a) => a.id === bobApproval.destinationAccountId)!;
    assert.equal(aliceAcc.projectedBalanceCents, 0);

    // Aprovação original foi marcada como revogada sem apagar documento
    const reloadedApprovals = loadDemoPaymentApprovals();
    const reloadedBobAppr = reloadedApprovals.find((a) => a.id === bobApproval.id)!;
    assert.equal(reloadedBobAppr.isRevoked, true);
    assert.ok(reloadedBobAppr.revokedAt);
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
});
