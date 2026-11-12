/**
 * TESTE DE INTEGRAÇÃO END-TO-END — CENÁRIO COMPLETO DE DOIS USUÁRIOS (RC1)
 *
 * Simula a experiência completa de dois usuários independentes (Alice e Bob)
 * interagindo tanto em suas finanças individuais isoladas quanto em um espaço compartilhado
 * no Firebase Emulator Suite (demo-projeto-beta-v3).
 *
 * Cenários validados:
 * 1. Login e autenticação independente de Alice e Bob.
 * 2. Isolamento estrito de contas bancárias e transações individuais.
 * 3. Criação de despesa compartilhada e rateio em obrigações (liabilities).
 * 4. Bob declara pagamento de sua cota; Alice (responsável) aprova com crédito no livro-razão.
 * 5. Ciclo de Custódia em 2 Etapas: Alice transfere para Bob -> Bob confirma -> Bob declara devolução parcial -> Alice confirma recebimento da devolução.
 * 6. Ciclo de Restituição com Estorno: Confirmação de recebimento e posterior estorno compensatório pelo credor legítimo.
 * 7. Bloqueios de Segurança: Bob tenta aprovar despesa de Alice (bloqueado) e tenta manipular coleções contábeis append-only (PERMISSION_DENIED).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import { LOCAL_EMULATOR_PROJECT_ID } from '../config/environment';
import { createSpace } from './spaceService';
import { createSpaceInvite, acceptSpaceInvite } from './spaceInviteService';
import { createAccount, getUserAccounts } from './accountService';
import {
  createSharedExpense,
  declareExpensePayment,
  approveExpensePayment,
  getExpenseLiabilities,
  confirmRestitutionReceipt,
  reverseRestitutionReceipt,
  getRestitutionReceipts,
} from './sharedFinanceService';
import {
  createCustodyTransfer,
  confirmCustodyReceipt,
  declareCustodyReturn,
  confirmCustodyReturnReceipt,
  getCustodyReturns,
} from './custodyService';
import { initializeApp as initAdmin, getApps as getAdminApps } from 'firebase-admin/app';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';

const adminApp = getAdminApps().length ? getAdminApps()[0] : initAdmin({ projectId: LOCAL_EMULATOR_PROJECT_ID });
const adminDb = getAdminFirestore(adminApp);

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

test('RC1 HOMOLOGAÇÃO: Cenário Completo de Dois Usuários (Alice & Bob)', async (t) => {
  await clearEmulatorsData();

  let aliceUid = '';
  let bobUid = '';
  let aliceAccId = '';
  let bobAccId = '';
  let spaceId = '';
  let expenseId = '';
  let bobDeclId = '';
  let custodyTransferId = '';

  // ----------------------------------------------------------------------------
  // CENÁRIO 1: Login e Autenticação Independente
  // ----------------------------------------------------------------------------
  await t.test('1. Registro e Login independente de Alice e Bob no Auth Emulator', async () => {
    // Registra Alice
    const aliceCred = await createUserWithEmailAndPassword(
      auth,
      'alice.rc1@exemplo.com',
      'SenhaSegura123!'
    );
    aliceUid = aliceCred.user.uid;
    assert.ok(aliceUid, 'Alice UID deve existir');

    // Cria conta bancária da Alice
    const accA = await createAccount(
      aliceUid,
      { name: 'Nubank Alice', type: 'checking' },
      false
    );
    aliceAccId = accA.id;

    // Desconecta Alice
    await signOut(auth);

    // Registra Bob
    const bobCred = await createUserWithEmailAndPassword(
      auth,
      'bob.rc1@exemplo.com',
      'SenhaSegura123!'
    );
    bobUid = bobCred.user.uid;
    assert.ok(bobUid, 'Bob UID deve existir');
    assert.notEqual(aliceUid, bobUid, 'UIDs devem ser distintos');

    // Cria conta bancária do Bob
    const accB = await createAccount(
      bobUid,
      { name: 'Inter Bob', type: 'checking' },
      false
    );
    bobAccId = accB.id;

    await signOut(auth);
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 2: Isolamento de Finanças Pessoais
  // ----------------------------------------------------------------------------
  await t.test('2. Isolamento de contas e transações individuais entre Alice e Bob', async () => {
    // Loga como Bob
    await signInWithEmailAndPassword(auth, 'bob.rc1@exemplo.com', 'SenhaSegura123!');

    // Bob lista suas contas
    const bobAccounts = await getUserAccounts(bobUid, false, false);
    assert.equal(bobAccounts.length, 1);
    assert.equal(bobAccounts[0].id, bobAccId);

    // Bob tenta ler contas da Alice diretamente via Firestore: deve ser bloqueado pelas regras com permission-denied
    await assert.rejects(
      async () => await getDoc(doc(db, 'accounts', aliceAccId)),
      /permission-denied|false for 'get'/
    );

    await signOut(auth);
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 3: Espaço Compartilhado e Divisão de Despesa (Rateio)
  // ----------------------------------------------------------------------------
  await t.test('3. Alice cria espaço "Residência Alice & Bob", convida Bob e Bob aceita', async () => {
    // Alice loga e cria espaço
    await signInWithEmailAndPassword(auth, 'alice.rc1@exemplo.com', 'SenhaSegura123!');

    const spaceResult = await createSpace(
      aliceUid,
      'Alice Silva',
      'alice.rc1@exemplo.com',
      { name: 'Residência Alice & Bob', description: 'Gestão da Casa' },
      false
    );
    spaceId = spaceResult.space.id;

    // Convida Bob
    const invite = await createSpaceInvite(
      spaceId,
      aliceUid,
      'Alice Silva',
      { invitedEmail: 'bob.rc1@exemplo.com', invitedRole: 'member' },
      false
    );

    await signOut(auth);

    // Bob loga e aceita o convite
    await signInWithEmailAndPassword(auth, 'bob.rc1@exemplo.com', 'SenhaSegura123!');

    await acceptSpaceInvite(
      invite.rawToken,
      { uid: bobUid, displayName: 'Bob Souza', email: 'bob.rc1@exemplo.com' },
      false
    );

    await signOut(auth);
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 4: Despesa Compartilhada, Declaração e Aprovação
  // ----------------------------------------------------------------------------
  await t.test('4. Alice registra despesa de R$ 400 (50/50); Bob declara cota de R$ 200; Alice aprova', async () => {
    // Alice cria despesa
    await signInWithEmailAndPassword(auth, 'alice.rc1@exemplo.com', 'SenhaSegura123!');

    const exp = await createSharedExpense(
      spaceId,
      {
        spaceId,
        title: 'Compras do Mês',
        totalOriginalAmountCents: 40000,
        competenceMonth: '2026-11',
        competenceDate: '2026-11-10',
        categoryId: 'cat_alim',
        categoryName: 'Alimentação',
        createdByUid: aliceUid,
        responsibleUid: aliceUid,
        payerUid: aliceUid,
        splitMethod: 'equal',
        participants: [
          { uid: aliceUid, name: 'Alice Silva' },
          { uid: bobUid, name: 'Bob Souza' },
        ],
        idempotencyKey: 'exp_rc1_compras_01',
      },
      false
    );
    expenseId = exp.expense.id;

    const liabilities = await getExpenseLiabilities(spaceId, expenseId, false);
    assert.equal(liabilities.length, 2);

    const bLiab = liabilities.find((l) => l.memberUid === bobUid);
    assert.ok(bLiab);
    assert.equal(bLiab.originalAmountCents, 20000);
    assert.equal(bLiab.remainingAmountCents, 20000);

    await signOut(auth);

    // Bob loga e declara pagamento
    await signInWithEmailAndPassword(auth, 'bob.rc1@exemplo.com', 'SenhaSegura123!');

    const decl = await declareExpensePayment(
      {
        spaceId,
        expenseId,
        memberUid: bobUid,
        memberName: 'Bob Souza',
        amountCents: 20000,
        paymentDate: '2026-11-11',
        paymentMethod: 'pix',
        notes: 'Pix enviado para Nubank da Alice',
        idempotencyKey: 'decl_rc1_bob_01',
      },
      false
    );
    assert.equal(decl.status, 'pending_validation');
    bobDeclId = decl.id;

    await signOut(auth);

    // Alice loga e aprova o pagamento direcionando o crédito para sua conta
    await signInWithEmailAndPassword(auth, 'alice.rc1@exemplo.com', 'SenhaSegura123!');

    const approved = await approveExpensePayment(
      {
        spaceId,
        expenseId,
        declarationId: bobDeclId,
        approverUid: aliceUid,
        destinationAccountId: aliceAccId,
        idempotencyKey: 'appr_rc1_alice_01',
      },
      false
    );
    assert.equal(approved.liability.status, 'paid');
    assert.equal(approved.liability.remainingAmountCents, 0);

    await signOut(auth);
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 5: Custódia em 2 Etapas (Transferência, Declaração de Devolução e Confirmação)
  // ----------------------------------------------------------------------------
  await t.test('5. Custódia em 2 Etapas: Alice transfere R$ 300 -> Bob confirma -> Bob declara devolução de R$ 100 -> Alice confirma devolução', async () => {
    // 1. Alice loga e transfere R$ 300 para Bob sob custódia
    await signInWithEmailAndPassword(auth, 'alice.rc1@exemplo.com', 'SenhaSegura123!');

    const transferRes = await createCustodyTransfer(
      aliceUid,
      {
        spaceId,
        custodianUid: bobUid,
        initialAmountCents: 30000,
        sourceAccountId: aliceAccId,
        description: 'Fundo para Feira Semanal',
        idempotencyKey: 'cust_rc1_transfer_01',
      },
      false
    );
    custodyTransferId = transferRes.transfer.id;
    assert.equal(transferRes.transfer.custodyStatus, 'pending_receipt');

    await signOut(auth);

    // 2. Bob loga e confirma recebimento dos fundos na conta Inter
    await signInWithEmailAndPassword(auth, 'bob.rc1@exemplo.com', 'SenhaSegura123!');

    const confirmRes = await confirmCustodyReceipt(
      bobUid,
      {
        transferId: custodyTransferId,
        destinationAccountId: bobAccId,
        confirmedAmountCents: 30000,
      },
      false
    );
    assert.equal(confirmRes.transfer.custodyStatus, 'available');
    assert.equal(confirmRes.transfer.availableBalanceCents, 30000);

    // 3. Bob declara devolução parcial de R$ 100 da sua conta Inter
    const declReturnRes = await declareCustodyReturn(
      bobUid,
      {
        transferId: custodyTransferId,
        sourceAccountId: bobAccId,
        amountCents: 10000,
        justification: 'Sobraram R$ 100 após a feira',
      },
      false
    );
    assert.equal(declReturnRes.transfer.custodyStatus, 'return_pending_confirmation');
    assert.equal(declReturnRes.transfer.availableBalanceCents, 20000);
    assert.equal(declReturnRes.transfer.reservedForReturnCents, 10000);
    assert.equal(declReturnRes.returnRecord.status, 'pending_confirmation');

    await signOut(auth);

    // 4. Alice loga, consulta os retornos pendentes e confirma recebimento na conta Nubank
    await signInWithEmailAndPassword(auth, 'alice.rc1@exemplo.com', 'SenhaSegura123!');

    const pendingReturns = await getCustodyReturns(custodyTransferId, false);
    const returnToConfirm = pendingReturns.find((r) => r.status === 'pending_confirmation');
    assert.ok(returnToConfirm, 'Deve haver um retorno aguardando confirmação');

    const confirmedReturnRes = await confirmCustodyReturnReceipt(
      aliceUid,
      {
        transferId: custodyTransferId,
        returnId: returnToConfirm.id,
        destinationAccountId: aliceAccId,
        notes: 'Confirmado Pix de R$ 100 devolvido pelo Bob',
      },
      false
    );
    assert.equal(confirmedReturnRes.returnRecord.status, 'confirmed');
    assert.equal(confirmedReturnRes.transfer.returnedAmountCents, 10000);
    assert.equal(confirmedReturnRes.transfer.reservedForReturnCents, 0);

    await signOut(auth);
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 6: Ciclo de Restituição com Estorno Compensatório
  // ----------------------------------------------------------------------------
  await t.test('6. Restituição: Credor confirma recebimento e posteriormente executa estorno compensatório', async () => {
    // Provisiona via Admin uma obrigação de restituição simulando cota restaurada
    const now = new Date().toISOString();
    const restitId = `rst_sim_${Date.now()}`;
    await adminDb.doc(`spaces/${spaceId}/shared_expenses/${expenseId}/restitutions/${restitId}`).set({
      id: restitId,
      spaceId,
      expenseId,
      debtorUid: bobUid,
      creditorUid: aliceUid,
      amountToRestoreCents: 5000,
      restitutedAmountCents: 0,
      remainingAmountCents: 5000,
      status: 'pending',
      reason: 'Ajuste de restituição após cancelamento parcial',
      createdAt: now,
      updatedAt: now,
    });

    // Alice (Credora) loga e confirma recebimento de R$ 50,00
    await signInWithEmailAndPassword(auth, 'alice.rc1@exemplo.com', 'SenhaSegura123!');

    const receiptRes = await confirmRestitutionReceipt(
      {
        spaceId,
        expenseId,
        restitutionId: restitId,
        creditorUid: aliceUid,
        amountCents: 5000,
        destinationAccountId: aliceAccId,
        notes: 'Pix recebido de restituição',
      },
      false
    );
    assert.equal(receiptRes.restitution.status, 'settled');
    assert.equal(receiptRes.restitution.remainingAmountCents, 0);

    // Alice verifica que o recibo foi emitido
    const receipts = await getRestitutionReceipts(spaceId, expenseId, restitId, false);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].amountCents, 5000);

    // Alice descobre erro contábil e estorna o recebimento da restituição
    const revRes = await reverseRestitutionReceipt(
      aliceUid,
      {
        spaceId,
        expenseId,
        restitutionId: restitId,
        receiptId: receipts[0].id,
        reversalReason: 'Transferência não compensada no extrato real',
      },
      false
    );
    assert.equal(revRes.reversal.amountCents, 5000);
    assert.equal(revRes.restitution.status, 'pending');
    assert.equal(revRes.restitution.remainingAmountCents, 5000);

    await signOut(auth);
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO 7: Bloqueios de Segurança e Governança
  // ----------------------------------------------------------------------------
  await t.test('7. Bloqueios de Governança: Bob tenta aprovar pagamento (bloqueado) e tenta manipular movimentações (rejeitado)', async () => {
    // Bob loga
    await signInWithEmailAndPassword(auth, 'bob.rc1@exemplo.com', 'SenhaSegura123!');

    // Bob tenta aprovar uma obrigação onde Alice é a responsibleUid -> deve lançar erro
    await assert.rejects(
      async () => {
        await approveExpensePayment(
          {
            spaceId,
            expenseId,
            declarationId: bobDeclId,
            approverUid: bobUid,
            destinationAccountId: bobAccId,
          },
          false
        );
      },
      /permission-denied|Acesso negado|Somente o validador/
    );

    // Bob tenta criar um movimento financeiro diretamente na coleção movements -> bloqueado pelas regras
    await assert.rejects(
      async () => {
        const { setDoc } = await import('firebase/firestore');
        await setDoc(doc(db, 'movements', `hack_mov_${Date.now()}`), {
          accountId: bobAccId,
          userId: bobUid,
          direction: 'inflow',
          amountCents: 9999999,
          originType: 'hack',
          description: 'Fundos ilegítimos',
        });
      },
      /PERMISSION_DENIED|false for 'create'/
    );

    await signOut(auth);
  });
});
