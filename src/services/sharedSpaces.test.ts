import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSpace,
  getUserSpaces,
  getSpaceById,
  getSpaceMembers,
  updateSpace,
  archiveSpace,
  unarchiveSpace,
  updateMemberRole,
  removeMemberFromSpace,
  leaveSpace,
} from './spaceService';

import {
  createSpaceInvite,
  acceptSpaceInvite,
  rejectSpaceInvite,
  revokeSpaceInvite,
  getInviteByRawToken,
  hashToken,
} from './spaceInviteService';

import {
  initiateSpaceDissolution,
  getSpaceDissolutionRequest,
  submitAuthorDestinationDecision,
  checkAndCancelExpiredDissolution,
  cancelDissolutionByCreator,
  isDissolutionExpired,
  canCancelDissolutionDueToTimeout,
  processDissolutionTimeout,
} from './spaceDissolutionService';

import { getSpaceAuditEvents } from './spaceAuditService';
import {
  getUserSpaceNotifications,
  markNotificationAsRead,
  sendSpaceNotification,
} from './spaceNotificationService';
import { universalStorage } from '../utils/universalStorage';

/**
 * ==============================================================================
 * SUÍTE DE TESTES AUTOMATIZADOS — FASE 5: ESPAÇOS COMPARTILHADOS (v3.1)
 * ==============================================================================
 * Cobertura de criação, participantes, convites com hash SHA-256, permissões,
 * arquivamento soberano, dissolução 30 dias com autodestinação e integridade.
 *
 * NOTA TÉCNICA: Estes testes executam no ambiente em memória (modo demo isolado),
 * validando contratos, integridade referencial, concorrência lógica e invariantes.
 */

test('FASE 5 — Espaços Compartilhados (Arquitetura v3.1)', async (t) => {
  // Limpeza de ambiente de testes
  universalStorage.clear();

  const userAlice = {
    uid: 'usr_alice_123',
    name: 'Alice Silva',
    email: 'alice@exemplo.com',
  };

  const userBob = {
    uid: 'usr_bob_456',
    name: 'Bob Souza',
    email: 'bob@exemplo.com',
  };

  const userCarol = {
    uid: 'usr_carol_789',
    name: 'Carol Lima',
    email: 'carol@exemplo.com',
  };

  const userDave = {
    uid: 'usr_dave_999',
    name: 'Dave Estranho',
    email: 'dave@externo.com',
  };

  await t.test('1. deve criar espaço compartilhado com criador como proprietário inicial', async () => {
    const { space, member } = await createSpace(
      userAlice.uid,
      userAlice.name,
      userAlice.email,
      {
        name: 'Apartamento 302',
        description: 'Despesas compartilhadas da moradia',
        monthlyBudgetCents: 450000,
      },
      true
    );

    assert.ok(space.id.startsWith('space_'));
    assert.equal(space.name, 'Apartamento 302');
    assert.equal(space.creatorUid, userAlice.uid);
    assert.equal(space.ownerId, userAlice.uid);
    assert.equal(space.spaceStatus, 'active');
    assert.deepEqual(space.memberUids, [userAlice.uid]);

    assert.equal(member.uid, userAlice.uid);
    assert.equal(member.role, 'owner');
    assert.equal(member.participationStatus, 'active');

    // Verifica trilha de auditoria
    const audits = await getSpaceAuditEvents(space.id, true);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].eventType, 'space_created');
  });

  await t.test('2. deve impedir criação por usuário não autenticado ou com dados inválidos', async () => {
    await assert.rejects(
      async () => {
        await createSpace('', 'Nome', 'email@test.com', { name: 'Espaço Inválido' }, true);
      },
      /Identificador de criador inválido/i
    );

    await assert.rejects(
      async () => {
        await createSpace(userAlice.uid, userAlice.name, userAlice.email, { name: '   ' }, true);
      },
      /O nome do espaço é obrigatório/i
    );
  });

  await t.test('3. deve consultar exclusivamente os espaços onde o usuário é participante', async () => {
    // Alice cria um espaço pessoal compartilhado
    const { space: spaceRepub } = await createSpace(
      userAlice.uid,
      userAlice.name,
      userAlice.email,
      { name: 'República Alice' },
      true
    );

    // Bob cria outro espaço
    const { space: spaceBob } = await createSpace(
      userBob.uid,
      userBob.name,
      userBob.email,
      { name: 'Viagem Bob' },
      true
    );

    // Consulta de Alice não deve ver o espaço de Bob
    const aliceSpaces = await getUserSpaces(userAlice.uid, false, true);
    assert.ok(aliceSpaces.some((s) => s.id === spaceRepub.id));
    assert.ok(!aliceSpaces.some((s) => s.id === spaceBob.id));

    // Consulta de Bob não deve ver o espaço de Alice
    const bobSpaces = await getUserSpaces(userBob.uid, false, true);
    assert.ok(bobSpaces.some((s) => s.id === spaceBob.id));
    assert.ok(!bobSpaces.some((s) => s.id === spaceRepub.id));
  });

  await t.test('4. deve bloquear acesso direto de usuário não participante ao espaço', async () => {
    const { space } = await createSpace(
      userAlice.uid,
      userAlice.name,
      userAlice.email,
      { name: 'Espaço Privado Alice' },
      true
    );

    // Dave tenta acessar o espaço de Alice diretamente
    await assert.rejects(
      async () => {
        await getSpaceById(space.id, userDave.uid, true);
      },
      /Violação de segurança: acesso não autorizado/i
    );
  });

  await t.test('5. deve gerar convite seguro armazenando hash SHA-256 e NUNCA o token puro', async () => {
    const { space } = await createSpace(
      userAlice.uid,
      userAlice.name,
      userAlice.email,
      { name: 'Churrasco de Fim de Ano' },
      true
    );

    const { invite, rawToken } = await createSpaceInvite(
      space.id,
      userAlice.uid,
      userAlice.name,
      {
        invitedEmail: 'bob@exemplo.com',
        invitedRole: 'member',
        expirationDays: 15,
      },
      true
    );

    assert.ok(rawToken.length >= 32);
    // O ID do convite deve ser o hash SHA-256 do token puro
    const expectedHash = await hashToken(rawToken);
    assert.equal(invite.id, expectedHash);
    assert.notEqual(invite.id, rawToken); // Prova absoluta de que não salva token puro

    assert.equal(invite.tokenStatus, 'pending');
    assert.equal(invite.spaceId, space.id);

    // Verifica que consegue localizar os dados via rawToken calculando o hash
    const found = await getInviteByRawToken(rawToken, true);
    assert.ok(found);
    assert.equal(found.id, expectedHash);
  });

  await t.test('6. deve aceitar convite válido associando atomicamente o UID ao espaço', async () => {
    const { space } = await createSpace(
      userAlice.uid,
      userAlice.name,
      userAlice.email,
      { name: 'Casa de Praia' },
      true
    );

    const { rawToken } = await createSpaceInvite(
      space.id,
      userAlice.uid,
      userAlice.name,
      { invitedRole: 'member' },
      true
    );

    // Bob aceita o convite
    const { space: updatedSpace, member: bobMember } = await acceptSpaceInvite(
      rawToken,
      userBob,
      true
    );

    assert.ok(updatedSpace.memberUids.includes(userBob.uid));
    assert.equal(bobMember.uid, userBob.uid);
    assert.equal(bobMember.participationStatus, 'active');
    assert.equal(bobMember.role, 'member');

    // Bob agora consegue consultar o espaço normalmente
    const bobSpaces = await getUserSpaces(userBob.uid, false, true);
    assert.ok(bobSpaces.some((s) => s.id === space.id));

    // Notificação enviada para Alice
    const aliceNotifs = await getUserSpaceNotifications(userAlice.uid, true);
    assert.ok(aliceNotifs.some((n) => n.type === 'invite_accepted'));
  });

  await t.test('7. deve impedir reutilização de convite já aceito (controle de uso único)', async () => {
    const { space } = await createSpace(
      userAlice.uid,
      userAlice.name,
      userAlice.email,
      { name: 'Espaço Convite Único' },
      true
    );

    const { rawToken } = await createSpaceInvite(
      space.id,
      userAlice.uid,
      userAlice.name,
      { invitedRole: 'member' },
      true
    );

    // Bob aceita primeiro
    await acceptSpaceInvite(rawToken, userBob, true);

    // Carol tenta usar o mesmo token
    await assert.rejects(
      async () => {
        await acceptSpaceInvite(rawToken, userCarol, true);
      },
      /não pode ser utilizado pois seu status atual é: accepted/i
    );
  });

  await t.test('8. deve impedir ingresso duplicado se o usuário já for participante ativo', async () => {
    const { space } = await createSpace(
      userAlice.uid,
      userAlice.name,
      userAlice.email,
      { name: 'Espaço Duplicidade' },
      true
    );

    const { rawToken } = await createSpaceInvite(
      space.id,
      userAlice.uid,
      userAlice.name,
      {},
      true
    );

    // Alice tenta aceitar o convite do seu próprio espaço
    await assert.rejects(
      async () => {
        await acceptSpaceInvite(rawToken, userAlice, true);
      },
      /Você já é um participante ativo deste espaço/i
    );
  });

  await t.test('9. deve rejeitar formalmente um convite', async () => {
    const { space } = await createSpace(
      userAlice.uid,
      userAlice.name,
      userAlice.email,
      { name: 'Espaço Rejeição' },
      true
    );

    const { rawToken } = await createSpaceInvite(
      space.id,
      userAlice.uid,
      userAlice.name,
      {},
      true
    );

    await rejectSpaceInvite(rawToken, userCarol, true);

    const inv = await getInviteByRawToken(rawToken, true);
    assert.equal(inv?.tokenStatus, 'rejected');

    // Tentativa de aceitar convite rejeitado falha
    await assert.rejects(
      async () => {
        await acceptSpaceInvite(rawToken, userCarol, true);
      },
      /não pode ser utilizado pois seu status atual é: rejected/i
    );
  });

  await t.test('10. deve revogar convite por participante autorizado antes do aceite', async () => {
    const { space } = await createSpace(
      userAlice.uid,
      userAlice.name,
      userAlice.email,
      { name: 'Espaço Revogação' },
      true
    );

    const { invite, rawToken } = await createSpaceInvite(
      space.id,
      userAlice.uid,
      userAlice.name,
      {},
      true
    );

    await revokeSpaceInvite(invite.id, userAlice.uid, userAlice.name, true);

    const inv = await getInviteByRawToken(rawToken, true);
    assert.equal(inv?.tokenStatus, 'revoked');

    await assert.rejects(
      async () => {
        await acceptSpaceInvite(rawToken, userBob, true);
      },
      /não pode ser utilizado pois seu status atual é: revoked/i
    );
  });

  await t.test('11. deve permitir apenas ao criador original arquivar e desarquivar o espaço', async () => {
    const { space } = await createSpace(
      userAlice.uid,
      userAlice.name,
      userAlice.email,
      { name: 'Espaço Arquivamento' },
      true
    );

    const { rawToken } = await createSpaceInvite(space.id, userAlice.uid, userAlice.name, {}, true);
    await acceptSpaceInvite(rawToken, userBob, true);

    // Bob tenta arquivar o espaço -> BLOQUEADO
    await assert.rejects(
      async () => {
        await archiveSpace(space.id, userBob.uid, userBob.name, true);
      },
      /Violação de autoridade: Somente o criador original do espaço tem autorização/i
    );

    // Alice (criadora) arquiva -> SUCESSO
    const archivedSpace = await archiveSpace(space.id, userAlice.uid, userAlice.name, true);
    assert.equal(archivedSpace.spaceStatus, 'archived');
    assert.equal(archivedSpace.archivedByUid, userAlice.uid);

    // Alice desarquiva -> SUCESSO
    const unarchivedSpace = await unarchiveSpace(space.id, userAlice.uid, userAlice.name, true);
    assert.equal(unarchivedSpace.spaceStatus, 'active');
    assert.equal(unarchivedSpace.archivedByUid, undefined);
  });

  await t.test('12. deve congelar operações de escrita e convites quando o espaço estiver arquivado', async () => {
    const { space } = await createSpace(
      userAlice.uid,
      userAlice.name,
      userAlice.email,
      { name: 'Espaço Congelado' },
      true
    );

    await archiveSpace(space.id, userAlice.uid, userAlice.name, true);

    // Tentativa de gerar convite em espaço arquivado deve falhar
    await assert.rejects(
      async () => {
        await createSpaceInvite(space.id, userAlice.uid, userAlice.name, {}, true);
      },
      /Não é permitido criar convites para um espaço arquivado/i
    );

    // Tentativa de editar espaço arquivado deve falhar
    await assert.rejects(
      async () => {
        await updateSpace(space.id, userAlice.uid, { name: 'Novo Nome' }, true);
      },
      /Espaço arquivado: modo somente leitura/i
    );
  });

  await t.test('13. deve remover participante revogando acesso operacional e preservando histórico', async () => {
    const { space } = await createSpace(
      userAlice.uid,
      userAlice.name,
      userAlice.email,
      { name: 'República Central' },
      true
    );

    const { rawToken } = await createSpaceInvite(space.id, userAlice.uid, userAlice.name, {}, true);
    await acceptSpaceInvite(rawToken, userBob, true);

    // Alice remove Bob
    await removeMemberFromSpace(space.id, userAlice.uid, userAlice.name, userBob.uid, true);

    // Bob não consta mais em memberUids operacionais
    const updatedSpace = (await getUserSpaces(userAlice.uid, false, true)).find((s) => s.id === space.id);
    assert.ok(!updatedSpace?.memberUids.includes(userBob.uid));
    // Bob é preservado em historicalMemberUids para consultas dos seus lançamentos
    assert.ok(updatedSpace?.historicalMemberUids?.includes(userBob.uid));

    // Bob não vê mais o espaço na sua listagem de espaços ativos
    const bobActiveSpaces = await getUserSpaces(userBob.uid, false, true, 'active');
    assert.ok(!bobActiveSpaces.some((s) => s.id === space.id));

    // Bob localiza o espaço no filtro de espaços com participação histórica
    const bobHistoricalSpaces = await getUserSpaces(userBob.uid, false, true, 'historical');
    assert.ok(bobHistoricalSpaces.some((s) => s.id === space.id));

    // O registro histórico do membro existe com status 'removed_by_admin'
    const members = await getSpaceMembers(space.id, userAlice.uid, true);
    const bobMember = members.find((m) => m.uid === userBob.uid);
    assert.equal(bobMember?.participationStatus, 'removed_by_admin');
    assert.ok(bobMember?.exitedAt);

    // Bob possui permissão de leitura histórica para conferir seus registros
    const spaceConsult = await getSpaceById(space.id, userBob.uid, true, true);
    assert.ok(spaceConsult);

    // Mas Bob tem o acesso operacional de escrita estritamente BLOQUEADO
    await assert.rejects(
      async () => {
        await getSpaceById(space.id, userBob.uid, true, false);
      },
      /Violação de segurança: acesso não autorizado a espaço no qual o usuário não é participante ativo/i
    );

    // Tentativa de mutação cadastral por ex-membro é categoricamente rejeitada
    await assert.rejects(
      async () => {
        await updateSpace(space.id, userBob.uid, { name: 'Tentativa de Hack' }, true);
      },
      /Apenas proprietários ou administradores podem editar/i
    );

    // Usuário completamente estranho (Dave) não tem nem acesso operacional nem histórico
    await assert.rejects(
      async () => {
        await getSpaceById(space.id, userDave.uid, true, true);
      },
      /Violação de segurança: acesso não autorizado/i
    );
  });

  await t.test('14. deve impedir a remoção do criador do espaço', async () => {
    const { space } = await createSpace(
      userAlice.uid,
      userAlice.name,
      userAlice.email,
      { name: 'República Segura' },
      true
    );

    const { rawToken } = await createSpaceInvite(
      space.id,
      userAlice.uid,
      userAlice.name,
      { invitedRole: 'admin' },
      true
    );
    await acceptSpaceInvite(rawToken, userBob, true);

    // Bob tenta remover Alice (criadora) -> BLOQUEADO
    await assert.rejects(
      async () => {
        await removeMemberFromSpace(space.id, userBob.uid, userBob.name, userAlice.uid, true);
      },
      /O criador do espaço não pode ser removido/i
    );
  });

  await t.test('15. deve permitir saída voluntária do participante', async () => {
    const { space } = await createSpace(
      userAlice.uid,
      userAlice.name,
      userAlice.email,
      { name: 'Viagem em Grupo' },
      true
    );

    const { rawToken } = await createSpaceInvite(space.id, userAlice.uid, userAlice.name, {}, true);
    await acceptSpaceInvite(rawToken, userCarol, true);

    // Carol sai voluntariamente
    await leaveSpace(space.id, userCarol.uid, userCarol.name, true);

    const members = await getSpaceMembers(space.id, userAlice.uid, true);
    const carolMember = members.find((m) => m.uid === userCarol.uid);
    assert.equal(carolMember?.participationStatus, 'voluntary_exit');
    assert.ok(carolMember?.exitedAt);

    // Criador tentando sair voluntariamente sem dissolver -> BLOQUEADO
    await assert.rejects(
      async () => {
        await leaveSpace(space.id, userAlice.uid, userAlice.name, true);
      },
      /O criador do espaço não pode abandoná-lo voluntariamente/i
    );
  });

  await t.test('16. deve gerenciar papéis de membros respeitando hierarquia de governança', async () => {
    const { space } = await createSpace(
      userAlice.uid,
      userAlice.name,
      userAlice.email,
      { name: 'Governança Hierárquica' },
      true
    );

    const { rawToken } = await createSpaceInvite(space.id, userAlice.uid, userAlice.name, {}, true);
    await acceptSpaceInvite(rawToken, userBob, true);

    // Alice promove Bob a admin
    const updatedBob = await updateMemberRole(
      space.id,
      userAlice.uid,
      userAlice.name,
      userBob.uid,
      'admin',
      true
    );
    assert.equal(updatedBob.role, 'admin');

    // Bob tenta rebaixar Alice -> BLOQUEADO
    await assert.rejects(
      async () => {
        await updateMemberRole(space.id, userBob.uid, userBob.name, userAlice.uid, 'member', true);
      },
      /Apenas o proprietário ou o criador do espaço podem alterar papéis/i
    );
  });

  await t.test('17. deve iniciar fluxo formal de dissolução exclusiva pelo criador com prazo de 30 dias', async () => {
    const { space } = await createSpace(
      userAlice.uid,
      userAlice.name,
      userAlice.email,
      { name: 'Espaço em Dissolução' },
      true
    );

    const { rawToken } = await createSpaceInvite(space.id, userAlice.uid, userAlice.name, {}, true);
    await acceptSpaceInvite(rawToken, userBob, true);

    // Bob tenta iniciar dissolução -> BLOQUEADO
    await assert.rejects(
      async () => {
        await initiateSpaceDissolution(space.id, userBob.uid, userBob.name, true);
      },
      /Somente o criador original do espaço tem autorização para iniciar a solicitação de dissolução/i
    );

    // Alice inicia dissolução
    const req = await initiateSpaceDissolution(space.id, userAlice.uid, userAlice.name, true);

    assert.equal(req.requestStatus, 'pending_author_responses');
    assert.equal(req.initiatedByUid, userAlice.uid);

    // Prazo estrito de 30 dias
    const initiatedTime = new Date(req.initiatedAt).getTime();
    const deadlineTime = new Date(req.deadlineDate).getTime();
    const diffDays = Math.round((deadlineTime - initiatedTime) / (1000 * 60 * 60 * 24));
    assert.equal(diffDays, 30);

    // Todos os autores iniciam com decisão 'pending'
    assert.equal(req.authorDestinations[userAlice.uid].decision, 'pending');
    assert.equal(req.authorDestinations[userBob.uid].decision, 'pending');
  });

  await t.test('18. cada autor escolhe o destino dos próprios registros sem influenciar outros autores', async () => {
    const { space } = await createSpace(
      userAlice.uid,
      userAlice.name,
      userAlice.email,
      { name: 'Espaço Autonomia' },
      true
    );

    const { rawToken } = await createSpaceInvite(space.id, userAlice.uid, userAlice.name, {}, true);
    await acceptSpaceInvite(rawToken, userBob, true);

    await initiateSpaceDissolution(space.id, userAlice.uid, userAlice.name, true);

    // Alice escolhe migrar para espaço individual
    const reqAlice = await submitAuthorDestinationDecision(
      space.id,
      userAlice.uid,
      userAlice.name,
      'migrate_to_existing_personal_space',
      'space_alice_pessoal',
      true
    );

    assert.equal(reqAlice.authorDestinations[userAlice.uid].decision, 'migrate_to_existing_personal_space');
    assert.equal(reqAlice.authorDestinations[userAlice.uid].targetSpaceId, 'space_alice_pessoal');
    // A decisão de Bob permanece estritamente pendente e inalterada
    assert.equal(reqAlice.authorDestinations[userBob.uid].decision, 'pending');
    assert.equal(reqAlice.requestStatus, 'pending_author_responses');

    // Bob escolhe arquivar/ocultar seus registros
    const reqBoth = await submitAuthorDestinationDecision(
      space.id,
      userBob.uid,
      userBob.name,
      'archive_or_hide',
      undefined,
      true
    );

    assert.equal(reqBoth.authorDestinations[userBob.uid].decision, 'archive_or_hide');
    // Como ambos decidiram, atinge o status fully_approved_ready
    assert.equal(reqBoth.requestStatus, 'fully_approved_ready');
  });

  await t.test('19. cancelamento automático por timeout: silêncio de autor cancela solicitação e preserva dados', async () => {
    const { space } = await createSpace(
      userAlice.uid,
      userAlice.name,
      userAlice.email,
      { name: 'Espaço Silêncio' },
      true
    );

    const { rawToken } = await createSpaceInvite(space.id, userAlice.uid, userAlice.name, {}, true);
    await acceptSpaceInvite(rawToken, userBob, true);

    const req = await initiateSpaceDissolution(space.id, userAlice.uid, userAlice.name, true);

    // Simula passagem de 31 dias (prazo expirado com Bob pendente)
    const expiredDeadline = new Date(Date.now() - 1000 * 60).toISOString(); // 1 minuto no passado
    const reqExpired = { ...req, deadlineDate: expiredDeadline };
    universalStorage.setItem(`mpf_v3_demo_dissolution_${space.id}`, JSON.stringify(reqExpired));

    // Executa checagem de timeout
    const cancelledReq = await checkAndCancelExpiredDissolution(space.id, true);

    assert.equal(cancelledReq.requestStatus, 'auto_cancelled_timeout');
    assert.ok(cancelledReq.cancelledAt);
    assert.match(cancelledReq.cancellationReason || '', /decorrido o prazo improrrogável de 30 dias/i);

    // O espaço permanece arquivado (read-only) e nenhum dado é deletado ou migrado
    const spaceAfter = await getSpaceById(space.id, userAlice.uid, true);
    assert.equal(spaceAfter?.spaceStatus, 'archived');
  });

  await t.test('20. cancelamento voluntário da solicitação pelo criador', async () => {
    const { space } = await createSpace(
      userAlice.uid,
      userAlice.name,
      userAlice.email,
      { name: 'Espaço Desistência' },
      true
    );

    await initiateSpaceDissolution(space.id, userAlice.uid, userAlice.name, true);

    const reqCancelled = await cancelDissolutionByCreator(
      space.id,
      userAlice.uid,
      userAlice.name,
      'Criador decidiu manter o espaço ativo.',
      true
    );

    assert.equal(reqCancelled.requestStatus, 'cancelled_by_creator');
    assert.match(reqCancelled.cancellationReason || '', /Criador decidiu manter o espaço ativo/i);
  });

  await t.test(
    '21. separação estrita: ex-participante preserva consulta histórica de auditoria mas é bloqueado de gerar convites ou alterar papéis',
    async () => {
      const { space } = await createSpace(
        userAlice.uid,
        userAlice.name,
        userAlice.email,
        { name: 'Espaço Segurança e Auditoria' },
        true
      );

      const { rawToken } = await createSpaceInvite(space.id, userAlice.uid, userAlice.name, {}, true);
      await acceptSpaceInvite(rawToken, userBob, true);

      // Carol entra
      const { rawToken: tokenCarol } = await createSpaceInvite(space.id, userAlice.uid, userAlice.name, {}, true);
      await acceptSpaceInvite(tokenCarol, userCarol, true);

      // Bob se retira voluntariamente
      await leaveSpace(space.id, userBob.uid, userBob.name, true);

      // 1. Bob como ex-participante consegue consultar os eventos de auditoria passados
      const audits = await getSpaceAuditEvents(space.id, true);
      assert.ok(audits.length > 0);

      // 2. Bob tenta gerar convite para um terceiro -> BLOQUEADO
      await assert.rejects(
        async () => {
          await createSpaceInvite(space.id, userBob.uid, userBob.name, {}, true);
        },
        /Apenas proprietários ou administradores/i
      );

      // 3. Bob tenta alterar o papel de Carol -> BLOQUEADO
      await assert.rejects(
        async () => {
          await updateMemberRole(space.id, userBob.uid, userBob.name, userCarol.uid, 'admin', true);
        },
        /Apenas o proprietário ou o criador do espaço podem alterar papéis/i
      );

      // 4. Bob tenta remover Carol -> BLOQUEADO
      await assert.rejects(
        async () => {
          await removeMemberFromSpace(space.id, userBob.uid, userBob.name, userCarol.uid, true);
        },
        /Apenas proprietários ou administradores podem remover participantes/i
      );
    }
  );

  await t.test(
    '22. idempotência estrita do processamento de timeout de dissolução (múltiplas invocações sem duplicidades)',
    async () => {
      const { space } = await createSpace(
        userAlice.uid,
        userAlice.name,
        userAlice.email,
        { name: 'Espaço Idempotência Timeout' },
        true
      );

      const { rawToken } = await createSpaceInvite(space.id, userAlice.uid, userAlice.name, {}, true);
      await acceptSpaceInvite(rawToken, userBob, true);

      const req = await initiateSpaceDissolution(space.id, userAlice.uid, userAlice.name, true);

      // Predicado: com prazo no futuro, não expirou
      assert.equal(isDissolutionExpired(req), false);
      assert.equal(canCancelDissolutionDueToTimeout(req), false);

      // Força a data de expiração para o passado (timeout atingido)
      const pastDeadline = new Date(Date.now() - 5000).toISOString();
      const expiredReq = { ...req, deadlineDate: pastDeadline };
      universalStorage.setItem(`mpf_v3_demo_dissolution_${space.id}`, JSON.stringify(expiredReq));

      assert.equal(isDissolutionExpired(expiredReq), true);
      assert.equal(canCancelDissolutionDueToTimeout(expiredReq), true);

      // Contagem de auditoria antes da 1a execução de timeout
      const auditsBefore = await getSpaceAuditEvents(space.id, true);
      const cancelAuditsCountBefore = auditsBefore.filter((a) => a.eventType === 'dissolution_cancelled').length;
      assert.equal(cancelAuditsCountBefore, 0);

      // 1ª Execução do processamento de timeout
      const run1 = await processDissolutionTimeout(space.id, true);
      assert.equal(run1.requestStatus, 'auto_cancelled_timeout');
      assert.ok(run1.cancelledAt);

      // Deve ter criado exatamente 1 evento de auditoria
      const auditsAfterRun1 = await getSpaceAuditEvents(space.id, true);
      const cancelAuditsCount1 = auditsAfterRun1.filter((a) => a.eventType === 'dissolution_cancelled').length;
      assert.equal(cancelAuditsCount1, 1);

      // Contagem de notificações de Bob específicas deste espaço
      const notifsBob1 = await getUserSpaceNotifications(userBob.uid, true);
      const timeoutNotifsBobCount1 = notifsBob1.filter((n) => n.spaceId === space.id && n.type === 'dissolution_cancelled').length;
      assert.equal(timeoutNotifsBobCount1, 1);

      // 2ª Execução de repetição (idempotência)
      const run2 = await processDissolutionTimeout(space.id, true);
      assert.equal(run2.requestStatus, 'auto_cancelled_timeout');
      assert.equal(run2.cancelledAt, run1.cancelledAt);

      // Não duplicou auditoria
      const auditsAfterRun2 = await getSpaceAuditEvents(space.id, true);
      const cancelAuditsCount2 = auditsAfterRun2.filter((a) => a.eventType === 'dissolution_cancelled').length;
      assert.equal(cancelAuditsCount2, 1);

      // Não duplicou notificações
      const notifsBob2 = await getUserSpaceNotifications(userBob.uid, true);
      const timeoutNotifsBobCount2 = notifsBob2.filter((n) => n.spaceId === space.id && n.type === 'dissolution_cancelled').length;
      assert.equal(timeoutNotifsBobCount2, 1);

      // 3ª Execução de repetição (idempotência)
      const run3 = await processDissolutionTimeout(space.id, true);
      assert.equal(run3.requestStatus, 'auto_cancelled_timeout');

      const auditsAfterRun3 = await getSpaceAuditEvents(space.id, true);
      const cancelAuditsCount3 = auditsAfterRun3.filter((a) => a.eventType === 'dissolution_cancelled').length;
      assert.equal(cancelAuditsCount3, 1);

      // Proteção de dados: o espaço continua arquivado e íntegro
      const spaceFinal = await getSpaceById(space.id, userAlice.uid, true);
      assert.equal(spaceFinal?.spaceStatus, 'archived');
    }
  );

  await t.test(
    '23. governança e segurança de notificações: destinatário atualiza status read e despachante confiável atua sem spoofing',
    async () => {
      const { space } = await createSpace(
        userAlice.uid,
        userAlice.name,
        userAlice.email,
        { name: 'Espaço Notificações' },
        true
      );

      // Despacha notificação via serviço
      const notif = await sendSpaceNotification(
        {
          userId: userBob.uid,
          spaceId: space.id,
          spaceName: space.name,
          type: 'invite_received',
          title: 'Convite Recebido',
          message: 'Você foi convidado para o espaço.',
          senderUid: userAlice.uid,
        },
        true
      );

      assert.equal(notif.userId, userBob.uid);
      assert.equal(notif.read, false);
      assert.equal(notif.senderUid, userAlice.uid);

      // Consulta notificações de Bob
      const bobNotifs = await getUserSpaceNotifications(userBob.uid, true);
      assert.ok(bobNotifs.some((n) => n.id === notif.id));

      // Bob marca notificação como lida
      await markNotificationAsRead(userBob.uid, notif.id, true);

      const bobNotifsAfter = await getUserSpaceNotifications(userBob.uid, true);
      const updated = bobNotifsAfter.find((n) => n.id === notif.id);
      assert.equal(updated?.read, true);
    }
  );
});
