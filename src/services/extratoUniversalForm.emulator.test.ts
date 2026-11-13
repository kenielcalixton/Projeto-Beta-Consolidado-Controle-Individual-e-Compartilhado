/**
 * Suíte de Integração Real: Extrato Financeiro & Formulário Universal de Lançamentos
 *
 * Valida contra os emuladores locais reais (Auth, Firestore e Cloud Functions - demo-projeto-beta-v3):
 * 1. Ausência definitiva do erro `Property scope is undefined` nas listagens do Extrato e recorrências/parcelamentos.
 * 2. Todos os fluxos de lançamento unificados (Individual avulso, Fixo/Recorrente, Parcelamento em andamento e Espaço Compartilhado com rateio).
 * 3. Isolamento estrito entre usuários e escopos, desduplicação e leitura segura de documentos antigos/incompletos.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { auth } from './firebase';
import { createAccount, getUserAccounts } from './accountService';
import { createSpace } from './spaceService';
import { createSpaceInvite, acceptSpaceInvite } from './spaceInviteService';
import {
  createPersonalTransaction,
  getUserPersonalTransactions,
} from './personalTransactionService';
import {
  createRecurrenceRule,
  generateRecurrenceInstance,
  getRecurrenceRules,
  createInstallmentContract,
  getInstallmentContracts,
  getInstallmentOccurrences,
} from './recurrenceService';
import { createSharedExpense, getSharedExpenses } from './sharedFinanceService';

test('EXTRATO & FORMULÁRIO UNIVERSAL — EMULATOR INTEGRATION (demo-projeto-beta-v3)', async (t) => {
  const suffix = Date.now().toString(36);
  const aliceEmail = `alice.ext.${suffix}@exemplo.com`;
  const bobEmail = `bob.ext.${suffix}@exemplo.com`;
  const eveEmail = `eve.ext.${suffix}@exemplo.com`;
  const pass = 'SenhaSegura123!';

  const aliceCred = await createUserWithEmailAndPassword(auth, aliceEmail, pass);
  const aliceUid = aliceCred.user.uid;
  await signOut(auth);

  const bobCred = await createUserWithEmailAndPassword(auth, bobEmail, pass);
  const bobUid = bobCred.user.uid;
  await signOut(auth);

  const eveCred = await createUserWithEmailAndPassword(auth, eveEmail, pass);
  const eveUid = eveCred.user.uid;
  await signOut(auth);

  let aliceCheckingId = '';
  let aliceCardId = '';
  let sharedSpaceId = '';

  await t.test('1. Setup de contas e espaço compartilhado de Alice & Bob (Eve excluída)', async () => {
    await signInWithEmailAndPassword(auth, aliceEmail, pass);

    const checking = await createAccount(
      aliceUid,
      { name: 'Conta Corrente Alice', type: 'checking', color: '#2563EB' },
      false
    );
    aliceCheckingId = checking.id;

    const card = await createAccount(
      aliceUid,
      {
        name: 'Cartão Platinum Alice',
        type: 'credit',
        creditLimitCents: 500000,
        closingDay: 20,
        dueDay: 27,
        color: '#9333EA',
      },
      false
    );
    aliceCardId = card.id;

    const spaceRes = await createSpace(
      aliceUid,
      'Alice Extrato',
      aliceEmail,
      { name: 'Casa Compartilhada Extrato', description: 'Teste real de extrato unificado' },
      false
    );
    sharedSpaceId = spaceRes.space.id;

    const invite = await createSpaceInvite(
      sharedSpaceId,
      aliceUid,
      'Alice Extrato',
      { invitedEmail: bobEmail, invitedRole: 'member' },
      false
    );
    await signOut(auth);

    await signInWithEmailAndPassword(auth, bobEmail, pass);
    await acceptSpaceInvite(
      invite.rawToken,
      { uid: bobUid, displayName: 'Bob Extrato', email: bobEmail },
      false
    );
    await signOut(auth);
  });

  await t.test('2. Validação da causa raiz: queries sem scope são rejeitadas e queries com scope listam sem erros', async () => {
    await signInWithEmailAndPassword(auth, aliceEmail, pass);

    await assert.rejects(
      () => getRecurrenceRules({ userId: aliceUid } as any, false),
      (err: any) => String(err?.message || err).includes('scope')
    );
    await assert.rejects(
      () => getInstallmentContracts({ userId: aliceUid } as any, false),
      (err: any) => String(err?.message || err).includes('scope')
    );

    const rules = await getRecurrenceRules({ scope: 'personal', userId: aliceUid }, false);
    const contracts = await getInstallmentContracts({ scope: 'personal', userId: aliceUid }, false);
    assert.ok(Array.isArray(rules));
    assert.ok(Array.isArray(contracts));
  });

  await t.test('3. Fluxo Universal Individual: receita, despesa avulsa, fixo/recorrente e parcelamento em andamento', async () => {
    await signInWithEmailAndPassword(auth, aliceEmail, pass);

    // Receita paga na conta corrente (+R$ 3.000,00)
    const incomeTx = await createPersonalTransaction(
      aliceUid,
      {
        type: 'income',
        description: 'Salário Mensal Extrato',
        categoryId: 'cat_sal',
        categoryName: 'Salário',
        amountCents: 300000,
        competenceDate: '2026-11-05',
        status: 'paid',
        accountId: aliceCheckingId,
        originType: 'manual',
        notes: 'Lançado via modal universal',
        idempotencyKey: `idem_ext_inc_${suffix}`,
      },
      false
    );
    assert.equal(incomeTx.amountCents, 300000);

    // Despesa paga na conta corrente (-R$ 450,00)
    const expenseTx = await createPersonalTransaction(
      aliceUid,
      {
        type: 'expense',
        description: 'Supermercado Extrato',
        categoryId: 'cat_alim',
        categoryName: 'Alimentação',
        amountCents: 45000,
        competenceDate: '2026-11-10',
        status: 'paid',
        accountId: aliceCheckingId,
        originType: 'manual',
        idempotencyKey: `idem_ext_exp_${suffix}`,
      },
      false
    );
    assert.equal(expenseTx.amountCents, 45000);

    // Verifica saldo projetado atualizado da conta (300000 - 45000 = 255000)
    const accs = await getUserAccounts(aliceUid, false, false);
    const updatedChecking = accs.find((a) => a.id === aliceCheckingId);
    assert.equal(updatedChecking?.projectedBalanceCents, 255000);

    // Regra Fixa + Materialização de instância no mês
    const recRes = await createRecurrenceRule(
      {
        scope: 'personal',
        userId: aliceUid,
        title: 'Aluguel Apartamento',
        type: 'expense',
        nature: 'fixed',
        amountCents: 120000,
        frequency: 'monthly',
        startCompetence: '2026-11',
        dueDay: 10,
        defaultAccountId: aliceCheckingId,
        idempotencyKey: `idem_ext_rec_${suffix}`,
      },
      false
    );
    const genRes = await generateRecurrenceInstance(
      { ruleId: recRes.rule.id, competenceMonth: '2026-11' },
      false
    );
    assert.ok(genRes.instance.generatedTransactionId);

    // Parcelamento em andamento (4/6 a 6/6 no cartão)
    const instRes = await createInstallmentContract(
      {
        scope: 'personal',
        userId: aliceUid,
        title: 'Notebook Pro 6x',
        totalContractAmountCents: 600000,
        remainingAmountCents: 300000,
        totalInstallmentsCount: 6,
        initialInstallmentNumber: 4,
        fundingSource: 'credit_card',
        sourceCardAccountId: aliceCardId,
        startCompetenceMonth: '2026-11',
        dueDay: 27,
        idempotencyKey: `idem_ext_inst_${suffix}`,
      },
      false
    );
    const occs = await getInstallmentOccurrences(instRes.contract.id, false);
    assert.deepEqual(
      occs.map((o) => o.installmentNumber),
      [4, 5, 6]
    );
    assert.equal(
      occs.reduce((sum, o) => sum + o.principalAmountCents, 0),
      300000
    );

    // Confirma listagem consolidada no Extrato individual sem duplicatas
    const extratoPersonal = await getUserPersonalTransactions(
      aliceUid,
      { competenceMonth: '2026-11' },
      false
    );
    const ids = extratoPersonal.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.includes(incomeTx.id));
    assert.ok(ids.includes(expenseTx.id));
    assert.ok(ids.includes(genRes.instance.generatedTransactionId!));

    const rulesList = await getRecurrenceRules({ scope: 'personal', userId: aliceUid }, false);
    assert.ok(rulesList.some((r) => r.id === recRes.rule.id));

    const contractsList = await getInstallmentContracts({ scope: 'personal', userId: aliceUid }, false);
    assert.ok(contractsList.some((c) => c.id === instRes.contract.id));
  });

  await t.test('4. Fluxo Universal Compartilhado (rateio percentual) e isolamento de documentos/autorizações', async () => {
    await signInWithEmailAndPassword(auth, aliceEmail, pass);

    const sharedExp = await createSharedExpense(
      sharedSpaceId,
      {
        spaceId: sharedSpaceId,
        title: 'Energia Elétrica Compartilhada',
        totalOriginalAmountCents: 20000,
        competenceMonth: '2026-11',
        competenceDate: '2026-11-12',
        categoryId: 'cat_shared',
        categoryName: 'Moradia',
        createdByUid: aliceUid,
        responsibleUid: aliceUid,
        payerUid: aliceUid,
        splitMethod: 'percentage',
        participants: [
          { uid: aliceUid, name: 'Alice Extrato' },
          { uid: bobUid, name: 'Bob Extrato' },
        ],
        percentages: {
          [aliceUid]: 60,
          [bobUid]: 40,
        },
      },
      false
    );
    assert.equal(sharedExp.expense.totalOriginalAmountCents, 20000);
    assert.equal(sharedExp.liabilities.length, 2);

    // Simula documento legado/incompleto no Firestore sem alterar o campo `scope` no banco
    const { initializeApp: initAdmin, getApps: getAdminApps } = await import('firebase-admin/app');
    const { getFirestore: getAdminFirestore } = await import('firebase-admin/firestore');
    const adminApp = getAdminApps().length ? getAdminApps()[0] : initAdmin({ projectId: 'demo-projeto-beta-v3' });
    const adminDb = getAdminFirestore(adminApp);

    const legacyTxId = `tx_legacy_${suffix}`;
    await adminDb
      .doc(`users/${aliceUid}/personal_transactions/${legacyTxId}`)
      .set({
        id: legacyTxId,
        userId: aliceUid,
        description: 'Registro Antigo Incompleto',
        amountCents: 7500,
        competenceDate: '2026-11-01',
        competenceMonth: '2026-11',
      });

    const extratoAlice = await getUserPersonalTransactions(
      aliceUid,
      { competenceMonth: '2026-11' },
      false
    );
    const legacyNormalized = extratoAlice.find((t) => t.id === legacyTxId);
    assert.ok(legacyNormalized, 'Documento incompleto deve ser normalizado sem quebrar o extrato');
    assert.equal(legacyNormalized.categoryName, 'Geral');
    assert.equal(legacyNormalized.status, 'pending');

    // Confirma que o documento no banco NÃO recebeu um campo `scope` fabricado
    const rawLegacySnap = await adminDb.doc(`users/${aliceUid}/personal_transactions/${legacyTxId}`).get();
    assert.equal(rawLegacySnap.data()?.scope, undefined);

    await signOut(auth);

    // Bob (membro do espaço) enxerga despesa do espaço, mas NÃO enxerga extrato individual de Alice
    await signInWithEmailAndPassword(auth, bobEmail, pass);
    const sharedVisibleToBob = await getSharedExpenses(sharedSpaceId, bobUid, false);
    assert.ok(sharedVisibleToBob.some((e) => e.id === sharedExp.expense.id));

    await assert.rejects(
      () => getUserPersonalTransactions(aliceUid, { competenceMonth: '2026-11' }, false),
      (err: any) => err?.code === 'permission-denied' || String(err).includes('permission-denied')
    );
    await assert.rejects(
      () => getRecurrenceRules({ scope: 'personal', userId: aliceUid }, false),
      (err: any) => err?.code === 'permission-denied' || String(err).includes('permission-denied')
    );

    await signOut(auth);

    // Eve (não-membro) é bloqueada no espaço compartilhado
    await signInWithEmailAndPassword(auth, eveEmail, pass);
    await assert.rejects(
      () => getSharedExpenses(sharedSpaceId, eveUid, false),
      (err: any) => err?.code === 'permission-denied' || String(err).includes('permission-denied')
    );
    await assert.rejects(
      () => getRecurrenceRules({ scope: 'shared', spaceId: sharedSpaceId }, false),
      (err: any) => err?.code === 'permission-denied' || String(err).includes('permission-denied')
    );
  });
});
