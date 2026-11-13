import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  createSpace,
  getUserSpaces,
  getSpaceById,
  getSpaceMembers,
  archiveSpace,
  updateMemberRole,
  leaveSpace,
} from './spaceService';

import {
  createSpaceInvite,
  acceptSpaceInvite,
} from './spaceInviteService';

import {
  initiateSpaceDissolution,
} from './spaceDissolutionService';

import {
  createSharedExpense,
  getSharedExpenses,
  getExpenseLiabilities,
  getSpaceFinancialSummary,
} from './sharedFinanceService';

import { universalStorage } from '../utils/universalStorage';

/**
 * ==============================================================================
 * SUÍTE DE TESTES DE ACEITAÇÃO: MÚLTIPLOS ESPAÇOS INDEPENDENTES E INTERFACE CANÔNICA
 * ==============================================================================
 * Cenário A: Criação e Isolamento de Múltiplos Espaços
 * Cenário B: Participação Simultânea e Alternância sem Vazamento Contábil
 * Cenário C: Governança e Permissões em Múltiplos Espaços
 * Cenário D: Integridade da Interface Canônica (Tema Escuro Global e Zero Legado)
 */

test('FASE 4 — Aceitação: Múltiplos Espaços Independentes e Experiência Canônica', async (t) => {
  universalStorage.clear();

  const userAlice = {
    uid: 'usr_alice_owner',
    name: 'Alice Silva',
    displayName: 'Alice Silva',
    email: 'alice@example.com',
  };

  const userBob = {
    uid: 'usr_bob_member',
    name: 'Bob Santos',
    displayName: 'Bob Santos',
    email: 'bob@example.com',
  };

  const userCarol = {
    uid: 'usr_carol_member',
    name: 'Carol Lima',
    displayName: 'Carol Lima',
    email: 'carol@example.com',
  };

  // ----------------------------------------------------------------------------
  // CENÁRIO A: Criação e Isolamento de Múltiplos Espaços
  // ----------------------------------------------------------------------------
  await t.test('Cenário A: Alice cria dois espaços distintos (Casa e Viagem) com membros isolados', async () => {
    // 1. Alice cria o primeiro espaço: "Casa"
    const { space: spaceCasa } = await createSpace(
      userAlice.uid,
      userAlice.displayName,
      userAlice.email,
      {
        name: 'Despesas Casa',
        description: 'Custos fixos e variáveis da residência',
        color: '#3b82f6',
        icon: 'ph-house',
      },
      true // isDemo
    );
    assert.ok(spaceCasa.id, 'Espaço Casa deve ter um ID');
    assert.equal(spaceCasa.creatorUid, userAlice.uid);

    // 2. Alice cria o segundo espaço: "Viagem"
    const { space: spaceViagem } = await createSpace(
      userAlice.uid,
      userAlice.displayName,
      userAlice.email,
      {
        name: 'Viagem Férias 2026',
        description: 'Rateio da viagem à praia',
        color: '#10b981',
        icon: 'ph-airplane',
      },
      true
    );
    assert.ok(spaceViagem.id, 'Espaço Viagem deve ter um ID');
    assert.notEqual(spaceCasa.id, spaceViagem.id, 'IDs dos espaços devem ser distintos');

    // 3. Alice convida Bob para "Casa"
    const { rawToken: tokenCasa } = await createSpaceInvite(
      spaceCasa.id,
      userAlice.uid,
      userAlice.displayName,
      {
        invitedEmail: userBob.email,
        invitedRole: 'member',
        expirationDays: 7,
      },
      true
    );
    await acceptSpaceInvite(tokenCasa, userBob, true);

    // 4. Alice convida Carol para "Viagem"
    const { rawToken: tokenViagem } = await createSpaceInvite(
      spaceViagem.id,
      userAlice.uid,
      userAlice.displayName,
      {
        invitedEmail: userCarol.email,
        invitedRole: 'member',
        expirationDays: 7,
      },
      true
    );
    await acceptSpaceInvite(tokenViagem, userCarol, true);

    // 5. Verificação de Isolamento Estrito:
    // Bob deve ver APENAS "Casa"
    const spacesBob = await getUserSpaces(userBob.uid, false, true);
    assert.equal(spacesBob.length, 1, 'Bob deve ver apenas 1 espaço');
    assert.equal(spacesBob[0].id, spaceCasa.id, 'Bob deve pertencer apenas ao Espaço Casa');

    // Carol deve ver APENAS "Viagem"
    const spacesCarol = await getUserSpaces(userCarol.uid, false, true);
    assert.equal(spacesCarol.length, 1, 'Carol deve ver apenas 1 espaço');
    assert.equal(spacesCarol[0].id, spaceViagem.id, 'Carol deve pertencer apenas ao Espaço Viagem');

    // Bob tenta consultar membros de "Viagem" diretamente -> deve ser bloqueado com violação de segurança
    await assert.rejects(
      async () => await getSpaceMembers(spaceViagem.id, userBob.uid, true),
      /violação de segurança/i,
      'Bob não pode consultar membros de Viagem'
    );

    // Carol tenta consultar membros de "Casa" diretamente -> deve ser bloqueada com violação de segurança
    await assert.rejects(
      async () => await getSpaceMembers(spaceCasa.id, userCarol.uid, true),
      /violação de segurança/i,
      'Carol não pode consultar membros de Casa'
    );
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO B: Participação Simultânea e Alternância sem Contaminação Cruzada
  // ----------------------------------------------------------------------------
  await t.test('Cenário B: Alice participa de múltiplos espaços simultaneamente sem vazamento de saldo', async () => {
    // 1. Alice consulta seus espaços e vê ambos
    const spacesAlice = await getUserSpaces(userAlice.uid, false, true);
    assert.equal(spacesAlice.length, 2, 'Alice deve ter acesso aos 2 espaços');
    const casa = spacesAlice.find((s) => s.name === 'Despesas Casa')!;
    const viagem = spacesAlice.find((s) => s.name === 'Viagem Férias 2026')!;
    assert.ok(casa, 'Espaço Casa deve estar presente');
    assert.ok(viagem, 'Espaço Viagem deve estar presente');

    // 2. Alice lança despesa no Espaço "Casa" de R$ 300,00 dividida meio a meio com Bob
    const { expense: expCasa } = await createSharedExpense(
      casa.id,
      {
        spaceId: casa.id,
        title: 'Aluguel & Condomínio',
        totalOriginalAmountCents: 30000,
        competenceMonth: '2026-11',
        competenceDate: '2026-11-01',
        categoryId: 'cat_moradia',
        categoryName: 'Moradia',
        createdByUid: userAlice.uid,
        responsibleUid: userAlice.uid,
        splitMethod: 'equal',
        participants: [
          { uid: userAlice.uid, name: userAlice.displayName },
          { uid: userBob.uid, name: userBob.displayName },
        ],
        idempotencyKey: 'idem_desp_casa_01',
      },
      true
    );
    assert.ok(expCasa.id);

    // 3. Alice lança despesa no Espaço "Viagem" de R$ 500,00 dividida meio a meio com Carol
    const { expense: expViagem } = await createSharedExpense(
      viagem.id,
      {
        spaceId: viagem.id,
        title: 'Hospedagem Pousada',
        totalOriginalAmountCents: 50000,
        competenceMonth: '2026-11',
        competenceDate: '2026-11-05',
        categoryId: 'cat_viagem',
        categoryName: 'Viagem',
        createdByUid: userAlice.uid,
        responsibleUid: userAlice.uid,
        splitMethod: 'equal',
        participants: [
          { uid: userAlice.uid, name: userAlice.displayName },
          { uid: userCarol.uid, name: userCarol.displayName },
        ],
        idempotencyKey: 'idem_desp_viagem_01',
      },
      true
    );
    assert.ok(expViagem.id);

    // 4. Verificação de Segregação Contábil em "Casa":
    const expensesCasa = await getSharedExpenses(casa.id, userAlice.uid, true);
    assert.equal(expensesCasa.length, 1);
    assert.equal(expensesCasa[0].title, 'Aluguel & Condomínio');

    const liabilitiesCasa = await getExpenseLiabilities(casa.id, expCasa.id, true);
    assert.equal(liabilitiesCasa.length, 2);
    const bobLiability = liabilitiesCasa.find((l) => l.memberUid === userBob.uid);
    assert.ok(bobLiability);
    assert.equal(bobLiability.assignedShareAmountCents, 15000, 'Cota do Bob na Casa deve ser R$ 150,00');

    // Nenhuma despesa ou passivo de Carol deve existir em "Casa"
    const carolInCasaLiabilities = liabilitiesCasa.some((l) => l.memberUid === userCarol.uid);
    assert.equal(carolInCasaLiabilities, false, 'Carol não tem liabilities em Casa');

    // 5. Verificação de Segregação Contábil em "Viagem":
    const expensesViagem = await getSharedExpenses(viagem.id, userAlice.uid, true);
    assert.equal(expensesViagem.length, 1);
    assert.equal(expensesViagem[0].title, 'Hospedagem Pousada');

    const liabilitiesViagem = await getExpenseLiabilities(viagem.id, expViagem.id, true);
    assert.equal(liabilitiesViagem.length, 2);
    const carolLiability = liabilitiesViagem.find((l) => l.memberUid === userCarol.uid);
    assert.ok(carolLiability);
    assert.equal(carolLiability.assignedShareAmountCents, 25000, 'Cota de Carol na Viagem deve ser R$ 250,00');

    // Nenhuma despesa ou passivo de Bob deve existir em "Viagem"
    const bobInViagemLiabilities = liabilitiesViagem.some((l) => l.memberUid === userBob.uid);
    assert.equal(bobInViagemLiabilities, false, 'Bob não tem liabilities em Viagem');

    // 6. Liquidações e Balanços independentes:
    const summaryCasa = await getSpaceFinancialSummary(casa.id, userAlice.uid, true);
    assert.equal(summaryCasa.totalExpensesCents, 30000);
    const summaryViagem = await getSpaceFinancialSummary(viagem.id, userAlice.uid, true);
    assert.equal(summaryViagem.totalExpensesCents, 50000);
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO C: Governança e Permissões em Múltiplos Espaços
  // ----------------------------------------------------------------------------
  await t.test('Cenário C: Governança, Soberania do Criador e Isolamento de Permissões', async () => {
    const spacesAlice = await getUserSpaces(userAlice.uid, false, true);
    const casa = spacesAlice.find((s) => s.name === 'Despesas Casa')!;
    const viagem = spacesAlice.find((s) => s.name === 'Viagem Férias 2026')!;

    // 1. Alice promove Bob para 'admin' no Espaço Casa
    await updateMemberRole(casa.id, userAlice.uid, userAlice.displayName, userBob.uid, 'admin', true);
    const membersCasa = await getSpaceMembers(casa.id, userAlice.uid, true);
    const bobMember = membersCasa.find((m) => m.uid === userBob.uid)!;
    assert.equal(bobMember.role, 'admin', 'Bob agora é admin em Casa');

    // 2. Bob (mesmo como admin) NÃO pode arquivar o espaço (privilégio soberano do criador)
    await assert.rejects(
      async () => {
        await archiveSpace(casa.id, userBob.uid, userBob.displayName, true);
      },
      /criador original/i,
      'Bob deve ser bloqueado ao tentar arquivar o espaço'
    );

    // 3. Bob (mesmo como admin) NÃO pode iniciar dissolução
    await assert.rejects(
      async () => {
        await initiateSpaceDissolution(
          casa.id,
          userBob.uid,
          userBob.displayName,
          true
        );
      },
      /criador original/i,
      'Bob deve ser bloqueado ao tentar iniciar dissolução'
    );

    // 4. Bob não tem qualquer permissão em Viagem (não é membro)
    await assert.rejects(
      async () => {
        await updateMemberRole(viagem.id, userBob.uid, userBob.displayName, userCarol.uid, 'admin', true);
      },
      /não autorizado|permissão insuficiente/i,
      'Bob deve ser bloqueado de gerenciar membros em Viagem'
    );

    // 5. Carol sai do Espaço Viagem voluntariamente
    await leaveSpace(viagem.id, userCarol.uid, userCarol.displayName, true);
    const spaceViagemAfterLeave = await getSpaceById(viagem.id, userAlice.uid, true, false);
    assert.ok(spaceViagemAfterLeave, 'Espaço Viagem deve existir após saída de Carol');
    assert.equal(spaceViagemAfterLeave.memberUids.includes(userCarol.uid), false, 'Carol não é mais membro ativo');
    assert.equal(
      spaceViagemAfterLeave.historicalMemberUids?.includes(userCarol.uid),
      true,
      'Carol é preservada em historicalMemberUids para integridade de auditoria'
    );

    // 6. Alice (criadora) arquiva com sucesso o Espaço Casa
    const archivedCasa = await archiveSpace(casa.id, userAlice.uid, userAlice.displayName, true);
    assert.equal(archivedCasa.spaceStatus, 'archived');
  });

  // ----------------------------------------------------------------------------
  // CENÁRIO D: Integridade da Interface Canônica e Remoção do Legado
  // ----------------------------------------------------------------------------
  await t.test('Cenário D: Remoção completa do legado e conformidade com o tema escuro', () => {
    // 1. Verificar que os arquivos da interface legado foram deletados do disco
    const legacyFiles = [
      'src/components/AccountsCardsView.tsx',
      'src/components/TransactionsView.tsx',
      'src/components/SpacesLedgerView.tsx',
    ];

    for (const file of legacyFiles) {
      const fullPath = path.resolve(process.cwd(), file);
      assert.equal(
        fs.existsSync(fullPath),
        false,
        `Arquivo legado ${file} deve estar fisicamente removido do repositório`
      );
    }

    // 2. Verificar que App.tsx não faz menção nem importa arquivos legados nem estados subView
    const appPath = path.resolve(process.cwd(), 'src/App.tsx');
    const appContent = fs.readFileSync(appPath, 'utf-8');

    assert.equal(appContent.includes('AccountsCardsView'), false, 'App.tsx não pode importar AccountsCardsView');
    assert.equal(appContent.includes('TransactionsView'), false, 'App.tsx não pode importar TransactionsView');
    assert.equal(appContent.includes('SpacesLedgerView'), false, 'App.tsx não pode importar SpacesLedgerView');
    assert.equal(appContent.includes('accountsSubView'), false, 'App.tsx não pode conter estado accountsSubView');
    assert.equal(appContent.includes('transactionsSubView'), false, 'App.tsx não pode conter estado transactionsSubView');
    assert.equal(appContent.includes('spacesSubView'), false, 'App.tsx não pode conter estado spacesSubView');

    // 3. Verificar que as visões canônicas v3 não possuem classes residuais de superfícies brancas
    const canonicalFiles = [
      'src/components/accounts/AccountsLedgerViewV3.tsx',
      'src/components/finance/PersonalFinanceViewV3.tsx',
      'src/components/spaces/SharedSpacesViewV3.tsx',
      'src/components/spaces/SharedFinanceSectionV3.tsx',
    ];

    for (const relPath of canonicalFiles) {
      const fullPath = path.resolve(process.cwd(), relPath);
      const content = fs.readFileSync(fullPath, 'utf-8');

      // Verifica se existem bg-white que representem superfície de tela (excluindo casos como toggle knob after:bg-white)
      const lines = content.split('\n');
      const whiteSurfaces = lines.filter((l) => {
        return (
          l.includes('bg-white') &&
          !l.includes('after:bg-white') &&
          !l.includes('before:bg-white')
        );
      });

      assert.equal(
        whiteSurfaces.length,
        0,
        `Componente canônico ${relPath} não pode conter superfícies bg-white hardcoded. Encontrado em: ${whiteSurfaces.join(', ')}`
      );
    }
  });
});
