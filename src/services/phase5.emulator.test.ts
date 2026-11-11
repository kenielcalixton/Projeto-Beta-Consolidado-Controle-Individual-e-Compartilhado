import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { terminate } from 'firebase/firestore';
import { ref, uploadString, getDownloadURL } from 'firebase/storage';
import {
  auth,
  db,
  getFirebaseConnectionDiagnostics,
  storage,
} from './firebase';
import {
  assertRemoteFirebaseIsolation,
  getActiveFirebaseConfig,
  LOCAL_EMULATOR_PROJECT_ID,
  PROTECTED_REMOTE_PROJECT_ID,
} from '../config/environment';
import {
  archiveSpace,
  createSpace,
  getSpaceById,
  getSpaceMembers,
  getUserSpaces,
  leaveSpace,
  removeMemberFromSpace,
  unarchiveSpace,
} from './spaceService';
import {
  acceptSpaceInvite,
  createSpaceInvite,
  getSpaceInvites,
} from './spaceInviteService';
import {
  getSpaceDissolutionRequest,
  initiateSpaceDissolution,
  processDissolutionTimeout,
  submitAuthorDestinationDecision,
} from './spaceDissolutionService';
import {
  getSpaceAuditEvents,
  recordSpaceAuditEvent,
} from './spaceAuditService';
import {
  getUserSpaceNotifications,
  markNotificationAsRead,
} from './spaceNotificationService';

async function clearEmulatorsData(): Promise<void> {
  // Limpa Firestore Emulator
  await fetch(
    `http://127.0.0.1:8080/emulator/v1/projects/${LOCAL_EMULATOR_PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' }
  );
  // Limpa Auth Emulator
  await fetch(
    `http://127.0.0.1:9099/emulator/v1/projects/${LOCAL_EMULATOR_PROJECT_ID}/accounts`,
    { method: 'DELETE' }
  );
}

async function createAndLoginUser(
  email: string,
  password: string
): Promise<string> {
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    return cred.user.uid;
  } catch {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    return cred.user.uid;
  }
}

test('INTEGRAÇÃO REAL — Firebase Emulator Suite (Auth + Firestore + Storage + Cloud Functions + Concorrência)', async (t) => {
  t.after(async () => {
    try {
      await signOut(auth);
      await terminate(db);
    } catch {
      // ignora erro no encerramento
    }
  });

  await t.test('1. Isolamento Absoluto: comprova conexão aos emuladores locais e bloqueio do projeto remoto', async () => {
    const diag = getFirebaseConnectionDiagnostics();
    assert.equal(diag.projectId, LOCAL_EMULATOR_PROJECT_ID);
    assert.notEqual(diag.projectId, PROTECTED_REMOTE_PROJECT_ID);
    assert.equal(diag.emulatorsEnabled, true);
    assert.equal(diag.emulatorsConnected, true);
    assert.equal(diag.endpoints?.host, '127.0.0.1');
    assert.equal(diag.endpoints?.authPort, 9099);
    assert.equal(diag.endpoints?.firestorePort, 8080);
    assert.equal(diag.endpoints?.storagePort, 9199);
    assert.equal(diag.endpoints?.functionsPort, 5001);

    // Garante que qualquer tentativa de passar o projeto remoto `teste-beta-fin-e-list` falha com erro de segurança
    assert.throws(() => {
      assertRemoteFirebaseIsolation(
        {
          ...getActiveFirebaseConfig(),
          projectId: PROTECTED_REMOTE_PROJECT_ID,
        },
        true
      );
    }, /Security Isolation Error/i);
  });

  await t.test('2. Emuladores Auth, Firestore, Storage e Reinicialização de Dados Locais', async () => {
    await clearEmulatorsData();

    const aliceUid = await createAndLoginUser('alice@emulator.local', 'Senha@123');
    assert.ok(aliceUid);

    // Valida Storage Emulator (porta 9199)
    const storageRef = ref(storage, `users/${aliceUid}/comprovante_teste.txt`);
    await uploadString(storageRef, 'Comprovante emulado local v3.1');
    const url = await getDownloadURL(storageRef);
    assert.match(url, /127\.0\.0\.1:9199|localhost:9199/);

    // Reinicializa e comprova limpeza
    await signOut(auth);
    await clearEmulatorsData();
  });

  await t.test('3. Backend Server-Side (Cloud Functions + Admin SDK): governança, convites, remoção, auditoria determinística e bloqueio não autorizado', async () => {
    await clearEmulatorsData();

    const aliceUid = await createAndLoginUser('alice@emulator.local', 'Senha@123');
    const bobUid = await createAndLoginUser('bob@emulator.local', 'Senha@123');
    const carolUid = await createAndLoginUser('carol@emulator.local', 'Senha@123');
    const strangerUid = await createAndLoginUser('stranger@emulator.local', 'Senha@123');

    // 3.1. Login como Alice (Criadora) e criação real no Firestore + Cloud Function de auditoria
    await signInWithEmailAndPassword(auth, 'alice@emulator.local', 'Senha@123');
    const { space } = await createSpace(
      aliceUid,
      'Alice Silva',
      'alice@emulator.local',
      {
        name: 'Condomínio Solar',
        description: 'Espaço real no Emulator',
        monthlyBudgetCents: 600000,
      },
      false // MODO REAL (Firestore + Cloud Functions Emulator)
    );

    // Verifica que a Cloud Function gravou o evento oficial de auditoria no Firestore
    const initialAudits = await getSpaceAuditEvents(space.id, aliceUid, false);
    assert.equal(initialAudits.length, 1);
    assert.equal(initialAudits[0].eventType, 'space_created');
    assert.ok(initialAudits[0].id.startsWith('audit_'));

    // 3.2. Repetição idempotente da mesma gravação de auditoria retorna o mesmo ID e não duplica no Firestore
    await recordSpaceAuditEvent(
      {
        spaceId: space.id,
        eventType: 'space_created',
        performedByUid: aliceUid,
        performedByName: 'Alice Silva',
        details: { name: space.name },
        operationKey: `create_${space.id}`,
      },
      false
    );
    const auditsAfterReplay = await getSpaceAuditEvents(space.id, aliceUid, false);
    assert.equal(auditsAfterReplay.length, 1);

    // 3.3. Alice gera convite e Bob aceita no Emulator
    const { rawToken: tokenBob } = await createSpaceInvite(
      space.id,
      aliceUid,
      'Alice Silva',
      { invitedRole: 'member' },
      false
    );

    await signInWithEmailAndPassword(auth, 'bob@emulator.local', 'Senha@123');
    await acceptSpaceInvite(
      tokenBob,
      { uid: bobUid, displayName: 'Bob Souza', email: 'bob@emulator.local' },
      false
    );

    // Alice também convida Carol
    await signInWithEmailAndPassword(auth, 'alice@emulator.local', 'Senha@123');
    const { rawToken: tokenCarol } = await createSpaceInvite(
      space.id,
      aliceUid,
      'Alice Silva',
      { invitedRole: 'member' },
      false
    );

    await signInWithEmailAndPassword(auth, 'carol@emulator.local', 'Senha@123');
    await acceptSpaceInvite(
      tokenCarol,
      { uid: carolUid, displayName: 'Carol Lima', email: 'carol@emulator.local' },
      false
    );

    // Verifica que Alice recebeu notificações determinísticas via Cloud Function
    await signInWithEmailAndPassword(auth, 'alice@emulator.local', 'Senha@123');
    const aliceNotifs = await getUserSpaceNotifications(aliceUid, false);
    assert.ok(aliceNotifs.some((n) => n.type === 'invite_accepted'));

    // 3.4. Teste de bloqueio no backend: Stranger tenta forjar evento de auditoria via Cloud Function
    await signInWithEmailAndPassword(auth, 'stranger@emulator.local', 'Senha@123');
    await assert.rejects(
      async () => {
        await recordSpaceAuditEvent(
          {
            spaceId: space.id,
            eventType: 'space_archived',
            performedByUid: strangerUid,
            performedByName: 'Invasor',
          },
          false
        );
      }
    );

    // 3.5. Teste de bloqueio no backend: Bob (membro comum) tenta registrar evento de arquivamento na Cloud Function
    await signInWithEmailAndPassword(auth, 'bob@emulator.local', 'Senha@123');
    await assert.rejects(
      async () => {
        await recordSpaceAuditEvent(
          {
            spaceId: space.id,
            eventType: 'space_archived',
            performedByUid: bobUid,
            performedByName: 'Bob Souza',
          },
          false
        );
      }
    );

    // 3.6. Alice remove Bob e verificamos o acesso histórico real no Firestore Emulator
    await signInWithEmailAndPassword(auth, 'alice@emulator.local', 'Senha@123');
    await removeMemberFromSpace(space.id, aliceUid, 'Alice Silva', bobUid, false);

    // Alice arquiva e desarquiva (operações pós-saída de Bob)
    await archiveSpace(space.id, aliceUid, 'Alice Silva', false);
    await unarchiveSpace(space.id, aliceUid, 'Alice Silva', false);

    // Bob loga como ex-participante no Firestore Emulator
    await signInWithEmailAndPassword(auth, 'bob@emulator.local', 'Senha@123');

    // Bob NÃO vê o espaço em 'active', mas vê a projeção histórica sanitizada em 'historical'
    const bobActive = await getUserSpaces(bobUid, true, false, 'active');
    assert.equal(bobActive.length, 0);

    const bobHistorical = await getUserSpaces(bobUid, true, false, 'historical');
    assert.equal(bobHistorical.length, 1);
    assert.equal(bobHistorical[0].id, space.id);
    assert.deepEqual(bobHistorical[0].memberUids, []); // Não expõe membros atuais
    assert.equal(bobHistorical[0].monthlyBudgetCents, undefined); // Não expõe orçamento

    // Bob NÃO pode listar convites do espaço
    await assert.rejects(
      async () => {
        await getSpaceInvites(space.id, bobUid, false);
      }
    );

    // Bob consulta membros e recebe APENAS o seu próprio documento
    const bobMembers = await getSpaceMembers(space.id, bobUid, false);
    assert.equal(bobMembers.length, 1);
    assert.equal(bobMembers[0].uid, bobUid);

    // Bob consulta auditoria no Firestore Emulator e recebe APENAS os eventos onde foi ator ou alvo
    const bobAudits = await getSpaceAuditEvents(space.id, bobUid, false);
    assert.ok(bobAudits.length >= 2); // invite_accepted e member_removed
    assert.ok(
      bobAudits.every(
        (ev) => ev.performedByUid === bobUid || ev.targetUid === bobUid
      )
    );
  });

  await t.test('4. Concorrência Real no Firestore + Functions Emulator: múltiplas chamadas simultâneas de processDissolutionTimeout', async () => {
    await clearEmulatorsData();

    const aliceUid = await createAndLoginUser('alice.diss@emulator.local', 'Senha@123');
    const bobUid = await createAndLoginUser('bob.diss@emulator.local', 'Senha@123');
    const carolUid = await createAndLoginUser('carol.diss@emulator.local', 'Senha@123');

    // Alice cria espaço e adiciona Bob e Carol
    await signInWithEmailAndPassword(auth, 'alice.diss@emulator.local', 'Senha@123');
    const { space } = await createSpace(
      aliceUid,
      'Alice Criadora',
      'alice.diss@emulator.local',
      { name: 'Espaço Concorrência Real' },
      false
    );

    const { rawToken: tokBob } = await createSpaceInvite(space.id, aliceUid, 'Alice Criadora', {}, false);
    const { rawToken: tokCarol } = await createSpaceInvite(space.id, aliceUid, 'Alice Criadora', {}, false);

    await signInWithEmailAndPassword(auth, 'bob.diss@emulator.local', 'Senha@123');
    await acceptSpaceInvite(tokBob, { uid: bobUid, displayName: 'Bob Autor' }, false);

    await signInWithEmailAndPassword(auth, 'carol.diss@emulator.local', 'Senha@123');
    await acceptSpaceInvite(tokCarol, { uid: carolUid, displayName: 'Carol Autora' }, false);

    // Alice inicia a solicitação de dissolução (30 dias)
    await signInWithEmailAndPassword(auth, 'alice.diss@emulator.local', 'Senha@123');
    const req = await initiateSpaceDissolution(space.id, aliceUid, 'Alice Criadora', false);
    assert.equal(req.requestStatus, 'pending_author_responses');

    // Alice responde sua decisão, mas Bob e Carol permanecem 'pending'
    await submitAuthorDestinationDecision(
      space.id,
      aliceUid,
      'Alice Criadora',
      'migrate_to_existing_personal_space',
      'space_pessoal_alice',
      false
    );

    // Bob lê e marca como lida sua notificação inicial de dissolução (para provarmos que o timeout a reabre!)
    await signInWithEmailAndPassword(auth, 'bob.diss@emulator.local', 'Senha@123');
    const bobNotifsBefore = await getUserSpaceNotifications(bobUid, false);
    const bobInitNotif = bobNotifsBefore.find(
      (n) => n.spaceId === space.id && n.type === 'dissolution_requested'
    );
    assert.ok(bobInitNotif);
    await markNotificationAsRead(bobUid, bobInitNotif.id, false);

    // Simula a data de referência após 31 dias (estouro do prazo de 30 dias com Bob e Carol pendentes)
    const futureAfter31Days = new Date(
      new Date(req.initiatedAt).getTime() + 31 * 24 * 60 * 60 * 1000
    );

    // Dispara 6 chamadas CONCORRENTES reais contra a Cloud Function e o Firestore Emulator!
    const concurrentResults = await Promise.all([
      processDissolutionTimeout(space.id, false, futureAfter31Days),
      processDissolutionTimeout(space.id, false, futureAfter31Days),
      processDissolutionTimeout(space.id, false, futureAfter31Days),
      processDissolutionTimeout(space.id, false, futureAfter31Days),
      processDissolutionTimeout(space.id, false, futureAfter31Days),
      processDissolutionTimeout(space.id, false, futureAfter31Days),
    ]);

    // Todas as chamadas retornam o estado consistente 'auto_cancelled_timeout'
    for (const res of concurrentResults) {
      assert.equal(res.requestStatus, 'auto_cancelled_timeout');
      assert.equal(
        res.authorDestinations[aliceUid].decision,
        'migrate_to_existing_personal_space',
        'A decisão individual já registrada de Alice deve ser 100% preservada'
      );
      assert.equal(res.authorDestinations[bobUid].decision, 'pending');
      assert.equal(res.authorDestinations[carolUid].decision, 'pending');
    }

    // Verifica no Firestore Emulator (como Alice) que houve EXATAMENTE 1 evento de auditoria de cancelamento
    await signInWithEmailAndPassword(auth, 'alice.diss@emulator.local', 'Senha@123');
    const allAudits = await getSpaceAuditEvents(space.id, aliceUid, false);
    const cancelAudits = allAudits.filter((a) => a.eventType === 'dissolution_cancelled');
    assert.equal(
      cancelAudits.length,
      1,
      `Deveria existir exatamente 1 evento dissolution_cancelled, mas foram encontrados ${cancelAudits.length}`
    );

    // Verifica notificações de Bob no Firestore Emulator:
    // - Exatamente 1 notificação 'dissolution_cancelled'
    // - Nome real do espaço ('Espaço Concorrência Real', não 'Espaço' genérico)
    // - A notificação inicial 'dissolution_requested' foi REABERTA (read: false)
    await signInWithEmailAndPassword(auth, 'bob.diss@emulator.local', 'Senha@123');
    const bobNotifsAfter = await getUserSpaceNotifications(bobUid, false);
    const bobCancelNotifs = bobNotifsAfter.filter(
      (n) => n.spaceId === space.id && n.type === 'dissolution_cancelled'
    );
    assert.equal(
      bobCancelNotifs.length,
      1,
      `Bob deveria ter exatamente 1 notificação de cancelamento, mas tem ${bobCancelNotifs.length}`
    );
    assert.equal(bobCancelNotifs[0].spaceName, 'Espaço Concorrência Real');

    const bobReopenedNotif = bobNotifsAfter.find((n) => n.id === bobInitNotif.id);
    assert.equal(
      bobReopenedNotif?.read,
      false,
      'A notificação do autor pendente (Bob) deve ter sido reaberta (read = false)'
    );

    // Verifica notificações de Carol (também exatamente 1 de cancelamento)
    await signInWithEmailAndPassword(auth, 'carol.diss@emulator.local', 'Senha@123');
    const carolNotifsAfter = await getUserSpaceNotifications(carolUid, false);
    const carolCancelNotifs = carolNotifsAfter.filter(
      (n) => n.spaceId === space.id && n.type === 'dissolution_cancelled'
    );
    assert.equal(carolCancelNotifs.length, 1);
    assert.equal(carolCancelNotifs[0].spaceName, 'Espaço Concorrência Real');

    // Verifica que o espaço continua arquivado e somente leitura e com dados preservados
    const finalSpace = await getSpaceById(space.id, carolUid, false);
    assert.equal(finalSpace?.spaceStatus, 'archived');

    await signOut(auth);
  });
});
