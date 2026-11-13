import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpace, getUserSpaces } from './spaceService';
import {
  createSpaceAttemptKey,
  executeSpaceCreationSubmission,
  mergeSpaceListItem,
  SpaceCreationControllerState,
} from '../utils/spaceCreationFlow';
import { Space } from '../types/financeV3';

test('FLUXO DE CRIAÇÃO DE ESPAÇOS (UI Controller + Demo Idempotência)', async (t) => {
  const userAlice = {
    uid: `usr_ui_alice_${Date.now()}`,
    name: 'Alice Teste',
    email: 'alice.ui@teste.local',
  };

  function createInitialState(): SpaceCreationControllerState {
    return {
      isModalOpen: true,
      isSubmitting: false,
      modalError: null,
      feedbackMessage: null,
      attemptKey: createSpaceAttemptKey(),
      form: {
        name: 'Casa Compartilhada',
        description: 'Despesas da casa',
        color: '#3b82f6',
        icon: 'ph-house-line',
        enabledModules: ['finance', 'acquisitions'],
        monthlyBudgetCents: 250000,
      },
      spaces: [],
      selectedSpace: null,
      spaceFilter: 'active',
    };
  }

  await t.test('Teste A — Criação simples fecha modal, limpa campos e atualiza listagem imediatamente', async () => {
    const state = createInitialState();
    const inFlightRef = { current: false };
    let parentNotifiedSpace: Space | null = null;

    const outcome = await executeSpaceCreationSubmission({
      inFlightRef,
      isSubmittingState: state.isSubmitting,
      attemptKey: state.attemptKey,
      form: state.form,
      onStart: (resolvedKey) => {
        state.attemptKey = resolvedKey;
        state.isSubmitting = true;
        state.modalError = null;
        state.feedbackMessage = null;
      },
      submitFn: (resolvedKey) =>
        createSpace(
          userAlice.uid,
          userAlice.name,
          userAlice.email,
          {
            name: state.form.name.trim(),
            description: state.form.description.trim(),
            icon: state.form.icon,
            color: state.form.color,
            enabledModules: state.form.enabledModules,
            monthlyBudgetCents: state.form.monthlyBudgetCents,
            idempotencyKey: resolvedKey,
          },
          true
        ),
      onSuccess: (res) => {
        state.selectedSpace = null;
        state.spaces = mergeSpaceListItem(state.spaces, res.space);
        state.isModalOpen = false;
        state.modalError = null;
        state.form.name = '';
        state.form.description = '';
        state.form.monthlyBudgetCents = 0;
        state.attemptKey = createSpaceAttemptKey();
        state.feedbackMessage = {
          type: 'success',
          text: `Espaço "${res.space.name}" criado com sucesso!`,
        };
        parentNotifiedSpace = res.space;
      },
      onError: (msg) => {
        state.modalError = msg;
      },
      onFinish: () => {
        state.isSubmitting = false;
      },
    });

    assert.equal(outcome.status, 'succeeded');
    assert.equal(state.isModalOpen, false);
    assert.equal(state.isSubmitting, false);
    assert.equal(inFlightRef.current, false);
    assert.equal(state.selectedSpace, null);
    assert.equal(state.spaces.length, 1);
    assert.equal(state.spaces[0].name, 'Casa Compartilhada');
    assert.ok(parentNotifiedSpace);
    assert.equal(state.form.name, '');
    assert.equal(state.feedbackMessage?.type, 'success');
  });

  await t.test('Teste B — Duplo clique na UI é bloqueado sincronamente e replay no serviço não duplica espaço', async () => {
    const state = createInitialState();
    state.form.name = 'Viagem Férias';
    const inFlightRef = { current: false };
    const fixedKey = state.attemptKey;
    let serviceCalls = 0;

    const runClick = () =>
      executeSpaceCreationSubmission({
        inFlightRef,
        isSubmittingState: state.isSubmitting,
        attemptKey: state.attemptKey,
        form: state.form,
        onStart: (resolvedKey) => {
          state.attemptKey = resolvedKey;
          state.isSubmitting = true;
          state.modalError = null;
        },
        submitFn: async (resolvedKey) => {
          serviceCalls += 1;
          await new Promise((r) => setTimeout(r, 25));
          return await createSpace(
            userAlice.uid,
            userAlice.name,
            userAlice.email,
            {
              name: state.form.name,
              description: state.form.description,
              icon: state.form.icon,
              color: state.form.color,
              enabledModules: state.form.enabledModules,
              monthlyBudgetCents: state.form.monthlyBudgetCents,
              idempotencyKey: resolvedKey,
            },
            true
          );
        },
        onSuccess: (res) => {
          state.spaces = mergeSpaceListItem(state.spaces, res.space);
          state.isModalOpen = false;
        },
        onError: (msg) => {
          state.modalError = msg;
        },
        onFinish: () => {
          state.isSubmitting = false;
        },
      });

    const [first, second] = await Promise.all([runClick(), runClick()]);
    assert.equal(first.status, 'succeeded');
    assert.equal(second.status, 'ignored_in_flight');
    assert.equal(serviceCalls, 1);
    assert.equal(state.spaces.length, 1);

    // Mesmo se uma nova chamada chegar ao serviço com a mesma idempotencyKey (retry de rede), não duplica
    const replay = await createSpace(
      userAlice.uid,
      userAlice.name,
      userAlice.email,
      {
        name: 'Viagem Férias',
        description: state.form.description,
        icon: state.form.icon,
        color: state.form.color,
        enabledModules: state.form.enabledModules,
        monthlyBudgetCents: state.form.monthlyBudgetCents,
        idempotencyKey: fixedKey,
      },
      true
    );
    assert.equal(replay.isIdempotentReplay, true);
    assert.equal(replay.space.id, state.spaces[0].id);

    const allSpaces = await getUserSpaces(userAlice.uid, false, true, 'active');
    assert.equal(allSpaces.filter((s) => s.name === 'Viagem Férias').length, 1);
  });

  await t.test('Teste C — Erro controlado mantém modal aberto, preserva dados preenchidos e permite nova tentativa com sucesso', async () => {
    const state = createInitialState();
    state.form.name = 'Projeto Especial';
    state.form.description = 'Orçamento controlado';
    state.form.monthlyBudgetCents = 123400;
    const originalAttemptKey = state.attemptKey;
    const inFlightRef = { current: false };
    let shouldFail = true;

    const submitAttempt = () =>
      executeSpaceCreationSubmission({
        inFlightRef,
        isSubmittingState: state.isSubmitting,
        attemptKey: state.attemptKey,
        form: state.form,
        onStart: (resolvedKey) => {
          state.attemptKey = resolvedKey;
          state.isSubmitting = true;
          state.modalError = null;
        },
        submitFn: async (resolvedKey) => {
          if (shouldFail) {
            throw new Error('Falha temporária de rede ao comunicar com o servidor.');
          }
          return await createSpace(
            userAlice.uid,
            userAlice.name,
            userAlice.email,
            {
              name: state.form.name,
              description: state.form.description,
              icon: state.form.icon,
              color: state.form.color,
              enabledModules: state.form.enabledModules,
              monthlyBudgetCents: state.form.monthlyBudgetCents,
              idempotencyKey: resolvedKey,
            },
            true
          );
        },
        onSuccess: (res) => {
          state.spaces = mergeSpaceListItem(state.spaces, res.space);
          state.isModalOpen = false;
          state.modalError = null;
          state.form.name = '';
          state.form.description = '';
          state.form.monthlyBudgetCents = 0;
          state.attemptKey = createSpaceAttemptKey();
        },
        onError: (msg) => {
          state.modalError = msg;
        },
        onFinish: () => {
          state.isSubmitting = false;
        },
      });

    // 1. Primeira tentativa falha
    const firstTry = await submitAttempt();
    assert.equal(firstTry.status, 'failed');
    assert.equal(state.isModalOpen, true); // Modal continua aberto
    assert.equal(state.isSubmitting, false);
    assert.equal(inFlightRef.current, false);
    assert.match(state.modalError || '', /Falha temporária de rede/);
    // Campos e chave de idempotência preservados integralmente
    assert.equal(state.form.name, 'Projeto Especial');
    assert.equal(state.form.description, 'Orçamento controlado');
    assert.equal(state.form.monthlyBudgetCents, 123400);
    assert.equal(state.attemptKey, originalAttemptKey);

    // 2. Segunda tentativa após correção de conectividade conclui com sucesso
    shouldFail = false;
    const secondTry = await submitAttempt();
    assert.equal(secondTry.status, 'succeeded');
    assert.equal(state.isModalOpen, false);
    assert.equal(state.modalError, null);
    assert.equal(state.spaces.length, 1);
    assert.equal(state.spaces[0].name, 'Projeto Especial');
    assert.notEqual(state.attemptKey, originalAttemptKey);
  });

  await t.test('Teste D — Mesmo usuário cria múltiplos espaços independentes (sem falso bloqueio por nome)', async () => {
    const uid = `usr_multi_${Date.now()}`;
    const spCasa = await createSpace(
      uid,
      'Alice',
      'alice@multi.local',
      { name: 'Casa', idempotencyKey: createSpaceAttemptKey() },
      true
    );
    const spViagem = await createSpace(
      uid,
      'Alice',
      'alice@multi.local',
      { name: 'Viagem', idempotencyKey: createSpaceAttemptKey() },
      true
    );
    const spCasaDois = await createSpace(
      uid,
      'Alice',
      'alice@multi.local',
      { name: 'Casa', idempotencyKey: createSpaceAttemptKey() },
      true
    );

    assert.notEqual(spCasa.space.id, spViagem.space.id);
    assert.notEqual(spCasa.space.id, spCasaDois.space.id);
    const list = await getUserSpaces(uid, false, true, 'active');
    assert.equal(list.length, 3);
  });

  await t.test('Teste E — Reuso de idempotencyKey com payload divergente é rejeitado', async () => {
    const uid = `usr_conflict_${Date.now()}`;
    const key = createSpaceAttemptKey();
    await createSpace(
      uid,
      'Alice',
      'alice@conflict.local',
      { name: 'Espaço Original', idempotencyKey: key },
      true
    );

    await assert.rejects(
      async () => {
        await createSpace(
          uid,
          'Alice',
          'alice@conflict.local',
          { name: 'Outro Nome Diferente', idempotencyKey: key },
          true
        );
      },
      /Conflito de idempotência/i
    );
  });
});
