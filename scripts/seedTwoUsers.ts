/**
 * Script de Provisionamento de Dados de Demonstração / Homologação RC1
 *
 * Cria dois usuários fictícios independentes (Alice e Bob) e um espaço compartilhado
 * com contas bancárias, cartões, despesas individuais e rateio compartilhado
 * para homologação no Firebase Emulator Suite (demo-projeto-beta-v3).
 *
 * Credenciais criadas:
 * - Alice: alice.rc1@exemplo.com / SenhaSegura123!
 * - Bob:   bob.rc1@exemplo.com   / SenhaSegura123!
 */

import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-projeto-beta-v3';

const app = getApps().length ? getApps()[0] : initializeApp({ projectId: 'demo-projeto-beta-v3' });
const adminAuth = getAuth(app);
const adminDb = getFirestore(app);

export async function seedTwoUsers() {
  console.log('🌱 Iniciando provisionamento de Alice e Bob no Firebase Emulator...');

  const now = new Date().toISOString();
  const effectiveDate = now.slice(0, 10);

  // ----------------------------------------------------------------------------
  // 1. USUÁRIO 1: ALICE
  // ----------------------------------------------------------------------------
  const aliceEmail = 'alice.rc1@exemplo.com';
  const alicePassword = 'SenhaSegura123!';
  let aliceRecord;
  try {
    aliceRecord = await adminAuth.getUserByEmail(aliceEmail);
  } catch {
    aliceRecord = await adminAuth.createUser({
      email: aliceEmail,
      password: alicePassword,
      displayName: 'Alice Silva',
      emailVerified: true,
    });
  }
  const aliceUid = aliceRecord.uid;
  console.log(`✅ Alice provisionada com UID: ${aliceUid}`);

  await adminDb.doc(`users/${aliceUid}`).set(
    {
      uid: aliceUid,
      email: aliceEmail,
      displayName: 'Alice Silva',
      name: 'Alice Silva',
      createdAt: now,
      updatedAt: now,
    },
    { merge: true }
  );

  // Contas da Alice
  const aliceCheckingId = `acc_checking_${aliceUid.slice(0, 8)}`;
  await adminDb.doc(`accounts/${aliceCheckingId}`).set({
    id: aliceCheckingId,
    userId: aliceUid,
    name: 'Nubank Alice',
    type: 'checking',
    currency: 'BRL',
    initialBalanceCents: 500000, // R$ 5.000,00
    isArchived: false,
    createdAt: now,
    updatedAt: now,
  });

  const aliceCheckingMovInitial = `mov_init_${aliceCheckingId}`;
  await adminDb.doc(`movements/${aliceCheckingMovInitial}`).set({
    id: aliceCheckingMovInitial,
    accountId: aliceCheckingId,
    userId: aliceUid,
    direction: 'inflow',
    amountCents: 500000,
    effectiveDate,
    originType: 'initial_balance',
    originId: aliceCheckingId,
    description: 'Saldo Inicial Nubank',
    createdAt: now,
  });

  const aliceCardId = `acc_card_${aliceUid.slice(0, 8)}`;
  await adminDb.doc(`accounts/${aliceCardId}`).set({
    id: aliceCardId,
    userId: aliceUid,
    name: 'Visa Infinite Alice',
    type: 'credit',
    currency: 'BRL',
    creditLimitCents: 1000000, // R$ 10.000,00
    closingDay: 15,
    dueDay: 25,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
  });

  // Categorias da Alice
  const aliceCategories = [
    { id: `cat_alim_${aliceUid.slice(0, 6)}`, name: 'Alimentação', type: 'expense', color: '#10B981', icon: 'fork-knife' },
    { id: `cat_mora_${aliceUid.slice(0, 6)}`, name: 'Moradia', type: 'expense', color: '#6366F1', icon: 'house' },
    { id: `cat_laze_${aliceUid.slice(0, 6)}`, name: 'Lazer', type: 'expense', color: '#F59E0B', icon: 'ticket' },
    { id: `cat_tran_${aliceUid.slice(0, 6)}`, name: 'Transporte', type: 'expense', color: '#EC4899', icon: 'car' },
    { id: `cat_sala_${aliceUid.slice(0, 6)}`, name: 'Salário', type: 'income', color: '#3B82F6', icon: 'money' },
  ];
  for (const cat of aliceCategories) {
    await adminDb.doc(`users/${aliceUid}/categories/${cat.id}`).set({
      ...cat,
      userId: aliceUid,
      createdAt: now,
    });
  }

  // Transação Individual da Alice
  const aliceTxId = `tx_superm_${aliceUid.slice(0, 8)}`;
  await adminDb.doc(`users/${aliceUid}/personal_transactions/${aliceTxId}`).set({
    id: aliceTxId,
    userId: aliceUid,
    description: 'Supermercado Semanal',
    amountCents: 25000, // R$ 250,00
    type: 'expense',
    accountId: aliceCheckingId,
    categoryId: aliceCategories[0].id,
    date: effectiveDate,
    paymentStatus: 'paid',
    notes: 'Compras de hortifruti da semana',
    createdAt: now,
    updatedAt: now,
  });

  const aliceTxMovId = `mov_tx_${aliceTxId}`;
  await adminDb.doc(`movements/${aliceTxMovId}`).set({
    id: aliceTxMovId,
    accountId: aliceCheckingId,
    userId: aliceUid,
    direction: 'outflow',
    amountCents: 25000,
    effectiveDate,
    originType: 'personal_expense',
    originId: aliceTxId,
    description: 'Supermercado Semanal',
    createdAt: now,
  });

  // Regra de Recorrência da Alice
  const aliceRuleId = `rec_netflix_${aliceUid.slice(0, 8)}`;
  await adminDb.doc(`recurrence_rules/${aliceRuleId}`).set({
    id: aliceRuleId,
    title: 'Assinatura Netflix',
    description: 'Plano Familiar 4K',
    amountCents: 5590, // R$ 55,90
    scopeType: 'individual',
    ownerUid: aliceUid,
    frequency: 'monthly',
    interval: 1,
    dayOfMonth: 10,
    isActive: true,
    autoCharge: false,
    defaultAccountId: aliceCheckingId,
    defaultCategoryId: aliceCategories[2].id,
    createdAt: now,
    updatedAt: now,
  });

  // ----------------------------------------------------------------------------
  // 2. USUÁRIO 2: BOB
  // ----------------------------------------------------------------------------
  const bobEmail = 'bob.rc1@exemplo.com';
  const bobPassword = 'SenhaSegura123!';
  let bobRecord;
  try {
    bobRecord = await adminAuth.getUserByEmail(bobEmail);
  } catch {
    bobRecord = await adminAuth.createUser({
      email: bobEmail,
      password: bobPassword,
      displayName: 'Bob Souza',
      emailVerified: true,
    });
  }
  const bobUid = bobRecord.uid;
  console.log(`✅ Bob provisionado com UID: ${bobUid}`);

  await adminDb.doc(`users/${bobUid}`).set(
    {
      uid: bobUid,
      email: bobEmail,
      displayName: 'Bob Souza',
      name: 'Bob Souza',
      createdAt: now,
      updatedAt: now,
    },
    { merge: true }
  );

  // Conta do Bob
  const bobCheckingId = `acc_checking_${bobUid.slice(0, 8)}`;
  await adminDb.doc(`accounts/${bobCheckingId}`).set({
    id: bobCheckingId,
    userId: bobUid,
    name: 'Inter Bob',
    type: 'checking',
    currency: 'BRL',
    initialBalanceCents: 400000, // R$ 4.000,00
    isArchived: false,
    createdAt: now,
    updatedAt: now,
  });

  const bobCheckingMovInitial = `mov_init_${bobCheckingId}`;
  await adminDb.doc(`movements/${bobCheckingMovInitial}`).set({
    id: bobCheckingMovInitial,
    accountId: bobCheckingId,
    userId: bobUid,
    direction: 'inflow',
    amountCents: 400000,
    effectiveDate,
    originType: 'initial_balance',
    originId: bobCheckingId,
    description: 'Saldo Inicial Banco Inter',
    createdAt: now,
  });

  // Categorias do Bob
  const bobCategories = [
    { id: `cat_alim_${bobUid.slice(0, 6)}`, name: 'Alimentação', type: 'expense', color: '#10B981', icon: 'fork-knife' },
    { id: `cat_laze_${bobUid.slice(0, 6)}`, name: 'Lazer', type: 'expense', color: '#F59E0B', icon: 'ticket' },
    { id: `cat_serv_${bobUid.slice(0, 6)}`, name: 'Serviços', type: 'expense', color: '#8B5CF6', icon: 'wrench' },
    { id: `cat_sala_${bobUid.slice(0, 6)}`, name: 'Salário', type: 'income', color: '#3B82F6', icon: 'money' },
  ];
  for (const cat of bobCategories) {
    await adminDb.doc(`users/${bobUid}/categories/${cat.id}`).set({
      ...cat,
      userId: bobUid,
      createdAt: now,
    });
  }

  // ----------------------------------------------------------------------------
  // 3. ESPAÇO COMPARTILHADO: RESIDÊNCIA ALICE & BOB
  // ----------------------------------------------------------------------------
  const spaceId = 'space_alice_bob_rc1';
  await adminDb.doc(`spaces/${spaceId}`).set({
    id: spaceId,
    name: 'Residência Alice & Bob',
    description: 'Gestão financeira compartilhada do casal',
    createdByUid: aliceUid,
    ownerUid: aliceUid,
    isArchived: false,
    members: [
      { uid: aliceUid, role: 'owner', joinedAt: now },
      { uid: bobUid, role: 'member', joinedAt: now },
    ],
    createdAt: now,
    updatedAt: now,
  });

  await adminDb.doc(`spaces/${spaceId}/members/${aliceUid}`).set({
    uid: aliceUid,
    displayName: 'Alice Silva',
    email: aliceEmail,
    role: 'owner',
    status: 'active',
    joinedAt: now,
  });

  await adminDb.doc(`spaces/${spaceId}/members/${bobUid}`).set({
    uid: bobUid,
    displayName: 'Bob Souza',
    email: bobEmail,
    role: 'member',
    status: 'active',
    joinedAt: now,
  });

  // Despesa Compartilhada: Compras do Mês (R$ 400,00 dividida meio a meio)
  const expenseId = 'exp_compras_mes_01';
  await adminDb.doc(`spaces/${spaceId}/shared_expenses/${expenseId}`).set({
    id: expenseId,
    spaceId,
    title: 'Compras do Mês',
    description: 'Abastecimento da despensa e produtos de limpeza',
    totalOriginalAmountCents: 40000, // R$ 400,00
    competenceMonth: now.slice(0, 7),
    splitMethod: 'equal',
    createdByUid: aliceUid,
    responsibleUid: aliceUid,
    payerUid: aliceUid,
    participantUids: [aliceUid, bobUid],
    createdAt: now,
    updatedAt: now,
  });

  // Cota da Alice (Já quitada pelo desembolso inicial)
  const aliceLiabId = `liab_alice_${expenseId}`;
  await adminDb.doc(`spaces/${spaceId}/shared_expenses/${expenseId}/liabilities/${aliceLiabId}`).set({
    id: aliceLiabId,
    expenseId,
    spaceId,
    debtorUid: aliceUid,
    responsibleUid: aliceUid,
    originalAmountCents: 20000, // R$ 200,00
    currentAmountCents: 20000,
    remainingAmountCents: 0,
    status: 'paid',
    createdAt: now,
    updatedAt: now,
  });

  // Cota do Bob (Pendente para pagamento/validação)
  const bobLiabId = `liab_bob_${expenseId}`;
  await adminDb.doc(`spaces/${spaceId}/shared_expenses/${expenseId}/liabilities/${bobLiabId}`).set({
    id: bobLiabId,
    expenseId,
    spaceId,
    debtorUid: bobUid,
    responsibleUid: aliceUid,
    originalAmountCents: 20000, // R$ 200,00
    currentAmountCents: 20000,
    remainingAmountCents: 20000,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  });

  // ----------------------------------------------------------------------------
  // 4. TRANSFERÊNCIA SOB CUSTÓDIA (ALICE -> BOB: R$ 300,00)
  // ----------------------------------------------------------------------------
  const custodyTransferId = 'cust_transfer_feira_01';
  await adminDb.doc(`transfers/${custodyTransferId}`).set({
    id: custodyTransferId,
    spaceId,
    senderUid: aliceUid,
    custodianUid: bobUid,
    initialAmountCents: 30000, // R$ 300,00
    availableBalanceCents: 30000,
    usedAmountCents: 0,
    returnedAmountCents: 0,
    reservedForReturnCents: 0,
    custodyStatus: 'available',
    description: 'Adiantamento para Feira & Açougue',
    sourceAccountId: aliceCheckingId,
    destinationAccountId: bobCheckingId,
    createdAt: now,
    updatedAt: now,
  });

  await adminDb.doc(`transfers/${custodyTransferId}/events/evt_01_created`).set({
    id: 'evt_01_created',
    transferId: custodyTransferId,
    eventType: 'created',
    amountCents: 30000,
    performedByUid: aliceUid,
    justification: 'Fundo semanal sob custódia do Bob',
    timestamp: now,
  });

  await adminDb.doc(`transfers/${custodyTransferId}/events/evt_02_receipt`).set({
    id: 'evt_02_receipt',
    transferId: custodyTransferId,
    eventType: 'receipt_confirmed',
    amountCents: 30000,
    affectedAccountId: bobCheckingId,
    performedByUid: bobUid,
    justification: 'Recebido via Pix na conta Inter',
    timestamp: now,
  });

  console.log('🎉 Provisionamento concluído com sucesso!');
  console.log('--------------------------------------------------');
  console.log('Usuários criados para testes:');
  console.log(`1. Alice: ${aliceEmail} | Senha: ${alicePassword} (UID: ${aliceUid})`);
  console.log(`2. Bob:   ${bobEmail}   | Senha: ${bobPassword} (UID: ${bobUid})`);
  console.log(`Espaço Compartilhado: "${spaceId}" (Residência Alice & Bob)`);
  console.log('--------------------------------------------------');

  return {
    alice: { uid: aliceUid, email: aliceEmail, checkingId: aliceCheckingId, cardId: aliceCardId },
    bob: { uid: bobUid, email: bobEmail, checkingId: bobCheckingId },
    space: { id: spaceId, expenseId, custodyTransferId },
  };
}

// Execução direta caso chamado via CLI
if (process.argv[1]?.endsWith('seedTwoUsers.ts')) {
  seedTwoUsers()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Erro no provisionamento:', err);
      process.exit(1);
    });
}
