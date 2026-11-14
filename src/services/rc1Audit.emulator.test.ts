import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { doc, getDoc, terminate } from 'firebase/firestore';
import { auth, db } from './firebase';
import { LOCAL_EMULATOR_PROJECT_ID } from '../config/environment';
import { createAccount, getAccountById } from './accountService';
import {
  cancelPersonalTransaction,
  createPersonalTransaction,
  getPersonalTransactionPayments,
  recordPartialPayment,
  reversePersonalTransactionPayment,
  updatePersonalTransaction,
} from './personalTransactionService';
import {
  AdhocRealtimePayload,
  cancelAdhocExpense,
  createAdhocExpense,
  mapAdhocObligationToTransaction,
  resolveAdhocCounterProposal,
  respondAdhocObligation,
  subscribeToUserAdhocData,
} from './adhocService';
import { createSpace, getUserSpaces } from './spaceService';
import {
  acceptSpaceInvite,
  createSpaceInvite,
  evaluateInviteAvailability,
  extractInviteToken,
  getInviteByRawToken,
} from './spaceInviteService';
import { createSpaceAttemptKey } from '../utils/spaceCreationFlow';
import {
  fetchItemsForListFromFirestore,
  fetchSharedListsFromFirestore,
  saveItemToFirestore,
  saveListToFirestore,
  subscribeToIndividualLists,
  subscribeToListItems,
  subscribeToSharedLists,
} from './acquisitionsFirebase';
import { confirmCartCheckout } from '../utils/stateMachine';
import { AcquisitionItem, AcquisitionList } from '../types/acquisitions';

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

async function createAndLoginUser(email: string, password: string): Promise<string> {
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    return cred.user.uid;
  } catch {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    return cred.user.uid;
  }
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 7000,
  stepMs = 50
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout (${timeoutMs}ms) aguardando atualização no emulador.`);
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

test('RC1 AUDIT EMULATOR — Rateio Avulso, Edição/Estorno, Convites por Token e Aquisições em Tempo Real', async (t) => {
  t.after(async () => {
    try {
      await signOut(auth);
      await terminate(db);
    } catch {
      // ignora erro de teardown
    }
  });

  await t.test(
    '1. Rateio Avulso End-to-End (2 usuários): criação, aceite sem quitação, contraproposta, resolução e cancelamento',
    async () => {
      await clearEmulatorsData();
      const aliceUid = await createAndLoginUser('alice.adhoc@emulator.local', 'Senha@123');
      const bobUid = await createAndLoginUser('bob.adhoc@emulator.local', 'Senha@123');

      // Alice cria rateio avulso envolvendo Bob
      await signInWithEmailAndPassword(auth, 'alice.adhoc@emulator.local', 'Senha@123');
      const created = await createAdhocExpense(
        aliceUid,
        {
          ownerEmail: 'alice.adhoc@emulator.local',
          ownerName: 'Alice Adhoc',
          title: 'Jantar de Equipe',
          totalAmountCents: 20000,
          date: '2026-11-10',
          dueDate: '2026-11-20',
          participants: [
            {
              uid: aliceUid,
              email: 'alice.adhoc@emulator.local',
              name: 'Alice Adhoc',
              assignedAmountCents: 10000,
              isOwner: true,
            },
            {
              email: 'bob.adhoc@emulator.local',
              name: 'Bob Adhoc',
              assignedAmountCents: 10000,
            },
          ],
          idempotencyKey: 'rc1_adhoc_1',
        },
        false
      );

      assert.equal(created.expense.totalAmountCents, 20000);
      assert.equal(created.obligations.length, 1);
      assert.equal(created.obligations[0].guestUid, bobUid);
      assert.equal(created.obligations[0].obligationStatus, 'pending_invite');

      // Bob entra, recebe via listener em tempo real e aceita a cota
      await signInWithEmailAndPassword(auth, 'bob.adhoc@emulator.local', 'Senha@123');
      let bobPayload: AdhocRealtimePayload = { expenses: [], obligations: [], transactions: [] };
      const unsubBob = subscribeToUserAdhocData(
        bobUid,
        'bob.adhoc@emulator.local',
        (data) => {
          bobPayload = data;
        },
        false
      );

      try {
        await waitForCondition(() =>
          bobPayload.obligations.some((o) => o.adhocExpenseId === created.expense.id)
        );
        // Sem duplicação no extrato do Bob
        assert.equal(
          bobPayload.transactions.filter((tx) => tx.id === created.expense.id).length,
          1
        );

        const acceptRes = await respondAdhocObligation(
          bobUid,
          {
            adhocExpenseId: created.expense.id,
            obligationId: created.obligations[0].id,
            action: 'accept',
          },
          false
        );

        // Regra crítica: aceitar cota NÃO marca despesa nem obrigação como paga!
        assert.equal(acceptRes.obligation.obligationStatus, 'accepted');
        assert.equal(acceptRes.obligation.paidAmountCents, 0);
        assert.equal(acceptRes.obligation.remainingBalanceCents, 10000);
        assert.equal(acceptRes.expense.status, 'active');

        const mappedAfterAccept = mapAdhocObligationToTransaction(
          acceptRes.obligation,
          acceptRes.expense
        );
        assert.equal(mappedAfterAccept.status, 'pending');
        assert.notEqual(mappedAfterAccept.status, 'paid');
      } finally {
        unsubBob();
      }

      // Contraproposta e resolução pelo criador
      await signInWithEmailAndPassword(auth, 'alice.adhoc@emulator.local', 'Senha@123');
      const created2 = await createAdhocExpense(
        aliceUid,
        {
          ownerEmail: 'alice.adhoc@emulator.local',
          ownerName: 'Alice Adhoc',
          title: 'Presente Aniversário',
          totalAmountCents: 30000,
          date: '2026-11-12',
          participants: [
            {
              uid: aliceUid,
              email: 'alice.adhoc@emulator.local',
              name: 'Alice Adhoc',
              assignedAmountCents: 15000,
              isOwner: true,
            },
            {
              email: 'bob.adhoc@emulator.local',
              name: 'Bob Adhoc',
              assignedAmountCents: 15000,
            },
          ],
          idempotencyKey: 'rc1_adhoc_2',
        },
        false
      );

      await signInWithEmailAndPassword(auth, 'bob.adhoc@emulator.local', 'Senha@123');
      await respondAdhocObligation(
        bobUid,
        {
          adhocExpenseId: created2.expense.id,
          obligationId: created2.obligations[0].id,
          action: 'counter_propose',
          proposedAmountCents: 12000,
          reason: 'Participação reduzida combinada',
        },
        false
      );

      await signInWithEmailAndPassword(auth, 'alice.adhoc@emulator.local', 'Senha@123');
      const resolveRes = await resolveAdhocCounterProposal(
        {
          adhocExpenseId: created2.expense.id,
          guestUid: bobUid,
          acceptCounterProposal: true,
        },
        false
      );
      assert.equal(resolveRes.ok, true);

      const exp2Snap = await getDoc(doc(db, 'adhoc_expenses', created2.expense.id));
      const exp2Data = exp2Snap.data();
      assert.ok(exp2Data);
      assert.equal(exp2Data.totalToReimburseCents, 12000);
      assert.equal(exp2Data.ownerShareAmountCents, 18000);
      assert.equal(exp2Data.negotiationStatus, 'accepted');

      // Cancelamento do rateio avulso pelo titular
      const cancelled = await cancelAdhocExpense(
        created2.expense.id,
        'Evento cancelado antes da compra',
        false
      );
      assert.equal(cancelled.status, 'cancelled');
    }
  );

  await t.test(
    '2. Lançamentos Individuais: edição segura, bloqueio de valor após pagamento, estorno compensatório e cancelamento',
    async () => {
      await clearEmulatorsData();
      const aliceUid = await createAndLoginUser('alice.tx@emulator.local', 'Senha@123');

      const checkingAcc = await createAccount(
        aliceUid,
        {
          name: 'Conta Corrente RC1',
          type: 'checking',
          icon: 'ph-bank',
          color: '#4F46E5',
        },
        false
      );

      const createdTx = await createPersonalTransaction(
        aliceUid,
        {
          description: 'Aluguel Residencial',
          amountCents: 150000,
          type: 'expense',
          status: 'pending',
          categoryId: 'cat_moradia',
          categoryName: 'Moradia',
          competenceDate: '2026-11-10',
          dueDate: '2026-11-15',
        },
        false
      );
      assert.equal(createdTx.amountCents, 150000);
      assert.equal(createdTx.status, 'pending');

      // Antes de qualquer pagamento, edição pode atualizar descrição e valor
      const editedBeforePay = await updatePersonalTransaction(
        aliceUid,
        createdTx.id,
        {
          description: 'Aluguel + Condomínio',
          amountCents: 160000,
          notes: 'Atualizado antes do pagamento',
        },
        false
      );
      assert.equal(editedBeforePay.description, 'Aluguel + Condomínio');
      assert.equal(editedBeforePay.amountCents, 160000);
      assert.equal(editedBeforePay.remainingAmountCents, 160000);

      // Amortização parcial de R$ 600,00
      const partialRes = await recordPartialPayment(
        createdTx.id,
        aliceUid,
        {
          amountCents: 60000,
          paymentDate: '2026-11-10',
          accountId: checkingAcc.id,
          authorUid: aliceUid,
          notes: 'Sinal pago',
        },
        false
      );
      assert.equal(partialRes.transaction.status, 'partially_paid');
      assert.equal(partialRes.transaction.paidAmountCents, 60000);
      assert.equal(partialRes.transaction.remainingAmountCents, 100000);

      const accAfterPay = await getAccountById(checkingAcc.id, aliceUid, false);
      assert.equal(accAfterPay?.projectedBalanceCents, -60000);

      // Com pagamento parcial ativo, alterar amountCents deve ser rejeitado
      await assert.rejects(
        async () => {
          await updatePersonalTransaction(
            aliceUid,
            createdTx.id,
            { amountCents: 170000 },
            false
          );
        },
        /estorne o pagamento|já possui pagamentos/i
      );

      // Edição apenas de metadados (observação) permanece permitida
      const editedMeta = await updatePersonalTransaction(
        aliceUid,
        createdTx.id,
        { notes: 'Aguardando saldo restante' },
        false
      );
      assert.equal(editedMeta.notes, 'Aguardando saldo restante');

      // Estorno compensatório restaura saldo e preserva histórico do pagamento original
      const revRes = await reversePersonalTransactionPayment(
        createdTx.id,
        aliceUid,
        {
          paymentId: partialRes.paymentRecord.id,
          reason: 'Pagamento lançado na conta incorreta',
        },
        false
      );
      assert.equal(revRes.isIdempotentReplay, false);
      assert.equal(revRes.transaction.paidAmountCents, 0);
      assert.equal(revRes.transaction.remainingAmountCents, 160000);
      assert.equal(revRes.transaction.status, 'pending');

      const accAfterRev = await getAccountById(checkingAcc.id, aliceUid, false);
      assert.equal(accAfterRev?.projectedBalanceCents, 0);

      const paymentsView = await getPersonalTransactionPayments(createdTx.id, aliceUid, false);
      assert.equal(paymentsView.length, 1);
      assert.equal(paymentsView[0].isReversed, true);

      // Cancelamento estruturado
      const cancelledTx = await cancelPersonalTransaction(
        createdTx.id,
        aliceUid,
        'Cobrança substituída por novo boleto',
        false
      );
      assert.equal(cancelledTx.status, 'cancelled');
      assert.equal(cancelledTx.remainingAmountCents, 0);
    }
  );

  await t.test(
    '3. Espaços Compartilhados: extração de token de URL, validação, aceite atômico e bloqueio de replay',
    async () => {
      await clearEmulatorsData();
      const aliceUid = await createAndLoginUser('alice.space@emulator.local', 'Senha@123');
      const bobUid = await createAndLoginUser('bob.space@emulator.local', 'Senha@123');

      await signInWithEmailAndPassword(auth, 'alice.space@emulator.local', 'Senha@123');
      const { space } = await createSpace(
        aliceUid,
        'Alice Space',
        'alice.space@emulator.local',
        {
          name: 'Apartamento 302',
          icon: 'ph-house-line',
          color: '#10B981',
          idempotencyKey: createSpaceAttemptKey(),
        },
        false
      );

      const { rawToken } = await createSpaceInvite(
        space.id,
        aliceUid,
        'Alice Space',
        {
          invitedEmail: 'bob.space@emulator.local',
          invitedRole: 'member',
        },
        false
      );

      const pastedLink = `https://app.local/espacos?token=${rawToken}&source=whatsapp`;
      const extracted = extractInviteToken(pastedLink);
      assert.equal(extracted, rawToken);

      // Bob verifica e aceita o convite via token extraído
      await signInWithEmailAndPassword(auth, 'bob.space@emulator.local', 'Senha@123');
      const inviteDoc = await getInviteByRawToken(pastedLink, false);
      assert.ok(inviteDoc);

      const availBefore = evaluateInviteAvailability(inviteDoc, {
        currentUserUid: bobUid,
        currentUserEmail: 'bob.space@emulator.local',
        activeMemberUids: [],
      });
      assert.equal(availBefore.canAccept, true);
      assert.equal(availBefore.code, 'valid');

      const acceptResult = await acceptSpaceInvite(
        extracted,
        {
          uid: bobUid,
          displayName: 'Bob Space',
          email: 'bob.space@emulator.local',
        },
        false
      );
      assert.equal(acceptResult.space.id, space.id);
      assert.ok(acceptResult.space.memberUids.includes(bobUid));

      const bobSpaces = await getUserSpaces(bobUid, false, false, 'active');
      assert.deepEqual(
        bobSpaces.map((s) => s.id),
        [space.id]
      );

      // Replay do mesmo token deve indicar uso prévio e ser recusado
      const inviteAfter = await getInviteByRawToken(extracted, false);
      const availAfter = evaluateInviteAvailability(inviteAfter, {
        currentUserUid: bobUid,
        currentUserEmail: 'bob.space@emulator.local',
        activeMemberUids: [space.id],
      });
      assert.equal(availAfter.canAccept, false);
      assert.equal(availAfter.code, 'accepted');

      await assert.rejects(async () => {
        await acceptSpaceInvite(
          extracted,
          {
            uid: bobUid,
            displayName: 'Bob Space',
            email: 'bob.space@emulator.local',
          },
          false
        );
      });
    }
  );

  await t.test(
    '4. Listas de Aquisição: persistência real no Firestore, isolamento individual, sync em tempo real e ciclo Carrinho -> Conferido',
    async () => {
      await clearEmulatorsData();
      const aliceUid = await createAndLoginUser('alice.acq@emulator.local', 'Senha@123');
      const bobUid = await createAndLoginUser('bob.acq@emulator.local', 'Senha@123');

      // Alice cria espaço e convida Bob
      await signInWithEmailAndPassword(auth, 'alice.acq@emulator.local', 'Senha@123');
      const { space } = await createSpace(
        aliceUid,
        'Alice Acq',
        'alice.acq@emulator.local',
        {
          name: 'Casa Compartilhada Acq',
          idempotencyKey: createSpaceAttemptKey(),
        },
        false
      );
      const { rawToken } = await createSpaceInvite(
        space.id,
        aliceUid,
        'Alice Acq',
        { invitedEmail: 'bob.acq@emulator.local', invitedRole: 'member' },
        false
      );

      await signInWithEmailAndPassword(auth, 'bob.acq@emulator.local', 'Senha@123');
      await acceptSpaceInvite(
        rawToken,
        { uid: bobUid, displayName: 'Bob Acq', email: 'bob.acq@emulator.local' },
        false
      );

      // Alice cria 1 lista individual e 1 lista compartilhada + itens
      await signInWithEmailAndPassword(auth, 'alice.acq@emulator.local', 'Senha@123');

      const indList: AcquisitionList = {
        id: 'list_ind_alice_rc1',
        workspaceId: `ind_${aliceUid}`,
        scopeType: 'individual',
        spaceId: null,
        ownerUid: aliceUid,
        name: 'Compras Pessoais Alice',
        type: 'recorrente',
        description: 'Uso pessoal',
        acceptedMemberEmails: ['alice.acq@emulator.local'],
        createdAt: new Date().toISOString(),
      };
      const sharedList: AcquisitionList = {
        id: 'list_shared_rc1',
        workspaceId: space.id,
        scopeType: 'shared',
        spaceId: space.id,
        ownerUid: aliceUid,
        name: 'Supermercado Casa',
        type: 'recorrente',
        description: 'Despensa conjunta',
        acceptedMemberEmails: ['alice.acq@emulator.local', 'bob.acq@emulator.local'],
        createdAt: new Date().toISOString(),
      };

      await saveListToFirestore(indList);
      await saveListToFirestore(sharedList);

      const indItem: AcquisitionItem = {
        id: 'item_ind_1',
        listId: indList.id,
        workspaceId: indList.workspaceId,
        createdByUid: aliceUid,
        name: 'Protetor Solar',
        groupId: 'grp_higiene',
        categoryId: 'cat_cuidados',
        listType: 'recorrente',
        stage: 'estoque',
        acceptedMemberEmails: ['alice.acq@emulator.local'],
        currentStock: 1,
        minStock: 1,
        unit: 'un',
        productsHistory: [],
        updatedAt: new Date().toISOString(),
      };
      const sharedItem: AcquisitionItem = {
        id: 'item_shared_cafe',
        listId: sharedList.id,
        workspaceId: sharedList.workspaceId,
        createdByUid: aliceUid,
        name: 'Café Torrado 500g',
        groupId: 'grp_alim',
        categoryId: 'cat_bebidas',
        listType: 'recorrente',
        stage: 'comprar',
        acceptedMemberEmails: ['alice.acq@emulator.local', 'bob.acq@emulator.local'],
        currentStock: 1,
        minStock: 2,
        unit: 'pct',
        productsHistory: [],
        updatedAt: new Date().toISOString(),
      };

      await saveItemToFirestore(indItem);
      await saveItemToFirestore(sharedItem);

      // Move o item compartilhado para 'carrinho' com cartDraft e confirma compra
      const itemInCart: AcquisitionItem = {
        ...sharedItem,
        stage: 'carrinho',
        cartDraft: {
          brand: 'Orfeu',
          unitPrice: 34.9,
          quantity: 2,
          storeName: 'Empório Café',
        },
        updatedAt: new Date().toISOString(),
      };
      await saveItemToFirestore(itemInCart);

      const { updatedItem: confirmedItem } = confirmCartCheckout(itemInCart, {
        brand: 'Orfeu',
        unitPrice: 34.9,
        quantity: 2,
        storeName: 'Empório Café',
      });
      await saveItemToFirestore(confirmedItem);

      // Bob conecta os listeners em tempo real e valida recebimento da lista compartilhada + isolamento da individual
      await signInWithEmailAndPassword(auth, 'bob.acq@emulator.local', 'Senha@123');
      let bobIndLists: AcquisitionList[] = [];
      let bobSharedLists: AcquisitionList[] = [];
      let bobSharedItems: AcquisitionItem[] = [];

      const unsubBobInd = subscribeToIndividualLists(bobUid, (l) => {
        bobIndLists = l;
      });
      const unsubBobShared = subscribeToSharedLists(space.id, (l) => {
        bobSharedLists = l;
      });
      const unsubBobItems = subscribeToListItems(sharedList.id, (items) => {
        bobSharedItems = items;
      });

      try {
        await waitForCondition(
          () =>
            bobSharedLists.some((l) => l.id === sharedList.id) &&
            bobSharedItems.some((i) => i.id === sharedItem.id && i.stage === 'conferido')
        );

        assert.equal(
          bobIndLists.some((l) => l.id === indList.id),
          false,
          'Lista individual de Alice não pode aparecer para Bob'
        );

        const syncedCafe = bobSharedItems.find((i) => i.id === sharedItem.id);
        assert.ok(syncedCafe);
        assert.equal(syncedCafe.stage, 'conferido');
        assert.equal(syncedCafe.currentStock, 3); // 1 inicial + 2 comprados
        assert.equal(syncedCafe.productsHistory.length, 1);
        assert.equal(syncedCafe.productsHistory[0].brand, 'Orfeu');

        // Simula reload (leitura direta do Firestore via getDocs)
        const reloadedLists = await fetchSharedListsFromFirestore(space.id);
        assert.equal(reloadedLists.length, 1);
        const reloadedItems = await fetchItemsForListFromFirestore(sharedList.id);
        assert.equal(reloadedItems.length, 1);
        assert.equal(reloadedItems[0].stage, 'conferido');
        assert.equal(reloadedItems[0].currentStock, 3);
        assert.equal(reloadedItems[0].productsHistory.length, 1);

        // Regra de segurança: Bob não pode ler documento da lista individual de Alice
        await assert.rejects(async () => {
          await getDoc(doc(db, 'acquisition_lists', indList.id));
        }, /permission-denied|insufficient permissions/i);
      } finally {
        unsubBobInd();
        unsubBobShared();
        unsubBobItems();
      }
    }
  );
});
