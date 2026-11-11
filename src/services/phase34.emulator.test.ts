import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import { LOCAL_EMULATOR_PROJECT_ID } from '../config/environment';
import {
  archiveAccount,
  createAccount,
  getAccountById,
} from './accountService';
import {
  getAccountMovements,
  reconcileAndSyncAccountBalance,
  recordMovement,
  reverseMovement,
} from './ledgerService';
import {
  executeInternalTransfer,
  getUserTransfers,
} from './transferService';
import {
  attachPurchaseToInvoice,
  calculateCardAvailableLimit,
  carryOverInvoiceBalance,
  payCardInvoice,
} from './creditCardService';
import {
  cancelPersonalTransaction,
  createPersonalTransaction,
  getPersonalTransactionPayments,
  getPersonalTransactionPaymentReversals,
  getUserPersonalTransactions,
  recordPartialPayment,
} from './personalTransactionService';
import {
  createPersonalBudget,
  getUserBudgetsWithProgress,
} from './budgetService';
import {
  createPersonalRefund,
  getRefundReceipts,
  recordRefundReceipt,
} from './refundService';

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

async function createAndLoginUser(
  email: string,
  password: string
): Promise<string> {
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    return cred.user.uid;
  } catch {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    return cred.user.uid;
  }
}

test('INTEGRAÇÃO REAL FASES 3 E 4 — Cloud Functions + Admin SDK + Firestore Rules + Concorrência (isDemo = false)', async (t) => {
  await clearEmulatorsData();

  await t.test('11.1 Segurança: bloqueio de não autenticado, isolamento entre usuários, imutabilidade client-side e conta arquivada', async () => {
    await signOut(auth);

    // 1. Usuário não autenticado é bloqueado em chamadas de backend
    await assert.rejects(
      async () => {
        await recordMovement(
          {
            accountId: 'acc_unauth',
            userId: 'fake_uid',
            direction: 'inflow',
            amountCents: 1000,
            originType: 'adhoc_receipt',
            originId: 'ref_1',
            description: 'Tentativa sem login',
            effectiveDate: '2026-04-10',
            authorUid: 'fake_uid',
            idempotencyKey: 'idem_unauth_1',
          },
          false
        );
      },
      /Autenticação|autenticado|unauthenticated/i
    );

    // Cria Usuário A e Usuário B no Auth Emulator
    const userAUid = await createAndLoginUser('user.a.f34@emulator.local', 'Senha@123');
    const accA = await createAccount(
      userAUid,
      { name: 'Conta Corrente User A', type: 'checking' },
      false
    );
    assert.equal(accA.projectedBalanceCents, 0);

    // Cliente A não pode alterar projectedBalanceCents diretamente no Firestore
    await assert.rejects(async () => {
      await updateDoc(doc(db, 'accounts', accA.id), {
        projectedBalanceCents: 999999,
      });
    });

    // Cliente A não pode escrever movimento contábil diretamente no Firestore
    await assert.rejects(async () => {
      await setDoc(doc(db, 'accounts', accA.id, 'movements', 'mov_direct_hack'), {
        id: 'mov_direct_hack',
        accountId: accA.id,
        userId: userAUid,
        direction: 'inflow',
        amountCents: 500000,
      });
    });

    // Troca para Usuário B
    const userBUid = await createAndLoginUser('user.b.f34@emulator.local', 'Senha@123');
    assert.notEqual(userAUid, userBUid);

    // Usuário B não consegue operar na conta de Usuário A via Cloud Functions
    await assert.rejects(
      async () => {
        await recordMovement(
          {
            accountId: accA.id,
            userId: userAUid,
            direction: 'inflow',
            amountCents: 10000,
            originType: 'adhoc_receipt',
            originId: 'ref_cross_user',
            description: 'Invasão na conta de A',
            effectiveDate: '2026-04-10',
            authorUid: userBUid,
            idempotencyKey: 'idem_cross_user_1',
          },
          false
        );
      },
      /Acesso negado|Permissão negada|permission-denied|não pertence/i
    );

    // Volta para Usuário A, registra movimento válido, arquiva conta e verifica bloqueio de novos movimentos e reversões
    await createAndLoginUser('user.a.f34@emulator.local', 'Senha@123');
    const validMov = await recordMovement(
      {
        accountId: accA.id,
        userId: userAUid,
        direction: 'inflow',
        amountCents: 25000,
        originType: 'adhoc_receipt',
        originId: 'ref_valid_a',
        description: 'Depósito inicial válido',
        effectiveDate: '2026-04-10',
        authorUid: userAUid,
        idempotencyKey: 'idem_valid_a_1',
      },
      false
    );
    assert.equal(validMov.amountCents, 25000);

    await archiveAccount(accA.id, userAUid, true, false);

    // Conta arquivada rejeita novo movimento
    await assert.rejects(
      async () => {
        await recordMovement(
          {
            accountId: accA.id,
            userId: userAUid,
            direction: 'outflow',
            amountCents: 5000,
            originType: 'personal_expense',
            originId: 'ref_archived',
            description: 'Tentativa em conta arquivada',
            effectiveDate: '2026-04-11',
            authorUid: userAUid,
            idempotencyKey: 'idem_archived_mov',
          },
          false
        );
      },
      /arquivada/i
    );

    // Conta arquivada rejeita reversão
    await assert.rejects(
      async () => {
        await reverseMovement(
          accA.id,
          validMov.id,
          userAUid,
          'Tentativa de estorno em conta arquivada',
          false
        );
      },
      /arquivada/i
    );

    // Desarquiva para uso futuro se necessário
    await archiveAccount(accA.id, userAUid, false, false);
  });

  await t.test('11.2 Concorrência Real e Resiliência Transacional (Promise.all no Emulator)', async (t2) => {
    await clearEmulatorsData();
    const uid = await createAndLoginUser('concurrency@emulator.local', 'Senha@123');

    const acc1 = await createAccount(uid, { name: 'Conta Principal', type: 'checking' }, false);
    const acc2 = await createAccount(uid, { name: 'Conta Reserva', type: 'savings' }, false);
    const card = await createAccount(
      uid,
      {
        name: 'Cartão Black',
        type: 'credit',
        creditLimitCents: 500000,
        closingDay: 20,
        dueDay: 28,
      },
      false
    );

    // Initial funding on acc1: R$ 1.000,00
    await recordMovement(
      {
        accountId: acc1.id,
        userId: uid,
        direction: 'inflow',
        amountCents: 100000,
        originType: 'adhoc_receipt',
        originId: 'seed_conc_funding',
        description: 'Aporte Inicial Concorrência',
        effectiveDate: '2026-04-01',
        authorUid: uid,
        idempotencyKey: 'idem_seed_conc_funding',
      },
      false
    );

    await t2.test('A. Duas chamadas simultâneas da mesma transferência e mesma chave de idempotência', async () => {
      const transferResults = await Promise.all([
        executeInternalTransfer(
          uid,
          {
            sourceAccountId: acc1.id,
            destinationAccountId: acc2.id,
            amountCents: 20000, // R$ 200,00
            description: 'Transferência Concorrente Idempotente',
            transferDate: '2026-04-02',
            idempotencyKey: 'idem_conc_trf_subtest_a',
          },
          false
        ),
        executeInternalTransfer(
          uid,
          {
            sourceAccountId: acc1.id,
            destinationAccountId: acc2.id,
            amountCents: 20000,
            description: 'Transferência Concorrente Idempotente',
            transferDate: '2026-04-02',
            idempotencyKey: 'idem_conc_trf_subtest_a',
          },
          false
        ),
      ]);

      // Ambas as chamadas simultâneas retornam a mesma referência canônica da transferência
      assert.equal(transferResults[0].transfer.id, transferResults[1].transfer.id);

      // No banco de dados real: exatamente 1 registro de transferência gravado
      const allTransfers = await getUserTransfers(uid, false);
      const matched = allTransfers.filter((t) => t.idempotencyKey === 'idem_conc_trf_subtest_a');
      assert.equal(matched.length, 1);

      // Movimentos no livro-razão: exatamente 1 saída em acc1 e 1 entrada em acc2
      const movsAcc1 = await getAccountMovements(acc1.id, uid, false);
      const trfOutMovs = movsAcc1.filter((m) => m.originType === 'internal_transfer_out');
      assert.equal(trfOutMovs.length, 1);
      assert.equal(trfOutMovs[0].amountCents, 20000);

      const movsAcc2 = await getAccountMovements(acc2.id, uid, false);
      const trfInMovs = movsAcc2.filter((m) => m.originType === 'internal_transfer_in');
      assert.equal(trfInMovs.length, 1);
      assert.equal(trfInMovs[0].amountCents, 20000);

      // Saldos das contas: acc1 decrementada em R$ 200, acc2 incrementada em R$ 200
      const a1State = await getAccountById(acc1.id, uid, false);
      const a2State = await getAccountById(acc2.id, uid, false);
      assert.equal(a1State?.projectedBalanceCents, 80000);
      assert.equal(a2State?.projectedBalanceCents, 20000);
      assert.equal(
        (a1State?.projectedBalanceCents || 0) + (a2State?.projectedBalanceCents || 0),
        100000,
        'Invariância patrimonial do saldo consolidado (+V - V = 0)'
      );
    });

    await t2.test('B. Duas chamadas simultâneas de estorno do mesmo movimento', async () => {
      // Registra movimento a ser estornado
      const targetMov = await recordMovement(
        {
          accountId: acc1.id,
          userId: uid,
          direction: 'outflow',
          amountCents: 15000, // R$ 150,00
          originType: 'personal_expense',
          originId: 'conc_rev_target_b',
          description: 'Débito teste estorno concorrente',
          effectiveDate: '2026-04-03',
          authorUid: uid,
          idempotencyKey: 'idem_conc_rev_target_b',
        },
        false
      );

      // Dispara 2 chamadas simultâneas de estorno sobre o mesmo targetMov.id
      const revSettled = await Promise.allSettled([
        reverseMovement(acc1.id, targetMov.id, uid, 'Estorno Simultâneo A', false),
        reverseMovement(acc1.id, targetMov.id, uid, 'Estorno Simultâneo B', false),
      ]);

      const fulfilled = revSettled.filter((r) => r.status === 'fulfilled');
      const rejected = revSettled.filter((r) => r.status === 'rejected');
      assert.equal(fulfilled.length, 1, 'Exatamente 1 chamada concorrente deve ser efetivada');
      assert.equal(rejected.length, 1, 'A segunda chamada simultânea deve ser rejeitada');

      // Verifica no livro oficial: exatamente 1 movimento compensatório gravado
      const movs = await getAccountMovements(acc1.id, uid, false);
      const compensatories = movs.filter((m) => m.reversalOfMovementId === targetMov.id);
      assert.equal(compensatories.length, 1);
      assert.equal(compensatories[0].direction, 'inflow');
      assert.equal(compensatories[0].amountCents, 15000);

      // Saldo restaurado sem dupla anulação: 80.000 - 15.000 + 15.000 = 80.000
      const a1State = await getAccountById(acc1.id, uid, false);
      assert.equal(a1State?.projectedBalanceCents, 80000);
    });

    await t2.test('C. Dois pagamentos simultâneos da mesma obrigação (sem sobrepagamento)', async () => {
      const pendingTx = await createPersonalTransaction(
        uid,
        {
          description: 'Serviço Manutenção R$ 100,00',
          amountCents: 10000,
          type: 'expense',
          status: 'pending',
          categoryId: 'cat_servicos',
          categoryName: 'Serviços',
          accountId: acc1.id,
          competenceDate: '2026-04-05',
          idempotencyKey: 'idem_conc_pending_subtest_c',
        },
        false
      );

      // Duas chamadas simultâneas tentando pagar 60% (6.000 centavos) do saldo restante
      const partSettled = await Promise.allSettled([
        recordPartialPayment(
          pendingTx.id,
          uid,
          {
            accountId: acc1.id,
            amountCents: 6000,
            paymentDate: '2026-04-06',
            authorUid: uid,
            idempotencyKey: 'idem_conc_part_c_call1',
          },
          false
        ),
        recordPartialPayment(
          pendingTx.id,
          uid,
          {
            accountId: acc1.id,
            amountCents: 6000,
            paymentDate: '2026-04-06',
            authorUid: uid,
            idempotencyKey: 'idem_conc_part_c_call2',
          },
          false
        ),
      ]);

      const fulfilled = partSettled.filter((r) => r.status === 'fulfilled');
      const rejected = partSettled.filter((r) => r.status === 'rejected');
      assert.equal(fulfilled.length, 1, 'Apenas 1 pagamento parcial de 60% pode vencer');
      assert.equal(rejected.length, 1, 'O segundo pagamento simultâneo deve falhar por exceder o saldo devedor restante');

      const payments = await getPersonalTransactionPayments(pendingTx.id, uid, false);
      assert.equal(payments.length, 1);
      assert.equal(payments[0].amountCents, 6000);

      // Estado da transação: status partially_paid, paidAmountCents = 6.000, remaining = 4.000
      const txs = await getUserPersonalTransactions(uid, {}, false);
      const txUpdated = txs.find((t) => t.id === pendingTx.id);
      assert.equal(txUpdated?.status, 'partially_paid');
      assert.equal(txUpdated?.paidAmountCents, 6000);
      assert.equal(txUpdated?.remainingAmountCents, 4000);
    });

    await t2.test('D. Dois recebimentos simultâneos do mesmo reembolso (sem excedente)', async () => {
      const paidExpense = await createPersonalTransaction(
        uid,
        {
          description: 'Despesa Reembolsável R$ 200,00',
          amountCents: 20000,
          type: 'expense',
          status: 'paid',
          categoryId: 'cat_equip',
          categoryName: 'Equipamentos',
          accountId: acc1.id,
          competenceDate: '2026-04-07',
          paymentDate: '2026-04-07',
          idempotencyKey: 'idem_conc_exp_refund_d',
        },
        false
      );

      const refund = await createPersonalRefund(
        uid,
        {
          originalTransactionId: paidExpense.id,
          debtorName: 'Colega de Trabalho',
          description: 'Reembolso Equipamento R$ 100,00',
          amountDueCents: 10000,
          idempotencyKey: 'idem_conc_refund_d',
        },
        false
      );

      // Duas chamadas simultâneas tentando receber 70% (7.000 centavos) cada
      const recSettled = await Promise.allSettled([
        recordRefundReceipt(
          uid,
          {
            refundId: refund.id,
            destinationAccountId: acc1.id,
            amountCents: 7000,
            receiptDate: '2026-04-08',
            authorUid: uid,
            idempotencyKey: 'idem_conc_rec_d_call1',
          },
          false
        ),
        recordRefundReceipt(
          uid,
          {
            refundId: refund.id,
            destinationAccountId: acc1.id,
            amountCents: 7000,
            receiptDate: '2026-04-08',
            authorUid: uid,
            idempotencyKey: 'idem_conc_rec_d_call2',
          },
          false
        ),
      ]);

      const fulfilled = recSettled.filter((r) => r.status === 'fulfilled');
      const rejected = recSettled.filter((r) => r.status === 'rejected');
      assert.equal(fulfilled.length, 1, 'Apenas 1 recebimento de 70% pode vencer');
      assert.equal(rejected.length, 1, 'O segundo recebimento concorrente deve falhar');

      const receipts = await getRefundReceipts(refund.id, uid, false);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].amountCents, 7000);
      assert.equal(receipts[0].originType, 'personal_refund');
      assert.equal(receipts[0].originalTransactionId, paidExpense.id);
    });

    await t2.test('E. Mesma chave de idempotência com payload divergente (rejeição com erro)', async () => {
      const baseKey = 'idem_conflict_subtest_e';

      // 1a chamada grava R$ 100,00
      const firstMov = await recordMovement(
        {
          accountId: acc1.id,
          userId: uid,
          direction: 'inflow',
          amountCents: 10000,
          originType: 'adhoc_receipt',
          originId: 'orig_e_1',
          description: 'Aporte Original E',
          effectiveDate: '2026-04-09',
          authorUid: uid,
          idempotencyKey: baseKey,
        },
        false
      );
      assert.equal(firstMov.amountCents, 10000);

      // 2a chamada com MESMA chave mas montante divergente de R$ 300,00 DEVE SER REJEITADA
      await assert.rejects(
        async () => {
          await recordMovement(
            {
              accountId: acc1.id,
              userId: uid,
              direction: 'inflow',
              amountCents: 30000, // Divergência!
              originType: 'adhoc_receipt',
              originId: 'orig_e_1',
              description: 'Tentativa de Aporte com Valor Divergente',
              effectiveDate: '2026-04-09',
              authorUid: uid,
              idempotencyKey: baseKey,
            },
            false
          );
        },
        /Conflito de idempotência|already-exists/i
      );

      // O movimento preserva o valor original de R$ 100,00 no livro oficial
      const movs = await getAccountMovements(acc1.id, uid, false);
      const movFound = movs.find((m) => m.idempotencyKey === baseKey);
      assert.equal(movFound?.amountCents, 10000);
    });

    await t2.test('F. Falha durante operação multi-documento (rollback integral em db.runTransaction)', async () => {
      // Cria conta de destino que será arquivada para provocar falha transacional
      const archivedDestAcc = await createAccount(
        uid,
        { name: 'Conta Destino Arquivada', type: 'checking' },
        false
      );
      await archiveAccount(archivedDestAcc.id, uid, true, false);

      const acc1Before = await getAccountById(acc1.id, uid, false);
      const balanceBefore = acc1Before?.projectedBalanceCents || 0;
      const movsBefore = await getAccountMovements(acc1.id, uid, false);
      const transfersBefore = await getUserTransfers(uid, false);

      // Tenta transferir para a conta arquivada: a validação server-side lança failed-precondition dentro da transação
      await assert.rejects(
        async () => {
          await executeInternalTransfer(
            uid,
            {
              sourceAccountId: acc1.id,
              destinationAccountId: archivedDestAcc.id,
              amountCents: 5000,
              description: 'Transferência destinada a falhar',
              transferDate: '2026-04-10',
              idempotencyKey: 'idem_conc_rollback_f',
            },
            false
          );
        },
        /arquivada/i
      );

      // Comprova rollback integral:
      // 1. Saldo de acc1 permaneceu idêntico
      const acc1After = await getAccountById(acc1.id, uid, false);
      assert.equal(acc1After?.projectedBalanceCents, balanceBefore);

      // 2. Nenhum movimento de débito (outflow) foi gravado em acc1
      const movsAfter = await getAccountMovements(acc1.id, uid, false);
      assert.equal(movsAfter.length, movsBefore.length);

      // 3. Nenhum movimento de crédito (inflow) foi gravado na conta de destino
      const destMovs = await getAccountMovements(archivedDestAcc.id, uid, false);
      assert.equal(destMovs.length, 0);

      // 4. Nenhum documento de transferência foi criado
      const transfersAfter = await getUserTransfers(uid, false);
      assert.equal(transfersAfter.length, transfersBefore.length);
    });
  });

  await t.test('11.3 Cenários Contábeis 1 a 6 End-to-End nos Emuladores', async () => {
    await clearEmulatorsData();
    const uid = await createAndLoginUser('accounting.e2e@emulator.local', 'Senha@123');

    // =========================================================================
    // CENÁRIO 1: Conta + Receita + Despesa Parcial + Cancelamento Completo
    // =========================================================================
    const checkingA = await createAccount(uid, { name: 'Conta Corrente A', type: 'checking' }, false);
    assert.equal(checkingA.projectedBalanceCents, 0);

    // Receita paga de R$ 500,00 (50.000 centavos)
    const incomeTx = await createPersonalTransaction(
      uid,
      {
        description: 'Salário / Freelance',
        amountCents: 50000,
        type: 'income',
        status: 'paid',
        categoryId: 'cat_renda',
        categoryName: 'Renda',
        accountId: checkingA.id,
        competenceDate: '2026-05-01',
        paymentDate: '2026-05-01',
        idempotencyKey: 'sc1_income_500',
      },
      false
    );
    assert.equal(incomeTx.status, 'paid');

    let accState = await getAccountById(checkingA.id, uid, false);
    assert.equal(accState?.projectedBalanceCents, 50000);

    // Despesa pendente de R$ 200,00 (20.000 centavos)
    const expTx = await createPersonalTransaction(
      uid,
      {
        description: 'Manutenção Residencial',
        amountCents: 20000,
        type: 'expense',
        status: 'pending',
        categoryId: 'cat_casa',
        categoryName: 'Casa',
        accountId: checkingA.id,
        competenceDate: '2026-05-02',
        idempotencyKey: 'sc1_exp_200',
      },
      false
    );
    assert.equal(expTx.status, 'pending');

    // Pagamento parcial 1: R$ 80,00 (8.000 centavos)
    const part1 = await recordPartialPayment(
      expTx.id,
      uid,
      {
        accountId: checkingA.id,
        amountCents: 8000,
        paymentDate: '2026-05-03',
        authorUid: uid,
        idempotencyKey: 'sc1_part_80',
      },
      false
    );
    assert.equal(part1.transaction.status, 'partially_paid');
    assert.equal(part1.transaction.paidAmountCents, 8000);
    assert.equal(part1.transaction.remainingAmountCents, 12000);

    accState = await getAccountById(checkingA.id, uid, false);
    assert.equal(accState?.projectedBalanceCents, 42000);

    // Pagamento parcial 2: R$ 120,00 (12.000 centavos) -> liquida total
    const part2 = await recordPartialPayment(
      expTx.id,
      uid,
      {
        accountId: checkingA.id,
        amountCents: 12000,
        paymentDate: '2026-05-04',
        authorUid: uid,
        idempotencyKey: 'sc1_part_120',
      },
      false
    );
    assert.equal(part2.transaction.status, 'paid');
    assert.equal(part2.transaction.paidAmountCents, 20000);
    assert.equal(part2.transaction.remainingAmountCents, 0);

    accState = await getAccountById(checkingA.id, uid, false);
    assert.equal(accState?.projectedBalanceCents, 30000);

    // Cancela a despesa: DEVE reverter AMBOS os pagamentos parciais (8.000 + 12.000 = 20.000)
    const cancelledExp = await cancelPersonalTransaction(expTx.id, uid, 'Serviço desfeito', false);
    assert.equal(cancelledExp.status, 'cancelled');

    const reconSc1 = await reconcileAndSyncAccountBalance(checkingA.id, uid, false);
    assert.equal(reconSc1.reconciledBalanceCents, 50000);
    assert.equal(reconSc1.previousBalanceCents, 50000);
    assert.equal(reconSc1.hasDivergence, false);

    // =========================================================================
    // CENÁRIO 2: Transferência Interna (invariância do saldo consolidado)
    // =========================================================================
    const savingsB = await createAccount(uid, { name: 'Poupança B', type: 'savings' }, false);

    const trfRes = await executeInternalTransfer(
      uid,
      {
        sourceAccountId: checkingA.id,
        destinationAccountId: savingsB.id,
        amountCents: 15000,
        description: 'Reserva de Emergência',
        transferDate: '2026-05-05',
        idempotencyKey: 'sc2_trf_150',
      },
      false
    );
    assert.equal(trfRes.sourceMovement.amountCents, 15000);
    assert.equal(trfRes.destinationMovement.amountCents, 15000);

    // Replay com a mesma idempotencyKey não duplica
    const trfReplay = await executeInternalTransfer(
      uid,
      {
        sourceAccountId: checkingA.id,
        destinationAccountId: savingsB.id,
        amountCents: 15000,
        description: 'Reserva de Emergência',
        transferDate: '2026-05-05',
        idempotencyKey: 'sc2_trf_150',
      },
      false
    );
    assert.equal(trfReplay.transfer.id, trfRes.transfer.id);

    const accAState2 = await getAccountById(checkingA.id, uid, false);
    const accBState2 = await getAccountById(savingsB.id, uid, false);
    assert.equal(accAState2?.projectedBalanceCents, 35000);
    assert.equal(accBState2?.projectedBalanceCents, 15000);
    assert.equal(
      (accAState2?.projectedBalanceCents || 0) + (accBState2?.projectedBalanceCents || 0),
      50000,
      'Saldo consolidado entre as contas deve permanecer invariante em R$ 500,00'
    );

    // =========================================================================
    // CENÁRIO 3: Cartão de Crédito + Fatura + Pagamento Parcial + Carry-Over
    // =========================================================================
    const cardAccount = await createAccount(
      uid,
      {
        name: 'Cartão Visa Infinite',
        type: 'credit',
        creditLimitCents: 100000, // R$ 1.000,00
        closingDay: 15,
        dueDay: 25,
      },
      false
    );

    // Compra 1: dia 10/05 (antes do fechamento dia 15) -> fatura 2026-05 (R$ 300,00)
    const cardPurchase1 = await createPersonalTransaction(
      uid,
      {
        description: 'Supermercado Mensal',
        amountCents: 30000,
        type: 'expense',
        status: 'paid',
        categoryId: 'cat_alimentacao',
        categoryName: 'Alimentação',
        accountId: cardAccount.id,
        competenceDate: '2026-05-10',
        paymentDate: '2026-05-10',
        idempotencyKey: 'sc3_card_purchase_1',
      },
      false
    );
    assert.equal(cardPurchase1.status, 'paid');

    // Compra 2: dia 18/05 (após fechamento dia 15) -> fatura 2026-06 (R$ 100,00)
    const cardPurchase2 = await createPersonalTransaction(
      uid,
      {
        description: 'Restaurante Pós-Fechamento',
        amountCents: 10000,
        type: 'expense',
        status: 'paid',
        categoryId: 'cat_alimentacao',
        categoryName: 'Alimentação',
        accountId: cardAccount.id,
        competenceDate: '2026-05-18',
        paymentDate: '2026-05-18',
        idempotencyKey: 'sc3_card_purchase_2',
      },
      false
    );
    assert.equal(cardPurchase2.status, 'paid');

    // Nenhuma compra no cartão alterou o saldo da conta corrente A (continua 35.000)
    const accABeforeInvoicePay = await getAccountById(checkingA.id, uid, false);
    assert.equal(accABeforeInvoicePay?.projectedBalanceCents, 35000);

    // Verifica limite disponível: 100.000 - (30.000 + 10.000) = 60.000
    const availBeforePay = await calculateCardAvailableLimit(cardAccount, uid, false);
    assert.equal(availBeforePay.availableLimitCents, 60000);

    // Pagamento parcial da fatura 2026-05: paga R$ 180,00 (18.000), restam R$ 120,00 (12.000)
    const invPay1 = await payCardInvoice(
      {
        cardAccountId: cardAccount.id,
        invoiceMonth: '2026-05',
        sourceAccountId: checkingA.id,
        amountPaidCents: 18000,
        paymentDate: '2026-05-20',
        userId: uid,
        idempotencyKey: 'sc3_inv_pay_180',
      },
      false
    );
    assert.equal(invPay1.invoice.invoiceStatus, 'partially_paid');
    assert.equal(invPay1.invoice.remainingBalanceCents, 12000);

    // Limite disponível após pagar 18.000: 100.000 - (12.000 + 10.000) = 78.000
    const availAfterPartPay = await calculateCardAvailableLimit(cardAccount, uid, false);
    assert.equal(availAfterPartPay.availableLimitCents, 78000);

    // Carry-over do saldo residual (12.000) de 2026-05 para 2026-06 + juros de 10% (1.200)
    const carryResult = await carryOverInvoiceBalance(
      {
        cardAccount,
        sourceInvoiceMonth: '2026-05',
        targetInvoiceMonth: '2026-06',
        interestRateMonthly: 0.1,
        userId: uid,
      },
      false
    );
    assert.equal(carryResult.sourceInvoice.remainingBalanceCents, 0);
    assert.equal(carryResult.sourceInvoice.invoiceStatus, 'carried_over');
    assert.equal(carryResult.sourceInvoice.carriedOverToMonth, '2026-06');
    assert.equal(carryResult.sourceInvoice.totalPaidAmountCents, 18000, 'Pagamento parcial real de 180,00 deve ser preservado');
    assert.equal(carryResult.carryOver.unpaidPrincipalCents, 12000);
    assert.equal(carryResult.carryOver.appliedInterestCents, 1200);

    // Fatura 2026-06 tinha 10.000 de compras + 12.000 rolados + 1.200 encargos = 23.200
    assert.equal(carryResult.targetInvoice.remainingBalanceCents, 23200);

    // Limite disponível após carry-over NÃO PODE DUPLICAR O SALDO ROLADO:
    // 100.000 - 23.200 = 76.800
    const availAfterCarryOver = await calculateCardAvailableLimit(cardAccount, uid, false);
    assert.equal(
      availAfterCarryOver.availableLimitCents,
      76800,
      'O saldo rolado não pode ser descontado em duplicidade no limite disponível do cartão'
    );

    // Repetição da mesma operação (idempotência no emulador)
    const carryReplay = await carryOverInvoiceBalance(
      {
        cardAccount,
        sourceInvoiceMonth: '2026-05',
        targetInvoiceMonth: '2026-06',
        interestRateMonthly: 0.1,
        userId: uid,
      },
      false
    );
    assert.equal(carryReplay.carryOver.id, carryResult.carryOver.id);
    assert.equal(carryReplay.targetInvoice.remainingBalanceCents, 23200);
    assert.equal(carryReplay.sourceInvoice.invoiceStatus, 'carried_over');

    // Teste de Transporte Integral (fatura inteira não paga de R$ 500,00 transportada com juros)
    const cardAccountIntegral = await createAccount(
      uid,
      {
        name: 'Cartão Platinum Transporte Integral',
        type: 'credit',
        creditLimitCents: 150000,
        closingDay: 15,
        dueDay: 25,
      },
      false
    );
    await createPersonalTransaction(
      uid,
      {
        description: 'Compra Integral Fatura',
        amountCents: 50000,
        type: 'expense',
        status: 'paid',
        categoryId: 'cat_outros',
        categoryName: 'Outros',
        accountId: cardAccountIntegral.id,
        competenceDate: '2026-05-10',
        paymentDate: '2026-05-10',
        idempotencyKey: 'sc3_card_integral_buy',
      },
      false
    );
    const carryIntegral = await carryOverInvoiceBalance(
      {
        cardAccount: cardAccountIntegral,
        sourceInvoiceMonth: '2026-05',
        targetInvoiceMonth: '2026-06',
        interestRateMonthly: 0.1,
        userId: uid,
      },
      false
    );
    assert.equal(carryIntegral.sourceInvoice.invoiceStatus, 'carried_over');
    assert.equal(carryIntegral.sourceInvoice.totalPaidAmountCents, 0, 'Sem pagamento prévio');
    assert.equal(carryIntegral.sourceInvoice.remainingBalanceCents, 0);
    assert.equal(carryIntegral.carryOver.unpaidPrincipalCents, 50000);
    assert.equal(carryIntegral.carryOver.appliedInterestCents, 5000);
    assert.equal(carryIntegral.targetInvoice.carriedOverBalanceCents, 50000);
    assert.equal(carryIntegral.targetInvoice.interestAndFeesCents, 5000);
    assert.equal(carryIntegral.targetInvoice.totalDueAmountCents, 55000);
    assert.equal(carryIntegral.targetInvoice.remainingBalanceCents, 55000);
    assert.ok(
      ['open', 'overdue'].includes(carryIntegral.targetInvoice.invoiceStatus),
      'Fatura de destino deve estar ativa com saldo devedor (open ou overdue)'
    );

    // Nenhuma movimentação bancária fictícia foi criada em contas correntes:
    const accACheck = await getAccountById(checkingA.id, uid, false);
    assert.equal(accACheck?.projectedBalanceCents, 17000, 'Saldo da conta corrente A inalterado por carry-over');

    // =========================================================================
    // CENÁRIO 4: Orçamento Individual (Realizado, Comprometido e Previsto)
    // =========================================================================
    await createPersonalBudget(
      uid,
      {
        name: 'Orçamento Alimentação Maio/2026',
        categoryIds: ['cat_alimentacao'],
        competenceMonth: '2026-05',
        plannedAmountCents: 60000, // R$ 600,00
      },
      false
    );

    // Adiciona uma despesa pendente (comprometida) de R$ 50,00 e uma prevista (forecast) de R$ 70,00 em 2026-05
    await createPersonalTransaction(
      uid,
      {
        description: 'Feira Orgânica Pendente',
        amountCents: 5000,
        type: 'expense',
        status: 'pending',
        categoryId: 'cat_alimentacao',
        categoryName: 'Alimentação',
        accountId: checkingA.id,
        competenceDate: '2026-05-21',
        idempotencyKey: 'sc4_exp_pending_50',
      },
      false
    );

    await createPersonalTransaction(
      uid,
      {
        description: 'Jantar Aniversário Previsto',
        amountCents: 7000,
        type: 'expense',
        status: 'forecast',
        categoryId: 'cat_alimentacao',
        categoryName: 'Alimentação',
        accountId: checkingA.id,
        competenceDate: '2026-05-28',
        idempotencyKey: 'sc4_exp_forecast_70',
      },
      false
    );

    const budgetsProgress = await getUserBudgetsWithProgress(uid, '2026-05', false);
    assert.equal(budgetsProgress.length, 1);
    const bgt = budgetsProgress[0];
    // Em 2026-05 para 'cat_alimentacao':
    // - Realizado (spentAmountCents / realizedAmountCents): 30.000 (compra 1 cartão) + 10.000 (compra 2 cartão) = 40.000
    //   (Note que o pagamento de fatura de 18.000 NÃO entra no orçamento e a despesa cancelada do Cenário 1 também não)
    // - Comprometido (committedAmountCents): 5.000 (Feira pendente)
    // - Previsto exclusivo (forecastOnlyAmountCents): 7.000 (Jantar previsto)
    // - Projeção total (forecastedAmountCents): 40.000 + 5.000 + 7.000 = 52.000
    assert.equal(bgt.realizedAmountCents, 40000);
    assert.equal(bgt.spentAmountCents, 40000);
    assert.equal(bgt.committedAmountCents, 5000);
    assert.equal(bgt.forecastOnlyAmountCents, 7000);
    assert.equal(bgt.forecastedAmountCents, 52000);
    assert.equal(bgt.remainingAmountCents, 20000);
    assert.equal(bgt.projectedRemainingAmountCents, 8000);

    // Validação pontual do estorno financeiro vs cancelamento no orçamento via Cloud Functions
    const paidExpToReverse = await createPersonalTransaction(
      uid,
      {
        description: 'Lanche da Tarde',
        amountCents: 10000, // R$ 100,00
        type: 'expense',
        status: 'paid',
        categoryId: 'cat_alimentacao',
        categoryName: 'Alimentação',
        accountId: checkingA.id,
        competenceDate: '2026-05-29',
        paymentDate: '2026-05-29',
        idempotencyKey: 'sc4_lanche_100',
      },
      false
    );
    let bgtCheck = (await getUserBudgetsWithProgress(uid, '2026-05', false))[0];
    assert.equal(bgtCheck.realizedAmountCents, 50000, 'Realizado sobe para R$ 500,00 com o lanche pago');

    // Snapshot do documento original de pagamento no Firestore real antes do estorno
    const rawPayDocRef = doc(db, 'users', uid, 'personal_transactions', paidExpToReverse.id, 'payments', `txpay_init_${paidExpToReverse.id}`);
    const rawPaySnapBefore = await getDoc(rawPayDocRef);
    assert.ok(rawPaySnapBefore.exists(), 'Documento original de pagamento existe no Firestore');
    const rawPayDataBefore = rawPaySnapBefore.data();

    // Estorno do movimento financeiro via Cloud Function (sem cancelar a obrigação)
    assert.ok(paidExpToReverse.financialMovementId);
    await reverseMovement(
      checkingA.id,
      paidExpToReverse.financialMovementId,
      uid,
      'Estorno do débito do lanche',
      false,
      { idempotent: true }
    );

    // Prova de Imutabilidade Estrita no Firestore Real: o documento original em 'payments' não sofreu NENHUMA alteração
    const rawPaySnapAfter = await getDoc(rawPayDocRef);
    assert.deepEqual(
      rawPayDataBefore,
      rawPaySnapAfter.data(),
      'O documento original de pagamento no Firestore real permanece rigorosamente inalterado após estorno'
    );
    assert.equal(rawPaySnapAfter.data()?.isReversed, undefined, 'Nenhum campo isReversed gravado no documento original de pagamento');

    // Verifica que o evento compensatório foi gravado na subcoleção 'payment_reversals'
    const revsLanche = await getPersonalTransactionPaymentReversals(paidExpToReverse.id, uid, false);
    assert.equal(revsLanche.length, 1, 'Novo evento registrado na subcoleção payment_reversals do Firestore');
    assert.equal(revsLanche[0].paymentId, `txpay_init_${paidExpToReverse.id}`);
    assert.equal(revsLanche[0].amountCents, 10000);
    assert.ok(revsLanche[0].reversalMovementId);

    bgtCheck = (await getUserBudgetsWithProgress(uid, '2026-05', false))[0];
    assert.equal(bgtCheck.realizedAmountCents, 40000, 'Realizado retorna a R$ 400,00 após estorno financeiro do lanche');
    assert.equal(bgtCheck.committedAmountCents, 15000, 'Comprometido absorve a despesa que voltou a ficar pendente (R$ 150,00)');
    assert.equal(bgtCheck.forecastedAmountCents, 62000, 'Projeção total permanece com o consumo previsto');

    const paysLanche = await getPersonalTransactionPayments(paidExpToReverse.id, uid, false);
    assert.equal(paysLanche.length, 1, 'Registro de pagamento original preservado na subcoleção do Firestore');
    assert.equal(paysLanche[0].isReversed, true, 'Marcado auditavelmente como estornado via visão derivada');
    assert.ok(paysLanche[0].reversalMovementId, 'Vínculo com movimento de estorno presente');
    assert.ok(paysLanche[0].reversal, 'Metadados da reversão presentes na visão derivada');

    // Agora cancela formalmente a obrigação
    await cancelPersonalTransaction(paidExpToReverse.id, uid, 'Cancelamento do pedido do lanche', false);

    // Prova de Imutabilidade Estrita após cancelamento da transação
    const rawPaySnapAfterCancel = await getDoc(rawPayDocRef);
    assert.deepEqual(
      rawPayDataBefore,
      rawPaySnapAfterCancel.data(),
      'O documento original de pagamento permanece 100% inalterado após cancelamento da transação'
    );

    const revsLancheAfterCancel = await getPersonalTransactionPaymentReversals(paidExpToReverse.id, uid, false);
    assert.equal(revsLancheAfterCancel.length, 1, 'Cancelamento preservou o evento prévio de estorno e não gerou duplicidade');

    bgtCheck = (await getUserBudgetsWithProgress(uid, '2026-05', false))[0];
    assert.equal(bgtCheck.realizedAmountCents, 40000);
    assert.equal(bgtCheck.committedAmountCents, 5000);
    assert.equal(bgtCheck.forecastedAmountCents, 52000);

    const paysLancheAfterCancel = await getPersonalTransactionPayments(paidExpToReverse.id, uid, false);
    assert.equal(paysLancheAfterCancel.length, 1, 'Registro continua preservado sem deleção');
    assert.equal(paysLancheAfterCancel[0].isReversed, true);

    // =========================================================================
    // CENÁRIO 5: Reembolso Individual (vínculo, recebimento parcial/total e bloqueio de excesso)
    // =========================================================================
    const sc5Refund = await createPersonalRefund(
      uid,
      {
        originalTransactionId: cardPurchase1.id, // compra de R$ 300,00
        debtorName: 'Irmão Divisão Feira',
        description: 'Reembolso de itens divididos no mercado',
        amountDueCents: 10000, // R$ 100,00 a receber
        idempotencyKey: 'sc5_refund_100',
      },
      false
    );
    assert.equal(sc5Refund.status, 'pending');

    // Recebimento parcial 1: R$ 40,00 (4.000 centavos) na conta corrente A
    const rec1 = await recordRefundReceipt(
      uid,
      {
        refundId: sc5Refund.id,
        destinationAccountId: checkingA.id,
        amountCents: 4000,
        receiptDate: '2026-05-22',
        authorUid: uid,
        idempotencyKey: 'sc5_rec_40',
      },
      false
    );
    assert.equal(rec1.refund.status, 'partially_received');
    assert.equal(rec1.refund.remainingAmountCents, 6000);
    assert.equal(rec1.movement.originType, 'personal_refund');
    assert.equal(rec1.receipt.originType, 'personal_refund');
    assert.equal(rec1.receipt.originalTransactionId, cardPurchase1.id);

    // Recebimento parcial 2: R$ 60,00 (6.000 centavos) -> liquida o reembolso
    const rec2 = await recordRefundReceipt(
      uid,
      {
        refundId: sc5Refund.id,
        destinationAccountId: checkingA.id,
        amountCents: 6000,
        receiptDate: '2026-05-23',
        authorUid: uid,
        idempotencyKey: 'sc5_rec_60',
      },
      false
    );
    assert.equal(rec2.refund.status, 'received');
    assert.equal(rec2.refund.remainingAmountCents, 0);

    // Tentativa de receber valor excedente (R$ 10,00 extras) deve ser bloqueada
    await assert.rejects(
      async () => {
        await recordRefundReceipt(
          uid,
          {
            refundId: sc5Refund.id,
            destinationAccountId: checkingA.id,
            amountCents: 1000,
            receiptDate: '2026-05-24',
            authorUid: uid,
            idempotencyKey: 'sc5_rec_excess',
          },
          false
        );
      },
      /quitado|liquidado|excede/i
    );

    // =========================================================================
    // CENÁRIO 6: Auditoria e Reconciliação Oficial de Saldo
    // =========================================================================
    // Saldo esperado de checkingA:
    // +50.000 (salário) - 8.000 (part1) - 12.000 (part2) + 8.000 (rev part1) + 12.000 (rev part2)
    // -15.000 (transferência p/ poupança B) - 18.000 (pagamento fatura) + 4.000 (reembolso 1) + 6.000 (reembolso 2)
    // -10.000 (lanche Cenário 4) + 10.000 (estorno compensatório do lanche)
    // = 27.000 centavos (R$ 270,00)
    const reconCheck = await reconcileAndSyncAccountBalance(checkingA.id, uid, false);
    assert.equal(reconCheck.reconciledBalanceCents, 27000);
    assert.equal(reconCheck.previousBalanceCents, 27000);
    assert.equal(reconCheck.hasDivergence, false);

    const movementsA = await getAccountMovements(checkingA.id, uid, false);
    assert.equal(movementsA.length, 11, 'Deve conter 11 movimentos registrados em modelo estritamente append-only');
  });
});
