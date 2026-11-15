/**
 * Suíte de Testes de Integração Real: Fase 8 — Listas de Aquisição e Copropriedade de Bens
 *
 * Executado contra os emuladores reais de Auth, Firestore e Cloud Functions (Arquitetura v3.1).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
} from 'firebase/firestore';
import { auth, db } from './firebase';
import { archiveAccount, createAccount, getUserAccounts } from './accountService';
import { recordMovement, getAccountMovements } from './ledgerService';
import { generateReversalDocId } from '../utils/movementLedger';
import { createSpace } from './spaceService';
import { createSpaceInvite, acceptSpaceInvite } from './spaceInviteService';
import {
  createAcquisitionList,
  getAcquisitionLists,
  getAcquisitionListById,
  createAcquisitionItem,
  getAcquisitionItemById,
  recordAcquisitionPurchase,
  getAcquisitionPurchases,
  reverseAcquisitionPurchase,
  getAcquisitionPurchaseReversals,
  recordStockMovement,
  getStockMovements,
  recordAcquisitionQuote,
  getAcquisitionQuotes,
  recordAcquisitionDeposit,
  getAcquisitionDeposits,
} from './acquisitionsService';

test('FASE 8 — EMULATOR INTEGRATION: Listas de Aquisição, Checkout e Copropriedade de Bens (v3.1)', async (t) => {
  // 1. Criação e autenticação de Alice
  const aliceCred = await createUserWithEmailAndPassword(
    auth,
    'alice.phase8@exemplo.com',
    'SenhaSegura123!'
  );
  const aliceUid = aliceCred.user.uid;

  // Criação do espaço compartilhado por Alice
  const createdSpace = await createSpace(
    aliceUid,
    'Alice Compradora',
    'alice.phase8@exemplo.com',
    {
      name: 'Espaço Aquisições Compartilhadas',
      description: 'Espaço para testes de bens e copropriedade',
    },
    false
  );
  const spaceId = createdSpace.space.id;

  const inviteBob = await createSpaceInvite(
    spaceId,
    aliceUid,
    'Alice Compradora',
    {
      invitedEmail: 'bob.phase8@exemplo.com',
      invitedRole: 'member',
    },
    false
  );

  await signOut(auth);

  // 2. Criação de Bob e ingresso no espaço
  const bobCred = await createUserWithEmailAndPassword(
    auth,
    'bob.phase8@exemplo.com',
    'SenhaSegura123!'
  );
  const bobUid = bobCred.user.uid;

  await acceptSpaceInvite(
    inviteBob.rawToken,
    { uid: bobUid, displayName: 'Bob Coproprietário', email: 'bob.phase8@exemplo.com' },
    false
  );

  await signOut(auth);

  let sharedListId = '';
  let goalListId = '';
  let recurringItemId = '';
  let goalItemId = '';
  let purchaseId = '';

  await t.test('1. Alice cria lista individual e lista compartilhada vinculada ao espaço no Firestore', async () => {
    await signInWithEmailAndPassword(auth, 'alice.phase8@exemplo.com', 'SenhaSegura123!');

    const indList = await createAcquisitionList(
      aliceUid,
      {
        name: 'Minhas Compras Individuais',
        scopeType: 'individual',
        type: 'recorrente',
      },
      false
    );
    assert.ok(indList.id);
    assert.equal(indList.scopeType, 'individual');
    assert.equal(indList.ownerUid, aliceUid);

    const sharedList = await createAcquisitionList(
      aliceUid,
      {
        name: 'Compras Compartilhadas da Casa',
        scopeType: 'shared',
        type: 'recorrente',
        spaceId,
        memberUids: [aliceUid, bobUid],
      },
      false
    );
    assert.ok(sharedList.id);
    sharedListId = sharedList.id;
    assert.equal(sharedList.scopeType, 'shared');
    assert.equal(sharedList.spaceId, spaceId);

    // Valida persistência no Firestore
    const listSnap = await getDoc(doc(db, 'acquisition_lists', sharedListId));
    assert.ok(listSnap.exists());
    assert.equal(listSnap.data().name, 'Compras Compartilhadas da Casa');
  });

  await t.test('2. Adição de item recorrente com estoque mínimo e movimentação de estoque via Cloud Function', async () => {
    await signInWithEmailAndPassword(auth, 'alice.phase8@exemplo.com', 'SenhaSegura123!');

    const item = await createAcquisitionItem(
      aliceUid,
      sharedListId,
      {
        name: 'Detergente Concentrado 1L',
        groupId: 'grp_limpeza',
        categoryId: 'cat_cozinha',
        currentStock: 2,
        minStock: 1,
        unit: 'L',
      },
      false
    );
    assert.ok(item.id);
    recurringItemId = item.id;
    assert.equal(item.currentStock, 2);
    assert.equal(item.stage, 'estoque');

    // Bob consome 1 unidade (ajuste de estoque negativo via Cloud Function)
    await signInWithEmailAndPassword(auth, 'bob.phase8@exemplo.com', 'SenhaSegura123!');

    const movRes = await recordStockMovement(
      bobUid,
      {
        listId: sharedListId,
        itemId: recurringItemId,
        movementType: 'consumption_outflow',
        quantityDelta: -1,
        justification: 'Uso na limpeza semanal',
        idempotencyKey: 'idem_real_smov_cons_1',
      },
      false
    );

    assert.equal(movRes.movement.quantityDelta, -1);
    assert.equal(movRes.item.currentStock, 1);

    // Valida item atualizado no Firestore
    const itemSnap = await getDoc(doc(db, 'acquisition_lists', sharedListId, 'items', recurringItemId));
    assert.equal(itemSnap.data()?.currentStock, 1);
  });

  await t.test('3. Item de objetivo com cotação de mercado e depósito de poupança com avanço de estágio', async () => {
    await signInWithEmailAndPassword(auth, 'alice.phase8@exemplo.com', 'SenhaSegura123!');

    // Cria lista de objetivos compartilhada
    const goalList = await createAcquisitionList(
      aliceUid,
      {
        name: 'Objetivos e Eletrodomésticos',
        scopeType: 'shared',
        type: 'objetivo',
        spaceId,
        memberUids: [aliceUid, bobUid],
      },
      false
    );
    goalListId = goalList.id;

    const item = await createAcquisitionItem(
      aliceUid,
      goalList.id,
      {
        name: 'Lava-Louças 14 Serviços',
        groupId: 'grp_eletro',
        categoryId: 'cat_cozinha',
        targetAmountCents: 350000, // R$ 3.500,00
      },
      false
    );
    goalItemId = item.id;
    assert.equal(item.stage, 'pesquisa');

    // Alice registra cotação oficial
    const qRes = await recordAcquisitionQuote(
      aliceUid,
      {
        listId: goalList.id,
        itemId: goalItemId,
        storeName: 'Ponto Frio',
        priceCents: 349900,
        url: 'https://pontofrio.com.br/lava-loucas',
        validUntil: '2026-12-31',
        idempotencyKey: 'idem_real_quote_1',
      },
      false
    );
    assert.ok(qRes.quote.id);
    assert.equal(qRes.quote.priceCents, 349900);

    // Bob registra aporte de poupança atingindo a meta
    await signInWithEmailAndPassword(auth, 'bob.phase8@exemplo.com', 'SenhaSegura123!');

    const depRes = await recordAcquisitionDeposit(
      bobUid,
      {
        listId: goalList.id,
        itemId: goalItemId,
        amountCents: 350000,
        notes: 'Aporte integral para aquisição da lava-louças',
        idempotencyKey: 'idem_real_dep_1',
      },
      false
    );

    assert.equal(depRes.item.savedAmountCents, 350000);
    assert.equal(depRes.item.stage, 'pronto', 'Atingir o valor-alvo deve mudar o estágio para pronto');
  });

  await t.test('4. Checkout Compartilhado via Cloud Function: calcula copropriedade estritamente proporcional aos desembolsos', async () => {
    await signInWithEmailAndPassword(auth, 'alice.phase8@exemplo.com', 'SenhaSegura123!');

    // Compra de R$ 1.000,00 do item recorrente (3 unidades a R$ 300,00 cada + R$ 100,00 frete)
    // Alice desembolsa R$ 300,00 (30%) e Bob desembolsa R$ 700,00 (70%)
    const checkoutRes = await recordAcquisitionPurchase(
      aliceUid,
      {
        listId: sharedListId,
        itemId: recurringItemId,
        storeName: 'Distribuidora Central',
        brand: 'CleanMax',
        quantity: 3,
        unitPriceCents: 30000,
        itemsNetCents: 90000,
        shippingCents: 10000,
        totalPaidCents: 100000, // R$ 1.000,00
        ownershipClassification: 'shared_participants',
        disbursements: [
          {
            funderUid: aliceUid,
            funderName: 'Alice',
            disbursedAmountCents: 30000,
            fundingSource: 'checking',
          },
          {
            funderUid: bobUid,
            funderName: 'Bob',
            disbursedAmountCents: 70000,
            fundingSource: 'credit_card',
          },
        ],
        idempotencyKey: 'idem_real_pur_detergente_1000',
      },
      false
    );

    assert.ok(checkoutRes.purchase.id);
    purchaseId = checkoutRes.purchase.id;
    assert.equal(checkoutRes.purchase.totalPaidCents, 100000);
    assert.equal(checkoutRes.purchase.ownershipShares.length, 2);

    const aliceShare = checkoutRes.purchase.ownershipShares.find((s) => s.uid === aliceUid);
    const bobShare = checkoutRes.purchase.ownershipShares.find((s) => s.uid === bobUid);

    assert.ok(aliceShare);
    assert.equal(aliceShare.disbursedAmountCents, 30000);
    assert.equal(aliceShare.ownershipPercentage, 30);

    assert.ok(bobShare);
    assert.equal(bobShare.disbursedAmountCents, 70000);
    assert.equal(bobShare.ownershipPercentage, 70);

    // Valida atualização do estoque: 1 (anterior) + 3 (comprado) = 4
    assert.equal(checkoutRes.item.currentStock, 4);
    assert.equal(checkoutRes.item.stage, 'conferido');

    // Valida auditoria gerada no espaço
    const auditSnap = await getDoc(
      doc(db, 'spaces', spaceId, 'audit', `audit_acq_pur_${purchaseId}`)
    );
    assert.ok(auditSnap.exists(), 'Auditoria de aquisição deve existir no espaço');
    assert.equal(auditSnap.data().eventType, 'acquisition_purchased');
  });

  await t.test('5. Replay idempotente no servidor retorna documento existente sem duplicar estoque', async () => {
    await signInWithEmailAndPassword(auth, 'alice.phase8@exemplo.com', 'SenhaSegura123!');

    const resReplay = await recordAcquisitionPurchase(
      aliceUid,
      {
        listId: sharedListId,
        itemId: recurringItemId,
        storeName: 'Distribuidora Central',
        quantity: 3,
        unitPriceCents: 30000,
        itemsNetCents: 90000,
        shippingCents: 10000,
        totalPaidCents: 100000,
        disbursements: [
          {
            funderUid: aliceUid,
            funderName: 'Alice',
            disbursedAmountCents: 30000,
            fundingSource: 'checking',
          },
          {
            funderUid: bobUid,
            funderName: 'Bob',
            disbursedAmountCents: 70000,
            fundingSource: 'credit_card',
          },
        ],
        idempotencyKey: 'idem_real_pur_detergente_1000',
      },
      false
    );

    assert.equal(resReplay.isIdempotentReplay, true);
    assert.equal(resReplay.purchase.id, purchaseId);

    // O estoque no Firestore permanece 4
    const itemSnap = await getDoc(doc(db, 'acquisition_lists', sharedListId, 'items', recurringItemId));
    assert.equal(itemSnap.data()?.currentStock, 4);
  });

  await t.test('6. Rejeita checkout com soma de desembolsos divergente do total pago', async () => {
    await signInWithEmailAndPassword(auth, 'alice.phase8@exemplo.com', 'SenhaSegura123!');

    await assert.rejects(
      async () => {
        await recordAcquisitionPurchase(
          aliceUid,
          {
            listId: sharedListId,
            itemId: recurringItemId,
            storeName: 'Loja Teste',
            quantity: 1,
            unitPriceCents: 5000,
            itemsNetCents: 5000,
            totalPaidCents: 5000,
            disbursements: [
              {
                funderUid: aliceUid,
                funderName: 'Alice',
                disbursedAmountCents: 4000, // Diverge de 5000!
                fundingSource: 'checking',
              },
            ],
            idempotencyKey: 'idem_divergent_cents',
          },
          false
        );
      },
      /(invalid-argument|400|exatamente igual)/
    );
  });

  await t.test('7. Imutabilidade Patrimonial nas Firestore Rules: proíbe alteração ou deleção de compra consolidada', async () => {
    await signInWithEmailAndPassword(auth, 'alice.phase8@exemplo.com', 'SenhaSegura123!');

    const purchaseRef = doc(
      db,
      'acquisition_lists',
      sharedListId,
      'items',
      recurringItemId,
      'purchases',
      purchaseId
    );

    // Tentativa do cliente de alterar os percentuais de copropriedade
    await assert.rejects(
      async () => {
        await updateDoc(purchaseRef, {
          'ownershipShares.0.ownershipPercentage': 99,
        });
      },
      /(permission-denied|PERMISSION_DENIED|false for 'update')/
    );

    // Tentativa do cliente de deletar o documento da compra
    await assert.rejects(
      async () => {
        await deleteDoc(purchaseRef);
      },
      /(permission-denied|PERMISSION_DENIED|false for 'delete')/
    );
  });

  await t.test('8. Segurança nas Cloud Functions de Aquisição: usuário externo (Eve) é bloqueado em estoque, cotação, depósito e checkout', async () => {
    const eveCred = await createUserWithEmailAndPassword(
      auth,
      'eve.phase8@exemplo.com',
      'SenhaSegura123!'
    );
    const eveUid = eveCred.user.uid;

    await assert.rejects(
      async () => {
        await recordStockMovement(
          eveUid,
          {
            listId: sharedListId,
            itemId: recurringItemId,
            movementType: 'manual_adjustment',
            quantityDelta: 50,
            idempotencyKey: 'idem_eve_smov_hack',
          },
          false
        );
      },
      /(permission-denied|Apenas membros do espaço)/
    );

    await assert.rejects(
      async () => {
        await recordAcquisitionQuote(
          eveUid,
          {
            listId: sharedListId,
            itemId: recurringItemId,
            storeName: 'Loja Falsa Eve',
            priceCents: 100,
            idempotencyKey: 'idem_eve_quote_hack',
          },
          false
        );
      },
      /(permission-denied|Apenas membros do espaço)/
    );

    await assert.rejects(
      async () => {
        await recordAcquisitionDeposit(
          eveUid,
          {
            listId: sharedListId,
            itemId: recurringItemId,
            amountCents: 5000,
            idempotencyKey: 'idem_eve_dep_hack',
          },
          false
        );
      },
      /(permission-denied|Apenas membros do espaço)/
    );

    await assert.rejects(
      async () => {
        await recordAcquisitionPurchase(
          eveUid,
          {
            listId: sharedListId,
            itemId: recurringItemId,
            storeName: 'Loja Hack Eve',
            quantity: 1,
            unitPriceCents: 1000,
            itemsNetCents: 1000,
            totalPaidCents: 1000,
            disbursements: [
              {
                funderUid: eveUid,
                funderName: 'Eve',
                disbursedAmountCents: 1000,
                fundingSource: 'checking',
              },
            ],
            idempotencyKey: 'idem_eve_pur_hack',
          },
          false
        );
      },
      /(permission-denied|Apenas membros do espaço)/
    );
  });

  // ============================================================================
  // TESTES DE INTEGRIDADE CONTÁBIL E ESTORNO DE AQUISIÇÕES (RC1)
  // ============================================================================
  let aliceAccId = '';
  let normalRecPurchaseId = '';
  let normalGoalPurchaseId = '';
  let stockBeforeNormalCheckout = 0;

  const getAliceAccountSnapshot = async () => {
    const accounts = await getUserAccounts(aliceUid, false);
    const acc = accounts.find((a) => a.id === aliceAccId);
    assert.ok(acc, 'Conta de Alice deve existir no Firestore');
    const movements = await getAccountMovements(aliceAccId, aliceUid, false);
    return { balanceCents: acc.projectedBalanceCents, movementCount: movements.length, movements };
  };

  await t.test('9. Checkout normal sem sourceAccountId preserva financiadores e não altera saldo ou movimentos da conta', async () => {
    await signInWithEmailAndPassword(auth, 'alice.phase8@exemplo.com', 'SenhaSegura123!');

    // Cria conta financeira de Alice com saldo inicial de R$ 1.000,00 (100000 centavos)
    const aliceAcc = await createAccount(
      aliceUid,
      { name: 'Conta Corrente Alice Fase 8', type: 'checking' },
      false
    );
    aliceAccId = aliceAcc.id;

    await recordMovement(
      {
        accountId: aliceAccId,
        userId: aliceUid,
        authorUid: aliceUid,
        direction: 'inflow',
        amountCents: 100000,
        effectiveDate: '2026-11-15',
        originType: 'manual_adjustment',
        originId: `init_${aliceAccId}`,
        description: 'Saldo inicial Alice',
        notes: 'Saldo inicial para teste de integridade contábil da Fase 8',
        idempotencyKey: `idem_init_${aliceAccId}`,
      },
      false
    );

    const beforeAcc = await getAliceAccountSnapshot();
    assert.equal(beforeAcc.balanceCents, 100000);
    assert.equal(beforeAcc.movementCount, 1);

    const itemBefore = await getAcquisitionItemById(sharedListId, recurringItemId, false);
    assert.ok(itemBefore);
    stockBeforeNormalCheckout = itemBefore.currentStock || 0;

    // 9A. Checkout em item recorrente sem sourceAccountId
    const recCheckout = await recordAcquisitionPurchase(
      aliceUid,
      {
        listId: sharedListId,
        itemId: recurringItemId,
        storeName: 'Atacado Limpeza',
        quantity: 2,
        unitPriceCents: 6000,
        itemsNetCents: 12000,
        totalPaidCents: 12000,
        ownershipClassification: 'shared_participants',
        disbursements: [
          {
            funderUid: aliceUid,
            funderName: 'Alice',
            disbursedAmountCents: 12000,
            fundingSource: 'checking',
          },
        ],
        idempotencyKey: 'idem_rc1_normal_rec_checkout',
      },
      false
    );

    normalRecPurchaseId = recCheckout.purchase.id;
    assert.equal(recCheckout.purchase.disbursements[0].funderUid, aliceUid);
    assert.equal(recCheckout.purchase.disbursements[0].funderName, 'Alice');
    assert.equal(recCheckout.purchase.disbursements[0].disbursedAmountCents, 12000);
    assert.equal(recCheckout.purchase.disbursements[0].fundingSource, 'checking');
    assert.equal(recCheckout.purchase.disbursements[0].sourceAccountId, null);
    assert.equal(recCheckout.item.currentStock, stockBeforeNormalCheckout + 2);
    assert.equal(recCheckout.item.stage, 'conferido');

    // 9B. Checkout em item não recorrente (objetivo) sem sourceAccountId
    const goalCheckout = await recordAcquisitionPurchase(
      aliceUid,
      {
        listId: goalListId,
        itemId: goalItemId,
        storeName: 'Ponto Frio',
        quantity: 1,
        unitPriceCents: 349900,
        itemsNetCents: 349900,
        totalPaidCents: 349900,
        ownershipClassification: 'shared_participants',
        disbursements: [
          {
            funderUid: aliceUid,
            funderName: 'Alice',
            disbursedAmountCents: 349900,
            fundingSource: 'checking',
          },
        ],
        idempotencyKey: 'idem_rc1_normal_goal_checkout',
      },
      false
    );

    normalGoalPurchaseId = goalCheckout.purchase.id;
    assert.equal(goalCheckout.purchase.disbursements[0].sourceAccountId, null);
    assert.equal(goalCheckout.item.stage, 'adquirido');
    assert.equal(goalCheckout.item.finalPaidAmountCents, 349900);

    const afterAcc = await getAliceAccountSnapshot();
    assert.equal(afterAcc.balanceCents, 100000);
    assert.equal(afterAcc.movementCount, 1);
  });

  await t.test('10. Estorno normal reverte estoque (recorrente) e estágio (objetivo) sem gerar movimentações financeiras indevidas', async () => {
    await signInWithEmailAndPassword(auth, 'alice.phase8@exemplo.com', 'SenhaSegura123!');

    const beforeAcc = await getAliceAccountSnapshot();
    assert.equal(beforeAcc.balanceCents, 100000);
    assert.equal(beforeAcc.movementCount, 1);

    // 10A. Estorno do item recorrente
    const smovsBeforeRec = await getStockMovements(sharedListId, recurringItemId, false);
    const revRec = await reverseAcquisitionPurchase(
      aliceUid,
      {
        listId: sharedListId,
        itemId: recurringItemId,
        purchaseId: normalRecPurchaseId,
        reversalReason: 'Devolução parcial validada em homologação',
        idempotencyKey: 'idem_rc1_rev_rec_1',
      },
      false
    );

    assert.equal(revRec.isIdempotentReplay, false);
    assert.equal(revRec.item.currentStock, stockBeforeNormalCheckout);
    const smovsAfterRec = await getStockMovements(sharedListId, recurringItemId, false);
    assert.equal(smovsAfterRec.length, smovsBeforeRec.length + 1);
    const revStockMov = smovsAfterRec.find(
      (m) =>
        m.movementType === 'reversal_outflow' &&
        m.justification === 'Devolução parcial validada em homologação'
    );
    assert.ok(revStockMov);
    assert.equal(revStockMov?.quantityDelta, -2);

    const recReversals = await getAcquisitionPurchaseReversals(sharedListId, recurringItemId, false);
    assert.equal(recReversals.filter((r) => r.purchaseId === normalRecPurchaseId).length, 1);

    // 10B. Estorno do item não recorrente (objetivo)
    const revGoal = await reverseAcquisitionPurchase(
      aliceUid,
      {
        listId: goalListId,
        itemId: goalItemId,
        purchaseId: normalGoalPurchaseId,
        reversalReason: 'Cancelamento de pedido antes da entrega',
        idempotencyKey: 'idem_rc1_rev_goal_1',
      },
      false
    );

    assert.equal(revGoal.isIdempotentReplay, false);
    assert.equal(revGoal.item.stage, 'cotado');
    assert.equal(revGoal.item.finalPaidAmountCents, null);
    const smovsGoal = await getStockMovements(goalListId, goalItemId, false);
    assert.equal(smovsGoal.length, 0);
    const goalReversals = await getAcquisitionPurchaseReversals(goalListId, goalItemId, false);
    assert.equal(goalReversals.filter((r) => r.purchaseId === normalGoalPurchaseId).length, 1);

    // Saldo e movimentos financeiros inalterados
    const afterAcc = await getAliceAccountSnapshot();
    assert.equal(afterAcc.balanceCents, 100000);
    assert.equal(afterAcc.movementCount, 1);
  });

  await t.test('11. Estorno repetido (idempotente) não decrementa estoque duas vezes nem altera saldo', async () => {
    await signInWithEmailAndPassword(auth, 'alice.phase8@exemplo.com', 'SenhaSegura123!');

    const beforeAcc = await getAliceAccountSnapshot();
    const smovsBefore = await getStockMovements(sharedListId, recurringItemId, false);

    const replay = await reverseAcquisitionPurchase(
      aliceUid,
      {
        listId: sharedListId,
        itemId: recurringItemId,
        purchaseId: normalRecPurchaseId,
        reversalReason: 'Devolução parcial validada em homologação',
        idempotencyKey: 'idem_rc1_rev_rec_1',
      },
      false
    );

    assert.equal(replay.isIdempotentReplay, true);
    assert.equal(replay.item.currentStock, stockBeforeNormalCheckout);

    const itemAfter = await getAcquisitionItemById(sharedListId, recurringItemId, false);
    assert.equal(itemAfter?.currentStock, stockBeforeNormalCheckout);

    const smovsAfter = await getStockMovements(sharedListId, recurringItemId, false);
    assert.equal(smovsAfter.length, smovsBefore.length);

    const recReversals = await getAcquisitionPurchaseReversals(sharedListId, recurringItemId, false);
    assert.equal(recReversals.filter((r) => r.purchaseId === normalRecPurchaseId).length, 1);

    const afterAcc = await getAliceAccountSnapshot();
    assert.equal(afterAcc.balanceCents, beforeAcc.balanceCents);
    assert.equal(afterAcc.movementCount, beforeAcc.movementCount);
  });

  await t.test('12. Checkout com sourceAccountId preenchido é rejeitado sem persistir compra nem alterar estoque ou saldo', async () => {
    await signInWithEmailAndPassword(auth, 'alice.phase8@exemplo.com', 'SenhaSegura123!');

    const beforeAcc = await getAliceAccountSnapshot();
    const itemBefore = await getAcquisitionItemById(sharedListId, recurringItemId, false);
    const purchasesBefore = await getAcquisitionPurchases(sharedListId, recurringItemId, false);

    await assert.rejects(
      async () => {
        await recordAcquisitionPurchase(
          aliceUid,
          {
            listId: sharedListId,
            itemId: recurringItemId,
            storeName: 'Loja Bloqueada',
            quantity: 1,
            unitPriceCents: 5000,
            itemsNetCents: 5000,
            totalPaidCents: 5000,
            disbursements: [
              {
                funderUid: aliceUid,
                funderName: 'Alice',
                disbursedAmountCents: 5000,
                fundingSource: 'checking',
                sourceAccountId: aliceAccId,
              },
            ],
            idempotencyKey: 'idem_rc1_blocked_source_account',
          },
          false
        );
      },
      /(invalid-argument|ainda não está disponível|sourceAccountId)/i
    );

    const afterAcc = await getAliceAccountSnapshot();
    assert.equal(afterAcc.balanceCents, beforeAcc.balanceCents);
    assert.equal(afterAcc.movementCount, beforeAcc.movementCount);

    const itemAfter = await getAcquisitionItemById(sharedListId, recurringItemId, false);
    assert.equal(itemAfter?.currentStock, itemBefore?.currentStock);

    const purchasesAfter = await getAcquisitionPurchases(sharedListId, recurringItemId, false);
    assert.equal(purchasesAfter.length, purchasesBefore.length);
  });

  await t.test('13. Compra histórica com sourceAccountId sem débito correspondente bloqueia estorno com failed-precondition e zero mutações parciais', async () => {
    await signInWithEmailAndPassword(auth, 'alice.phase8@exemplo.com', 'SenhaSegura123!');

    const { initializeApp: initAdmin, getApps: getAdminApps } = await import('firebase-admin/app');
    const { getFirestore: getAdminFirestore } = await import('firebase-admin/firestore');
    const adminApp = getAdminApps().length
      ? getAdminApps()[0]
      : initAdmin({ projectId: 'demo-projeto-beta-v3' });
    const adminDb = getAdminFirestore(adminApp);

    const beforeAcc = await getAliceAccountSnapshot();
    assert.equal(beforeAcc.balanceCents, 100000);
    assert.equal(beforeAcc.movementCount, 1);

    // 13A. Semeia compra histórica com sourceAccountId (sem débito) em item recorrente
    const histRecPurchaseId = 'pur_hist_rc1_rec_sem_debito';
    const recItemRef = adminDb.doc(`acquisition_lists/${sharedListId}/items/${recurringItemId}`);
    const recSnapBeforeSeed = await recItemRef.get();
    const expectedRecStock = (recSnapBeforeSeed.data()?.currentStock || 0) + 2;
    await recItemRef.update({ currentStock: expectedRecStock, stage: 'conferido' });

    const histRecPurchaseDoc = {
      id: histRecPurchaseId,
      itemId: recurringItemId,
      listId: sharedListId,
      spaceId,
      physicalBuyerUid: aliceUid,
      authorUid: aliceUid,
      storeName: 'Fornecedor Histórico Recorrente',
      quantity: 2,
      unitPriceCents: 10000,
      itemsNetCents: 20000,
      shippingCents: 0,
      feesCents: 0,
      discountsCents: 0,
      totalPaidCents: 20000,
      purchaseDate: '2026-10-10',
      ownershipClassification: 'individual',
      disbursements: [
        {
          funderUid: aliceUid,
          funderName: 'Alice',
          disbursedAmountCents: 20000,
          fundingSource: 'checking',
          sourceAccountId: aliceAccId,
        },
      ],
      ownershipShares: [
        {
          uid: aliceUid,
          name: 'Alice',
          disbursedAmountCents: 20000,
          ownershipPercentage: 100,
        },
      ],
      idempotencyKey: 'idem_hist_rc1_rec',
      createdAt: '2026-10-10T10:00:00.000Z',
    };
    await recItemRef.collection('purchases').doc(histRecPurchaseId).set(histRecPurchaseDoc);

    const smovsBeforeRecHist = await getStockMovements(sharedListId, recurringItemId, false);
    const reversalsBeforeRecHist = await getAcquisitionPurchaseReversals(sharedListId, recurringItemId, false);

    await assert.rejects(
      async () => {
        await reverseAcquisitionPurchase(
          aliceUid,
          {
            listId: sharedListId,
            itemId: recurringItemId,
            purchaseId: histRecPurchaseId,
            reversalReason: 'Tentativa de estorno histórico sem débito',
            idempotencyKey: 'idem_rev_hist_rc1_rec',
          },
          false
        );
      },
      /(failed-precondition|Estorno automático bloqueado para análise)/i
    );

    // Zero mutações parciais no item recorrente, subcoleções, auditoria e conta
    const recItemAfterFail = await getAcquisitionItemById(sharedListId, recurringItemId, false);
    assert.equal(recItemAfterFail?.currentStock, expectedRecStock);
    assert.equal(recItemAfterFail?.stage, 'conferido');
    const smovsAfterRecHist = await getStockMovements(sharedListId, recurringItemId, false);
    assert.equal(smovsAfterRecHist.length, smovsBeforeRecHist.length);
    const reversalsAfterRecHist = await getAcquisitionPurchaseReversals(sharedListId, recurringItemId, false);
    assert.equal(reversalsAfterRecHist.length, reversalsBeforeRecHist.length);
    const rawHistRecSnap = await recItemRef.collection('purchases').doc(histRecPurchaseId).get();
    assert.equal(rawHistRecSnap.exists, true);
    assert.equal(rawHistRecSnap.data()?.disbursements?.[0]?.sourceAccountId, aliceAccId);

    const afterRecFailAcc = await getAliceAccountSnapshot();
    assert.equal(afterRecFailAcc.balanceCents, 100000);
    assert.equal(afterRecFailAcc.movementCount, 1);

    // 13B. Semeia item não recorrente (objetivo) com compra histórica com sourceAccountId sem débito
    const histGoalItem = await createAcquisitionItem(
      aliceUid,
      goalListId,
      {
        name: 'Cafeteira Histórica',
        groupId: 'grp_eletro',
        categoryId: 'cat_cozinha',
        targetAmountCents: 150000,
      },
      false
    );
    const histGoalPurchaseId = 'pur_hist_rc1_goal_sem_debito';
    const histGoalItemRef = adminDb.doc(`acquisition_lists/${goalListId}/items/${histGoalItem.id}`);
    await histGoalItemRef.update({
      stage: 'adquirido',
      finalPaidAmountCents: 150000,
    });
    await histGoalItemRef.collection('purchases').doc(histGoalPurchaseId).set({
      id: histGoalPurchaseId,
      itemId: histGoalItem.id,
      listId: goalListId,
      spaceId,
      physicalBuyerUid: aliceUid,
      authorUid: aliceUid,
      storeName: 'Loja Histórica',
      quantity: 1,
      unitPriceCents: 150000,
      itemsNetCents: 150000,
      shippingCents: 0,
      feesCents: 0,
      discountsCents: 0,
      totalPaidCents: 150000,
      purchaseDate: '2026-10-12',
      ownershipClassification: 'individual',
      disbursements: [
        {
          funderUid: aliceUid,
          funderName: 'Alice',
          disbursedAmountCents: 150000,
          fundingSource: 'checking',
          sourceAccountId: aliceAccId,
        },
      ],
      ownershipShares: [
        {
          uid: aliceUid,
          name: 'Alice',
          disbursedAmountCents: 150000,
          ownershipPercentage: 100,
        },
      ],
      idempotencyKey: 'idem_hist_rc1_goal',
      createdAt: '2026-10-12T10:00:00.000Z',
    });

    await assert.rejects(
      async () => {
        await reverseAcquisitionPurchase(
          aliceUid,
          {
            listId: goalListId,
            itemId: histGoalItem.id,
            purchaseId: histGoalPurchaseId,
            reversalReason: 'Tentativa de estorno histórico objetivo sem débito',
            idempotencyKey: 'idem_rev_hist_rc1_goal',
          },
          false
        );
      },
      /(failed-precondition|Estorno automático bloqueado para análise)/i
    );

    const histGoalAfter = await getAcquisitionItemById(goalListId, histGoalItem.id, false);
    assert.equal(histGoalAfter?.stage, 'adquirido');
    assert.equal(histGoalAfter?.finalPaidAmountCents, 150000);
    const histGoalReversals = await getAcquisitionPurchaseReversals(goalListId, histGoalItem.id, false);
    assert.equal(histGoalReversals.length, 0);
    const rawHistGoalPurSnap = await histGoalItemRef.collection('purchases').doc(histGoalPurchaseId).get();
    assert.equal(rawHistGoalPurSnap.exists, true);

    // Confirma que nenhum evento de estorno foi gravado na auditoria para as compras históricas bloqueadas
    const auditSnaps = await getDocs(collection(db, 'spaces', spaceId, 'audit'));
    const blockedRevAudits = auditSnaps.docs.filter((d) => {
      const data = d.data();
      return (
        data.eventType === 'acquisition_purchase_reversed' &&
        (data.details?.purchaseId === histRecPurchaseId || data.details?.purchaseId === histGoalPurchaseId)
      );
    });
    assert.equal(blockedRevAudits.length, 0);

    const finalAcc = await getAliceAccountSnapshot();
    assert.equal(finalAcc.balanceCents, 100000);
    assert.equal(finalAcc.movementCount, 1);
  });

  // ============================================================================
  // TESTES PERMANENTES DE COMPENSAÇÃO LEGÍTIMA E SEGURANÇA DE ESTORNO (RC1)
  // ============================================================================
  let compAccId = '';

  await t.test('14. Compensação financeira legítima: estorna compra histórica com débito verificável (rev_...), restaura saldo e bloqueia 2ª tentativa com idempotencyKey diferente', async () => {
    await signInWithEmailAndPassword(auth, 'alice.phase8@exemplo.com', 'SenhaSegura123!');

    const { initializeApp: initAdmin, getApps: getAdminApps } = await import('firebase-admin/app');
    const { getFirestore: getAdminFirestore } = await import('firebase-admin/firestore');
    const adminApp = getAdminApps().length
      ? getAdminApps()[0]
      : initAdmin({ projectId: 'demo-projeto-beta-v3' });
    const adminDb = getAdminFirestore(adminApp);

    // 1. Conta dedicada com saldo inicial de R$ 1.000,00 (100000 centavos)
    const compAcc = await createAccount(
      aliceUid,
      { name: 'Conta Compensação Legítima Fase 8', type: 'checking' },
      false
    );
    compAccId = compAcc.id;

    await recordMovement(
      {
        accountId: compAccId,
        userId: aliceUid,
        authorUid: aliceUid,
        direction: 'inflow',
        amountCents: 100000,
        effectiveDate: '2026-11-15',
        originType: 'manual_adjustment',
        originId: `init_${compAccId}`,
        description: 'Saldo inicial R$ 1.000,00',
        notes: 'Saldo inicial para teste permanente de compensação legítima',
        idempotencyKey: `idem_init_${compAccId}`,
      },
      false
    );

    const accInit = (await getUserAccounts(aliceUid, false)).find((a) => a.id === compAccId);
    assert.equal(accInit?.projectedBalanceCents, 100000);

    // Item recorrente dedicado para rastreio exato de estoque
    const compItem = await createAcquisitionItem(
      aliceUid,
      sharedListId,
      {
        name: 'Filtro Purificador Compensação',
        groupId: 'grp_casa',
        categoryId: 'cat_cozinha',
        currentStock: 4,
      },
      false
    );
    await adminDb.doc(`acquisition_lists/${sharedListId}/items/${compItem.id}`).update({
      stage: 'conferido',
    });

    // 2. Registra débito real de R$ 300,00 (30000 centavos) vinculado à compra
    const compPurchaseId = 'pur_comp_legit_rc1_300';
    const debitMov = await recordMovement(
      {
        accountId: compAccId,
        userId: aliceUid,
        authorUid: aliceUid,
        direction: 'outflow',
        amountCents: 30000,
        effectiveDate: '2026-11-15',
        originType: 'acquisition_checkout',
        originId: compPurchaseId,
        description: 'Débito real de compra de aquisição R$ 300,00',
        idempotencyKey: 'idem_debit_comp_legit_300',
      },
      false
    );

    const accAfterDebit = (await getUserAccounts(aliceUid, false)).find((a) => a.id === compAccId);
    assert.equal(accAfterDebit?.projectedBalanceCents, 70000);

    // 3. Compra histórica com sourceAccountId apontando para a conta debitada
    await adminDb
      .doc(`acquisition_lists/${sharedListId}/items/${compItem.id}/purchases/${compPurchaseId}`)
      .set({
        id: compPurchaseId,
        itemId: compItem.id,
        listId: sharedListId,
        spaceId,
        physicalBuyerUid: aliceUid,
        authorUid: aliceUid,
        storeName: 'Loja Compensação Legítima',
        quantity: 1,
        unitPriceCents: 30000,
        itemsNetCents: 30000,
        shippingCents: 0,
        feesCents: 0,
        discountsCents: 0,
        totalPaidCents: 30000,
        purchaseDate: '2026-11-15',
        ownershipClassification: 'individual',
        disbursements: [
          {
            funderUid: aliceUid,
            funderName: 'Alice',
            disbursedAmountCents: 30000,
            fundingSource: 'checking',
            sourceAccountId: compAccId,
          },
        ],
        ownershipShares: [
          {
            uid: aliceUid,
            name: 'Alice',
            disbursedAmountCents: 30000,
            ownershipPercentage: 100,
          },
        ],
        idempotencyKey: 'idem_pur_comp_legit_300',
        createdAt: '2026-11-15T10:00:00.000Z',
      });

    // 4. Estorno via Cloud Function oficial
    const rev1 = await reverseAcquisitionPurchase(
      aliceUid,
      {
        listId: sharedListId,
        itemId: compItem.id,
        purchaseId: compPurchaseId,
        reversalReason: 'Estorno legítimo com débito comprovado',
        idempotencyKey: 'idem_rev_comp_legit_1',
      },
      false
    );
    assert.equal(rev1.isIdempotentReplay, false);

    // 5-8. Valida movimento compensatório único, padrão rev_..., referência ao débito e saldo restaurado
    const movsAfter1 = await getAccountMovements(compAccId, aliceUid, false);
    const compMovs1 = movsAfter1.filter((m) => m.reversalOfMovementId === debitMov.id);
    assert.equal(compMovs1.length, 1);
    assert.equal(compMovs1[0].direction, 'inflow');
    assert.equal(compMovs1[0].amountCents, 30000);
    assert.equal(compMovs1[0].reversalOfMovementId, debitMov.id);
    assert.equal(compMovs1[0].id, generateReversalDocId(debitMov.id));
    assert.ok(compMovs1[0].id.startsWith('rev_'));
    assert.equal(compMovs1[0].originType, 'acquisition_reversal');
    assert.equal(compMovs1[0].originId, rev1.reversal.id);
    assert.equal(compMovs1[0].idempotencyKey, `reversal_${debitMov.id}`);

    const accAfterRev1 = (await getUserAccounts(aliceUid, false)).find((a) => a.id === compAccId);
    assert.equal(accAfterRev1?.projectedBalanceCents, 100000);
    assert.equal(movsAfter1.length, 3);

    const itemAfterRev1 = await getAcquisitionItemById(sharedListId, compItem.id, false);
    assert.equal(itemAfterRev1?.currentStock, 3);
    const smovsAfterRev1 = await getStockMovements(sharedListId, compItem.id, false);
    assert.equal(smovsAfterRev1.length, 1);
    assert.equal(smovsAfterRev1[0].movementType, 'reversal_outflow');
    const reversalsAfterRev1 = await getAcquisitionPurchaseReversals(sharedListId, compItem.id, false);
    assert.equal(reversalsAfterRev1.length, 1);

    // 9-10. Segunda tentativa com idempotencyKey DIFERENTE não gera outro crédito nem altera estoque
    const rev2 = await reverseAcquisitionPurchase(
      aliceUid,
      {
        listId: sharedListId,
        itemId: compItem.id,
        purchaseId: compPurchaseId,
        reversalReason: 'Segunda tentativa com outra chave',
        idempotencyKey: 'idem_rev_comp_legit_2_outra_chave',
      },
      false
    );
    assert.equal(rev2.isIdempotentReplay, true);
    assert.equal(rev2.reversal.id, rev1.reversal.id);

    const movsAfter2 = await getAccountMovements(compAccId, aliceUid, false);
    const accAfterRev2 = (await getUserAccounts(aliceUid, false)).find((a) => a.id === compAccId);
    assert.equal(movsAfter2.length, 3);
    assert.equal(movsAfter2.filter((m) => m.reversalOfMovementId === debitMov.id).length, 1);
    assert.equal(accAfterRev2?.projectedBalanceCents, 100000);

    const itemAfterRev2 = await getAcquisitionItemById(sharedListId, compItem.id, false);
    assert.equal(itemAfterRev2?.currentStock, 3);
    const smovsAfterRev2 = await getStockMovements(sharedListId, compItem.id, false);
    assert.equal(smovsAfterRev2.length, 1);
    const reversalsAfterRev2 = await getAcquisitionPurchaseReversals(sharedListId, compItem.id, false);
    assert.equal(reversalsAfterRev2.length, 1);
  });

  await t.test('15. Testes negativos de segurança no estorno: bloqueia conta inexistente, arquivada, de outro usuário, sem débito, valor divergente e origem/titularidade incompatível sem mutações parciais', async () => {
    await signInWithEmailAndPassword(auth, 'alice.phase8@exemplo.com', 'SenhaSegura123!');

    const { initializeApp: initAdmin, getApps: getAdminApps } = await import('firebase-admin/app');
    const { getFirestore: getAdminFirestore } = await import('firebase-admin/firestore');
    const adminApp = getAdminApps().length
      ? getAdminApps()[0]
      : initAdmin({ projectId: 'demo-projeto-beta-v3' });
    const adminDb = getAdminFirestore(adminApp);

    const secItem = await createAcquisitionItem(
      aliceUid,
      sharedListId,
      {
        name: 'Item Segurança Negativa Estorno',
        groupId: 'grp_casa',
        categoryId: 'cat_cozinha',
        currentStock: 10,
      },
      false
    );
    await adminDb.doc(`acquisition_lists/${sharedListId}/items/${secItem.id}`).update({
      stage: 'conferido',
    });

    const seedPurchase = async (purchaseId: string, disbursements: Array<Record<string, unknown>>, totalPaidCents: number) => {
      await adminDb
        .doc(`acquisition_lists/${sharedListId}/items/${secItem.id}/purchases/${purchaseId}`)
        .set({
          id: purchaseId,
          itemId: secItem.id,
          listId: sharedListId,
          spaceId,
          physicalBuyerUid: aliceUid,
          authorUid: aliceUid,
          storeName: 'Loja Segurança',
          quantity: 2,
          unitPriceCents: Math.floor(totalPaidCents / 2),
          itemsNetCents: totalPaidCents,
          shippingCents: 0,
          feesCents: 0,
          discountsCents: 0,
          totalPaidCents,
          purchaseDate: '2026-11-15',
          ownershipClassification: 'individual',
          disbursements,
          ownershipShares: [
            {
              uid: String(disbursements[0].funderUid),
              name: String(disbursements[0].funderName),
              disbursedAmountCents: totalPaidCents,
              ownershipPercentage: 100,
            },
          ],
          idempotencyKey: `idem_${purchaseId}`,
          createdAt: '2026-11-15T10:00:00.000Z',
        });
    };

    const assertZeroMutationsForPurchase = async (purchaseId: string) => {
      const itemSnap = await getAcquisitionItemById(sharedListId, secItem.id, false);
      assert.equal(itemSnap?.currentStock, 10);
      assert.equal(itemSnap?.stage, 'conferido');
      const smovs = await getStockMovements(sharedListId, secItem.id, false);
      assert.equal(smovs.length, 0);
      const revs = await getAcquisitionPurchaseReversals(sharedListId, secItem.id, false);
      assert.equal(revs.length, 0);
      const purSnap = await adminDb
        .doc(`acquisition_lists/${sharedListId}/items/${secItem.id}/purchases/${purchaseId}`)
        .get();
      assert.equal(purSnap.exists, true);
      const auditSnaps = await getDocs(collection(db, 'spaces', spaceId, 'audit'));
      const revAudit = auditSnaps.docs.find(
        (d) =>
          d.data().eventType === 'acquisition_purchase_reversed' &&
          d.data().details?.purchaseId === purchaseId
      );
      assert.equal(revAudit, undefined);
    };

    // 15A. Conta de origem inexistente
    const purMissingAcc = 'pur_sec_missing_acc';
    await seedPurchase(
      purMissingAcc,
      [
        {
          funderUid: aliceUid,
          funderName: 'Alice',
          disbursedAmountCents: 10000,
          fundingSource: 'checking',
          sourceAccountId: 'acc_inexistente_rc1',
        },
      ],
      10000
    );
    await assert.rejects(
      async () => {
        await reverseAcquisitionPurchase(
          aliceUid,
          { listId: sharedListId, itemId: secItem.id, purchaseId: purMissingAcc, idempotencyKey: 'idem_sec_1' },
          false
        );
      },
      /(failed-precondition|inexistente ou arquivada)/i
    );
    await assertZeroMutationsForPurchase(purMissingAcc);

    // 15B. Conta arquivada (mesmo com débito original válido)
    const archivedAcc = await createAccount(aliceUid, { name: 'Conta Arquivada Sec', type: 'checking' }, false);
    await recordMovement(
      {
        accountId: archivedAcc.id,
        userId: aliceUid,
        authorUid: aliceUid,
        direction: 'inflow',
        amountCents: 100000,
        effectiveDate: '2026-11-15',
        originType: 'manual_adjustment',
        originId: `init_${archivedAcc.id}`,
        description: 'Saldo inicial conta arquivada',
        notes: 'Setup teste segurança conta arquivada',
        idempotencyKey: `idem_init_${archivedAcc.id}`,
      },
      false
    );
    const purArchivedAcc = 'pur_sec_archived_acc';
    await recordMovement(
      {
        accountId: archivedAcc.id,
        userId: aliceUid,
        authorUid: aliceUid,
        direction: 'outflow',
        amountCents: 20000,
        effectiveDate: '2026-11-15',
        originType: 'acquisition_checkout',
        originId: purArchivedAcc,
        description: 'Débito antes de arquivar',
        idempotencyKey: 'idem_debit_archived_sec',
      },
      false
    );
    await archiveAccount(archivedAcc.id, aliceUid, true, false);
    await seedPurchase(
      purArchivedAcc,
      [
        {
          funderUid: aliceUid,
          funderName: 'Alice',
          disbursedAmountCents: 20000,
          fundingSource: 'checking',
          sourceAccountId: archivedAcc.id,
        },
      ],
      20000
    );
    await assert.rejects(
      async () => {
        await reverseAcquisitionPurchase(
          aliceUid,
          { listId: sharedListId, itemId: secItem.id, purchaseId: purArchivedAcc, idempotencyKey: 'idem_sec_2' },
          false
        );
      },
      /(failed-precondition|inexistente ou arquivada)/i
    );
    const archivedAccAfter = (await getUserAccounts(aliceUid, true, false)).find((a) => a.id === archivedAcc.id);
    assert.equal(archivedAccAfter?.isArchived, true);
    assert.equal(archivedAccAfter?.projectedBalanceCents, 80000);
    assert.equal((await getAccountMovements(archivedAcc.id, aliceUid, false)).length, 2);
    await assertZeroMutationsForPurchase(purArchivedAcc);

    // 15C. Conta pertencente a outro usuário (Bob) divergente do funderUid (Alice)
    await signInWithEmailAndPassword(auth, 'bob.phase8@exemplo.com', 'SenhaSegura123!');
    const bobSecAcc = await createAccount(bobUid, { name: 'Conta Bob Sec', type: 'checking' }, false);
    await recordMovement(
      {
        accountId: bobSecAcc.id,
        userId: bobUid,
        authorUid: bobUid,
        direction: 'inflow',
        amountCents: 50000,
        effectiveDate: '2026-11-15',
        originType: 'manual_adjustment',
        originId: `init_${bobSecAcc.id}`,
        description: 'Saldo inicial Bob',
        notes: 'Setup teste segurança titularidade',
        idempotencyKey: `idem_init_${bobSecAcc.id}`,
      },
      false
    );
    const purOtherOwner = 'pur_sec_other_owner';
    await recordMovement(
      {
        accountId: bobSecAcc.id,
        userId: bobUid,
        authorUid: bobUid,
        direction: 'outflow',
        amountCents: 15000,
        effectiveDate: '2026-11-15',
        originType: 'acquisition_checkout',
        originId: purOtherOwner,
        description: 'Débito conta Bob',
        idempotencyKey: 'idem_debit_bob_sec',
      },
      false
    );
    await signInWithEmailAndPassword(auth, 'alice.phase8@exemplo.com', 'SenhaSegura123!');
    await seedPurchase(
      purOtherOwner,
      [
        {
          funderUid: aliceUid,
          funderName: 'Alice',
          disbursedAmountCents: 15000,
          fundingSource: 'checking',
          sourceAccountId: bobSecAcc.id,
        },
      ],
      15000
    );
    await assert.rejects(
      async () => {
        await reverseAcquisitionPurchase(
          aliceUid,
          { listId: sharedListId, itemId: secItem.id, purchaseId: purOtherOwner, idempotencyKey: 'idem_sec_3' },
          false
        );
      },
      /(failed-precondition|não corresponde ao titular do desembolso)/i
    );
    await signInWithEmailAndPassword(auth, 'bob.phase8@exemplo.com', 'SenhaSegura123!');
    const bobAccAfter = (await getUserAccounts(bobUid, false)).find((a) => a.id === bobSecAcc.id);
    assert.equal(bobAccAfter?.projectedBalanceCents, 35000);
    assert.equal((await getAccountMovements(bobSecAcc.id, bobUid, false)).length, 2);
    await signInWithEmailAndPassword(auth, 'alice.phase8@exemplo.com', 'SenhaSegura123!');
    await assertZeroMutationsForPurchase(purOtherOwner);

    // 15D. Débito original inexistente na conta ativa de Alice
    const purNoDebit = 'pur_sec_no_debit';
    await seedPurchase(
      purNoDebit,
      [
        {
          funderUid: aliceUid,
          funderName: 'Alice',
          disbursedAmountCents: 25000,
          fundingSource: 'checking',
          sourceAccountId: compAccId,
        },
      ],
      25000
    );
    await assert.rejects(
      async () => {
        await reverseAcquisitionPurchase(
          aliceUid,
          { listId: sharedListId, itemId: secItem.id, purchaseId: purNoDebit, idempotencyKey: 'idem_sec_4' },
          false
        );
      },
      /(failed-precondition|sem débito financeiro correspondente verificável)/i
    );
    assert.equal((await getUserAccounts(aliceUid, false)).find((a) => a.id === compAccId)?.projectedBalanceCents, 100000);
    assert.equal((await getAccountMovements(compAccId, aliceUid, false)).length, 3);
    await assertZeroMutationsForPurchase(purNoDebit);

    // 15E. Débito com valor diferente do desembolso registrado (débito 15000 vs compra 20000)
    const purWrongAmount = 'pur_sec_wrong_amount';
    await recordMovement(
      {
        accountId: compAccId,
        userId: aliceUid,
        authorUid: aliceUid,
        direction: 'outflow',
        amountCents: 15000,
        effectiveDate: '2026-11-15',
        originType: 'acquisition_checkout',
        originId: purWrongAmount,
        description: 'Débito com valor divergente',
        idempotencyKey: 'idem_debit_wrong_amount_sec',
      },
      false
    );
    await seedPurchase(
      purWrongAmount,
      [
        {
          funderUid: aliceUid,
          funderName: 'Alice',
          disbursedAmountCents: 20000,
          fundingSource: 'checking',
          sourceAccountId: compAccId,
        },
      ],
      20000
    );
    await assert.rejects(
      async () => {
        await reverseAcquisitionPurchase(
          aliceUid,
          { listId: sharedListId, itemId: secItem.id, purchaseId: purWrongAmount, idempotencyKey: 'idem_sec_5' },
          false
        );
      },
      /(failed-precondition|sem débito financeiro correspondente verificável)/i
    );
    assert.equal((await getUserAccounts(aliceUid, false)).find((a) => a.id === compAccId)?.projectedBalanceCents, 85000);
    assert.equal((await getAccountMovements(compAccId, aliceUid, false)).length, 4);
    await assertZeroMutationsForPurchase(purWrongAmount);

    // 15F-1. Débito com originType incompatível (personal_expense em vez de acquisition_checkout)
    const purWrongOrigin = 'pur_sec_wrong_origin';
    await recordMovement(
      {
        accountId: compAccId,
        userId: aliceUid,
        authorUid: aliceUid,
        direction: 'outflow',
        amountCents: 10000,
        effectiveDate: '2026-11-15',
        originType: 'personal_expense',
        originId: purWrongOrigin,
        description: 'Débito com originType incompatível',
        idempotencyKey: 'idem_debit_wrong_origin_sec',
      },
      false
    );
    await seedPurchase(
      purWrongOrigin,
      [
        {
          funderUid: aliceUid,
          funderName: 'Alice',
          disbursedAmountCents: 10000,
          fundingSource: 'checking',
          sourceAccountId: compAccId,
        },
      ],
      10000
    );
    await assert.rejects(
      async () => {
        await reverseAcquisitionPurchase(
          aliceUid,
          { listId: sharedListId, itemId: secItem.id, purchaseId: purWrongOrigin, idempotencyKey: 'idem_sec_6a' },
          false
        );
      },
      /(failed-precondition|sem débito financeiro correspondente verificável)/i
    );
    assert.equal((await getUserAccounts(aliceUid, false)).find((a) => a.id === compAccId)?.projectedBalanceCents, 75000);
    assert.equal((await getAccountMovements(compAccId, aliceUid, false)).length, 5);
    await assertZeroMutationsForPurchase(purWrongOrigin);

    // 15F-2. Débito semeado com userId incompatível no próprio movimento (userId: bobUid na conta de Alice)
    const purWrongMovOwner = 'pur_sec_wrong_mov_owner';
    await adminDb.collection(`accounts/${compAccId}/movements`).doc('mov_sec_spoof_owner').set({
      id: 'mov_sec_spoof_owner',
      accountId: compAccId,
      userId: bobUid,
      authorUid: bobUid,
      direction: 'outflow',
      amountCents: 10000,
      effectiveDate: '2026-11-15',
      registeredAt: '2026-11-15T10:00:00.000Z',
      originType: 'acquisition_checkout',
      originId: purWrongMovOwner,
      confirmationStatus: 'cleared',
      description: 'Movimento com titularidade incompatível',
      idempotencyKey: 'idem_spoof_mov_owner_sec',
    });
    await seedPurchase(
      purWrongMovOwner,
      [
        {
          funderUid: aliceUid,
          funderName: 'Alice',
          disbursedAmountCents: 10000,
          fundingSource: 'checking',
          sourceAccountId: compAccId,
        },
      ],
      10000
    );
    await assert.rejects(
      async () => {
        await reverseAcquisitionPurchase(
          aliceUid,
          { listId: sharedListId, itemId: secItem.id, purchaseId: purWrongMovOwner, idempotencyKey: 'idem_sec_6b' },
          false
        );
      },
      /(failed-precondition|sem débito financeiro correspondente verificável)/i
    );
    assert.equal((await getUserAccounts(aliceUid, false)).find((a) => a.id === compAccId)?.projectedBalanceCents, 75000);
    assert.equal((await getAccountMovements(compAccId, aliceUid, false)).length, 5);
    await assertZeroMutationsForPurchase(purWrongMovOwner);
  });

  await signOut(auth);
});
