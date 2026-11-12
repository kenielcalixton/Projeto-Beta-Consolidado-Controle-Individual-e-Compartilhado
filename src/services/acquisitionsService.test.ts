import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAcquisitionList,
  getAcquisitionLists,
  getAcquisitionListById,
  createAcquisitionItem,
  getAcquisitionItems,
  getAcquisitionItemById,
  updateAcquisitionItemStage,
  recordAcquisitionPurchase,
  getAcquisitionPurchases,
  recordStockMovement,
  getStockMovements,
  recordAcquisitionQuote,
  getAcquisitionQuotes,
  recordAcquisitionDeposit,
  getAcquisitionDeposits,
  reverseAcquisitionPurchase,
  getAcquisitionPurchaseReversals,
} from './acquisitionsService';
import { universalStorage } from '../utils/universalStorage';

describe('FASE 8 — Listas de Aquisição e Copropriedade de Bens (Arquitetura v3.1)', () => {
  const ALICE_UID = 'user_alice_fase8';
  const BOB_UID = 'user_bob_fase8';
  const SPACE_ID = 'space_home_fase8';

  beforeEach(() => {
    universalStorage.clear();
  });

  it('1. deve criar lista individual e lista compartilhada com separação estrita de escopo', async () => {
    const listInd = await createAcquisitionList(
      ALICE_UID,
      {
        name: 'Minhas Compras Pessoais',
        scopeType: 'individual',
        type: 'recorrente',
      },
      true
    );
    assert.ok(listInd.id);
    assert.equal(listInd.scopeType, 'individual');
    assert.equal(listInd.ownerUid, ALICE_UID);

    const listShared = await createAcquisitionList(
      ALICE_UID,
      {
        name: 'Supermercado da Casa',
        scopeType: 'shared',
        type: 'recorrente',
        spaceId: SPACE_ID,
        memberUids: [ALICE_UID, BOB_UID],
      },
      true
    );
    assert.ok(listShared.id);
    assert.equal(listShared.scopeType, 'shared');
    assert.equal(listShared.spaceId, SPACE_ID);
    assert.equal(listShared.memberUids.length, 2);

    const aliceIndLists = await getAcquisitionLists(ALICE_UID, undefined, true);
    assert.equal(aliceIndLists.length, 1);
    assert.equal(aliceIndLists[0].id, listInd.id);

    const spaceLists = await getAcquisitionLists(ALICE_UID, SPACE_ID, true);
    assert.equal(spaceLists.length, 1);
    assert.equal(spaceLists[0].id, listShared.id);
  });

  it('2. deve catalogar itens recorrentes com estoque e registrar movimentações manuais e de consumo', async () => {
    const list = await createAcquisitionList(
      ALICE_UID,
      {
        name: 'Despensa',
        scopeType: 'shared',
        type: 'recorrente',
        spaceId: SPACE_ID,
      },
      true
    );

    const item = await createAcquisitionItem(
      ALICE_UID,
      list.id,
      {
        name: 'Arroz 5kg',
        groupId: 'grp_alimentos',
        categoryId: 'cat_graos',
        currentStock: 2,
        minStock: 1,
        unit: 'pct',
      },
      true
    );
    assert.equal(item.currentStock, 2);
    assert.equal(item.stage, 'estoque');

    // Consumo de 1 pacote
    const consRes = await recordStockMovement(
      ALICE_UID,
      {
        listId: list.id,
        itemId: item.id,
        movementType: 'consumption_outflow',
        quantityDelta: -1,
        justification: 'Consumo semanal da família',
      },
      true
    );
    assert.equal(consRes.item.currentStock, 1);

    // Ajuste manual de +3 pacotes
    const adjRes = await recordStockMovement(
      BOB_UID,
      {
        listId: list.id,
        itemId: item.id,
        movementType: 'manual_adjustment',
        quantityDelta: 3,
        justification: 'Inventário físico mensal',
      },
      true
    );
    assert.equal(adjRes.item.currentStock, 4);

    const smovs = await getStockMovements(list.id, item.id, true);
    assert.equal(smovs.length, 2);
  });

  it('3. deve gerenciar item de objetivo com cotações de mercado e depósitos de poupança', async () => {
    const list = await createAcquisitionList(
      ALICE_UID,
      {
        name: 'Metas da Casa',
        scopeType: 'shared',
        type: 'objetivo',
        spaceId: SPACE_ID,
      },
      true
    );

    const item = await createAcquisitionItem(
      ALICE_UID,
      list.id,
      {
        name: 'Geladeira French Door',
        groupId: 'grp_eletro',
        categoryId: 'cat_cozinha',
        targetAmountCents: 500000, // R$ 5.000,00
      },
      true
    );
    assert.equal(item.stage, 'pesquisa');

    // Registra cotação
    const quoteRes = await recordAcquisitionQuote(
      ALICE_UID,
      {
        listId: list.id,
        itemId: item.id,
        storeName: 'Fast Shop',
        priceCents: 489900,
        url: 'https://fastshop.com.br/geladeira',
      },
      true
    );
    assert.ok(quoteRes.quote.id);
    const quotes = await getAcquisitionQuotes(list.id, item.id, true);
    assert.equal(quotes.length, 1);

    // Aporte parcial 1: Alice deposita R$ 2.000,00
    const dep1 = await recordAcquisitionDeposit(
      ALICE_UID,
      {
        listId: list.id,
        itemId: item.id,
        amountCents: 200000,
        notes: 'Economia do mês de Outubro',
      },
      true
    );
    assert.equal(dep1.item.savedAmountCents, 200000);
    assert.equal(dep1.item.stage, 'poupando');

    // Aporte final 2: Bob deposita R$ 3.000,00 atingindo a meta
    const dep2 = await recordAcquisitionDeposit(
      BOB_UID,
      {
        listId: list.id,
        itemId: item.id,
        amountCents: 300000,
        notes: 'Bônus semestral',
      },
      true
    );
    assert.equal(dep2.item.savedAmountCents, 500000);
    assert.equal(dep2.item.stage, 'pronto', 'Ao atingir o valor-alvo o estágio avança para pronto');

    const deposits = await getAcquisitionDeposits(list.id, item.id, true);
    assert.equal(deposits.length, 2);
  });

  it('4. Checkout Individual: comprador detém 100% de copropriedade e estoque é incrementado automaticamente', async () => {
    const list = await createAcquisitionList(
      ALICE_UID,
      {
        name: 'Minhas Compras',
        scopeType: 'individual',
        type: 'recorrente',
      },
      true
    );

    const item = await createAcquisitionItem(
      ALICE_UID,
      list.id,
      {
        name: 'Café Especial 500g',
        groupId: 'grp_alimentos',
        categoryId: 'cat_cafe',
        currentStock: 1,
      },
      true
    );

    const checkoutRes = await recordAcquisitionPurchase(
      ALICE_UID,
      {
        listId: list.id,
        itemId: item.id,
        storeName: 'Torrefação Local',
        quantity: 3,
        unitPriceCents: 4500, // R$ 45,00 cada
        itemsNetCents: 13500,
        shippingCents: 1500,
        discountsCents: 1000,
        totalPaidCents: 14000, // 13500 + 1500 - 1000 = 14000 (R$ 140,00)
        disbursements: [
          {
            funderUid: ALICE_UID,
            funderName: 'Alice',
            disbursedAmountCents: 14000,
            fundingSource: 'checking',
          },
        ],
        idempotencyKey: 'idem_pur_alice_cafe_140',
      },
      true
    );

    assert.equal(checkoutRes.purchase.totalPaidCents, 14000);
    assert.equal(checkoutRes.purchase.ownershipShares.length, 1);
    assert.equal(checkoutRes.purchase.ownershipShares[0].uid, ALICE_UID);
    assert.equal(checkoutRes.purchase.ownershipShares[0].ownershipPercentage, 100);

    // Valida atualização do item
    assert.equal(checkoutRes.item.currentStock, 4); // 1 + 3 = 4
    assert.equal(checkoutRes.item.stage, 'conferido');

    // Valida movimentação de estoque automática purchase_inflow
    const smovs = await getStockMovements(list.id, item.id, true);
    assert.equal(smovs.length, 1);
    assert.equal(smovs[0].movementType, 'purchase_inflow');
    assert.equal(smovs[0].quantityDelta, 3);
  });

  it('5. Checkout Compartilhado: calcula copropriedade patrimonial estritamente proporcional aos desembolsos', async () => {
    const list = await createAcquisitionList(
      ALICE_UID,
      {
        name: 'Bens Compartilhados',
        scopeType: 'shared',
        type: 'objetivo',
        spaceId: SPACE_ID,
      },
      true
    );

    const item = await createAcquisitionItem(
      ALICE_UID,
      list.id,
      {
        name: 'Smart TV 65 4K',
        groupId: 'grp_eletronicos',
        categoryId: 'cat_tv',
        targetAmountCents: 400000,
      },
      true
    );

    // Compra de R$ 4.000,00: Alice desembolsa R$ 1.600,00 (40%) e Bob desembolsa R$ 2.400,00 (60%)
    const checkoutRes = await recordAcquisitionPurchase(
      ALICE_UID,
      {
        listId: list.id,
        itemId: item.id,
        storeName: 'Magazine Luiza',
        brand: 'LG',
        quantity: 1,
        unitPriceCents: 400000,
        itemsNetCents: 400000,
        totalPaidCents: 400000,
        ownershipClassification: 'shared_participants',
        disbursements: [
          {
            funderUid: ALICE_UID,
            funderName: 'Alice',
            disbursedAmountCents: 160000,
            fundingSource: 'credit_card',
          },
          {
            funderUid: BOB_UID,
            funderName: 'Bob',
            disbursedAmountCents: 240000,
            fundingSource: 'checking',
          },
        ],
        idempotencyKey: 'idem_pur_tv_alice_bob_4000',
      },
      true
    );

    assert.equal(checkoutRes.purchase.totalPaidCents, 400000);
    assert.equal(checkoutRes.purchase.ownershipShares.length, 2);

    const aliceShare = checkoutRes.purchase.ownershipShares.find((s) => s.uid === ALICE_UID);
    const bobShare = checkoutRes.purchase.ownershipShares.find((s) => s.uid === BOB_UID);

    assert.ok(aliceShare);
    assert.equal(aliceShare.disbursedAmountCents, 160000);
    assert.equal(aliceShare.ownershipPercentage, 40);

    assert.ok(bobShare);
    assert.equal(bobShare.disbursedAmountCents, 240000);
    assert.equal(bobShare.ownershipPercentage, 60);

    assert.equal(checkoutRes.item.stage, 'adquirido');
    assert.equal(checkoutRes.item.finalPaidAmountCents, 400000);
  });

  it('6. Rejeita checkout com violação de conservação contábil (soma dos desembolsos != total pago)', async () => {
    const list = await createAcquisitionList(
      ALICE_UID,
      {
        name: 'Lista Teste',
        scopeType: 'individual',
        type: 'desejo',
      },
      true
    );

    const item = await createAcquisitionItem(
      ALICE_UID,
      list.id,
      {
        name: 'Fone Bluetooth',
        groupId: 'grp_audio',
        categoryId: 'cat_fone',
      },
      true
    );

    // Total é R$ 500,00, mas soma dos desembolsos é R$ 450,00
    await assert.rejects(
      async () => {
        await recordAcquisitionPurchase(
          ALICE_UID,
          {
            listId: list.id,
            itemId: item.id,
            storeName: 'Amazon',
            quantity: 1,
            unitPriceCents: 50000,
            itemsNetCents: 50000,
            totalPaidCents: 50000,
            disbursements: [
              {
                funderUid: ALICE_UID,
                funderName: 'Alice',
                disbursedAmountCents: 45000, // Falta 5000 centavos!
                fundingSource: 'checking',
              },
            ],
            idempotencyKey: 'idem_divergent_sum',
          },
          true
        );
      },
      /(diverge|conservação contábil|não coincide)/i
    );
  });

  it('7. Replay idempotente no checkout retorna documento idêntico sem duplicar estoque', async () => {
    const list = await createAcquisitionList(
      ALICE_UID,
      {
        name: 'Despensa Idempotente',
        scopeType: 'individual',
        type: 'recorrente',
      },
      true
    );

    const item = await createAcquisitionItem(
      ALICE_UID,
      list.id,
      {
        name: 'Sabão Líquido',
        groupId: 'grp_limpeza',
        categoryId: 'cat_lavanderia',
        currentStock: 1,
      },
      true
    );

    const payload = {
      listId: list.id,
      itemId: item.id,
      storeName: 'Atacadão',
      quantity: 2,
      unitPriceCents: 3000,
      itemsNetCents: 6000,
      totalPaidCents: 6000,
      disbursements: [
        {
          funderUid: ALICE_UID,
          funderName: 'Alice',
          disbursedAmountCents: 6000,
          fundingSource: 'checking' as const,
        },
      ],
      idempotencyKey: 'idem_pur_sabao_replay',
    };

    const res1 = await recordAcquisitionPurchase(ALICE_UID, payload, true);
    assert.equal(res1.isIdempotentReplay, false);
    assert.equal(res1.item.currentStock, 3); // 1 + 2 = 3

    const res2 = await recordAcquisitionPurchase(ALICE_UID, payload, true);
    assert.equal(res2.isIdempotentReplay, true);
    assert.equal(res2.purchase.id, res1.purchase.id);

    // O estoque permanece 3 e não foi incrementado uma segunda vez
    const checkItem = await getAcquisitionItemById(list.id, item.id, true);
    assert.equal(checkItem?.currentStock, 3);

    const smovs = await getStockMovements(list.id, item.id, true);
    assert.equal(smovs.length, 1, 'Movimentação de estoque deve ser única');
  });

  it('8. Estorno compensatório de compra de aquisição: decrementa estoque compensatoriamente, gera subcoleção reversals e assegura idempotência', async () => {
    const list = await createAcquisitionList(
      ALICE_UID,
      {
        name: 'Despensa para Estorno',
        scopeType: 'individual',
        type: 'recorrente',
      },
      true
    );

    const item = await createAcquisitionItem(
      ALICE_UID,
      list.id,
      {
        name: 'Detergente Neutro',
        groupId: 'grp_limpeza',
        categoryId: 'cat_cozinha',
        currentStock: 1,
      },
      true
    );

    // Compra de 2 unidades
    const purRes = await recordAcquisitionPurchase(
      ALICE_UID,
      {
        listId: list.id,
        itemId: item.id,
        storeName: 'Mercado do Bairro',
        quantity: 2,
        unitPriceCents: 250,
        itemsNetCents: 500,
        totalPaidCents: 500,
        disbursements: [
          {
            funderUid: ALICE_UID,
            funderName: 'Alice',
            disbursedAmountCents: 500,
            fundingSource: 'checking',
          },
        ],
        idempotencyKey: 'idem_pur_detergente_500',
      },
      true
    );

    assert.equal(purRes.item.currentStock, 3); // 1 + 2 = 3

    // Estorno da compra
    const revRes = await reverseAcquisitionPurchase(
      ALICE_UID,
      {
        listId: list.id,
        itemId: item.id,
        purchaseId: purRes.purchase.id,
        reversalReason: 'Produto com vazamento devolvido ao fornecedor',
        idempotencyKey: 'idem_rev_detergente_1',
      },
      true
    );

    assert.equal(revRes.isIdempotentReplay, false);
    assert.equal(revRes.reversal.purchaseId, purRes.purchase.id);
    assert.equal(revRes.reversal.totalReversedAmountCents, 500);
    assert.equal(revRes.item.currentStock, 1, 'Estoque deve ser revertido compensatoriamente para 1');

    const smovs = await getStockMovements(list.id, item.id, true);
    assert.equal(smovs.length, 2);
    const revSmov = smovs.find((s) => s.movementType === 'reversal_outflow');
    assert.ok(revSmov);
    assert.equal(revSmov?.quantityDelta, -2);

    // Subcoleção reversals consultada
    const revList = await getAcquisitionPurchaseReversals(list.id, item.id, true);
    assert.equal(revList.length, 1);
    assert.equal(revList[0].id, revRes.reversal.id);

    // Replay idempotente do estorno
    const replayRev = await reverseAcquisitionPurchase(
      ALICE_UID,
      {
        listId: list.id,
        itemId: item.id,
        purchaseId: purRes.purchase.id,
        reversalReason: 'Produto com vazamento devolvido ao fornecedor',
        idempotencyKey: 'idem_rev_detergente_1',
      },
      true
    );

    assert.equal(replayRev.isIdempotentReplay, true);
    assert.equal(replayRev.reversal.id, revRes.reversal.id);

    // Estoque não é decrementado novamente
    const finalItem = await getAcquisitionItemById(list.id, item.id, true);
    assert.equal(finalItem?.currentStock, 1);
  });
});
