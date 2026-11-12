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
  doc,
  getDoc,
  updateDoc,
  deleteDoc,
} from 'firebase/firestore';
import { auth, db } from './firebase';
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

  await signOut(auth);
});
