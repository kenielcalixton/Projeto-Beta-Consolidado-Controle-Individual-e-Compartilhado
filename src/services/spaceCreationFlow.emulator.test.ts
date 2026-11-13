import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { terminate } from 'firebase/firestore';
import { auth, db } from './firebase';
import { LOCAL_EMULATOR_PROJECT_ID } from '../config/environment';
import {
  createSpace,
  getSpaceById,
  getUserSpaces,
  subscribeToUserActiveSpaces,
} from './spaceService';
import { getSpaceAuditEvents } from './spaceAuditService';
import { acceptSpaceInvite, createSpaceInvite } from './spaceInviteService';
import {
  createSpaceAttemptKey,
  executeSpaceCreationSubmission,
  mergeSpaceListItem,
} from '../utils/spaceCreationFlow';
import { Space } from '../types/financeV3';

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
  timeoutMs = 5000,
  stepMs = 40
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout (${timeoutMs}ms) aguardando atualização em tempo real.`);
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

test('RC1 EMULATOR — Fluxo Completo de Criação de Espaços Compartilhados (Atomicidade, Idempotência, Tempo Real e Isolamento)', async (t) => {
  t.after(async () => {
    try {
      await signOut(auth);
      await terminate(db);
    } catch {
      // ignora erro no teardown
    }
  });

  await t.test('Teste A — Criação simples persiste atomicamente e atualiza listagem em tempo real sem trocar de aba', async () => {
    await clearEmulatorsData();
    const aliceUid = await createAndLoginUser('alice.rc1@emulator.local', 'Senha@123');

    let latestSnapshot: Space[] = [];
    const unsubscribe = subscribeToUserActiveSpaces(
      aliceUid,
      false,
      (list) => {
        latestSnapshot = list;
      },
      (err) => {
        throw err;
      },
      false
    );

    try {
      await waitForCondition(() => Array.isArray(latestSnapshot));

      const attemptKey = createSpaceAttemptKey();
      const created = await createSpace(
        aliceUid,
        'Alice RC1',
        'alice.rc1@emulator.local',
        {
          name: 'Espaço Casa RC1',
          description: 'Criação atômica via createSpaceOfficial',
          monthlyBudgetCents: 350000,
          idempotencyKey: attemptKey,
        },
        false
      );

      assert.equal(created.isIdempotentReplay, false);
      assert.equal(created.space.name, 'Espaço Casa RC1');
      assert.equal(created.member.uid, aliceUid);
      assert.equal(created.member.role, 'owner');

      // Listener onSnapshot recebe o novo espaço imediatamente sem recarregar página ou trocar de aba
      await waitForCondition(() => latestSnapshot.some((s) => s.id === created.space.id));
      assert.equal(latestSnapshot.length, 1);

      const audits = await getSpaceAuditEvents(created.space.id, aliceUid, false);
      assert.equal(audits.length, 1);
      assert.equal(audits[0].eventType, 'space_created');
    } finally {
      unsubscribe();
    }
  });

  await t.test('Teste B — Duplo clique concorrente e replay com mesma idempotencyKey não duplicam espaço no Firestore', async () => {
    await clearEmulatorsData();
    const aliceUid = await createAndLoginUser('alice.dup@emulator.local', 'Senha@123');

    const fixedKey = createSpaceAttemptKey();
    const payload = {
      name: 'República Sem Duplicidade',
      description: 'Teste de concorrência',
      monthlyBudgetCents: 400000,
      idempotencyKey: fixedKey,
    };

    // Duas chamadas simultâneas direto no backend/serviço com a mesma idempotencyKey
    const [res1, res2] = await Promise.all([
      createSpace(aliceUid, 'Alice Dup', 'alice.dup@emulator.local', payload, false),
      createSpace(aliceUid, 'Alice Dup', 'alice.dup@emulator.local', payload, false),
    ]);

    // E um terceiro replay sequencial
    const res3 = await createSpace(aliceUid, 'Alice Dup', 'alice.dup@emulator.local', payload, false);

    assert.equal(res1.space.id, res2.space.id);
    assert.equal(res1.space.id, res3.space.id);
    assert.equal(res3.isIdempotentReplay, true);

    const aliceSpaces = await getUserSpaces(aliceUid, false, false, 'active');
    assert.equal(aliceSpaces.length, 1);

    const audits = await getSpaceAuditEvents(res1.space.id, aliceUid, false);
    assert.equal(audits.length, 1);

    // Reutilizar a mesma idempotencyKey para um espaço com dados divergentes deve ser rejeitado pelo backend
    await assert.rejects(
      async () => {
        await createSpace(
          aliceUid,
          'Alice Dup',
          'alice.dup@emulator.local',
          { ...payload, name: 'Nome Divergente' },
          false
        );
      },
      /Conflito de idempotência|already-exists/i
    );
  });

  await t.test('Teste C — Falha controlada preserva estado/campos/chave e retry posterior conclui com sucesso no emulador', async () => {
    await clearEmulatorsData();
    const aliceUid = await createAndLoginUser('alice.err@emulator.local', 'Senha@123');

    // 1. Chamada não autenticada deve ser rejeitada pelo backend
    await signOut(auth);
    await assert.rejects(
      async () => {
        await createSpace(
          aliceUid,
          'Alice Err',
          'alice.err@emulator.local',
          { name: 'Sem Sessão', idempotencyKey: createSpaceAttemptKey() },
          false
        );
      },
      /Autenticação obrigatória|unauthenticated/i
    );

    // 2. Reloga e simula falha na primeira tentativa do controlador de formulário + sucesso no retry
    await signInWithEmailAndPassword(auth, 'alice.err@emulator.local', 'Senha@123');

    let isModalOpen = true;
    let isSubmitting = false;
    let modalError: string | null = null;
    let attemptKey = createSpaceAttemptKey();
    const preservedKey = attemptKey;
    const inFlightRef = { current: false };
    let formName = 'Casa Retry';
    let formDesc = 'Mantido após erro';
    let spacesState: Space[] = [];
    let simulateFirstFailure = true;

    const runFormSubmit = () =>
      executeSpaceCreationSubmission({
        inFlightRef,
        isSubmittingState: isSubmitting,
        attemptKey,
        form: {
          name: formName,
          description: formDesc,
          color: '#3b82f6',
          icon: 'ph-users-three',
          enabledModules: ['finance', 'acquisitions'],
          monthlyBudgetCents: 100000,
        },
        onStart: (resolvedKey) => {
          attemptKey = resolvedKey;
          isSubmitting = true;
          modalError = null;
        },
        submitFn: async (resolvedKey) => {
          if (simulateFirstFailure) {
            throw new Error('Falha simulada de comunicação antes do backend.');
          }
          return await createSpace(
            aliceUid,
            'Alice Err',
            'alice.err@emulator.local',
            {
              name: formName,
              description: formDesc,
              monthlyBudgetCents: 100000,
              idempotencyKey: resolvedKey,
            },
            false
          );
        },
        onSuccess: (res) => {
          spacesState = mergeSpaceListItem(spacesState, res.space);
          isModalOpen = false;
          modalError = null;
          formName = '';
          formDesc = '';
          attemptKey = createSpaceAttemptKey();
        },
        onError: (msg) => {
          modalError = msg;
        },
        onFinish: () => {
          isSubmitting = false;
        },
      });

    const failedAttempt = await runFormSubmit();
    assert.equal(failedAttempt.status, 'failed');
    assert.equal(isModalOpen, true);
    assert.equal(formName, 'Casa Retry');
    assert.equal(formDesc, 'Mantido após erro');
    assert.equal(attemptKey, preservedKey);
    assert.match(modalError || '', /Falha simulada/);

    simulateFirstFailure = false;
    const retryAttempt = await runFormSubmit();
    assert.equal(retryAttempt.status, 'succeeded');
    assert.equal(isModalOpen, false);
    assert.equal(modalError, null);
    assert.equal(spacesState.length, 1);
    assert.equal(spacesState[0].name, 'Casa Retry');
  });

  await t.test('Teste D — Mesmo usuário cria múltiplos espaços (Casa, Viagem e nome repetido com chaves distintas)', async () => {
    await clearEmulatorsData();
    const aliceUid = await createAndLoginUser('alice.multi@emulator.local', 'Senha@123');

    let liveSpaces: Space[] = [];
    const unsubscribe = subscribeToUserActiveSpaces(
      aliceUid,
      false,
      (list) => {
        liveSpaces = list;
      },
      undefined,
      false
    );

    try {
      const spCasa = await createSpace(
        aliceUid,
        'Alice Multi',
        'alice.multi@emulator.local',
        { name: 'Casa', idempotencyKey: createSpaceAttemptKey() },
        false
      );
      const spViagem = await createSpace(
        aliceUid,
        'Alice Multi',
        'alice.multi@emulator.local',
        { name: 'Viagem', idempotencyKey: createSpaceAttemptKey() },
        false
      );
      const spCasaExtra = await createSpace(
        aliceUid,
        'Alice Multi',
        'alice.multi@emulator.local',
        { name: 'Casa', idempotencyKey: createSpaceAttemptKey() },
        false
      );

      assert.notEqual(spCasa.space.id, spViagem.space.id);
      assert.notEqual(spCasa.space.id, spCasaExtra.space.id);

      await waitForCondition(() => liveSpaces.length === 3);
      assert.equal(liveSpaces.filter((s) => s.name === 'Casa').length, 2);
      assert.equal(liveSpaces.filter((s) => s.name === 'Viagem').length, 1);
    } finally {
      unsubscribe();
    }
  });

  await t.test('Teste E — Alice, Bob e Carol: múltiplos espaços independentes com isolamento rigoroso', async () => {
    await clearEmulatorsData();
    const aliceUid = await createAndLoginUser('alice.iso@emulator.local', 'Senha@123');
    const bobUid = await createAndLoginUser('bob.iso@emulator.local', 'Senha@123');
    const carolUid = await createAndLoginUser('carol.iso@emulator.local', 'Senha@123');

    // Alice cria Casa e Viagem, convida Bob para Casa e Carol para Viagem
    await signInWithEmailAndPassword(auth, 'alice.iso@emulator.local', 'Senha@123');
    const { space: spaceCasa } = await createSpace(
      aliceUid,
      'Alice',
      'alice.iso@emulator.local',
      { name: 'Casa', idempotencyKey: createSpaceAttemptKey() },
      false
    );
    const { space: spaceViagem } = await createSpace(
      aliceUid,
      'Alice',
      'alice.iso@emulator.local',
      { name: 'Viagem', idempotencyKey: createSpaceAttemptKey() },
      false
    );

    const { rawToken: tokBob } = await createSpaceInvite(
      spaceCasa.id,
      aliceUid,
      'Alice',
      { invitedEmail: 'bob.iso@emulator.local', invitedRole: 'member' },
      false
    );
    const { rawToken: tokCarol } = await createSpaceInvite(
      spaceViagem.id,
      aliceUid,
      'Alice',
      { invitedEmail: 'carol.iso@emulator.local', invitedRole: 'member' },
      false
    );

    // Bob aceita convite de Casa
    await signInWithEmailAndPassword(auth, 'bob.iso@emulator.local', 'Senha@123');
    await acceptSpaceInvite(
      tokBob,
      { uid: bobUid, displayName: 'Bob', email: 'bob.iso@emulator.local' },
      false
    );

    const bobSpaces = await getUserSpaces(bobUid, false, false, 'active');
    assert.deepEqual(
      bobSpaces.map((s) => s.id),
      [spaceCasa.id]
    );
    await assert.rejects(async () => {
      await getSpaceById(spaceViagem.id, bobUid, false);
    }, /acesso não autorizado/i);

    // Carol aceita convite de Viagem
    await signInWithEmailAndPassword(auth, 'carol.iso@emulator.local', 'Senha@123');
    await acceptSpaceInvite(
      tokCarol,
      { uid: carolUid, displayName: 'Carol', email: 'carol.iso@emulator.local' },
      false
    );

    const carolSpaces = await getUserSpaces(carolUid, false, false, 'active');
    assert.deepEqual(
      carolSpaces.map((s) => s.id),
      [spaceViagem.id]
    );
    await assert.rejects(async () => {
      await getSpaceById(spaceCasa.id, carolUid, false);
    }, /acesso não autorizado/i);

    // Alice vê ambos os espaços ativos imediatamente
    await signInWithEmailAndPassword(auth, 'alice.iso@emulator.local', 'Senha@123');
    const aliceSpaces = await getUserSpaces(aliceUid, false, false, 'active');
    assert.equal(aliceSpaces.length, 2);
    assert.ok(aliceSpaces.some((s) => s.id === spaceCasa.id));
    assert.ok(aliceSpaces.some((s) => s.id === spaceViagem.id));
  });
});
