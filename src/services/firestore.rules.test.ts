import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  deleteDoc,
  where,
} from 'firebase/firestore';

const PROJECT_ID = 'demo-projeto-beta-v3';

test('FIRESTORE SECURITY RULES — Validação Real no Firestore Emulator (Fase 5 & Governança)', async (t) => {
  const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
  const rules = fs.readFileSync(rulesPath, 'utf8');

  let testEnv: RulesTestEnvironment;

  t.before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: '127.0.0.1',
        port: 8080,
        rules,
      },
    });
  });

  t.after(async () => {
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  t.beforeEach(async () => {
    await testEnv.clearFirestore();

    // Seed estado canônico usando contexto administrativo (bypass rules)
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();

      // Espaço compartilhado:
      // - Alice (creatorUid & owner)
      // - AdminBob (admin ativo)
      // - MemberCarol (member ativo)
      // - ExDave (ex-participante removido: consta APENAS em historicalMemberUids, NÃO em memberUids)
      // - StrangerEve (usuário autenticado sem qualquer vínculo)
      await setDoc(doc(adminDb, 'spaces', 'space_1'), {
        id: 'space_1',
        creatorUid: 'uid_alice',
        ownerId: 'uid_alice',
        name: 'Apartamento Central',
        description: 'Espaço de teste de regras',
        icon: 'ph-users-three',
        color: '#3b82f6',
        spaceStatus: 'active',
        memberUids: ['uid_alice', 'uid_bob', 'uid_carol'],
        historicalMemberUids: ['uid_alice', 'uid_bob', 'uid_carol', 'uid_dave'],
        enabledModules: ['finance', 'acquisitions'],
        monthlyBudgetCents: 500000,
        createdAt: '2026-11-01T10:00:00.000Z',
      });

      // Projeção histórica sanitizada para ExDave
      await setDoc(doc(adminDb, 'spaces', 'space_1', 'historical_views', 'uid_dave'), {
        id: 'space_1',
        spaceId: 'space_1',
        memberUid: 'uid_dave',
        creatorUid: 'uid_alice',
        ownerId: 'uid_alice',
        name: 'Apartamento Central',
        spaceStatus: 'active',
        enabledModules: ['finance', 'acquisitions'],
        createdAt: '2026-11-01T10:00:00.000Z',
        exitedAt: '2026-11-05T10:00:00.000Z',
      });

      // Documentos de membros
      await setDoc(doc(adminDb, 'spaces', 'space_1', 'members', 'uid_alice'), {
        id: 'uid_alice',
        spaceId: 'space_1',
        uid: 'uid_alice',
        displayName: 'Alice Criadora',
        contactEmail: 'alice@test.com',
        role: 'owner',
        participationStatus: 'active',
        invitedAt: '2026-11-01T10:00:00.000Z',
        joinedAt: '2026-11-01T10:00:00.000Z',
      });

      await setDoc(doc(adminDb, 'spaces', 'space_1', 'members', 'uid_bob'), {
        id: 'uid_bob',
        spaceId: 'space_1',
        uid: 'uid_bob',
        displayName: 'Bob Admin',
        contactEmail: 'bob@test.com',
        role: 'admin',
        participationStatus: 'active',
        invitedAt: '2026-11-01T10:00:00.000Z',
        joinedAt: '2026-11-01T10:00:00.000Z',
      });

      await setDoc(doc(adminDb, 'spaces', 'space_1', 'members', 'uid_carol'), {
        id: 'uid_carol',
        spaceId: 'space_1',
        uid: 'uid_carol',
        displayName: 'Carol Membro',
        contactEmail: 'carol@test.com',
        role: 'member',
        participationStatus: 'active',
        invitedAt: '2026-11-01T10:00:00.000Z',
        joinedAt: '2026-11-01T10:00:00.000Z',
      });

      await setDoc(doc(adminDb, 'spaces', 'space_1', 'members', 'uid_dave'), {
        id: 'uid_dave',
        spaceId: 'space_1',
        uid: 'uid_dave',
        displayName: 'Dave Ex-Membro',
        contactEmail: 'dave@test.com',
        role: 'member',
        participationStatus: 'removed_by_admin',
        invitedAt: '2026-11-01T10:00:00.000Z',
        joinedAt: '2026-11-01T10:00:00.000Z',
        exitedAt: '2026-11-05T10:00:00.000Z',
      });

      // Eventos de auditoria:
      // - audit_1: Dave entrou (targetUid == uid_dave)
      // - audit_2: Alice promoveu Bob (nem performedByUid nem targetUid são uid_dave)
      await setDoc(doc(adminDb, 'spaces', 'space_1', 'audit', 'audit_1'), {
        id: 'audit_1',
        spaceId: 'space_1',
        eventType: 'invite_accepted',
        performedByUid: 'uid_dave',
        performedByName: 'Dave Ex-Membro',
        targetUid: 'uid_dave',
        timestamp: '2026-11-02T10:00:00.000Z',
      });

      await setDoc(doc(adminDb, 'spaces', 'space_1', 'audit', 'audit_2'), {
        id: 'audit_2',
        spaceId: 'space_1',
        eventType: 'member_role_changed',
        performedByUid: 'uid_alice',
        performedByName: 'Alice Criadora',
        targetUid: 'uid_bob',
        timestamp: '2026-11-06T10:00:00.000Z',
      });

      // Convite ativo do espaço
      await setDoc(doc(adminDb, 'space_invites', 'hash_invite_1'), {
        id: 'hash_invite_1',
        spaceId: 'space_1',
        spaceName: 'Apartamento Central',
        invitedRole: 'member',
        invitedByUid: 'uid_alice',
        invitedByName: 'Alice Criadora',
        tokenStatus: 'pending',
        expiresAt: '2026-12-01T10:00:00.000Z',
        createdAt: '2026-11-06T10:00:00.000Z',
      });

      // Solicitação de dissolução com decisões individuais
      await setDoc(doc(adminDb, 'spaces', 'space_1', 'dissolution', 'request'), {
        id: 'request',
        spaceId: 'space_1',
        initiatedByUid: 'uid_alice',
        initiatedAt: '2026-11-07T10:00:00.000Z',
        deadlineDate: '2026-12-07T10:00:00.000Z',
        requestStatus: 'pending_author_responses',
        authorDestinations: {
          uid_alice: { decision: 'migrate_to_existing_personal_space' },
          uid_bob: { decision: 'pending' },
          uid_carol: { decision: 'pending' },
        },
      });

      // Despesas compartilhadas:
      // - exp_dave: criada por uid_dave (ex-membro autor de registro histórico)
      // - exp_alice_only: criada por uid_alice, sem relação com uid_dave
      await setDoc(doc(adminDb, 'spaces', 'space_1', 'shared_expenses', 'exp_dave'), {
        id: 'exp_dave',
        spaceId: 'space_1',
        title: 'Internet Novembro',
        totalOriginalAmountCents: 15000,
        createdByUid: 'uid_dave',
        responsibleUid: 'uid_alice',
        validationStatus: 'approved',
        commitmentStatus: 'active',
        paymentExecutionStatus: 'unpaid',
      });

      await setDoc(
        doc(adminDb, 'spaces', 'space_1', 'shared_expenses', 'exp_dave', 'liabilities', 'uid_dave'),
        {
          id: 'uid_dave',
          memberUid: 'uid_dave',
          allocatedAmountCents: 5000,
        }
      );

      await setDoc(
        doc(adminDb, 'spaces', 'space_1', 'shared_expenses', 'exp_dave', 'liabilities', 'uid_bob'),
        {
          id: 'uid_bob',
          memberUid: 'uid_bob',
          allocatedAmountCents: 5000,
        }
      );

      await setDoc(
        doc(adminDb, 'spaces', 'space_1', 'shared_expenses', 'exp_dave', 'payments', 'pay_dave'),
        {
          id: 'pay_dave',
          executedByUid: 'uid_dave',
          amountCents: 5000,
        }
      );

      await setDoc(
        doc(adminDb, 'spaces', 'space_1', 'shared_expenses', 'exp_dave', 'payments', 'pay_bob'),
        {
          id: 'pay_bob',
          executedByUid: 'uid_bob',
          amountCents: 5000,
        }
      );

      await setDoc(doc(adminDb, 'spaces', 'space_1', 'shared_expenses', 'exp_alice_only'), {
        id: 'exp_alice_only',
        spaceId: 'space_1',
        title: 'Conserto Fechadura Pós-Saída',
        totalOriginalAmountCents: 20000,
        createdByUid: 'uid_alice',
        responsibleUid: 'uid_alice',
        validationStatus: 'approved',
        commitmentStatus: 'active',
        paymentExecutionStatus: 'unpaid',
      });
    });
  });

  await t.test('1. Usuário não autenticado: bloqueado de ler espaços, membros, auditoria ou listar convites', async () => {
    const unauthDb = testEnv.unauthenticatedContext().firestore();

    await assertFails(getDoc(doc(unauthDb, 'spaces', 'space_1')));
    await assertFails(getDoc(doc(unauthDb, 'spaces', 'space_1', 'members', 'uid_alice')));
    await assertFails(getDoc(doc(unauthDb, 'spaces', 'space_1', 'audit', 'audit_1')));
    // Listagem global de convites deve falhar mesmo para getDocs
    await assertFails(getDocs(collection(unauthDb, 'space_invites')));
    // Apenas get individual pelo hash exato do token é permitido para pré-visualização antes do login
    await assertSucceeds(getDoc(doc(unauthDb, 'space_invites', 'hash_invite_1')));
  });

  await t.test('2. Usuário autenticado sem vínculo (StrangerEve): bloqueado de ler e escrever no espaço', async () => {
    const eveDb = testEnv.authenticatedContext('uid_eve').firestore();

    await assertFails(getDoc(doc(eveDb, 'spaces', 'space_1')));
    await assertFails(getDoc(doc(eveDb, 'spaces', 'space_1', 'historical_views', 'uid_eve')));
    await assertFails(getDocs(collection(eveDb, 'spaces', 'space_1', 'members')));
    await assertFails(getDocs(collection(eveDb, 'spaces', 'space_1', 'audit')));
    await assertFails(
      getDocs(query(collection(eveDb, 'space_invites'), where('spaceId', '==', 'space_1')))
    );
    await assertFails(
      updateDoc(doc(eveDb, 'spaces', 'space_1'), { name: 'Invasão Eve' })
    );
  });

  await t.test('3. Participante ativo (Carol) vs Administrador (Bob) vs Criador (Alice): governança e arquivamento', async () => {
    const aliceDb = testEnv.authenticatedContext('uid_alice').firestore();
    const bobDb = testEnv.authenticatedContext('uid_bob').firestore();
    const carolDb = testEnv.authenticatedContext('uid_carol').firestore();

    // Participante ativo lê espaço, membros, convites do espaço e auditoria completa
    await assertSucceeds(getDoc(doc(carolDb, 'spaces', 'space_1')));
    await assertSucceeds(getDocs(collection(carolDb, 'spaces', 'space_1', 'members')));
    await assertSucceeds(getDocs(collection(carolDb, 'spaces', 'space_1', 'audit')));
    await assertSucceeds(
      getDocs(query(collection(carolDb, 'space_invites'), where('spaceId', '==', 'space_1')))
    );

    // Admin (Bob) NÃO pode arquivar o espaço (autoridade exclusiva do criador)
    await assertFails(
      updateDoc(doc(bobDb, 'spaces', 'space_1'), {
        spaceStatus: 'archived',
        archivedAt: '2026-11-10T10:00:00.000Z',
        archivedByUid: 'uid_bob',
      })
    );

    // Criadora (Alice) arquiva o espaço com sucesso
    await assertSucceeds(
      updateDoc(doc(aliceDb, 'spaces', 'space_1'), {
        spaceStatus: 'archived',
        archivedAt: '2026-11-10T10:00:00.000Z',
        archivedByUid: 'uid_alice',
      })
    );

    // Com o espaço arquivado, nenhuma mutação cadastral ou novo convite é permitido
    await assertFails(
      updateDoc(doc(aliceDb, 'spaces', 'space_1'), {
        name: 'Tentativa em Arquivado',
      })
    );
    await assertFails(
      setDoc(doc(aliceDb, 'space_invites', 'hash_invite_2'), {
        id: 'hash_invite_2',
        spaceId: 'space_1',
        invitedByUid: 'uid_alice',
        tokenStatus: 'pending',
      })
    );
  });

  await t.test('4. Ex-participante / Participante removido (ExDave): acesso histórico estritamente restrito', async () => {
    const daveDb = testEnv.authenticatedContext('uid_dave').firestore();

    // 4.1. Ex-participante NÃO pode ler o documento operacional raiz `spaces/space_1` (protege memberUids atuais e orçamento)
    await assertFails(getDoc(doc(daveDb, 'spaces', 'space_1')));

    // 4.2. Ex-participante PODE ler sua própria projeção histórica sanitizada (`historical_views/uid_dave`)
    await assertSucceeds(
      getDoc(doc(daveDb, 'spaces', 'space_1', 'historical_views', 'uid_dave'))
    );

    // 4.3. Ex-participante PODE ler seu próprio registro em `members/uid_dave`, mas NÃO o de Alice ou Bob
    await assertSucceeds(getDoc(doc(daveDb, 'spaces', 'space_1', 'members', 'uid_dave')));
    await assertFails(getDoc(doc(daveDb, 'spaces', 'space_1', 'members', 'uid_alice')));
    await assertFails(getDocs(collection(daveDb, 'spaces', 'space_1', 'members')));

    // 4.4. Ex-participante NÃO pode listar convites do espaço nem listagem global de convites
    await assertFails(
      getDocs(query(collection(daveDb, 'space_invites'), where('spaceId', '==', 'space_1')))
    );
    await assertFails(getDocs(collection(daveDb, 'space_invites')));

    // 4.5. Ex-participante NÃO pode ler a solicitação de dissolução nem decisões individuais de outros autores
    await assertFails(getDoc(doc(daveDb, 'spaces', 'space_1', 'dissolution', 'request')));

    // 4.6. Auditoria: Ex-participante falha se tentar query ampla sem filtro, mas sucede em query filtrada para seus próprios eventos
    await assertFails(getDocs(collection(daveDb, 'spaces', 'space_1', 'audit')));
    await assertFails(getDoc(doc(daveDb, 'spaces', 'space_1', 'audit', 'audit_2'))); // Evento entre Alice e Bob

    const daveActorQuery = query(
      collection(daveDb, 'spaces', 'space_1', 'audit'),
      where('performedByUid', '==', 'uid_dave')
    );
    const snap = await assertSucceeds(getDocs(daveActorQuery));
    assert.equal(snap.size, 1);
    assert.equal(snap.docs[0].id, 'audit_1');
  });

  await t.test('5. Autor de registro histórico (ExDave): acessa somente suas próprias despesas, obrigações e pagamentos', async () => {
    const daveDb = testEnv.authenticatedContext('uid_dave').firestore();

    // Dave criou `exp_dave` -> leitura permitida
    await assertSucceeds(
      getDoc(doc(daveDb, 'spaces', 'space_1', 'shared_expenses', 'exp_dave'))
    );
    // Dave não tem relação com `exp_alice_only` -> leitura bloqueada
    await assertFails(
      getDoc(doc(daveDb, 'spaces', 'space_1', 'shared_expenses', 'exp_alice_only'))
    );

    // Dave lê sua própria obrigação (`liabilities/uid_dave`), mas é bloqueado de ler a de Bob (`liabilities/uid_bob`)
    await assertSucceeds(
      getDoc(
        doc(daveDb, 'spaces', 'space_1', 'shared_expenses', 'exp_dave', 'liabilities', 'uid_dave')
      )
    );
    await assertFails(
      getDoc(
        doc(daveDb, 'spaces', 'space_1', 'shared_expenses', 'exp_dave', 'liabilities', 'uid_bob')
      )
    );

    // Dave lê seu próprio pagamento (`payments/pay_dave`), mas é bloqueado de ler o de Bob (`payments/pay_bob`)
    await assertSucceeds(
      getDoc(
        doc(daveDb, 'spaces', 'space_1', 'shared_expenses', 'exp_dave', 'payments', 'pay_dave')
      )
    );
    await assertFails(
      getDoc(
        doc(daveDb, 'spaces', 'space_1', 'shared_expenses', 'exp_dave', 'payments', 'pay_bob')
      )
    );
  });

  await t.test('6. Anti-Spoofing: bloqueio absoluto de falsificação de auditoria e notificações críticas pelo cliente', async () => {
    const aliceDb = testEnv.authenticatedContext('uid_alice').firestore();
    const bobDb = testEnv.authenticatedContext('uid_bob').firestore();

    // Mesmo a criadora (Alice) ou admin (Bob) são bloqueados de gravar diretamente em `audit` pelo cliente
    await assertFails(
      setDoc(doc(aliceDb, 'spaces', 'space_1', 'audit', 'fake_audit_999'), {
        id: 'fake_audit_999',
        spaceId: 'space_1',
        eventType: 'space_archived',
        performedByUid: 'uid_alice',
        performedByName: 'Alice Criadora',
        timestamp: new Date().toISOString(),
      })
    );

    // Bloqueio absoluto de criação direta de notificações pelo cliente (mesmo para si ou para outro)
    await assertFails(
      setDoc(doc(aliceDb, 'users', 'uid_bob', 'notifications', 'fake_notif_1'), {
        id: 'fake_notif_1',
        userId: 'uid_bob',
        spaceId: 'space_1',
        spaceName: 'Apartamento Central',
        type: 'dissolution_requested',
        title: 'Notificação Forjada',
        message: 'Tentativa de spoofing pelo cliente.',
        read: false,
        createdAt: new Date().toISOString(),
      })
    );

    // Cliente também não pode forjar status `auto_cancelled_timeout` diretamente no Firestore (exclusivo do backend)
    await assertFails(
      updateDoc(doc(aliceDb, 'spaces', 'space_1', 'dissolution', 'request'), {
        requestStatus: 'auto_cancelled_timeout',
        cancelledAt: new Date().toISOString(),
        cancellationReason: 'Forjado no cliente',
      })
    );
  });

  await t.test('7. Fase 3 (Contas e Livro Financeiro): bloqueio de alteração direta de saldo projetado e escrita direta em movements pelo cliente', async () => {
    const aliceDb = testEnv.authenticatedContext('uid_alice').firestore();
    const bobDb = testEnv.authenticatedContext('uid_bob').firestore();
    const unauthDb = testEnv.unauthenticatedContext().firestore();

    // 7.1. Criação de conta legítima com projectedBalanceCents == 0
    await assertSucceeds(
      setDoc(doc(aliceDb, 'accounts', 'acc_alice_1'), {
        id: 'acc_alice_1',
        userId: 'uid_alice',
        name: 'Conta Corrente Alice',
        type: 'checking',
        projectedBalanceCents: 0,
        isArchived: false,
        createdAt: '2026-11-01T10:00:00.000Z',
        updatedAt: '2026-11-01T10:00:00.000Z',
      })
    );

    // 7.2. Bloqueia criação de conta com saldo inicial > 0 pelo cliente
    await assertFails(
      setDoc(doc(aliceDb, 'accounts', 'acc_alice_fake_bal'), {
        id: 'acc_alice_fake_bal',
        userId: 'uid_alice',
        name: 'Conta Saldo Forjado',
        type: 'checking',
        projectedBalanceCents: 999999,
        isArchived: false,
        createdAt: '2026-11-01T10:00:00.000Z',
        updatedAt: '2026-11-01T10:00:00.000Z',
      })
    );

    // 7.3. Titular pode atualizar nome/arquivamento mantendo projectedBalanceCents inalterado
    await assertSucceeds(
      updateDoc(doc(aliceDb, 'accounts', 'acc_alice_1'), {
        name: 'Conta Corrente Alice Editada',
        updatedAt: '2026-11-02T10:00:00.000Z',
      })
    );

    // 7.4. Titular é BLOQUEADO de alterar projectedBalanceCents diretamente pelo cliente
    await assertFails(
      updateDoc(doc(aliceDb, 'accounts', 'acc_alice_1'), {
        projectedBalanceCents: 500000,
      })
    );

    // 7.5. Outro usuário (Bob) e não autenticado são bloqueados de ler ou alterar conta de Alice
    await assertFails(getDoc(doc(bobDb, 'accounts', 'acc_alice_1')));
    await assertFails(getDoc(doc(unauthDb, 'accounts', 'acc_alice_1')));
    await assertFails(
      updateDoc(doc(bobDb, 'accounts', 'acc_alice_1'), {
        name: 'Invasão Bob',
      })
    );

    // 7.6. Escrita direta em accounts/{accountId}/movements/{movementId} pelo cliente é ESTRITAMENTE BLOQUEADA
    await assertFails(
      setDoc(doc(aliceDb, 'accounts', 'acc_alice_1', 'movements', 'mov_client_direct'), {
        id: 'mov_client_direct',
        accountId: 'acc_alice_1',
        userId: 'uid_alice',
        direction: 'inflow',
        amountCents: 10000,
        effectiveDate: '2026-11-05',
        confirmationStatus: 'cleared',
        originType: 'manual_adjustment',
        originId: 'orig_1',
        description: 'Tentativa direta pelo cliente',
        authorUid: 'uid_alice',
        createdAt: '2026-11-05T10:00:00.000Z',
      })
    );
  });

  await t.test('8. Fase 4 (Subcoleções Financeiras): isolamento estrito por titular e bloqueio de escrita direta em coleções autoritativas', async () => {
    const aliceDb = testEnv.authenticatedContext('uid_alice').firestore();
    const bobDb = testEnv.authenticatedContext('uid_bob').firestore();

    // Seed pelo Admin SDK (simulando gravação oficial das Cloud Functions)
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();
      await setDoc(doc(adminDb, 'accounts', 'acc_alice_card'), {
        id: 'acc_alice_card',
        userId: 'uid_alice',
        name: 'Cartão Alice',
        type: 'credit',
        projectedBalanceCents: 0,
        isArchived: false,
        createdAt: '2026-11-01T10:00:00.000Z',
        updatedAt: '2026-11-01T10:00:00.000Z',
      });
      await setDoc(doc(adminDb, 'accounts', 'acc_alice_card', 'invoices', '2026-11'), {
        id: '2026-11',
        accountId: 'acc_alice_card',
        userId: 'uid_alice',
        invoiceMonth: '2026-11',
        remainingBalanceCents: 30000,
        invoiceStatus: 'open',
      });
      await setDoc(
        doc(adminDb, 'accounts', 'acc_alice_card', 'invoices', '2026-11', 'charges', 'chg_1'),
        {
          id: 'chg_1',
          amountCents: 15000,
        }
      );
      await setDoc(
        doc(adminDb, 'accounts', 'acc_alice_card', 'invoices', '2026-11', 'carry_overs', 'carry_1'),
        {
          id: 'carry_1',
          unpaidPrincipalCents: 5000,
        }
      );
      await setDoc(
        doc(adminDb, 'accounts', 'acc_alice_card', 'private_payment_metadata', 'ppm_1'),
        {
          id: 'ppm_1',
          bankName: 'Banco Teste',
        }
      );
      // Coleções equivalentes legadas top-level
      await setDoc(doc(adminDb, 'personal_incomes', 'inc_leg_1'), {
        id: 'inc_leg_1',
        userId: 'uid_alice',
        amountCents: 50000,
      });
      await setDoc(doc(adminDb, 'personal_incomes', 'inc_leg_1', 'receipts', 'rec_leg_1'), {
        id: 'rec_leg_1',
        amountCents: 50000,
      });
      await setDoc(doc(adminDb, 'personal_expenses', 'exp_leg_1'), {
        id: 'exp_leg_1',
        userId: 'uid_alice',
        amountCents: 20000,
      });
      await setDoc(doc(adminDb, 'personal_expenses', 'exp_leg_1', 'payments', 'pay_leg_1'), {
        id: 'pay_leg_1',
        amountCents: 20000,
      });
      await setDoc(doc(adminDb, 'credit_card_statements', 'stmt_leg_1'), {
        id: 'stmt_leg_1',
        userId: 'uid_alice',
        amountCents: 30000,
      });
      await setDoc(doc(adminDb, 'credit_card_statements', 'stmt_leg_1', 'charges', 'chg_leg_1'), {
        id: 'chg_leg_1',
        amountCents: 15000,
      });
      await setDoc(doc(adminDb, 'credit_card_statements', 'stmt_leg_1', 'payments', 'pay_leg_1'), {
        id: 'pay_leg_1',
        amountCents: 15000,
      });
      await setDoc(doc(adminDb, 'personal_refunds', 'ref_leg_1'), {
        id: 'ref_leg_1',
        userId: 'uid_alice',
        amountDueCents: 5000,
      });
      await setDoc(
        doc(adminDb, 'accounts', 'acc_alice_card', 'invoices', '2026-11', 'payments', 'pay_1'),
        {
          id: 'pay_1',
          amountPaidCents: 10000,
        }
      );
      await setDoc(doc(adminDb, 'users', 'uid_alice', 'personal_transactions', 'ptx_1'), {
        id: 'ptx_1',
        userId: 'uid_alice',
        description: 'Salário Alice',
        amountCents: 500000,
      });
      await setDoc(
        doc(adminDb, 'users', 'uid_alice', 'personal_transactions', 'ptx_1', 'payments', 'txpay_1'),
        {
          id: 'txpay_1',
          amountCents: 500000,
        }
      );
      await setDoc(
        doc(adminDb, 'users', 'uid_alice', 'personal_transactions', 'ptx_1', 'payment_reversals', 'payrev_1'),
        {
          id: 'payrev_1',
          paymentId: 'txpay_1',
          amountCents: 500000,
        }
      );
      await setDoc(doc(adminDb, 'users', 'uid_alice', 'internal_transfers', 'xfer_1'), {
        id: 'xfer_1',
        userId: 'uid_alice',
        amountCents: 20000,
      });
      await setDoc(doc(adminDb, 'users', 'uid_alice', 'personal_refunds', 'ref_1'), {
        id: 'ref_1',
        userId: 'uid_alice',
        amountDueCents: 5000,
      });
      await setDoc(
        doc(adminDb, 'users', 'uid_alice', 'personal_refunds', 'ref_1', 'receipts', 'rec_1'),
        {
          id: 'rec_1',
          userId: 'uid_alice',
          amountCents: 5000,
        }
      );
    });

    // 8.1. Alice (titular) lê seus próprios documentos e subcoleções da Fase 4
    await assertSucceeds(getDoc(doc(aliceDb, 'accounts', 'acc_alice_card', 'invoices', '2026-11')));
    await assertSucceeds(
      getDoc(doc(aliceDb, 'accounts', 'acc_alice_card', 'invoices', '2026-11', 'payments', 'pay_1'))
    );
    await assertSucceeds(
      getDoc(doc(aliceDb, 'accounts', 'acc_alice_card', 'invoices', '2026-11', 'charges', 'chg_1'))
    );
    await assertSucceeds(
      getDoc(doc(aliceDb, 'accounts', 'acc_alice_card', 'invoices', '2026-11', 'carry_overs', 'carry_1'))
    );
    await assertSucceeds(
      getDoc(doc(aliceDb, 'accounts', 'acc_alice_card', 'private_payment_metadata', 'ppm_1'))
    );
    await assertSucceeds(getDoc(doc(aliceDb, 'users', 'uid_alice', 'personal_transactions', 'ptx_1')));
    await assertSucceeds(
      getDoc(doc(aliceDb, 'users', 'uid_alice', 'personal_transactions', 'ptx_1', 'payments', 'txpay_1'))
    );
    await assertSucceeds(
      getDoc(doc(aliceDb, 'users', 'uid_alice', 'personal_transactions', 'ptx_1', 'payment_reversals', 'payrev_1'))
    );
    await assertSucceeds(getDoc(doc(aliceDb, 'users', 'uid_alice', 'internal_transfers', 'xfer_1')));
    await assertSucceeds(getDoc(doc(aliceDb, 'users', 'uid_alice', 'personal_refunds', 'ref_1')));
    await assertSucceeds(
      getDoc(doc(aliceDb, 'users', 'uid_alice', 'personal_refunds', 'ref_1', 'receipts', 'rec_1'))
    );

    // Coleções legadas top-level: leitura permitida apenas ao titular
    await assertSucceeds(getDoc(doc(aliceDb, 'personal_incomes', 'inc_leg_1')));
    await assertSucceeds(getDoc(doc(aliceDb, 'personal_incomes', 'inc_leg_1', 'receipts', 'rec_leg_1')));
    await assertSucceeds(getDoc(doc(aliceDb, 'personal_expenses', 'exp_leg_1')));
    await assertSucceeds(getDoc(doc(aliceDb, 'personal_expenses', 'exp_leg_1', 'payments', 'pay_leg_1')));
    await assertSucceeds(getDoc(doc(aliceDb, 'credit_card_statements', 'stmt_leg_1')));
    await assertSucceeds(getDoc(doc(aliceDb, 'credit_card_statements', 'stmt_leg_1', 'charges', 'chg_leg_1')));
    await assertSucceeds(getDoc(doc(aliceDb, 'credit_card_statements', 'stmt_leg_1', 'payments', 'pay_leg_1')));
    await assertSucceeds(getDoc(doc(aliceDb, 'personal_refunds', 'ref_leg_1')));

    // 8.2. Bob é bloqueado de ler qualquer documento ou subcoleção financeira individual de Alice
    await assertFails(getDoc(doc(bobDb, 'accounts', 'acc_alice_card', 'invoices', '2026-11')));
    await assertFails(
      getDoc(doc(bobDb, 'accounts', 'acc_alice_card', 'invoices', '2026-11', 'payments', 'pay_1'))
    );
    await assertFails(
      getDoc(doc(bobDb, 'accounts', 'acc_alice_card', 'invoices', '2026-11', 'charges', 'chg_1'))
    );
    await assertFails(
      getDoc(doc(bobDb, 'accounts', 'acc_alice_card', 'invoices', '2026-11', 'carry_overs', 'carry_1'))
    );
    await assertFails(
      getDoc(doc(bobDb, 'accounts', 'acc_alice_card', 'private_payment_metadata', 'ppm_1'))
    );
    await assertFails(getDoc(doc(bobDb, 'users', 'uid_alice', 'personal_transactions', 'ptx_1')));
    await assertFails(
      getDoc(doc(bobDb, 'users', 'uid_alice', 'personal_transactions', 'ptx_1', 'payments', 'txpay_1'))
    );
    await assertFails(
      getDoc(doc(bobDb, 'users', 'uid_alice', 'personal_transactions', 'ptx_1', 'payment_reversals', 'payrev_1'))
    );
    await assertFails(getDoc(doc(bobDb, 'users', 'uid_alice', 'internal_transfers', 'xfer_1')));
    await assertFails(getDoc(doc(bobDb, 'users', 'uid_alice', 'personal_refunds', 'ref_1')));
    await assertFails(
      getDoc(doc(bobDb, 'users', 'uid_alice', 'personal_refunds', 'ref_1', 'receipts', 'rec_1'))
    );
    await assertFails(getDoc(doc(bobDb, 'personal_incomes', 'inc_leg_1')));
    await assertFails(getDoc(doc(bobDb, 'personal_incomes', 'inc_leg_1', 'receipts', 'rec_leg_1')));
    await assertFails(getDoc(doc(bobDb, 'personal_expenses', 'exp_leg_1')));
    await assertFails(getDoc(doc(bobDb, 'personal_expenses', 'exp_leg_1', 'payments', 'pay_leg_1')));
    await assertFails(getDoc(doc(bobDb, 'credit_card_statements', 'stmt_leg_1')));
    await assertFails(getDoc(doc(bobDb, 'credit_card_statements', 'stmt_leg_1', 'charges', 'chg_leg_1')));
    await assertFails(getDoc(doc(bobDb, 'credit_card_statements', 'stmt_leg_1', 'payments', 'pay_leg_1')));
    await assertFails(getDoc(doc(bobDb, 'personal_refunds', 'ref_leg_1')));

    // 8.3. Escrita direta pelo cliente nas coleções financeiras autoritativas é bloqueada (exige Cloud Functions)
    await assertFails(
      setDoc(doc(aliceDb, 'users', 'uid_alice', 'personal_transactions', 'ptx_forged'), {
        id: 'ptx_forged',
        userId: 'uid_alice',
        amountCents: 10000,
      })
    );
    await assertFails(
      setDoc(doc(aliceDb, 'users', 'uid_alice', 'personal_transactions', 'ptx_1', 'payments', 'pay_forged'), {
        id: 'pay_forged',
        amountCents: 5000,
      })
    );
    await assertFails(
      setDoc(doc(aliceDb, 'users', 'uid_alice', 'personal_transactions', 'ptx_1', 'payment_reversals', 'rev_forged'), {
        id: 'rev_forged',
        amountCents: 5000,
      })
    );
    await assertFails(
      updateDoc(doc(aliceDb, 'users', 'uid_alice', 'personal_transactions', 'ptx_1', 'payments', 'txpay_1'), {
        isReversed: true,
      })
    );
    await assertFails(
      setDoc(doc(aliceDb, 'users', 'uid_alice', 'internal_transfers', 'xfer_forged'), {
        id: 'xfer_forged',
        userId: 'uid_alice',
        amountCents: 10000,
      })
    );
    await assertFails(
      setDoc(doc(aliceDb, 'users', 'uid_alice', 'personal_refunds', 'ref_forged'), {
        id: 'ref_forged',
        userId: 'uid_alice',
        amountDueCents: 10000,
      })
    );
    await assertFails(
      setDoc(doc(aliceDb, 'accounts', 'acc_alice_card', 'invoices', '2026-12'), {
        id: '2026-12',
        userId: 'uid_alice',
      })
    );
    await assertFails(
      setDoc(doc(aliceDb, 'accounts', 'acc_alice_card', 'invoices', '2026-11', 'charges', 'chg_hack'), {
        id: 'chg_hack',
        amountCents: 5000,
      })
    );
    await assertFails(
      setDoc(doc(aliceDb, 'accounts', 'acc_alice_card', 'invoices', '2026-11', 'carry_overs', 'co_hack'), {
        id: 'co_hack',
        unpaidPrincipalCents: 5000,
      })
    );
    await assertFails(
      setDoc(doc(aliceDb, 'personal_incomes', 'inc_hack'), {
        id: 'inc_hack',
        userId: 'uid_alice',
      })
    );
    await assertFails(
      setDoc(doc(aliceDb, 'personal_expenses', 'exp_hack'), {
        id: 'exp_hack',
        userId: 'uid_alice',
      })
    );
    await assertFails(
      setDoc(doc(aliceDb, 'credit_card_statements', 'stmt_hack'), {
        id: 'stmt_hack',
        userId: 'uid_alice',
      })
    );
    await assertFails(
      setDoc(doc(aliceDb, 'personal_refunds', 'ref_hack'), {
        id: 'ref_hack',
        userId: 'uid_alice',
      })
    );

    // 8.4. Categorias e Orçamentos de planejamento permitem CRUD apenas pelo próprio titular
    await assertSucceeds(
      setDoc(doc(aliceDb, 'users', 'uid_alice', 'categories', 'cat_1'), {
        id: 'cat_1',
        userId: 'uid_alice',
        name: 'Alimentação',
        type: 'expense',
        isArchived: false,
      })
    );
    await assertFails(
      setDoc(doc(bobDb, 'users', 'uid_alice', 'categories', 'cat_bob_inject'), {
        id: 'cat_bob_inject',
        userId: 'uid_alice',
        name: 'Invasão Bob',
        type: 'expense',
        isArchived: false,
      })
    );

    await assertSucceeds(
      setDoc(doc(aliceDb, 'users', 'uid_alice', 'budgets', 'bgt_1'), {
        id: 'bgt_1',
        userId: 'uid_alice',
        name: 'Orçamento Nov',
        categoryIds: ['cat_1'],
        competenceMonth: '2026-11',
        plannedAmountCents: 100000,
      })
    );
    await assertFails(getDoc(doc(bobDb, 'users', 'uid_alice', 'budgets', 'bgt_1')));
  });

  await t.test('9. Fase 6 (Rateios e Reembolsos Compartilhados): isolamento, declaração pelo devedor e bloqueio de falsificação de aprovações', async () => {
    const aliceDb = testEnv.authenticatedContext('uid_alice').firestore();
    const bobDb = testEnv.authenticatedContext('uid_bob').firestore();
    const eveDb = testEnv.authenticatedContext('uid_eve').firestore();

    // Seed de espaço com Alice (responsável) e Bob (membro)
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();
      await setDoc(doc(adminDb, 'spaces', 'space_f6'), {
        id: 'space_f6',
        name: 'Espaço Fase 6',
        creatorUid: 'uid_alice',
        ownerId: 'uid_alice',
        memberUids: ['uid_alice', 'uid_bob'],
        spaceStatus: 'active',
        createdAt: '2026-11-01T10:00:00.000Z',
      });
      await setDoc(doc(adminDb, 'spaces', 'space_f6', 'members', 'uid_alice'), {
        uid: 'uid_alice',
        role: 'owner',
        participationStatus: 'active',
      });
      await setDoc(doc(adminDb, 'spaces', 'space_f6', 'members', 'uid_bob'), {
        uid: 'uid_bob',
        role: 'member',
        participationStatus: 'active',
      });
      await setDoc(doc(adminDb, 'spaces', 'space_f6', 'shared_expenses', 'exp_test_1'), {
        id: 'exp_test_1',
        spaceId: 'space_f6',
        title: 'Despesa Compartilhada Teste',
        totalOriginalAmountCents: 10000,
        competenceMonth: '2026-11',
        competenceDate: '2026-11-10',
        createdByUid: 'uid_alice',
        responsibleUid: 'uid_alice',
        validationStatus: 'approved',
        commitmentStatus: 'active',
        paymentExecutionStatus: 'unpaid',
      });
    });

    // 9.1. Usuário sem vínculo (Eve) é bloqueado de ler ou criar despesas compartilhadas
    await assertFails(getDoc(doc(eveDb, 'spaces', 'space_f6', 'shared_expenses', 'exp_test_1')));
    await assertFails(
      setDoc(doc(eveDb, 'spaces', 'space_f6', 'shared_expenses', 'exp_eve_hack'), {
        id: 'exp_eve_hack',
        spaceId: 'space_f6',
        title: 'Invasão Eve',
        createdByUid: 'uid_eve',
      })
    );

    // 9.2. Membro ativo (Bob) lê despesa
    await assertSucceeds(getDoc(doc(bobDb, 'spaces', 'space_f6', 'shared_expenses', 'exp_test_1')));

    // 9.3. Devedor ativo (Bob) declara pagamento de sua cota com sucesso
    await assertSucceeds(
      setDoc(
        doc(
          bobDb,
          'spaces',
          'space_f6',
          'shared_expenses',
          'exp_test_1',
          'payment_declarations',
          'decl_bob_valid'
        ),
        {
          id: 'decl_bob_valid',
          expenseId: 'exp_test_1',
          spaceId: 'space_f6',
          memberUid: 'uid_bob',
          amountCents: 5000,
          paymentDate: '2026-11-11',
          paymentMethod: 'pix',
          status: 'pending_validation',
        }
      )
    );

    // 9.4. Bob tenta forjar declaração atribuindo a cota a Alice (violação de identidade) -> FALHA
    await assertFails(
      setDoc(
        doc(
          bobDb,
          'spaces',
          'space_f6',
          'shared_expenses',
          'exp_test_1',
          'payment_declarations',
          'decl_bob_spoof'
        ),
        {
          id: 'decl_bob_spoof',
          expenseId: 'exp_test_1',
          spaceId: 'space_f6',
          memberUid: 'uid_alice', // Spoofing!
          amountCents: 5000,
          paymentDate: '2026-11-11',
          status: 'pending_validation',
        }
      )
    );

    // 9.5. Escrita direta em payment_approvals pelo cliente é ESTRITAMENTE BLOQUEADA (Cloud Functions exclusive)
    await assertFails(
      setDoc(
        doc(
          aliceDb,
          'spaces',
          'space_f6',
          'shared_expenses',
          'exp_test_1',
          'payment_approvals',
          'appr_hack'
        ),
        {
          id: 'appr_hack',
          declarationId: 'decl_bob_valid',
          amountCents: 5000,
          approverUid: 'uid_alice',
        }
      )
    );

    // 9.6. Escrita direta em approval_revocations pelo cliente é ESTRITAMENTE BLOQUEADA (Cloud Functions exclusive)
    await assertFails(
      setDoc(
        doc(
          aliceDb,
          'spaces',
          'space_f6',
          'shared_expenses',
          'exp_test_1',
          'approval_revocations',
          'revoc_hack'
        ),
        {
          id: 'revoc_hack',
          approvalId: 'appr_hack',
          reason: 'Burlar auditoria',
        }
      )
    );

    // 9.7. Imutabilidade estrita de declarações: update e delete são ESTRITAMENTE BLOQUEADOS para clientes
    await assertFails(
      updateDoc(
        doc(
          bobDb,
          'spaces',
          'space_f6',
          'shared_expenses',
          'exp_test_1',
          'payment_declarations',
          'decl_bob_valid'
        ),
        {
          status: 'approved',
          amountCents: 99999,
        }
      )
    );
    await assertFails(
      deleteDoc(
        doc(
          bobDb,
          'spaces',
          'space_f6',
          'shared_expenses',
          'exp_test_1',
          'payment_declarations',
          'decl_bob_valid'
        )
      )
    );

    // 9.8. Escrita direta em payment_rejections pelo cliente é ESTRITAMENTE BLOQUEADA (Cloud Functions exclusive)
    await assertFails(
      setDoc(
        doc(
          aliceDb,
          'spaces',
          'space_f6',
          'shared_expenses',
          'exp_test_1',
          'payment_rejections',
          'rej_hack'
        ),
        {
          id: 'rej_hack',
          declarationId: 'decl_bob_valid',
          reason: 'Forjar rejeição direta',
        }
      )
    );

    // 9.9. Validação de valor: declaração com valor <= 0 é bloqueada
    await assertFails(
      setDoc(
        doc(
          bobDb,
          'spaces',
          'space_f6',
          'shared_expenses',
          'exp_test_1',
          'payment_declarations',
          'decl_bob_zero'
        ),
        {
          id: 'decl_bob_zero',
          expenseId: 'exp_test_1',
          spaceId: 'space_f6',
          memberUid: 'uid_bob',
          amountCents: 0,
          paymentDate: '2026-11-11',
          status: 'pending_validation',
        }
      )
    );

    // 9.10. Leitura de payment_rejections: membros leem, não membros são bloqueados
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();
      await setDoc(
        doc(
          adminDb,
          'spaces',
          'space_f6',
          'shared_expenses',
          'exp_test_1',
          'payment_rejections',
          'rej_official_1'
        ),
        {
          id: 'rej_official_1',
          declarationId: 'decl_bob_valid',
          expenseId: 'exp_test_1',
          spaceId: 'space_f6',
          rejectionReason: 'Comprovante ilegível',
          rejectedByUid: 'uid_alice',
        }
      );
    });

    await assertSucceeds(
      getDoc(
        doc(
          bobDb,
          'spaces',
          'space_f6',
          'shared_expenses',
          'exp_test_1',
          'payment_rejections',
          'rej_official_1'
        )
      )
    );
    await assertFails(
      getDoc(
        doc(
          eveDb,
          'spaces',
          'space_f6',
          'shared_expenses',
          'exp_test_1',
          'payment_rejections',
          'rej_official_1'
        )
      )
    );

    // 9.11. CENÁRIO 9 (IMUTABILIDADE ESTRITA NAS REGRAS):
    // Testa updateDoc e deleteDoc em payment_approvals, payment_rejections, approval_revocations e movements
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();
      await setDoc(
        doc(
          adminDb,
          'spaces',
          'space_f6',
          'shared_expenses',
          'exp_test_1',
          'payment_approvals',
          'appr_official_1'
        ),
        {
          id: 'appr_official_1',
          declarationId: 'decl_bob_valid',
          expenseId: 'exp_test_1',
          spaceId: 'space_f6',
          memberUid: 'uid_bob',
          responsibleUid: 'uid_alice',
          beneficiaryUid: 'uid_alice',
          amountCents: 5000,
          approverUid: 'uid_alice',
        }
      );
      await setDoc(
        doc(
          adminDb,
          'spaces',
          'space_f6',
          'shared_expenses',
          'exp_test_1',
          'approval_revocations',
          'revoc_official_1'
        ),
        {
          id: 'revoc_official_1',
          approvalId: 'appr_official_1',
          declarationId: 'decl_bob_valid',
          expenseId: 'exp_test_1',
          spaceId: 'space_f6',
          memberUid: 'uid_bob',
          responsibleUid: 'uid_alice',
          beneficiaryUid: 'uid_alice',
          revokedAmountCents: 5000,
          reason: 'Motivo oficial',
          revokedByUid: 'uid_alice',
        }
      );
      await setDoc(doc(adminDb, 'accounts', 'acc_alice_f6'), {
        id: 'acc_alice_f6',
        userId: 'uid_alice',
        name: 'Conta Alice F6',
        type: 'checking',
        projectedBalanceCents: 5000,
      });
      await setDoc(doc(adminDb, 'accounts', 'acc_alice_f6', 'movements', 'mov_official_1'), {
        id: 'mov_official_1',
        accountId: 'acc_alice_f6',
        userId: 'uid_alice',
        direction: 'inflow',
        amountCents: 5000,
        originType: 'shared_reimbursement',
        originId: 'appr_official_1',
      });
    });

    // Ninguém (nem mesmo a responsável Alice ou o membro Bob) pode executar updateDoc ou deleteDoc em payment_approvals
    await assertFails(
      updateDoc(
        doc(
          aliceDb,
          'spaces',
          'space_f6',
          'shared_expenses',
          'exp_test_1',
          'payment_approvals',
          'appr_official_1'
        ),
        { isRevoked: true }
      )
    );
    await assertFails(
      deleteDoc(
        doc(
          aliceDb,
          'spaces',
          'space_f6',
          'shared_expenses',
          'exp_test_1',
          'payment_approvals',
          'appr_official_1'
        )
      )
    );

    // Ninguém pode executar updateDoc ou deleteDoc em payment_rejections
    await assertFails(
      updateDoc(
        doc(
          aliceDb,
          'spaces',
          'space_f6',
          'shared_expenses',
          'exp_test_1',
          'payment_rejections',
          'rej_official_1'
        ),
        { reason: 'Tentativa de adulterar motivo' }
      )
    );
    await assertFails(
      deleteDoc(
        doc(
          aliceDb,
          'spaces',
          'space_f6',
          'shared_expenses',
          'exp_test_1',
          'payment_rejections',
          'rej_official_1'
        )
      )
    );

    // Ninguém pode executar updateDoc ou deleteDoc em approval_revocations
    await assertFails(
      updateDoc(
        doc(
          aliceDb,
          'spaces',
          'space_f6',
          'shared_expenses',
          'exp_test_1',
          'approval_revocations',
          'revoc_official_1'
        ),
        { reason: 'Tentativa de adulterar revogação' }
      )
    );
    await assertFails(
      deleteDoc(
        doc(
          aliceDb,
          'spaces',
          'space_f6',
          'shared_expenses',
          'exp_test_1',
          'approval_revocations',
          'revoc_official_1'
        )
      )
    );

    // Ninguém pode executar updateDoc ou deleteDoc em movements (livro-razão append-only)
    await assertFails(
      updateDoc(doc(aliceDb, 'accounts', 'acc_alice_f6', 'movements', 'mov_official_1'), {
        amountCents: 100,
      })
    );
    await assertFails(
      deleteDoc(doc(aliceDb, 'accounts', 'acc_alice_f6', 'movements', 'mov_official_1'))
    );
  });

  await t.test('10. Bloqueio estrito de escritas não autorizadas em obrigações (F6), listas/itens/compras/estoque (F8) e ocorrências/instâncias (F9)', async () => {
    const aliceDb = testEnv.authenticatedContext('uid_alice').firestore();
    const bobDb = testEnv.authenticatedContext('uid_bob').firestore();
    const eveDb = testEnv.authenticatedContext('uid_eve').firestore();

    // 10.1. F6: Bloqueio de escrita direta em liabilities e payments pelo cliente
    await assertFails(
      updateDoc(
        doc(bobDb, 'spaces', 'space_f6', 'shared_expenses', 'exp_test_1', 'liabilities', 'uid_bob'),
        {
          remainingAmountCents: 0,
          status: 'paid',
        }
      )
    );
    await assertFails(
      setDoc(
        doc(bobDb, 'spaces', 'space_f6', 'shared_expenses', 'exp_test_1', 'liabilities', 'uid_bob_hack'),
        {
          id: 'uid_bob_hack',
          remainingAmountCents: 0,
        }
      )
    );
    await assertFails(
      setDoc(
        doc(bobDb, 'spaces', 'space_f6', 'shared_expenses', 'exp_test_1', 'payments', 'pay_hack_1'),
        {
          id: 'pay_hack_1',
          amountCents: 5000,
          executedByUid: 'uid_bob',
        }
      )
    );

    // 10.2. F8: Isolamento de listas individuais e bloqueio de criação direta de compras e estoque
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();
      await setDoc(doc(adminDb, 'acquisition_lists', 'list_alice_private'), {
        id: 'list_alice_private',
        name: 'Lista Privada Alice',
        scopeType: 'individual',
        ownerUid: 'uid_alice',
        type: 'desejo',
      });
      await setDoc(
        doc(adminDb, 'acquisition_lists', 'list_alice_private', 'items', 'item_secret'),
        {
          id: 'item_secret',
          name: 'Item Secreto',
          listId: 'list_alice_private',
          scopeType: 'individual',
          ownerUid: 'uid_alice',
        }
      );
    });

    // Bob ou Eve não podem ler itens de lista individual de Alice
    await assertFails(
      getDoc(doc(bobDb, 'acquisition_lists', 'list_alice_private', 'items', 'item_secret'))
    );
    await assertFails(
      getDoc(doc(eveDb, 'acquisition_lists', 'list_alice_private', 'items', 'item_secret'))
    );

    // Alice pode ler seu próprio item
    await assertSucceeds(
      getDoc(doc(aliceDb, 'acquisition_lists', 'list_alice_private', 'items', 'item_secret'))
    );

    // Ninguém (nem Alice) pode criar compras ou movimentos de estoque diretamente pelo cliente
    await assertFails(
      setDoc(
        doc(
          aliceDb,
          'acquisition_lists',
          'list_alice_private',
          'items',
          'item_secret',
          'purchases',
          'pch_hack'
        ),
        {
          id: 'pch_hack',
          totalPaidCents: 1000,
          authorUid: 'uid_alice',
        }
      )
    );
    await assertFails(
      setDoc(
        doc(
          aliceDb,
          'acquisition_lists',
          'list_alice_private',
          'items',
          'item_secret',
          'stock_movements',
          'stk_hack'
        ),
        {
          id: 'stk_hack',
          quantityDelta: 10,
          authorUid: 'uid_alice',
        }
      )
    );

    // 10.3. F9: Isolamento e bloqueio de escritas em instâncias e parcelas
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();
      await setDoc(doc(adminDb, 'recurrence_rules', 'rec_alice_1'), {
        id: 'rec_alice_1',
        scope: 'personal',
        userId: 'uid_alice',
        title: 'Streaming Alice',
      });
      await setDoc(
        doc(adminDb, 'recurrence_rules', 'rec_alice_1', 'instances', '2026-11'),
        {
          id: '2026-11',
          ruleId: 'rec_alice_1',
          actualAmountCents: 4990,
        }
      );
      await setDoc(doc(adminDb, 'installment_contracts', 'inst_alice_1'), {
        id: 'inst_alice_1',
        scope: 'personal',
        userId: 'uid_alice',
        title: 'Notebook Alice',
      });
      await setDoc(
        doc(adminDb, 'installment_contracts', 'inst_alice_1', 'occurrences', '01'),
        {
          id: '01',
          contractId: 'inst_alice_1',
          installmentNumber: 1,
          principalAmountCents: 10000,
          status: 'scheduled',
        }
      );
    });

    // Bob não pode ler as instâncias nem as parcelas do contrato pessoal de Alice
    await assertFails(
      getDoc(doc(bobDb, 'recurrence_rules', 'rec_alice_1', 'instances', '2026-11'))
    );
    await assertFails(
      getDoc(doc(bobDb, 'installment_contracts', 'inst_alice_1', 'occurrences', '01'))
    );

    // Alice pode ler suas próprias instâncias e ocorrências
    await assertSucceeds(
      getDoc(doc(aliceDb, 'recurrence_rules', 'rec_alice_1', 'instances', '2026-11'))
    );
    await assertSucceeds(
      getDoc(doc(aliceDb, 'installment_contracts', 'inst_alice_1', 'occurrences', '01'))
    );

    // Cliente é bloqueado de escrever diretamente em instances e occurrences
    await assertFails(
      updateDoc(doc(aliceDb, 'recurrence_rules', 'rec_alice_1', 'instances', '2026-11'), {
        actualAmountCents: 0,
      })
    );
    await assertFails(
      updateDoc(
        doc(aliceDb, 'installment_contracts', 'inst_alice_1', 'occurrences', '01'),
        {
          principalAmountCents: 0,
          status: 'paid',
        }
      )
    );
  });

  await t.test('11. Perfil /users/{uid} e Listas de Aquisição (individual vs shared): isolamento por titular e espaço', async () => {
    const aliceDb = testEnv.authenticatedContext('uid_alice').firestore();
    const bobDb = testEnv.authenticatedContext('uid_bob').firestore();
    const eveDb = testEnv.authenticatedContext('uid_eve').firestore();

    // 11.1. Usuário cria e lê seu próprio perfil em /users/{uid}
    await assertSucceeds(
      setDoc(doc(aliceDb, 'users', 'uid_alice'), {
        uid: 'uid_alice',
        name: 'Alice Perfil',
        email: 'alice@test.com',
        preferredTheme: 'dark',
      })
    );
    await assertSucceeds(getDoc(doc(aliceDb, 'users', 'uid_alice')));
    await assertSucceeds(
      updateDoc(doc(aliceDb, 'users', 'uid_alice'), { name: 'Alice Atualizada' })
    );

    // 11.2. Outro usuário não pode ler, atualizar, excluir ou criar perfil alheio
    await assertFails(getDoc(doc(bobDb, 'users', 'uid_alice')));
    await assertFails(updateDoc(doc(bobDb, 'users', 'uid_alice'), { name: 'Invasão' }));
    await assertFails(deleteDoc(doc(aliceDb, 'users', 'uid_alice')));
    await assertFails(
      setDoc(doc(bobDb, 'users', 'uid_alice'), {
        uid: 'uid_alice',
        name: 'Spoof',
      })
    );

    // 11.3. Lista individual: Alice cria com scopeType: 'individual' e ownerUid: 'uid_alice'; Bob/Eve bloqueados
    await assertSucceeds(
      setDoc(doc(aliceDb, 'acquisition_lists', 'list_ind_alice'), {
        id: 'list_ind_alice',
        name: 'Lista Pessoal Alice',
        type: 'recorrente',
        scopeType: 'individual',
        spaceId: null,
        ownerUid: 'uid_alice',
      })
    );
    await assertSucceeds(getDoc(doc(aliceDb, 'acquisition_lists', 'list_ind_alice')));
    await assertFails(getDoc(doc(bobDb, 'acquisition_lists', 'list_ind_alice')));
    await assertFails(
      setDoc(doc(bobDb, 'acquisition_lists', 'list_ind_spoof'), {
        id: 'list_ind_spoof',
        name: 'Spoof Individual',
        type: 'desejo',
        scopeType: 'individual',
        ownerUid: 'uid_alice',
      })
    );

    // 11.4. Lista compartilhada em space_1: Alice e Bob (membros ativos) leem/criam; Eve bloqueada
    await assertSucceeds(
      setDoc(doc(aliceDb, 'acquisition_lists', 'list_shared_space1'), {
        id: 'list_shared_space1',
        name: 'Compras Apartamento',
        type: 'recorrente',
        scopeType: 'shared',
        spaceId: 'space_1',
        ownerUid: 'uid_alice',
      })
    );
    await assertSucceeds(getDoc(doc(bobDb, 'acquisition_lists', 'list_shared_space1')));
    await assertSucceeds(
      setDoc(
        doc(bobDb, 'acquisition_lists', 'list_shared_space1', 'items', 'item_bob_1'),
        {
          id: 'item_bob_1',
          listId: 'list_shared_space1',
          name: 'Café em Grãos',
          createdByUid: 'uid_bob',
        }
      )
    );
    await assertFails(getDoc(doc(eveDb, 'acquisition_lists', 'list_shared_space1')));
    await assertFails(
      setDoc(doc(eveDb, 'acquisition_lists', 'list_shared_eve_hack'), {
        id: 'list_shared_eve_hack',
        name: 'Hack Eve',
        type: 'desejo',
        scopeType: 'shared',
        spaceId: 'space_1',
        ownerUid: 'uid_eve',
      })
    );
  });

  await t.test('12. Dissolução de espaço: cancelamento pelo criador e reabertura estritamente restrita após cancelamento', async () => {
    const aliceDb = testEnv.authenticatedContext('uid_alice').firestore();
    const bobDb = testEnv.authenticatedContext('uid_bob').firestore();
    const carolDb = testEnv.authenticatedContext('uid_carol').firestore();

    // Enquanto `pending_author_responses` está ativa, criadora não pode sobrescrever `deadlineDate` livremente
    await assertFails(
      setDoc(doc(aliceDb, 'spaces', 'space_1', 'dissolution', 'request'), {
        id: 'request',
        spaceId: 'space_1',
        initiatedByUid: 'uid_alice',
        initiatedAt: '2026-11-15T10:00:00.000Z',
        deadlineDate: '2099-12-31T10:00:00.000Z',
        requestStatus: 'pending_author_responses',
        authorDestinations: { uid_alice: { decision: 'pending' } },
      })
    );

    // Somente a criadora (Alice) pode cancelar voluntariamente; Bob (admin) não pode cancelar
    await assertFails(
      updateDoc(doc(bobDb, 'spaces', 'space_1', 'dissolution', 'request'), {
        requestStatus: 'cancelled_by_creator',
        cancelledAt: '2026-11-08T10:00:00.000Z',
        cancellationReason: 'Tentativa Bob',
      })
    );
    await assertSucceeds(
      updateDoc(doc(aliceDb, 'spaces', 'space_1', 'dissolution', 'request'), {
        requestStatus: 'cancelled_by_creator',
        cancelledAt: '2026-11-08T10:00:00.000Z',
        cancellationReason: 'Cancelado pela criadora para testes',
      })
    );

    // Após cancelada, Bob/Carol NÃO podem reabrir a dissolução
    await assertFails(
      setDoc(doc(bobDb, 'spaces', 'space_1', 'dissolution', 'request'), {
        id: 'request',
        spaceId: 'space_1',
        initiatedByUid: 'uid_bob',
        initiatedAt: '2026-11-09T10:00:00.000Z',
        deadlineDate: '2026-12-09T10:00:00.000Z',
        requestStatus: 'pending_author_responses',
        authorDestinations: { uid_bob: { decision: 'pending' } },
      })
    );
    await assertFails(
      setDoc(doc(carolDb, 'spaces', 'space_1', 'dissolution', 'request'), {
        id: 'request',
        spaceId: 'space_1',
        initiatedByUid: 'uid_carol',
        initiatedAt: '2026-11-09T10:00:00.000Z',
        deadlineDate: '2026-12-09T10:00:00.000Z',
        requestStatus: 'pending_author_responses',
        authorDestinations: { uid_carol: { decision: 'pending' } },
      })
    );

    // Criadora NÃO pode spoofing de initiatedByUid ao reabrir
    await assertFails(
      setDoc(doc(aliceDb, 'spaces', 'space_1', 'dissolution', 'request'), {
        id: 'request',
        spaceId: 'space_1',
        initiatedByUid: 'uid_bob',
        initiatedAt: '2026-11-09T10:00:00.000Z',
        deadlineDate: '2026-12-09T10:00:00.000Z',
        requestStatus: 'pending_author_responses',
        authorDestinations: { uid_alice: { decision: 'pending' } },
      })
    );

    // Criadora (Alice) reabre legitimamente após cancelamento
    await assertSucceeds(
      setDoc(doc(aliceDb, 'spaces', 'space_1', 'dissolution', 'request'), {
        id: 'request',
        spaceId: 'space_1',
        initiatedByUid: 'uid_alice',
        initiatedAt: '2026-11-09T10:00:00.000Z',
        deadlineDate: '2026-12-09T10:00:00.000Z',
        requestStatus: 'pending_author_responses',
        authorDestinations: {
          uid_alice: { decision: 'pending' },
          uid_bob: { decision: 'pending' },
          uid_carol: { decision: 'pending' },
        },
      })
    );
  });

  await t.test('13. Despesas Compartilhadas (liabilities, payments e integridade): não autenticado, outro espaço, adulteração e registros históricos', async () => {
    const unauthDb = testEnv.unauthenticatedContext().firestore();
    const aliceDb = testEnv.authenticatedContext('uid_alice').firestore();
    const bobDb = testEnv.authenticatedContext('uid_bob').firestore();
    const eveDb = testEnv.authenticatedContext('uid_eve').firestore(); // Membro de space_2 apenas

    await testEnv.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();
      await setDoc(doc(adminDb, 'spaces', 'space_2'), {
        id: 'space_2',
        creatorUid: 'uid_eve',
        ownerId: 'uid_eve',
        name: 'Espaço Isolado Eve',
        spaceStatus: 'active',
        memberUids: ['uid_eve'],
        historicalMemberUids: ['uid_eve'],
      });
      await setDoc(doc(adminDb, 'spaces', 'space_1', 'shared_expenses', 'exp_pending_bob'), {
        id: 'exp_pending_bob',
        spaceId: 'space_1',
        title: 'Despesa Pendente Bob',
        totalOriginalAmountCents: 10000,
        createdByUid: 'uid_bob',
        responsibleUid: 'uid_alice',
        participantUids: ['uid_alice', 'uid_bob'],
        validationStatus: 'pending_validation',
        commitmentStatus: 'active',
        paymentExecutionStatus: 'unpaid',
      });
    });

    // Não autenticado: bloqueado em liabilities e payments
    await assertFails(
      getDoc(doc(unauthDb, 'spaces', 'space_1', 'shared_expenses', 'exp_dave', 'liabilities', 'uid_bob'))
    );
    await assertFails(
      getDoc(doc(unauthDb, 'spaces', 'space_1', 'shared_expenses', 'exp_dave', 'payments', 'pay_bob'))
    );
    await assertFails(
      setDoc(doc(unauthDb, 'spaces', 'space_1', 'shared_expenses', 'exp_dave', 'liabilities', 'uid_unauth'), {
        id: 'uid_unauth',
      })
    );

    // Usuário de outro espaço (Eve em space_2): bloqueado de ler/escrever em space_1
    await assertFails(
      getDoc(doc(eveDb, 'spaces', 'space_1', 'shared_expenses', 'exp_dave', 'liabilities', 'uid_bob'))
    );
    await assertFails(
      getDoc(doc(eveDb, 'spaces', 'space_1', 'shared_expenses', 'exp_dave', 'payments', 'pay_bob'))
    );

    // Membro ativo e responsável (Alice e Bob): leitura permitida; escrita direta em liabilities/payments ESTRITAMENTE NEGADA
    await assertSucceeds(
      getDoc(doc(bobDb, 'spaces', 'space_1', 'shared_expenses', 'exp_dave', 'liabilities', 'uid_bob'))
    );
    await assertSucceeds(
      getDoc(doc(aliceDb, 'spaces', 'space_1', 'shared_expenses', 'exp_dave', 'payments', 'pay_bob'))
    );
    await assertFails(
      setDoc(doc(aliceDb, 'spaces', 'space_1', 'shared_expenses', 'exp_dave', 'liabilities', 'uid_alice'), {
        id: 'uid_alice',
        remainingAmountCents: 0,
      })
    );
    await assertFails(
      updateDoc(doc(bobDb, 'spaces', 'space_1', 'shared_expenses', 'exp_dave', 'payments', 'pay_bob'), {
        amountCents: 999999,
      })
    );
    await assertFails(
      deleteDoc(doc(aliceDb, 'spaces', 'space_1', 'shared_expenses', 'exp_dave', 'payments', 'pay_bob'))
    );

    // Tentativa do autor (Bob) de auto-aprovar despesa pendente ou transferir responsibleUid -> NEGADA
    await assertFails(
      updateDoc(doc(bobDb, 'spaces', 'space_1', 'shared_expenses', 'exp_pending_bob'), {
        validationStatus: 'approved',
      })
    );
    await assertFails(
      updateDoc(doc(bobDb, 'spaces', 'space_1', 'shared_expenses', 'exp_pending_bob'), {
        responsibleUid: 'uid_bob',
      })
    );

    // Tentativa de adulterar registro de auditoria histórico do espaço -> NEGADA
    await assertFails(
      updateDoc(doc(aliceDb, 'spaces', 'space_1', 'audit', 'audit_1'), {
        eventType: 'tampered',
      })
    );
    await assertFails(deleteDoc(doc(aliceDb, 'spaces', 'space_1', 'audit', 'audit_1')));
  });

  await t.test('14. Aquisições (lists, items, purchases, stock_movements, purchase_reversals): isolamento, imutabilidade de escopo e bloqueio de escritas exclusivas do backend', async () => {
    const unauthDb = testEnv.unauthenticatedContext().firestore();
    const aliceDb = testEnv.authenticatedContext('uid_alice').firestore();
    const bobDb = testEnv.authenticatedContext('uid_bob').firestore();
    const eveDb = testEnv.authenticatedContext('uid_eve').firestore();

    await testEnv.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();
      await setDoc(doc(adminDb, 'spaces', 'space_2'), {
        id: 'space_2',
        creatorUid: 'uid_eve',
        ownerId: 'uid_eve',
        name: 'Espaço Eve',
        spaceStatus: 'active',
        memberUids: ['uid_eve'],
      });
      await setDoc(doc(adminDb, 'spaces', 'space_archived'), {
        id: 'space_archived',
        creatorUid: 'uid_alice',
        ownerId: 'uid_alice',
        name: 'Espaço Arquivado',
        spaceStatus: 'archived',
        memberUids: ['uid_alice', 'uid_bob'],
      });
      await setDoc(doc(adminDb, 'acquisition_lists', 'list_shared_s1'), {
        id: 'list_shared_s1',
        scopeType: 'shared',
        spaceId: 'space_1',
        ownerUid: 'uid_alice',
        name: 'Lista Casa',
        type: 'recorrente',
      });
      await setDoc(doc(adminDb, 'acquisition_lists', 'list_shared_arch'), {
        id: 'list_shared_arch',
        scopeType: 'shared',
        spaceId: 'space_archived',
        ownerUid: 'uid_alice',
        name: 'Lista Arquivada',
        type: 'recorrente',
      });
      await setDoc(doc(adminDb, 'acquisition_lists', 'list_shared_s1', 'items', 'item_s1'), {
        id: 'item_s1',
        listId: 'list_shared_s1',
        name: 'Detergente',
        createdByUid: 'uid_alice',
      });
      await setDoc(
        doc(adminDb, 'acquisition_lists', 'list_shared_s1', 'items', 'item_s1', 'purchases', 'pur_1'),
        {
          id: 'pur_1',
          itemId: 'item_s1',
          listId: 'list_shared_s1',
          totalPaidCents: 2500,
        }
      );
      await setDoc(
        doc(adminDb, 'acquisition_lists', 'list_shared_s1', 'items', 'item_s1', 'stock_movements', 'smov_1'),
        {
          id: 'smov_1',
          itemId: 'item_s1',
          quantityDelta: 2,
        }
      );
      await setDoc(
        doc(adminDb, 'acquisition_lists', 'list_shared_s1', 'items', 'item_s1', 'purchase_reversals', 'prev_1'),
        {
          id: 'prev_1',
          purchaseId: 'pur_1',
          totalReversedAmountCents: 2500,
        }
      );
    });

    // Não autenticado bloqueado em todas as subcoleções
    await assertFails(getDoc(doc(unauthDb, 'acquisition_lists', 'list_shared_s1')));
    await assertFails(getDoc(doc(unauthDb, 'acquisition_lists', 'list_shared_s1', 'items', 'item_s1')));
    await assertFails(
      getDoc(doc(unauthDb, 'acquisition_lists', 'list_shared_s1', 'items', 'item_s1', 'stock_movements', 'smov_1'))
    );

    // Usuário de outro espaço (Eve / space_2) bloqueado em lists, items, purchases, stock_movements e purchase_reversals
    await assertFails(getDoc(doc(eveDb, 'acquisition_lists', 'list_shared_s1')));
    await assertFails(getDoc(doc(eveDb, 'acquisition_lists', 'list_shared_s1', 'items', 'item_s1')));
    await assertFails(
      getDoc(doc(eveDb, 'acquisition_lists', 'list_shared_s1', 'items', 'item_s1', 'purchases', 'pur_1'))
    );
    await assertFails(
      getDoc(doc(eveDb, 'acquisition_lists', 'list_shared_s1', 'items', 'item_s1', 'stock_movements', 'smov_1'))
    );
    await assertFails(
      getDoc(doc(eveDb, 'acquisition_lists', 'list_shared_s1', 'items', 'item_s1', 'purchase_reversals', 'prev_1'))
    );
    await assertFails(
      setDoc(doc(eveDb, 'acquisition_lists', 'list_shared_s1', 'items', 'item_eve_hack'), {
        id: 'item_eve_hack',
        listId: 'list_shared_s1',
        createdByUid: 'uid_eve',
      })
    );

    // Membro ativo (Bob): lê listas, itens, compras, movimentos e estornos legitimamente
    await assertSucceeds(getDoc(doc(bobDb, 'acquisition_lists', 'list_shared_s1')));
    await assertSucceeds(getDoc(doc(bobDb, 'acquisition_lists', 'list_shared_s1', 'items', 'item_s1')));
    await assertSucceeds(
      getDoc(doc(bobDb, 'acquisition_lists', 'list_shared_s1', 'items', 'item_s1', 'purchases', 'pur_1'))
    );
    await assertSucceeds(
      getDoc(doc(bobDb, 'acquisition_lists', 'list_shared_s1', 'items', 'item_s1', 'stock_movements', 'smov_1'))
    );
    await assertSucceeds(
      getDoc(doc(bobDb, 'acquisition_lists', 'list_shared_s1', 'items', 'item_s1', 'purchase_reversals', 'prev_1'))
    );

    // Membro ativo (Bob) NÃO pode sequestrar scopeType/ownerUid/spaceId da lista compartilhada nem deletar a lista
    await assertFails(
      updateDoc(doc(bobDb, 'acquisition_lists', 'list_shared_s1'), {
        scopeType: 'individual',
        ownerUid: 'uid_bob',
        spaceId: null,
      })
    );
    await assertFails(deleteDoc(doc(aliceDb, 'acquisition_lists', 'list_shared_s1')));

    // Espaço arquivado: atualização em lista ou criação de item bloqueada
    await assertFails(
      updateDoc(doc(aliceDb, 'acquisition_lists', 'list_shared_arch'), { name: 'Tentativa' })
    );
    await assertFails(
      setDoc(doc(aliceDb, 'acquisition_lists', 'list_shared_arch', 'items', 'item_arch'), {
        id: 'item_arch',
        listId: 'list_shared_arch',
        createdByUid: 'uid_alice',
      })
    );

    // Membro ativo NÃO pode escrever diretamente em purchases, stock_movements, quotes, deposits ou purchase_reversals
    await assertFails(
      updateDoc(doc(aliceDb, 'acquisition_lists', 'list_shared_s1', 'items', 'item_s1', 'purchases', 'pur_1'), {
        totalPaidCents: 1,
      })
    );
    await assertFails(
      deleteDoc(doc(aliceDb, 'acquisition_lists', 'list_shared_s1', 'items', 'item_s1', 'purchases', 'pur_1'))
    );
    await assertFails(
      setDoc(
        doc(bobDb, 'acquisition_lists', 'list_shared_s1', 'items', 'item_s1', 'stock_movements', 'smov_hack'),
        { id: 'smov_hack', quantityDelta: 99 }
      )
    );
    await assertFails(
      updateDoc(
        doc(aliceDb, 'acquisition_lists', 'list_shared_s1', 'items', 'item_s1', 'stock_movements', 'smov_1'),
        { quantityDelta: 50 }
      )
    );
    await assertFails(
      setDoc(doc(bobDb, 'acquisition_lists', 'list_shared_s1', 'items', 'item_s1', 'quotes', 'q_hack'), {
        id: 'q_hack',
        priceCents: 100,
      })
    );
    await assertFails(
      setDoc(doc(bobDb, 'acquisition_lists', 'list_shared_s1', 'items', 'item_s1', 'deposits', 'd_hack'), {
        id: 'd_hack',
        amountCents: 100,
      })
    );
    await assertFails(
      setDoc(
        doc(aliceDb, 'acquisition_lists', 'list_shared_s1', 'items', 'item_s1', 'purchase_reversals', 'prev_hack'),
        { id: 'prev_hack', purchaseId: 'pur_1' }
      )
    );
  });

  await t.test('15. Recorrências e Parcelamentos (instances e occurrences): bloqueio de escrita direta, adulteração financeira e isolamento entre espaços', async () => {
    const unauthDb = testEnv.unauthenticatedContext().firestore();
    const aliceDb = testEnv.authenticatedContext('uid_alice').firestore();
    const bobDb = testEnv.authenticatedContext('uid_bob').firestore();
    const eveDb = testEnv.authenticatedContext('uid_eve').firestore();

    await testEnv.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();
      await setDoc(doc(adminDb, 'spaces', 'space_archived'), {
        id: 'space_archived',
        creatorUid: 'uid_alice',
        ownerId: 'uid_alice',
        name: 'Espaço Arquivado',
        spaceStatus: 'archived',
        memberUids: ['uid_alice', 'uid_bob'],
      });
      await setDoc(doc(adminDb, 'recurrence_rules', 'rec_shared_1'), {
        id: 'rec_shared_1',
        scope: 'shared',
        userId: 'uid_alice',
        spaceId: 'space_1',
        title: 'Condomínio',
        type: 'expense',
        amountCents: 60000,
        status: 'active',
      });
      await setDoc(doc(adminDb, 'recurrence_rules', 'rec_shared_arch'), {
        id: 'rec_shared_arch',
        scope: 'shared',
        userId: 'uid_alice',
        spaceId: 'space_archived',
        title: 'Regra Arquivada',
        type: 'expense',
        amountCents: 10000,
        status: 'active',
      });
      await setDoc(doc(adminDb, 'recurrence_rules', 'rec_shared_1', 'instances', '2026-11'), {
        id: '2026-11',
        ruleId: 'rec_shared_1',
        actualAmountCents: 60000,
        generationStatus: 'generated',
      });
      await setDoc(doc(adminDb, 'installment_contracts', 'inst_shared_1'), {
        id: 'inst_shared_1',
        scope: 'shared',
        userId: 'uid_alice',
        spaceId: 'space_1',
        title: 'Geladeira 6x',
        totalContractAmountCents: 300000,
        status: 'active',
      });
      await setDoc(doc(adminDb, 'installment_contracts', 'inst_shared_1', 'occurrences', '01'), {
        id: '01',
        contractId: 'inst_shared_1',
        installmentNumber: 1,
        principalAmountCents: 50000,
        status: 'scheduled',
      });
    });

    // Não autenticado bloqueado em todas as operações
    await assertFails(getDoc(doc(unauthDb, 'recurrence_rules', 'rec_shared_1')));
    await assertFails(getDoc(doc(unauthDb, 'recurrence_rules', 'rec_shared_1', 'instances', '2026-11')));
    await assertFails(getDoc(doc(unauthDb, 'installment_contracts', 'inst_shared_1')));
    await assertFails(getDoc(doc(unauthDb, 'installment_contracts', 'inst_shared_1', 'occurrences', '01')));

    // Usuário de outro espaço (Eve) bloqueado em leitura e escrita
    await assertFails(getDoc(doc(eveDb, 'recurrence_rules', 'rec_shared_1')));
    await assertFails(getDoc(doc(eveDb, 'recurrence_rules', 'rec_shared_1', 'instances', '2026-11')));
    await assertFails(getDoc(doc(eveDb, 'installment_contracts', 'inst_shared_1')));
    await assertFails(getDoc(doc(eveDb, 'installment_contracts', 'inst_shared_1', 'occurrences', '01')));

    // Membro ativo do espaço (Bob) lê regras, instâncias, contratos e ocorrências compartilhadas
    await assertSucceeds(getDoc(doc(bobDb, 'recurrence_rules', 'rec_shared_1')));
    await assertSucceeds(getDoc(doc(bobDb, 'recurrence_rules', 'rec_shared_1', 'instances', '2026-11')));
    await assertSucceeds(getDoc(doc(bobDb, 'installment_contracts', 'inst_shared_1')));
    await assertSucceeds(getDoc(doc(bobDb, 'installment_contracts', 'inst_shared_1', 'occurrences', '01')));

    // Atualização legítima de status em recurrence_rules por membro ativo é permitida, mas adulterar amountCents/scope é BLOQUEADO
    await assertSucceeds(
      updateDoc(doc(bobDb, 'recurrence_rules', 'rec_shared_1'), { status: 'paused' })
    );
    await assertFails(
      updateDoc(doc(aliceDb, 'recurrence_rules', 'rec_shared_1'), { amountCents: 1 })
    );
    await assertFails(
      updateDoc(doc(bobDb, 'recurrence_rules', 'rec_shared_1'), {
        scope: 'personal',
        userId: 'uid_bob',
        spaceId: null,
      })
    );
    await assertFails(
      updateDoc(doc(aliceDb, 'recurrence_rules', 'rec_shared_arch'), { status: 'paused' })
    );

    // Criação, alteração e exclusão direta pelo cliente em recurrence_rules/instances -> BLOQUEADAS
    await assertFails(
      setDoc(doc(aliceDb, 'recurrence_rules', 'rec_shared_1', 'instances', '2026-12'), {
        id: '2026-12',
        ruleId: 'rec_shared_1',
        actualAmountCents: 60000,
      })
    );
    await assertFails(
      updateDoc(doc(aliceDb, 'recurrence_rules', 'rec_shared_1', 'instances', '2026-11'), {
        actualAmountCents: 1,
      })
    );
    await assertFails(
      deleteDoc(doc(aliceDb, 'recurrence_rules', 'rec_shared_1', 'instances', '2026-11'))
    );

    // Criação, alteração e exclusão direta pelo cliente em installment_contracts e occurrences -> ESTRITAMENTE BLOQUEADAS
    await assertFails(
      setDoc(doc(aliceDb, 'installment_contracts', 'inst_client_hack'), {
        id: 'inst_client_hack',
        scope: 'personal',
        userId: 'uid_alice',
        totalContractAmountCents: 1000,
      })
    );
    await assertFails(
      updateDoc(doc(aliceDb, 'installment_contracts', 'inst_shared_1'), {
        totalContractAmountCents: 100,
        status: 'cancelled_early',
      })
    );
    await assertFails(deleteDoc(doc(aliceDb, 'installment_contracts', 'inst_shared_1')));
    await assertFails(
      setDoc(doc(aliceDb, 'installment_contracts', 'inst_shared_1', 'occurrences', '02'), {
        id: '02',
        contractId: 'inst_shared_1',
        principalAmountCents: 50000,
      })
    );
    await assertFails(
      updateDoc(doc(aliceDb, 'installment_contracts', 'inst_shared_1', 'occurrences', '01'), {
        status: 'paid',
        principalAmountCents: 0,
      })
    );
    await assertFails(
      deleteDoc(doc(aliceDb, 'installment_contracts', 'inst_shared_1', 'occurrences', '01'))
    );
  });

  await t.test('16. Endurecimento P0 — Convites (space_invites, adhoc_invites), Rateios Avulsos (adhoc_expenses, adhoc_obligations) e Custódia (transfers)', async () => {
    const unauthDb = testEnv.unauthenticatedContext().firestore();
    const aliceDb = testEnv.authenticatedContext('uid_alice').firestore();
    const bobDb = testEnv.authenticatedContext('uid_bob').firestore();
    const eveDb = testEnv.authenticatedContext('uid_eve').firestore();

    await testEnv.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();

      await setDoc(doc(adminDb, 'adhoc_invites', 'adhoc_hash_1'), {
        id: 'adhoc_hash_1',
        adhocExpenseId: 'adhoc_1',
        debtorRecordId: 'ext_1',
        invitedEmail: 'convidado@exemplo.com',
        assignedAmountCents: 4500,
        creatorUid: 'uid_alice',
        tokenStatus: 'pending',
      });

      await setDoc(doc(adminDb, 'adhoc_expenses', 'adhoc_1'), {
        id: 'adhoc_1',
        ownerUid: 'uid_alice',
        registeredDebtorUids: ['uid_bob'],
        totalAmountCents: 9000,
        status: 'active',
      });

      await setDoc(doc(adminDb, 'users', 'uid_bob', 'adhoc_obligations', 'adhoc_ob_1'), {
        id: 'adhoc_ob_1',
        adhocExpenseId: 'adhoc_1',
        guestUid: 'uid_bob',
        creditorUid: 'uid_alice',
        assignedAmountCents: 4500,
        paidAmountCents: 0,
        remainingBalanceCents: 4500,
        obligationStatus: 'pending_invite',
      });

      await setDoc(doc(adminDb, 'transfers', 'custody_1'), {
        id: 'custody_1',
        spaceId: 'space_1',
        senderUid: 'uid_alice',
        custodianUid: 'uid_bob',
        amountCents: 10000,
        availableBalanceCents: 10000,
        usedAmountCents: 0,
        returnedAmountCents: 0,
        custodyStatus: 'confirmed',
      });

      await setDoc(doc(adminDb, 'transfers', 'custody_1', 'events', 'ev_1'), {
        id: 'ev_1',
        transferId: 'custody_1',
        eventType: 'created',
        actorUid: 'uid_alice',
      });
    });

    // 16.1 space_invites: get por hash permitido; escrita/update/delete direto bloqueado inclusive para membros ativos
    await assertSucceeds(getDoc(doc(unauthDb, 'space_invites', 'hash_invite_1')));
    await assertSucceeds(
      getDocs(query(collection(aliceDb, 'space_invites'), where('spaceId', '==', 'space_1')))
    );
    await assertFails(
      setDoc(doc(aliceDb, 'space_invites', 'hash_client_forged'), {
        id: 'hash_client_forged',
        spaceId: 'space_1',
        invitedByUid: 'uid_alice',
        tokenStatus: 'pending',
      })
    );
    await assertFails(
      updateDoc(doc(bobDb, 'space_invites', 'hash_invite_1'), {
        tokenStatus: 'accepted',
        acceptedByUid: 'uid_bob',
      })
    );
    await assertFails(
      updateDoc(doc(eveDb, 'space_invites', 'hash_invite_1'), {
        tokenStatus: 'revoked',
        revokedByUid: 'uid_eve',
      })
    );
    await assertFails(deleteDoc(doc(aliceDb, 'space_invites', 'hash_invite_1')));

    // 16.2 adhoc_invites: get por hash permitido; listagem global/anônima bloqueada; listagem do criador permitida; escrita direta bloqueada
    await assertSucceeds(getDoc(doc(unauthDb, 'adhoc_invites', 'adhoc_hash_1')));
    await assertFails(getDocs(collection(unauthDb, 'adhoc_invites')));
    await assertFails(getDocs(collection(bobDb, 'adhoc_invites')));
    await assertSucceeds(
      getDocs(query(collection(aliceDb, 'adhoc_invites'), where('creatorUid', '==', 'uid_alice')))
    );
    await assertFails(
      setDoc(doc(aliceDb, 'adhoc_invites', 'adhoc_hash_forged'), {
        id: 'adhoc_hash_forged',
        creatorUid: 'uid_alice',
        tokenStatus: 'pending',
      })
    );
    await assertFails(
      updateDoc(doc(bobDb, 'adhoc_invites', 'adhoc_hash_1'), {
        tokenStatus: 'accepted',
        acceptedByUid: 'uid_bob',
      })
    );

    // 16.3 adhoc_expenses e adhoc_obligations: leitura legítima preservada; estranho bloqueado; escrita direta bloqueada
    await assertSucceeds(getDoc(doc(aliceDb, 'adhoc_expenses', 'adhoc_1')));
    await assertSucceeds(getDoc(doc(bobDb, 'adhoc_expenses', 'adhoc_1')));
    await assertFails(getDoc(doc(eveDb, 'adhoc_expenses', 'adhoc_1')));
    await assertFails(
      setDoc(doc(aliceDb, 'adhoc_expenses', 'adhoc_forged'), {
        id: 'adhoc_forged',
        ownerUid: 'uid_alice',
        totalAmountCents: 1000,
      })
    );
    await assertFails(
      updateDoc(doc(aliceDb, 'adhoc_expenses', 'adhoc_1'), { totalAmountCents: 999999 })
    );
    await assertFails(deleteDoc(doc(aliceDb, 'adhoc_expenses', 'adhoc_1')));

    await assertSucceeds(getDoc(doc(bobDb, 'users', 'uid_bob', 'adhoc_obligations', 'adhoc_ob_1')));
    await assertSucceeds(getDoc(doc(aliceDb, 'users', 'uid_bob', 'adhoc_obligations', 'adhoc_ob_1')));
    await assertFails(getDoc(doc(eveDb, 'users', 'uid_bob', 'adhoc_obligations', 'adhoc_ob_1')));
    await assertFails(
      setDoc(doc(aliceDb, 'users', 'uid_bob', 'adhoc_obligations', 'adhoc_ob_forged'), {
        id: 'adhoc_ob_forged',
        creditorUid: 'uid_alice',
        assignedAmountCents: 5000,
      })
    );
    await assertFails(
      updateDoc(doc(bobDb, 'users', 'uid_bob', 'adhoc_obligations', 'adhoc_ob_1'), {
        paidAmountCents: 4500,
        obligationStatus: 'accepted',
      })
    );

    // 16.4 transfers e transfers/events (custódia): leitura preservada; mutação direta bloqueada
    await assertSucceeds(getDoc(doc(aliceDb, 'transfers', 'custody_1')));
    await assertSucceeds(getDoc(doc(bobDb, 'transfers', 'custody_1')));
    await assertFails(getDoc(doc(eveDb, 'transfers', 'custody_1')));
    await assertFails(
      setDoc(doc(aliceDb, 'transfers', 'custody_forged'), {
        id: 'custody_forged',
        senderUid: 'uid_alice',
        custodianUid: 'uid_bob',
        amountCents: 50000,
      })
    );
    await assertFails(
      updateDoc(doc(bobDb, 'transfers', 'custody_1'), {
        availableBalanceCents: 999999,
        custodyStatus: 'confirmed',
      })
    );
    await assertFails(
      setDoc(doc(aliceDb, 'transfers', 'custody_1', 'events', 'ev_forged'), {
        id: 'ev_forged',
        eventType: 'confirmed',
      })
    );
  });

  await t.test('17. Endurecimento P0 — Liquidações (settlements, allocations, reversions) e proteção de acquisition_lists/items', async () => {
    const aliceDb = testEnv.authenticatedContext('uid_alice').firestore();
    const bobDb = testEnv.authenticatedContext('uid_bob').firestore();
    const carolDb = testEnv.authenticatedContext('uid_carol').firestore();
    const daveDb = testEnv.authenticatedContext('uid_dave').firestore();
    const eveDb = testEnv.authenticatedContext('uid_eve').firestore();

    await testEnv.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();

      // Liquidação bilateral entre Bob (debtor) e Alice (creditor) em space_1; Carol é terceira no mesmo espaço
      await setDoc(doc(adminDb, 'spaces', 'space_1', 'settlements', 'set_bob_alice'), {
        id: 'set_bob_alice',
        spaceId: 'space_1',
        debtorUid: 'uid_bob',
        creditorUid: 'uid_alice',
        amountCents: 5000,
        status: 'pending_confirmation',
      });
      await setDoc(
        doc(adminDb, 'spaces', 'space_1', 'settlements', 'set_bob_alice', 'allocations', 'alloc_1'),
        {
          id: 'alloc_1',
          settlementId: 'set_bob_alice',
          expenseId: 'exp_dave',
          allocatedAmountCents: 5000,
        }
      );
      await setDoc(
        doc(adminDb, 'spaces', 'space_1', 'settlements', 'set_bob_alice', 'reversions', 'rev_1'),
        {
          id: 'rev_1',
          settlementId: 'set_bob_alice',
          reason: 'Teste',
        }
      );

      // Lista e itens de aquisição (item deletável vs item já adquirido/com meta financiada)
      await setDoc(doc(adminDb, 'acquisition_lists', 'list_acq_p0'), {
        id: 'list_acq_p0',
        scopeType: 'shared',
        spaceId: 'space_1',
        ownerUid: 'uid_alice',
        name: 'Lista P0',
        type: 'objetivo',
      });
      await setDoc(doc(adminDb, 'acquisition_lists', 'list_acq_p0', 'items', 'item_draft'), {
        id: 'item_draft',
        listId: 'list_acq_p0',
        createdByUid: 'uid_alice',
        stage: 'pesquisa',
        savedAmountCents: 0,
      });
      await setDoc(doc(adminDb, 'acquisition_lists', 'list_acq_p0', 'items', 'item_acquired'), {
        id: 'item_acquired',
        listId: 'list_acq_p0',
        createdByUid: 'uid_alice',
        stage: 'adquirido',
        finalPaidAmountCents: 15000,
        savedAmountCents: 15000,
      });
    });

    // 17.1 settlements e allocations: leitura permitida para membros e histórico envolvido; escrita/alteração por terceiro (Carol) ou cliente bloqueada
    await assertSucceeds(getDoc(doc(aliceDb, 'spaces', 'space_1', 'settlements', 'set_bob_alice')));
    await assertSucceeds(
      getDoc(
        doc(bobDb, 'spaces', 'space_1', 'settlements', 'set_bob_alice', 'allocations', 'alloc_1')
      )
    );
    await assertFails(
      getDoc(doc(daveDb, 'spaces', 'space_1', 'settlements', 'set_bob_alice'))
    );
    await assertFails(
      getDoc(doc(eveDb, 'spaces', 'space_1', 'settlements', 'set_bob_alice'))
    );

    // Carol (terceira no espaço) NÃO pode alterar nem criar alocações financeiras entre Bob e Alice
    await assertFails(
      setDoc(
        doc(carolDb, 'spaces', 'space_1', 'settlements', 'set_bob_alice', 'allocations', 'alloc_carol_hack'),
        {
          id: 'alloc_carol_hack',
          settlementId: 'set_bob_alice',
          allocatedAmountCents: 99999,
        }
      )
    );
    await assertFails(
      updateDoc(
        doc(carolDb, 'spaces', 'space_1', 'settlements', 'set_bob_alice', 'allocations', 'alloc_1'),
        { allocatedAmountCents: 1 }
      )
    );
    await assertFails(
      deleteDoc(
        doc(carolDb, 'spaces', 'space_1', 'settlements', 'set_bob_alice', 'allocations', 'alloc_1')
      )
    );

    // Nem mesmo Bob/Alice podem forjar settlements/allocations/reversions diretamente no cliente
    await assertFails(
      setDoc(doc(bobDb, 'spaces', 'space_1', 'settlements', 'set_forged'), {
        id: 'set_forged',
        debtorUid: 'uid_bob',
        creditorUid: 'uid_alice',
        amountCents: 5000,
      })
    );
    await assertFails(
      updateDoc(doc(aliceDb, 'spaces', 'space_1', 'settlements', 'set_bob_alice'), {
        status: 'confirmed',
      })
    );
    await assertFails(
      setDoc(
        doc(aliceDb, 'spaces', 'space_1', 'settlements', 'set_bob_alice', 'reversions', 'rev_forged'),
        { id: 'rev_forged' }
      )
    );

    // 17.2 acquisition_lists/items: bloqueia spoofing de listId na criação e exclusão de item já adquirido/financiado; preserva fluxo legítimo
    await assertFails(
      setDoc(doc(bobDb, 'acquisition_lists', 'list_acq_p0', 'items', 'item_spoof_list'), {
        id: 'item_spoof_list',
        listId: 'outra_lista',
        createdByUid: 'uid_bob',
      })
    );
    await assertFails(
      deleteDoc(doc(aliceDb, 'acquisition_lists', 'list_acq_p0', 'items', 'item_acquired'))
    );
    await assertSucceeds(
      deleteDoc(doc(aliceDb, 'acquisition_lists', 'list_acq_p0', 'items', 'item_draft'))
    );
  });
});
