/**
 * Suíte de Testes de Integração Real: Fase 9 — Recorrências e Parcelamentos Desacoplados
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
} from 'firebase/firestore';
import { auth, db } from './firebase';
import { createSpace } from './spaceService';
import { createSpaceInvite, acceptSpaceInvite } from './spaceInviteService';
import {
  createRecurrenceRule,
  generateRecurrenceInstance,
  getRecurrenceRuleById,
  getRecurrenceInstances,
  createInstallmentContract,
  cancelInstallmentContract,
  getInstallmentContractById,
  getInstallmentOccurrences,
} from './recurrenceService';

test('FASE 9 — EMULATOR INTEGRATION: Recorrências e Parcelamentos Desacoplados (v3.1)', async (t) => {
  // 1. Criação e autenticação de Alice
  const aliceCred = await createUserWithEmailAndPassword(
    auth,
    'alice.phase9@exemplo.com',
    'SenhaSegura123!'
  );
  const aliceUid = aliceCred.user.uid;

  // Criação do espaço compartilhado por Alice
  const createdSpace = await createSpace(
    aliceUid,
    'Alice Recorrente',
    'alice.phase9@exemplo.com',
    {
      name: 'Espaço Recorrências e Parcelamentos',
      description: 'Espaço para testes da Fase 9',
    },
    false
  );
  const spaceId = createdSpace.space.id;

  const inviteBob = await createSpaceInvite(
    spaceId,
    aliceUid,
    'Alice Recorrente',
    {
      invitedEmail: 'bob.phase9@exemplo.com',
      invitedRole: 'member',
    },
    false
  );

  await signOut(auth);

  // 2. Criação de Bob e ingresso no espaço
  const bobCred = await createUserWithEmailAndPassword(
    auth,
    'bob.phase9@exemplo.com',
    'SenhaSegura123!'
  );
  const bobUid = bobCred.user.uid;

  await acceptSpaceInvite(
    inviteBob.rawToken,
    { uid: bobUid, displayName: 'Bob Recorrente', email: 'bob.phase9@exemplo.com' },
    false
  );

  await signOut(auth);

  let individualRuleId = '';
  let sharedRuleId = '';
  let contract3xId = '';

  await t.test('1. Alice cria regra de recorrência individual no Firestore via Cloud Function autoritativa', async () => {
    await signInWithEmailAndPassword(auth, 'alice.phase9@exemplo.com', 'SenhaSegura123!');

    const res = await createRecurrenceRule(
      {
        scope: 'personal',
        userId: aliceUid,
        title: 'Assinatura Streaming HD',
        description: 'Mensalidade de streaming',
        amountCents: 4990,
        frequency: 'monthly',
        interval: 1,
        startCompetence: '2026-01',
        dueDay: 10,
        idempotencyKey: 'idem_real_rule_alice_01',
      },
      false
    );

    assert.ok(res.rule.id);
    assert.equal(res.isIdempotentReplay, false);
    individualRuleId = res.rule.id;
    assert.equal(res.rule.amountCents, 4990);
    assert.equal(res.rule.dueDay, 10);
    assert.equal(res.rule.status, 'active');

    // Valida idempotência real no servidor
    const resDup = await createRecurrenceRule(
      {
        scope: 'personal',
        userId: aliceUid,
        title: 'Assinatura Streaming HD',
        amountCents: 4990,
        startCompetence: '2026-01',
        dueDay: 10,
        idempotencyKey: 'idem_real_rule_alice_01',
      },
      false
    );
    assert.equal(resDup.isIdempotentReplay, true);
    assert.equal(resDup.rule.id, individualRuleId);

    // Valida persistência direta no Firestore
    const snap = await getDoc(doc(db, 'recurrence_rules', individualRuleId));
    assert.ok(snap.exists());
    assert.equal(snap.data().title, 'Assinatura Streaming HD');
  });

  await t.test('2. Alice gera instâncias de recorrência por competência com idempotência estrita', async () => {
    await signInWithEmailAndPassword(auth, 'alice.phase9@exemplo.com', 'SenhaSegura123!');

    const gen1 = await generateRecurrenceInstance(
      {
        ruleId: individualRuleId,
        competenceMonth: '2026-01',
      },
      false
    );
    assert.equal(gen1.isIdempotentReplay, false);
    assert.equal(gen1.instance.competenceMonth, '2026-01');
    assert.equal(gen1.instance.actualAmountCents, 4990);
    assert.equal(gen1.instance.generationStatus, 'generated');

    // Replay idempotente na mesma competência
    const gen1Replay = await generateRecurrenceInstance(
      {
        ruleId: individualRuleId,
        competenceMonth: '2026-01',
      },
      false
    );
    assert.equal(gen1Replay.isIdempotentReplay, true);
    assert.equal(gen1Replay.instance.competenceMonth, '2026-01');

    // Próxima competência
    const gen2 = await generateRecurrenceInstance(
      {
        ruleId: individualRuleId,
        competenceMonth: '2026-02',
      },
      false
    );
    assert.equal(gen2.isIdempotentReplay, false);
    assert.equal(gen2.instance.competenceMonth, '2026-02');

    const instances = await getRecurrenceInstances(individualRuleId, false);
    assert.equal(instances.length, 2);
  });

  await t.test('3. Criação de contrato de parcelamento em 3x com divisão estrita de centavos (conservação contábil)', async () => {
    await signInWithEmailAndPassword(auth, 'alice.phase9@exemplo.com', 'SenhaSegura123!');

    // R$ 100,00 (10000 centavos) divididos em 3x:
    // Base = 3333 centavos. Resto = 1 centavo.
    // Parcela 1 = 3334 centavos
    // Parcela 2 = 3333 centavos
    // Parcela 3 = 3333 centavos
    const res = await createInstallmentContract(
      {
        scope: 'personal',
        userId: aliceUid,
        title: 'Compra Eletrônicos 3x',
        totalContractAmountCents: 10000,
        totalInstallmentsCount: 3,
        startCompetenceMonth: '2026-03',
        dueDay: 15,
        idempotencyKey: 'idem_real_contract_3x_alice',
      },
      false
    );

    assert.ok(res.contract.id);
    contract3xId = res.contract.id;
    assert.equal(res.isIdempotentReplay, false);
    assert.equal(res.contract.totalContractAmountCents, 10000);
    assert.equal(res.contract.totalInstallmentsCount, 3);
    assert.equal(res.contract.status, 'active');

    // Valida ocorrências geradas no Firestore
    const occurrences = await getInstallmentOccurrences(contract3xId, false);
    assert.equal(occurrences.length, 3);

    assert.equal(occurrences[0].installmentNumber, 1);
    assert.equal(occurrences[0].principalAmountCents, 3334);
    assert.equal(occurrences[0].competenceMonth, '2026-03');
    assert.equal(occurrences[0].dueDate, '2026-03-15');
    assert.equal(occurrences[0].status, 'scheduled');

    assert.equal(occurrences[1].installmentNumber, 2);
    assert.equal(occurrences[1].principalAmountCents, 3333);
    assert.equal(occurrences[1].competenceMonth, '2026-04');
    assert.equal(occurrences[1].dueDate, '2026-04-15');
    assert.equal(occurrences[1].status, 'scheduled');

    assert.equal(occurrences[2].installmentNumber, 3);
    assert.equal(occurrences[2].principalAmountCents, 3333);
    assert.equal(occurrences[2].competenceMonth, '2026-05');
    assert.equal(occurrences[2].dueDate, '2026-05-15');
    assert.equal(occurrences[2].status, 'scheduled');

    // Valida soma total exata
    const totalSum = occurrences.reduce((acc, o) => acc + o.principalAmountCents, 0);
    assert.equal(totalSum, 10000);
  });

  await t.test('4. Cancelamento antecipado de parcelamento preserva parcelas faturadas ou pagas e cancela apenas scheduled', async () => {
    await signInWithEmailAndPassword(auth, 'alice.phase9@exemplo.com', 'SenhaSegura123!');

    // Simula que a parcela 01 foi faturada (billed) e a parcela 02 foi paga (paid)
    const occ1Ref = doc(db, 'installment_contracts', contract3xId, 'occurrences', '01');
    const occ2Ref = doc(db, 'installment_contracts', contract3xId, 'occurrences', '02');

    await updateDoc(occ1Ref, { status: 'billed' });
    await updateDoc(occ2Ref, { status: 'paid' });

    // Alice executa o cancelamento antecipado
    const cancelRes = await cancelInstallmentContract(
      {
        contractId: contract3xId,
        cancellationReason: 'Devolução parcial autorizada pela loja',
      },
      false
    );

    assert.equal(cancelRes.contract.status, 'cancelled_early');
    assert.equal(cancelRes.cancelledCount, 1); // Apenas a parcela 03 era 'scheduled'

    // Validação de integridade no Firestore
    const occurrencesAfter = await getInstallmentOccurrences(contract3xId, false);
    assert.equal(occurrencesAfter[0].status, 'billed'); // Preservada
    assert.equal(occurrencesAfter[1].status, 'paid'); // Preservada
    assert.equal(occurrencesAfter[2].status, 'cancelled'); // Cancelada
  });

  await t.test('5. Bob no espaço compartilhado acessa regra compartilhada e é impedido de acessar regra pessoal de Alice', async () => {
    await signInWithEmailAndPassword(auth, 'alice.phase9@exemplo.com', 'SenhaSegura123!');

    // Alice cria regra compartilhada no espaço
    const sharedRes = await createRecurrenceRule(
      {
        scope: 'shared',
        userId: aliceUid,
        spaceId,
        title: 'Internet Fibra do Espaço',
        amountCents: 15000,
        startCompetence: '2026-01',
        dueDay: 20,
        idempotencyKey: 'idem_real_rule_shared_01',
      },
      false
    );
    sharedRuleId = sharedRes.rule.id;

    await signOut(auth);

    // Bob se autentica
    await signInWithEmailAndPassword(auth, 'bob.phase9@exemplo.com', 'SenhaSegura123!');

    // Bob consegue ler a regra compartilhada do espaço
    const sharedSnap = await getDoc(doc(db, 'recurrence_rules', sharedRuleId));
    assert.ok(sharedSnap.exists());
    assert.equal(sharedSnap.data().title, 'Internet Fibra do Espaço');

    // Bob tenta ler a regra individual de Alice (Firestore Security Rules deve bloquear com permission-denied)
    await assert.rejects(
      async () => {
        await getDoc(doc(db, 'recurrence_rules', individualRuleId));
      },
      (err: any) => {
        return err.code === 'permission-denied' || String(err).includes('permission-denied');
      }
    );
  });
});
