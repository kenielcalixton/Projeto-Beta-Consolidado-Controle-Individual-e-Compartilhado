import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import { LOCAL_EMULATOR_PROJECT_ID } from '../config/environment';
import { createAccount, getAccountById } from './accountService';
import { createSpace } from './spaceService';
import { createSpaceInvite, acceptSpaceInvite } from './spaceInviteService';
import { createSharedExpense } from './sharedFinanceService';
import {
  confirmCustodyReceipt,
  createCustodyTransfer,
  returnCustodyFunds,
  useCustodyFundsInExpense,
} from './custodyService';
import { getAccountMovements } from './ledgerService';

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

test('FASE 7 — EMULATOR INTEGRATION: Transferências e Custódia entre Participantes (v3.1)', async (t) => {
  await clearEmulatorsData();

  // 1. Criação e autenticação de Alice
  const aliceCred = await createUserWithEmailAndPassword(
    auth,
    'alice.phase7@exemplo.com',
    'SenhaSegura123!'
  );
  const aliceUid = aliceCred.user.uid;

  const aliceChecking = await createAccount(
    aliceUid,
    { name: 'Conta Corrente Alice Real', type: 'checking' },
    false
  );

  const createdSpace = await createSpace(
    aliceUid,
    'Alice Remetente',
    'alice.phase7@exemplo.com',
    {
      name: 'Espaço Viagem e Despesas',
      description: 'Espaço para controle de custódia e despesas',
    },
    false
  );
  const spaceId = createdSpace.space.id;

  const inviteBob = await createSpaceInvite(
    spaceId,
    aliceUid,
    'Alice Remetente',
    {
      invitedEmail: 'bob.phase7@exemplo.com',
      invitedRole: 'member',
    },
    false
  );

  await signOut(auth);

  // 2. Criação de Bob, aceite de convite e conta bancária
  const bobCred = await createUserWithEmailAndPassword(
    auth,
    'bob.phase7@exemplo.com',
    'SenhaSegura123!'
  );
  const bobUid = bobCred.user.uid;

  await acceptSpaceInvite(
    inviteBob.rawToken,
    { uid: bobUid, displayName: 'Bob Custodiante', email: 'bob.phase7@exemplo.com' },
    false
  );

  const bobChecking = await createAccount(
    bobUid,
    { name: 'Conta Corrente Bob Real', type: 'checking' },
    false
  );

  await signOut(auth);

  let transferId = '';

  await t.test('1. Alice declara transferência de R$ 500,00 sob custódia de Bob: debita Alice e gera pending_receipt', async () => {
    await signInWithEmailAndPassword(auth, 'alice.phase7@exemplo.com', 'SenhaSegura123!');

    const res = await createCustodyTransfer(
      aliceUid,
      {
        spaceId,
        custodianUid: bobUid,
        initialAmountCents: 50000,
        sourceAccountId: aliceChecking.id,
        description: 'Fundo para adiantamento do Airbnb',
        notes: 'Bob efetuará a reserva',
        transferDate: '2026-11-12',
        idempotencyKey: 'idem_real_alice_bob_500',
      },
      false
    );

    assert.ok(res.transfer.id);
    transferId = res.transfer.id;
    assert.equal(res.transfer.initialAmountCents, 50000);
    assert.equal(res.transfer.availableBalanceCents, 0, 'Disponível deve ser 0 antes da confirmação de Bob');
    assert.equal(res.transfer.custodyStatus, 'pending_receipt');
    assert.equal(res.isIdempotentReplay, false);

    // Verifica saldo projetado de Alice no Firestore
    const aliceAcc = await getAccountById(aliceChecking.id, aliceUid, false);
    assert.equal(aliceAcc?.projectedBalanceCents, -50000);

    // Verifica livro de movimentos de Alice
    const movs = await getAccountMovements(aliceChecking.id, aliceUid, false);
    assert.equal(movs.length, 1);
    assert.equal(movs[0].direction, 'outflow');
    assert.equal(movs[0].originType, 'custody_transfer_out');
    assert.equal(movs[0].amountCents, 50000);

    // Verifica evento de auditoria gerado no espaço para Bob
    const auditSnap = await getDoc(
      doc(db, 'spaces', spaceId, 'audit', `audit_cust_created_${transferId}`)
    );
    assert.ok(auditSnap.exists(), 'Auditoria de custódia deve existir no espaço');
    assert.equal(auditSnap.data().eventType, 'custody_transfer_created');
  });

  await t.test('2. Replay idempotente no servidor retorna documento existente sem duplicar débito', async () => {
    await signInWithEmailAndPassword(auth, 'alice.phase7@exemplo.com', 'SenhaSegura123!');

    const res = await createCustodyTransfer(
      aliceUid,
      {
        spaceId,
        custodianUid: bobUid,
        initialAmountCents: 50000,
        sourceAccountId: aliceChecking.id,
        description: 'Fundo para adiantamento do Airbnb',
        transferDate: '2026-11-12',
        idempotencyKey: 'idem_real_alice_bob_500',
      },
      false
    );

    assert.equal(res.isIdempotentReplay, true);
    const movs = await getAccountMovements(aliceChecking.id, aliceUid, false);
    assert.equal(movs.length, 1, 'Movimento contábil de Alice deve ser único');
  });

  await t.test('3. Bloqueio de confirmação ilegítima: somente o custodiante Bob pode confirmar', async () => {
    // Alice tenta confirmar a transferência dela mesma (deve falhar)
    await signInWithEmailAndPassword(auth, 'alice.phase7@exemplo.com', 'SenhaSegura123!');

    await assert.rejects(
      async () => {
        await confirmCustodyReceipt(
          aliceUid,
          {
            transferId,
            destinationAccountId: aliceChecking.id,
            idempotencyKey: 'idem_illegal_conf',
          },
          false
        );
      },
      /(permission-denied|403|Somente o custodiante legítimo)/
    );
  });

  await t.test('4. Bob confirma o recebimento dos R$ 500,00 na sua conta bancária: credita Bob e status available', async () => {
    await signInWithEmailAndPassword(auth, 'bob.phase7@exemplo.com', 'SenhaSegura123!');

    const res = await confirmCustodyReceipt(
      bobUid,
      {
        transferId,
        destinationAccountId: bobChecking.id,
        notes: 'Confirmado no banco com sucesso',
        idempotencyKey: 'idem_real_conf_bob_500',
      },
      false
    );

    assert.equal(res.transfer.custodyStatus, 'available');
    assert.equal(res.transfer.availableBalanceCents, 50000);
    assert.equal(res.transfer.destinationAccountId, bobChecking.id);

    // Verifica saldo projetado de Bob no Firestore
    const bobAcc = await getAccountById(bobChecking.id, bobUid, false);
    assert.equal(bobAcc?.projectedBalanceCents, 50000);

    // Verifica livro de movimentos de Bob
    const bobMovs = await getAccountMovements(bobChecking.id, bobUid, false);
    assert.equal(bobMovs.length, 1);
    assert.equal(bobMovs[0].direction, 'inflow');
    assert.equal(bobMovs[0].originType, 'custody_transfer_in');
    assert.equal(bobMovs[0].amountCents, 50000);

    // Verifica notificação recebida por Bob e auditoria no espaço
    const notifBob = await getDoc(
      doc(db, 'users', bobUid, 'notifications', `notif_cust_declared_${transferId}`)
    );
    assert.ok(notifBob.exists(), 'Bob deve ter recebido a notificação de declaração');
    assert.equal(notifBob.data().type, 'custody_transfer_created');

    const auditSnap = await getDoc(
      doc(db, 'spaces', spaceId, 'audit', `audit_cust_confirmed_${transferId}`)
    );
    assert.ok(auditSnap.exists(), 'Auditoria de confirmação de custódia deve existir no espaço');
    assert.equal(auditSnap.data().eventType, 'custody_receipt_confirmed');
  });

  let expenseId = '';

  await t.test('5. Bob utiliza R$ 350,00 da custódia para cobrir despesa do Airbnb: status partially_used sem duplicar débito', async () => {
    await signInWithEmailAndPassword(auth, 'bob.phase7@exemplo.com', 'SenhaSegura123!');

    const expRes = await createSharedExpense(
      spaceId,
      {
        spaceId,
        title: 'Reserva do Airbnb',
        totalOriginalAmountCents: 35000,
        competenceMonth: '2026-11',
        competenceDate: '2026-11-12',
        categoryId: 'cat_lodging',
        categoryName: 'Hospedagem',
        createdByUid: bobUid,
        responsibleUid: bobUid,
        payerUid: bobUid,
        splitMethod: 'equal',
        participants: [
          { uid: aliceUid, name: 'Alice' },
          { uid: bobUid, name: 'Bob' },
        ],
      },
      false
    );
    expenseId = expRes.expense.id;

    const res = await useCustodyFundsInExpense(
      bobUid,
      {
        transferId,
        expenseId,
        amountCents: 35000,
        notes: 'Pagamento efetuado via cartão corporativo',
        idempotencyKey: 'idem_real_use_350',
      },
      false
    );

    assert.equal(res.transfer.usedAmountCents, 35000);
    assert.equal(res.transfer.availableBalanceCents, 15000);
    assert.equal(res.transfer.custodyStatus, 'partially_used');

    // Movimentações bancárias de Bob não devem sofrer alteração adicional pelo uso
    const bobMovs = await getAccountMovements(bobChecking.id, bobUid, false);
    assert.equal(bobMovs.length, 1, 'Uso da custódia não duplica débito na conta');
  });

  await t.test('6. Tentativa de usar valor excedente ao saldo disponível é rejeitada', async () => {
    await signInWithEmailAndPassword(auth, 'bob.phase7@exemplo.com', 'SenhaSegura123!');

    await assert.rejects(
      async () => {
        await useCustodyFundsInExpense(
          bobUid,
          {
            transferId,
            expenseId,
            amountCents: 20000, // Disponível é 15000
            idempotencyKey: 'idem_excess_use',
          },
          false
        );
      },
      /(invalid-argument|400|excede o saldo)/
    );
  });

  await t.test('7. Bob devolve os R$ 150,00 restantes para Alice: débito em Bob, crédito em Alice e status settled_by_mixed', async () => {
    await signInWithEmailAndPassword(auth, 'bob.phase7@exemplo.com', 'SenhaSegura123!');

    const res = await returnCustodyFunds(
      bobUid,
      {
        transferId,
        sourceAccountId: bobChecking.id,
        destinationAccountId: aliceChecking.id,
        amountCents: 15000,
        justification: 'Troco da reserva devolvido integralmente',
        idempotencyKey: 'idem_real_ret_150',
      },
      false
    );

    assert.equal(res.transfer.returnedAmountCents, 15000);
    assert.equal(res.transfer.availableBalanceCents, 0);
    assert.equal(res.transfer.custodyStatus, 'settled_by_mixed');

    // Valida débito contábil na conta de Bob
    const bobAcc = await getAccountById(bobChecking.id, bobUid, false);
    assert.equal(bobAcc?.projectedBalanceCents, 35000); // 50000 recebido - 15000 devolvido = 35000
    const bobMovs = await getAccountMovements(bobChecking.id, bobUid, false);
    assert.equal(bobMovs.length, 2);
    const bobRetMov = bobMovs.find((m) => m.originType === 'custody_return_out');
    assert.ok(bobRetMov, 'Deve existir movimento de devolução na conta de Bob');
    assert.equal(bobRetMov.direction, 'outflow');
    assert.equal(bobRetMov.amountCents, 15000);

    // Valida auditoria de devolução registrada no espaço (Bob é membro do espaço)
    const auditRet = await getDoc(
      doc(db, 'spaces', spaceId, 'audit', `audit_cust_return_${res.returnRecord.id}`)
    );
    assert.ok(auditRet.exists(), 'Auditoria de devolução deve existir no espaço');
    assert.equal(auditRet.data().eventType, 'custody_return_confirmed');

    // Autentica como Alice para validar o crédito contábil e notificação na conta pessoal dela
    await signInWithEmailAndPassword(auth, 'alice.phase7@exemplo.com', 'SenhaSegura123!');

    // Valida crédito contábil na conta de Alice
    const aliceAcc = await getAccountById(aliceChecking.id, aliceUid, false);
    assert.equal(aliceAcc?.projectedBalanceCents, -35000); // -50000 saída + 15000 retorno = -35000
    const aliceMovs = await getAccountMovements(aliceChecking.id, aliceUid, false);
    assert.equal(aliceMovs.length, 2);
    const aliceRetMov = aliceMovs.find((m) => m.originType === 'custody_return_in');
    assert.ok(aliceRetMov, 'Deve existir movimento de devolução recebida na conta de Alice');
    assert.equal(aliceRetMov.direction, 'inflow');
    assert.equal(aliceRetMov.amountCents, 15000);

    const notifAlice = await getDoc(
      doc(db, 'users', aliceUid, 'notifications', `notif_cust_return_${res.returnRecord.id}`)
    );
    assert.ok(notifAlice.exists(), 'Alice deve ter recebido a notificação de devolução');
    assert.equal(notifAlice.data().type, 'custody_return_confirmed');
  });

  await signOut(auth);
});
