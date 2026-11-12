import test from 'node:test';
import assert from 'node:assert/strict';
import { universalStorage } from '../utils/universalStorage';
import { createAccount } from './accountService';
import {
  confirmCustodyReceipt,
  createCustodyTransfer,
  declareCustodyReturn,
  confirmCustodyReturnReceipt,
  getCustodyReturns,
  getSpaceCustodyBalances,
  getSpaceCustodyTransfers,
  getUserCustodyTransfers,
  returnCustodyFunds,
  useCustodyFundsInExpense,
} from './custodyService';
import { getAccountMovements } from './ledgerService';

test('FASE 7 — Transferências sob Custódia e Adiantamentos entre Participantes (v3.1)', async (t) => {
  universalStorage.clear();

  const aliceUid = 'usr_alice_phase7';
  const bobUid = 'usr_bob_phase7';
  const spaceId = 'space_home_phase7';

  // Contas de Alice
  const aliceChecking = await createAccount(
    aliceUid,
    { name: 'Conta Corrente Alice', type: 'checking' },
    true
  );
  // Conta de Bob
  const bobChecking = await createAccount(
    bobUid,
    { name: 'Conta Corrente Bob', type: 'checking' },
    true
  );

  await t.test('1. Alice transfere R$ 200,00 sob custódia de Bob: debita Alice e cria transferência em pending_receipt', async () => {
    const res = await createCustodyTransfer(
      aliceUid,
      {
        spaceId,
        custodianUid: bobUid,
        initialAmountCents: 20000,
        sourceAccountId: aliceChecking.id,
        description: 'Adiantamento compras de mercado',
        notes: 'Para cobrir feira da semana',
        transferDate: '2026-11-12',
        idempotencyKey: 'idem_alice_bob_200',
      },
      true
    );

    assert.equal(res.transfer.initialAmountCents, 20000);
    assert.equal(res.transfer.availableBalanceCents, 0, 'Saldo deve permanecer 0 até confirmação de Bob');
    assert.equal(res.transfer.custodyStatus, 'pending_receipt');
    assert.equal(res.isIdempotentReplay, false);

    // Movimento de saída na conta de Alice
    const aliceMovs = await getAccountMovements(aliceChecking.id, aliceUid, true);
    assert.equal(aliceMovs.length, 1);
    assert.equal(aliceMovs[0].direction, 'outflow');
    assert.equal(aliceMovs[0].amountCents, 20000);
    assert.equal(aliceMovs[0].originType, 'custody_transfer_out');
  });

  await t.test('2. Idempotência estrita: reenvio da mesma transferência não duplica movimentos', async () => {
    const res = await createCustodyTransfer(
      aliceUid,
      {
        spaceId,
        custodianUid: bobUid,
        initialAmountCents: 20000,
        sourceAccountId: aliceChecking.id,
        description: 'Adiantamento compras de mercado',
        notes: 'Para cobrir feira da semana',
        transferDate: '2026-11-12',
        idempotencyKey: 'idem_alice_bob_200',
      },
      true
    );

    assert.equal(res.isIdempotentReplay, true);
    const aliceMovs = await getAccountMovements(aliceChecking.id, aliceUid, true);
    assert.equal(aliceMovs.length, 1, 'Não deve gerar segundo movimento');
  });

  await t.test('3. Bloqueios de validação: mesmo participante ou conta de cartão', async () => {
    await assert.rejects(
      async () => {
        await createCustodyTransfer(
          aliceUid,
          {
            custodianUid: aliceUid,
            initialAmountCents: 5000,
            sourceAccountId: aliceChecking.id,
          },
          true
        );
      },
      /distinto do remetente/
    );

    const aliceCard = await createAccount(
      aliceUid,
      { name: 'Cartão Alice', type: 'credit', creditLimitCents: 100000 },
      true
    );

    await assert.rejects(
      async () => {
        await createCustodyTransfer(
          aliceUid,
          {
            custodianUid: bobUid,
            initialAmountCents: 5000,
            sourceAccountId: aliceCard.id,
          },
          true
        );
      },
      /cartão de crédito/
    );
  });

  let transferId = '';

  await t.test('4. Bob confirma o recebimento dos R$ 200,00: credita a conta de Bob e libera availableBalanceCents', async () => {
    const transfers = await getSpaceCustodyTransfers(spaceId, true);
    transferId = transfers[0].id;

    // Tentativa ilegítima por Alice deve falhar
    await assert.rejects(
      async () => {
        await confirmCustodyReceipt(
          aliceUid,
          {
            transferId,
            destinationAccountId: aliceChecking.id,
          },
          true
        );
      },
      /Somente o custodiante legítimo/
    );

    const confRes = await confirmCustodyReceipt(
      bobUid,
      {
        transferId,
        destinationAccountId: bobChecking.id,
        notes: 'Confirmado no extrato Itaú',
        idempotencyKey: 'idem_conf_bob_200',
      },
      true
    );

    assert.equal(confRes.transfer.custodyStatus, 'available');
    assert.equal(confRes.transfer.availableBalanceCents, 20000);
    assert.equal(confRes.destinationMovement.direction, 'inflow');
    assert.equal(confRes.destinationMovement.amountCents, 20000);
    assert.equal(confRes.destinationMovement.originType, 'custody_transfer_in');

    const bobMovs = await getAccountMovements(bobChecking.id, bobUid, true);
    assert.equal(bobMovs.length, 1);
    assert.equal(bobMovs[0].amountCents, 20000);
  });

  await t.test('5. Bob utiliza R$ 120,00 da custódia para cobrir despesa compartilhada: status partially_used', async () => {
    const useRes = await useCustodyFundsInExpense(
      bobUid,
      {
        transferId,
        expenseId: 'exp_mercado_120',
        amountCents: 12000,
        notes: 'Compras de hortifruti e açougue',
        idempotencyKey: 'idem_use_120',
      },
      true
    );

    assert.equal(useRes.transfer.usedAmountCents, 12000);
    assert.equal(useRes.transfer.availableBalanceCents, 8000);
    assert.equal(useRes.transfer.custodyStatus, 'partially_used');

    // Movimentações bancárias de Bob não devem sofrer alteração adicional pelo uso
    const bobMovs = await getAccountMovements(bobChecking.id, bobUid, true);
    assert.equal(bobMovs.length, 1, 'Uso da custódia abate o contrato, sem duplicar movimento contábil');
  });

  await t.test('6. Tentativa de usar valor superior ao saldo disponível é bloqueada', async () => {
    await assert.rejects(
      async () => {
        await useCustodyFundsInExpense(
          bobUid,
          {
            transferId,
            expenseId: 'exp_extra',
            amountCents: 9000, // Saldo restante é 8000
          },
          true
        );
      },
      /excede o saldo disponível/
    );
  });

  await t.test('7. Bob devolve os R$ 80,00 restantes para Alice: débito em Bob, crédito em Alice e status settled_by_mixed', async () => {
    const retRes = await returnCustodyFunds(
      bobUid,
      {
        transferId,
        sourceAccountId: bobChecking.id,
        destinationAccountId: aliceChecking.id,
        amountCents: 8000,
        justification: 'Saldo não utilizado devolvido integralmente',
        idempotencyKey: 'idem_ret_80',
      },
      true
    );

    assert.equal(retRes.transfer.returnedAmountCents, 8000);
    assert.equal(retRes.transfer.availableBalanceCents, 0);
    assert.equal(retRes.transfer.custodyStatus, 'settled_by_mixed'); // 120 usado + 80 devolvido = 200 liquidado

    // Verifica movimentos contábeis
    assert.equal(retRes.sourceMovement.direction, 'outflow');
    assert.equal(retRes.sourceMovement.originType, 'custody_return_out');
    assert.equal(retRes.sourceMovement.amountCents, 8000);

    assert.equal(retRes.destinationMovement.direction, 'inflow');
    assert.equal(retRes.destinationMovement.originType, 'custody_return_in');
    assert.equal(retRes.destinationMovement.amountCents, 8000);

    const aliceMovs = await getAccountMovements(aliceChecking.id, aliceUid, true);
    assert.equal(aliceMovs.length, 2, 'Alice tem saída de 200 e retorno de 80');

    const bobMovs = await getAccountMovements(bobChecking.id, bobUid, true);
    assert.equal(bobMovs.length, 2, 'Bob tem entrada de 200 e saída de 80');
  });

  await t.test('8. Balanço consolidado de custódia do espaço reflete liquidação integral', async () => {
    const balances = await getSpaceCustodyBalances(spaceId, true);
    assert.equal(balances.length, 1);
    assert.equal(balances[0].senderUid, aliceUid);
    assert.equal(balances[0].custodianUid, bobUid);
    assert.equal(balances[0].totalInitialCents, 20000);
    assert.equal(balances[0].totalUsedCents, 12000);
    assert.equal(balances[0].totalReturnedCents, 8000);
    assert.equal(balances[0].availableBalanceCents, 0);
  });

  await t.test('9. Devolução de custódia em 2 etapas: Bob declara devolução (reserva saldo) e Alice confirma recebimento (liquida e credita Alice)', async () => {
    // Nova transferência de Alice para Bob de R$ 100,00
    const trRes = await createCustodyTransfer(
      aliceUid,
      {
        spaceId,
        custodianUid: bobUid,
        initialAmountCents: 10000,
        sourceAccountId: aliceChecking.id,
        description: 'Adiantamento 2 etapas',
        transferDate: '2026-11-12',
        idempotencyKey: 'idem_xfer_2step',
      },
      true
    );

    const confRes = await confirmCustodyReceipt(
      bobUid,
      {
        transferId: trRes.transfer.id,
        destinationAccountId: bobChecking.id,
        idempotencyKey: 'idem_conf_2step',
      },
      true
    );

    // Saldo inicial de Bob antes da devolução
    const bobMovsBefore = await getAccountMovements(bobChecking.id, bobUid, true);
    const bobCountBefore = bobMovsBefore.length;

    // 1. Bob declara devolução de R$ 60,00
    const declRes = await declareCustodyReturn(
      bobUid,
      {
        transferId: trRes.transfer.id,
        sourceAccountId: bobChecking.id,
        amountCents: 6000,
        justification: 'Devolvendo sobra via Pix',
        idempotencyKey: 'idem_decl_ret_60',
      },
      true
    );

    assert.equal(declRes.transfer.availableBalanceCents, 4000);
    assert.equal(declRes.transfer.reservedForReturnCents, 6000);
    assert.equal(declRes.transfer.custodyStatus, 'return_pending_confirmation');
    assert.equal(declRes.returnRecord.status, 'pending_confirmation');
    assert.equal(declRes.returnRecord.amountCents, 6000);

    // Contas bancárias ainda não foram movimentadas na declaração
    const bobMovsAfterDecl = await getAccountMovements(bobChecking.id, bobUid, true);
    assert.equal(bobMovsAfterDecl.length, bobCountBefore, 'Não gera movimento bancário antes da confirmação');

    // Replay idempotente na declaração
    const replayDecl = await declareCustodyReturn(
      bobUid,
      {
        transferId: trRes.transfer.id,
        sourceAccountId: bobChecking.id,
        amountCents: 6000,
        justification: 'Devolvendo sobra via Pix',
        idempotencyKey: 'idem_decl_ret_60',
      },
      true
    );
    assert.equal(replayDecl.isIdempotentReplay, true);
    assert.equal(replayDecl.returnRecord.id, declRes.returnRecord.id);

    // 2. Alice confirma o recebimento dos R$ 60,00
    const confRetRes = await confirmCustodyReturnReceipt(
      aliceUid,
      {
        transferId: trRes.transfer.id,
        returnId: declRes.returnRecord.id,
        destinationAccountId: aliceChecking.id,
        notes: 'Confirmado na minha conta corrente',
        idempotencyKey: 'idem_conf_ret_60',
      },
      true
    );

    assert.equal(confRetRes.transfer.availableBalanceCents, 4000);
    assert.equal(confRetRes.transfer.reservedForReturnCents, 0);
    assert.equal(confRetRes.transfer.returnedAmountCents, 6000);
    assert.equal(confRetRes.transfer.custodyStatus, 'partial_return_confirmed');
    assert.equal(confRetRes.returnRecord.status, 'confirmed');

    // Movimentações bancárias geradas
    assert.ok(confRetRes.sourceMovement);
    assert.equal(confRetRes.sourceMovement?.direction, 'outflow');
    assert.equal(confRetRes.sourceMovement?.amountCents, 6000);
    assert.equal(confRetRes.sourceMovement?.originType, 'custody_return_out');

    assert.ok(confRetRes.destinationMovement);
    assert.equal(confRetRes.destinationMovement?.direction, 'inflow');
    assert.equal(confRetRes.destinationMovement?.amountCents, 6000);
    assert.equal(confRetRes.destinationMovement?.originType, 'custody_return_in');

    // Listagem de devoluções
    const returnsList = await getCustodyReturns(trRes.transfer.id, true);
    assert.equal(returnsList.length, 1);
    assert.equal(returnsList[0].id, declRes.returnRecord.id);
    assert.equal(returnsList[0].status, 'confirmed');
  });
});
