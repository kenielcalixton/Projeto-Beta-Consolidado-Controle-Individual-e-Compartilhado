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
import { createAccount, archiveAccount, getUserAccounts } from './accountService';
import { recordMovement, getAccountMovements, reverseMovement } from './ledgerService';
import { generateReversalDocId } from '../utils/movementLedger';
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

  it('9. deve rejeitar checkout com sourceAccountId preenchido sem alterar estoque ou persistir compra', async () => {
    const list = await createAcquisitionList(
      ALICE_UID,
      {
        name: 'Despensa Política Contábil',
        scopeType: 'individual',
        type: 'recorrente',
      },
      true
    );

    const item = await createAcquisitionItem(
      ALICE_UID,
      list.id,
      {
        name: 'Azeite Extra Virgem',
        groupId: 'grp_alimentos',
        categoryId: 'cat_oleos',
        currentStock: 2,
      },
      true
    );

    await assert.rejects(
      async () => {
        await recordAcquisitionPurchase(
          ALICE_UID,
          {
            listId: list.id,
            itemId: item.id,
            storeName: 'Empório',
            quantity: 1,
            unitPriceCents: 4500,
            itemsNetCents: 4500,
            totalPaidCents: 4500,
            disbursements: [
              {
                funderUid: ALICE_UID,
                funderName: 'Alice',
                disbursedAmountCents: 4500,
                fundingSource: 'checking',
                sourceAccountId: 'acc_demo_alice_1',
              },
            ],
            idempotencyKey: 'idem_demo_blocked_source_acc',
          },
          true
        );
      },
      /(sourceAccountId|ainda não está disponível)/i
    );

    const itemAfter = await getAcquisitionItemById(list.id, item.id, true);
    assert.equal(itemAfter?.currentStock, 2);
    const purchasesAfter = await getAcquisitionPurchases(list.id, item.id, true);
    assert.equal(purchasesAfter.length, 0);
  });

  it('10. deve bloquear estorno de compra histórica com sourceAccountId sem débito verificável sem gerar mutação parcial', async () => {
    const list = await createAcquisitionList(
      ALICE_UID,
      {
        name: 'Metas Históricas',
        scopeType: 'individual',
        type: 'objetivo',
      },
      true
    );

    const item = await createAcquisitionItem(
      ALICE_UID,
      list.id,
      {
        name: 'Aspirador Robô',
        groupId: 'grp_eletro',
        categoryId: 'cat_casa',
        targetAmountCents: 200000,
      },
      true
    );

    const rawItems = JSON.parse(universalStorage.getItem('demo_acq_items_v3') || '[]');
    const idx = rawItems.findIndex((i: { id: string }) => i.id === item.id);
    rawItems[idx] = { ...rawItems[idx], stage: 'adquirido', finalPaidAmountCents: 200000 };
    universalStorage.setItem('demo_acq_items_v3', JSON.stringify(rawItems));

    const histPurchaseId = 'pur_demo_hist_sem_debito';
    const rawPurchases = JSON.parse(universalStorage.getItem('demo_acq_purchases_v3') || '[]');
    rawPurchases.push({
      id: histPurchaseId,
      itemId: item.id,
      listId: list.id,
      physicalBuyerUid: ALICE_UID,
      authorUid: ALICE_UID,
      storeName: 'Loja Antiga',
      quantity: 1,
      unitPriceCents: 200000,
      itemsNetCents: 200000,
      shippingCents: 0,
      feesCents: 0,
      discountsCents: 0,
      totalPaidCents: 200000,
      purchaseDate: '2026-10-01',
      ownershipClassification: 'individual',
      disbursements: [
        {
          funderUid: ALICE_UID,
          funderName: 'Alice',
          disbursedAmountCents: 200000,
          fundingSource: 'checking',
          sourceAccountId: 'acc_demo_alice_hist',
        },
      ],
      ownershipShares: [
        {
          uid: ALICE_UID,
          name: 'Alice',
          disbursedAmountCents: 200000,
          ownershipPercentage: 100,
        },
      ],
      idempotencyKey: 'idem_demo_hist_sem_debito',
      createdAt: '2026-10-01T10:00:00.000Z',
    });
    universalStorage.setItem('demo_acq_purchases_v3', JSON.stringify(rawPurchases));

    await assert.rejects(
      async () => {
        await reverseAcquisitionPurchase(
          ALICE_UID,
          {
            listId: list.id,
            itemId: item.id,
            purchaseId: histPurchaseId,
            reversalReason: 'Estorno histórico bloqueado',
            idempotencyKey: 'idem_rev_demo_hist_blocked',
          },
          true
        );
      },
      /Estorno automático bloqueado para análise/i
    );

    const itemAfter = await getAcquisitionItemById(list.id, item.id, true);
    assert.equal(itemAfter?.stage, 'adquirido');
    assert.equal(itemAfter?.finalPaidAmountCents, 200000);
    const reversalsAfter = await getAcquisitionPurchaseReversals(list.id, item.id, true);
    assert.equal(reversalsAfter.length, 0);
  });

  function snapshotDemoState() {
    const readKey = (key: string) => JSON.parse(universalStorage.getItem(key) || '[]');
    return {
      lists: readKey('demo_acq_lists_v3'),
      items: readKey('demo_acq_items_v3'),
      purchases: readKey('demo_acq_purchases_v3'),
      stockMovements: readKey('demo_acq_stock_movements_v3'),
      reversals: readKey('demo_acq_purchase_reversals_v3'),
      accounts: readKey('mpf_v3_demo_accounts'),
      movements: readKey('mpf_v3_demo_movements'),
    };
  }

  async function seedRecurringPurchaseWithSourceAccount(params: {
    purchaseId: string;
    funderUid: string;
    funderName: string;
    sourceAccountId: string;
    amountCents: number;
    quantity?: number;
  }) {
    const quantity = params.quantity ?? 3;
    const list = await createAcquisitionList(
      ALICE_UID,
      {
        name: 'Despensa Demo Estorno',
        scopeType: 'individual',
        type: 'recorrente',
      },
      true
    );

    const item = await createAcquisitionItem(
      ALICE_UID,
      list.id,
      {
        name: 'Café Especial',
        groupId: 'grp_alimentos',
        categoryId: 'cat_bebidas',
        currentStock: 2,
        minStock: 1,
        unit: 'pct',
      },
      true
    );

    await recordStockMovement(
      ALICE_UID,
      {
        listId: list.id,
        itemId: item.id,
        movementType: 'purchase_inflow',
        quantityDelta: quantity,
        justification: `Compra histórica #${params.purchaseId}`,
      },
      true
    );

    const rawPurchases = JSON.parse(universalStorage.getItem('demo_acq_purchases_v3') || '[]');
    rawPurchases.push({
      id: params.purchaseId,
      itemId: item.id,
      listId: list.id,
      physicalBuyerUid: params.funderUid,
      authorUid: params.funderUid,
      storeName: 'Cafeteria Central',
      quantity,
      unitPriceCents: Math.round(params.amountCents / quantity),
      itemsNetCents: params.amountCents,
      shippingCents: 0,
      feesCents: 0,
      discountsCents: 0,
      totalPaidCents: params.amountCents,
      purchaseDate: '2026-10-15',
      ownershipClassification: 'individual',
      disbursements: [
        {
          funderUid: params.funderUid,
          funderName: params.funderName,
          disbursedAmountCents: params.amountCents,
          fundingSource: 'checking',
          sourceAccountId: params.sourceAccountId,
        },
      ],
      ownershipShares: [
        {
          uid: params.funderUid,
          name: params.funderName,
          disbursedAmountCents: params.amountCents,
          ownershipPercentage: 100,
        },
      ],
      idempotencyKey: `idem_${params.purchaseId}`,
      createdAt: '2026-10-15T10:00:00.000Z',
    });
    universalStorage.setItem('demo_acq_purchases_v3', JSON.stringify(rawPurchases));

    return { list, item };
  }

  it('11. deve bloquear estorno em modo demo para conta arquivada sem qualquer alteração parcial (estoque, item, saldo ou movimentos)', async () => {
    const acc = await createAccount(ALICE_UID, { name: 'Conta Arquivada', type: 'checking' }, true);
    await recordMovement(
      {
        accountId: acc.id,
        userId: ALICE_UID,
        authorUid: ALICE_UID,
        direction: 'inflow',
        amountCents: 100000,
        effectiveDate: '2026-10-01',
        originType: 'personal_income',
        originId: 'init_11',
        description: 'Saldo inicial',
        idempotencyKey: 'idem_init_11',
      },
      true
    );

    const purchaseId = 'pur_demo_archived_acc';
    await recordMovement(
      {
        accountId: acc.id,
        userId: ALICE_UID,
        authorUid: ALICE_UID,
        direction: 'outflow',
        amountCents: 30000,
        effectiveDate: '2026-10-15',
        originType: 'acquisition_checkout',
        originId: purchaseId,
        description: 'Débito aquisição',
        idempotencyKey: 'idem_debit_11',
      },
      true
    );

    const { list, item } = await seedRecurringPurchaseWithSourceAccount({
      purchaseId,
      funderUid: ALICE_UID,
      funderName: 'Alice',
      sourceAccountId: acc.id,
      amountCents: 30000,
      quantity: 3,
    });

    await archiveAccount(acc.id, ALICE_UID, true, true);

    const before = snapshotDemoState();

    await assert.rejects(
      async () => {
        await reverseAcquisitionPurchase(
          ALICE_UID,
          {
            listId: list.id,
            itemId: item.id,
            purchaseId,
            reversalReason: 'Tentativa em conta arquivada',
            idempotencyKey: 'idem_rev_11',
          },
          true
        );
      },
      /inexistente ou arquivada/i
    );

    const after = snapshotDemoState();
    assert.deepEqual(after, before);

    const itemAfter = await getAcquisitionItemById(list.id, item.id, true);
    assert.equal(itemAfter?.currentStock, 5);
    const stockMovsAfter = await getStockMovements(list.id, item.id, true);
    assert.equal(stockMovsAfter.length, 1);
    const movsAfter = await getAccountMovements(acc.id, ALICE_UID, true);
    assert.equal(movsAfter.length, 2);
    const accsAfter = await getUserAccounts(ALICE_UID, true, true);
    assert.equal(accsAfter[0].projectedBalanceCents, 70000);
    const reversalsAfter = await getAcquisitionPurchaseReversals(list.id, item.id, true);
    assert.equal(reversalsAfter.length, 0);
  });

  it('12. deve bloquear estorno em modo demo para conta inexistente sem qualquer alteração parcial', async () => {
    const { list, item } = await seedRecurringPurchaseWithSourceAccount({
      purchaseId: 'pur_demo_missing_acc',
      funderUid: ALICE_UID,
      funderName: 'Alice',
      sourceAccountId: 'acc_inexistente_demo_999',
      amountCents: 15000,
      quantity: 2,
    });

    const before = snapshotDemoState();

    await assert.rejects(
      async () => {
        await reverseAcquisitionPurchase(
          ALICE_UID,
          {
            listId: list.id,
            itemId: item.id,
            purchaseId: 'pur_demo_missing_acc',
            reversalReason: 'Tentativa em conta inexistente',
            idempotencyKey: 'idem_rev_12',
          },
          true
        );
      },
      /inexistente ou arquivada/i
    );

    const after = snapshotDemoState();
    assert.deepEqual(after, before);
  });

  it('13. deve bloquear estorno em modo demo quando conta pertence a outro usuário sem qualquer alteração parcial', async () => {
    const bobAcc = await createAccount(BOB_UID, { name: 'Conta do Bob', type: 'checking' }, true);
    await recordMovement(
      {
        accountId: bobAcc.id,
        userId: BOB_UID,
        authorUid: BOB_UID,
        direction: 'inflow',
        amountCents: 80000,
        effectiveDate: '2026-10-01',
        originType: 'personal_income',
        originId: 'init_13',
        description: 'Saldo Bob',
        idempotencyKey: 'idem_init_13',
      },
      true
    );

    const purchaseId = 'pur_demo_other_owner_acc';
    await recordMovement(
      {
        accountId: bobAcc.id,
        userId: BOB_UID,
        authorUid: BOB_UID,
        direction: 'outflow',
        amountCents: 20000,
        effectiveDate: '2026-10-15',
        originType: 'acquisition_checkout',
        originId: purchaseId,
        description: 'Débito Bob',
        idempotencyKey: 'idem_debit_13',
      },
      true
    );

    const { list, item } = await seedRecurringPurchaseWithSourceAccount({
      purchaseId,
      funderUid: ALICE_UID,
      funderName: 'Alice',
      sourceAccountId: bobAcc.id,
      amountCents: 20000,
      quantity: 2,
    });

    const before = snapshotDemoState();

    await assert.rejects(
      async () => {
        await reverseAcquisitionPurchase(
          ALICE_UID,
          {
            listId: list.id,
            itemId: item.id,
            purchaseId,
            reversalReason: 'Tentativa cross-user',
            idempotencyKey: 'idem_rev_13',
          },
          true
        );
      },
      /não corresponde ao titular do desembolso/i
    );

    const after = snapshotDemoState();
    assert.deepEqual(after, before);
    const bobAccsAfter = await getUserAccounts(BOB_UID, true, true);
    assert.equal(bobAccsAfter[0].projectedBalanceCents, 60000);
  });

  it('14. deve bloquear estorno em modo demo quando conta existe mas débito original é inexistente, sem mutação parcial', async () => {
    const acc = await createAccount(ALICE_UID, { name: 'Conta Sem Débito', type: 'checking' }, true);
    await recordMovement(
      {
        accountId: acc.id,
        userId: ALICE_UID,
        authorUid: ALICE_UID,
        direction: 'inflow',
        amountCents: 90000,
        effectiveDate: '2026-10-01',
        originType: 'personal_income',
        originId: 'init_14',
        description: 'Saldo inicial',
        idempotencyKey: 'idem_init_14',
      },
      true
    );

    const { list, item } = await seedRecurringPurchaseWithSourceAccount({
      purchaseId: 'pur_demo_no_debit',
      funderUid: ALICE_UID,
      funderName: 'Alice',
      sourceAccountId: acc.id,
      amountCents: 25000,
      quantity: 2,
    });

    const before = snapshotDemoState();

    await assert.rejects(
      async () => {
        await reverseAcquisitionPurchase(
          ALICE_UID,
          {
            listId: list.id,
            itemId: item.id,
            purchaseId: 'pur_demo_no_debit',
            reversalReason: 'Débito ausente',
            idempotencyKey: 'idem_rev_14',
          },
          true
        );
      },
      /sem débito financeiro correspondente verificável/i
    );

    const after = snapshotDemoState();
    assert.deepEqual(after, before);
  });

  it('15. deve concluir estorno da compra sem duplicar crédito ou movimento quando débito original já foi estornado previamente', async () => {
    const acc = await createAccount(ALICE_UID, { name: 'Conta Pré-Estornada', type: 'checking' }, true);
    await recordMovement(
      {
        accountId: acc.id,
        userId: ALICE_UID,
        authorUid: ALICE_UID,
        direction: 'inflow',
        amountCents: 100000,
        effectiveDate: '2026-10-01',
        originType: 'personal_income',
        originId: 'init_15',
        description: 'Saldo inicial',
        idempotencyKey: 'idem_init_15',
      },
      true
    );

    const purchaseId = 'pur_demo_already_reversed_debit';
    const debitMov = await recordMovement(
      {
        accountId: acc.id,
        userId: ALICE_UID,
        authorUid: ALICE_UID,
        direction: 'outflow',
        amountCents: 30000,
        effectiveDate: '2026-10-15',
        originType: 'acquisition_checkout',
        originId: purchaseId,
        description: 'Débito aquisição',
        idempotencyKey: 'idem_debit_15',
      },
      true
    );

    // Estorno financeiro prévio direto no ledger
    await reverseMovement(acc.id, debitMov.id, ALICE_UID, 'Estorno prévio manual', true);

    const { list, item } = await seedRecurringPurchaseWithSourceAccount({
      purchaseId,
      funderUid: ALICE_UID,
      funderName: 'Alice',
      sourceAccountId: acc.id,
      amountCents: 30000,
      quantity: 3,
    });

    const movsBefore = await getAccountMovements(acc.id, ALICE_UID, true);
    assert.equal(movsBefore.length, 3);
    const accsBefore = await getUserAccounts(ALICE_UID, true, true);
    assert.equal(accsBefore[0].projectedBalanceCents, 100000);

    const result = await reverseAcquisitionPurchase(
      ALICE_UID,
      {
        listId: list.id,
        itemId: item.id,
        purchaseId,
        reversalReason: 'Estorno operacional após estorno financeiro prévio',
        idempotencyKey: 'idem_rev_15',
      },
      true
    );

    assert.equal(result.isIdempotentReplay, false);
    assert.equal(result.item.currentStock, 2);

    const movsAfter = await getAccountMovements(acc.id, ALICE_UID, true);
    assert.equal(movsAfter.length, 3);
    const accsAfter = await getUserAccounts(ALICE_UID, true, true);
    assert.equal(accsAfter[0].projectedBalanceCents, 100000);

    const stockMovsAfter = await getStockMovements(list.id, item.id, true);
    assert.equal(stockMovsAfter.length, 2);
    const revStockMov = stockMovsAfter.find((m) => m.movementType === 'reversal_outflow');
    assert.ok(revStockMov, 'Movimento de estoque reversal_outflow deve existir');
    assert.equal(revStockMov.quantityDelta, -3);

    const reversalsAfter = await getAcquisitionPurchaseReversals(list.id, item.id, true);
    assert.equal(reversalsAfter.length, 1);
  });

  it('16. deve executar estorno válido em modo demo com compensação contábil legítima (rev_..., acquisition_reversal) e atualização de estoque', async () => {
    const acc = await createAccount(ALICE_UID, { name: 'Conta Principal Demo', type: 'checking' }, true);
    await recordMovement(
      {
        accountId: acc.id,
        userId: ALICE_UID,
        authorUid: ALICE_UID,
        direction: 'inflow',
        amountCents: 100000,
        effectiveDate: '2026-10-01',
        originType: 'personal_income',
        originId: 'init_16',
        description: 'Saldo inicial',
        idempotencyKey: 'idem_init_16',
      },
      true
    );

    const purchaseId = 'pur_demo_valid_reversal';
    const debitMov = await recordMovement(
      {
        accountId: acc.id,
        userId: ALICE_UID,
        authorUid: ALICE_UID,
        direction: 'outflow',
        amountCents: 30000,
        effectiveDate: '2026-10-15',
        originType: 'acquisition_checkout',
        originId: purchaseId,
        description: 'Débito aquisição legítimo',
        idempotencyKey: 'idem_debit_16',
      },
      true
    );

    const { list, item } = await seedRecurringPurchaseWithSourceAccount({
      purchaseId,
      funderUid: ALICE_UID,
      funderName: 'Alice',
      sourceAccountId: acc.id,
      amountCents: 30000,
      quantity: 3,
    });

    const accsBefore = await getUserAccounts(ALICE_UID, true, true);
    assert.equal(accsBefore[0].projectedBalanceCents, 70000);

    const result = await reverseAcquisitionPurchase(
      ALICE_UID,
      {
        listId: list.id,
        itemId: item.id,
        purchaseId,
        reversalReason: 'Devolução integral em loja',
        idempotencyKey: 'idem_rev_16',
      },
      true
    );

    assert.equal(result.isIdempotentReplay, false);
    assert.equal(result.item.currentStock, 2);

    const expectedRevId = generateReversalDocId(debitMov.id);
    assert.ok(expectedRevId.startsWith('rev_'));

    const movsAfter = await getAccountMovements(acc.id, ALICE_UID, true);
    assert.equal(movsAfter.length, 3);
    const compMov = movsAfter.find((m) => m.id === expectedRevId);
    assert.ok(compMov, 'Movimento compensatório rev_... deve existir');
    assert.equal(compMov.direction, 'inflow');
    assert.equal(compMov.amountCents, 30000);
    assert.equal(compMov.originType, 'acquisition_reversal');
    assert.equal(compMov.reversalOfMovementId, debitMov.id);
    assert.equal(compMov.originId, result.reversal.id);

    const accsAfter = await getUserAccounts(ALICE_UID, true, true);
    assert.equal(accsAfter[0].projectedBalanceCents, 100000);

    const stockMovsAfter = await getStockMovements(list.id, item.id, true);
    assert.equal(stockMovsAfter.length, 2);
    const revStockMov = stockMovsAfter.find((m) => m.movementType === 'reversal_outflow');
    assert.ok(revStockMov, 'Movimento de estoque reversal_outflow deve existir');
    assert.equal(revStockMov.quantityDelta, -3);
    assert.equal(revStockMov.previousStock, 5);
    assert.equal(revStockMov.newStock, 2);

    const itemAfter = await getAcquisitionItemById(list.id, item.id, true);
    assert.equal(itemAfter?.currentStock, 2);
    const listAfter = await getAcquisitionListById(list.id, true);
    assert.equal(listAfter?.id, list.id);
    const purchasesAfter = await getAcquisitionPurchases(list.id, item.id, true);
    assert.equal(purchasesAfter.length, 1);
    const reversalsAfter = await getAcquisitionPurchaseReversals(list.id, item.id, true);
    assert.equal(reversalsAfter.length, 1);
  });

  it('17. deve preservar idempotência ao repetir a mesma solicitação de estorno em modo demo sem duplicar movimentos ou alterar saldo/estoque', async () => {
    const acc = await createAccount(ALICE_UID, { name: 'Conta Idempotência Demo', type: 'checking' }, true);
    await recordMovement(
      {
        accountId: acc.id,
        userId: ALICE_UID,
        authorUid: ALICE_UID,
        direction: 'inflow',
        amountCents: 100000,
        effectiveDate: '2026-10-01',
        originType: 'personal_income',
        originId: 'init_17',
        description: 'Saldo inicial',
        idempotencyKey: 'idem_init_17',
      },
      true
    );

    const purchaseId = 'pur_demo_idempotent_replay';
    await recordMovement(
      {
        accountId: acc.id,
        userId: ALICE_UID,
        authorUid: ALICE_UID,
        direction: 'outflow',
        amountCents: 30000,
        effectiveDate: '2026-10-15',
        originType: 'acquisition_checkout',
        originId: purchaseId,
        description: 'Débito aquisição',
        idempotencyKey: 'idem_debit_17',
      },
      true
    );

    const { list, item } = await seedRecurringPurchaseWithSourceAccount({
      purchaseId,
      funderUid: ALICE_UID,
      funderName: 'Alice',
      sourceAccountId: acc.id,
      amountCents: 30000,
      quantity: 3,
    });

    const first = await reverseAcquisitionPurchase(
      ALICE_UID,
      {
        listId: list.id,
        itemId: item.id,
        purchaseId,
        reversalReason: 'Estorno original',
        idempotencyKey: 'idem_rev_17',
      },
      true
    );
    assert.equal(first.isIdempotentReplay, false);

    const afterFirst = snapshotDemoState();

    const secondSameKey = await reverseAcquisitionPurchase(
      ALICE_UID,
      {
        listId: list.id,
        itemId: item.id,
        purchaseId,
        reversalReason: 'Estorno original',
        idempotencyKey: 'idem_rev_17',
      },
      true
    );
    assert.equal(secondSameKey.isIdempotentReplay, true);
    assert.equal(secondSameKey.reversal.id, first.reversal.id);

    const thirdDifferentKey = await reverseAcquisitionPurchase(
      ALICE_UID,
      {
        listId: list.id,
        itemId: item.id,
        purchaseId,
        reversalReason: 'Repetição com outra chave',
        idempotencyKey: 'idem_rev_17_retry',
      },
      true
    );
    assert.equal(thirdDifferentKey.isIdempotentReplay, true);
    assert.equal(thirdDifferentKey.reversal.id, first.reversal.id);

    const afterReplays = snapshotDemoState();
    assert.deepEqual(afterReplays, afterFirst);
  });
});
