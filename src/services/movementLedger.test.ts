import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  Account,
  FinancialMovement,
  CentsInteger,
} from '../types/financeV3';
import {
  buildFinancialMovement,
  buildCompensatoryMovement,
  reconcileAccountBalance,
  parseBRLToCents,
  formatCentsToBRL,
  validatePositiveCents,
  generateMovementDocId,
} from '../utils/movementLedger';
import {
  createAccount,
  getUserAccounts,
  archiveAccount,
  updateAccount,
  validateAccountInput,
} from './accountService';
import {
  recordMovement,
  getAccountMovements,
  reverseMovement,
  reconcileAndSyncAccountBalance,
  auditAccountBalance,
} from './ledgerService';
import {
  TrustedFinancialLedgerBackend,
  TrustedDbAdapter,
} from './backend/trustedLedgerBackend';
import { universalStorage } from '../utils/universalStorage';

describe('FASE 3 — Motor Contábil, Contas e Livro de Movimentações (v3.1)', () => {
  const USER_A = 'usr_alice_canonical_111';
  const USER_B = 'usr_bob_canonical_222';

  beforeEach(() => {
    // Limpa estado isolado de teste/demonstração antes de cada caso
    universalStorage.clear();
  });

  // 1. Criação de conta
  it('1. deve criar conta financeira com todos os campos canônicos e saldo projetado inicial zero', async () => {
    const acc = await createAccount(
      USER_A,
      {
        name: 'Nubank Principal',
        type: 'checking',
        color: '#820ad1',
        icon: 'ph-bank',
      },
      true // Modo isolado / demo
    );

    assert.ok(acc.id.startsWith('acc_'));
    assert.equal(acc.userId, USER_A);
    assert.equal(acc.name, 'Nubank Principal');
    assert.equal(acc.type, 'checking');
    assert.equal(acc.projectedBalanceCents, 0); // Regra D1: Saldo inicial é 0 até haver movimentação
    assert.equal(acc.isArchived, false);
    assert.ok(acc.createdAt);
    assert.ok(acc.updatedAt);
  });

  // 2. Consulta de contas por usuário
  it('2. deve consultar contas pertencentes ao usuário autenticado', async () => {
    await createAccount(USER_A, { name: 'Conta A1', type: 'checking' }, true);
    await createAccount(USER_A, { name: 'Conta A2', type: 'savings' }, true);

    const accountsA = await getUserAccounts(USER_A, false, true);
    assert.equal(accountsA.length, 2);
    assert.ok(accountsA.some((a) => a.name === 'Conta A1'));
    assert.ok(accountsA.some((a) => a.name === 'Conta A2'));
  });

  // 3. Isolamento entre usuários
  it('3. deve garantir isolamento estrito entre usuários (User A não visualiza contas de User B)', async () => {
    await createAccount(USER_A, { name: 'Conta Secreta de Alice', type: 'wallet' }, true);
    await createAccount(USER_B, { name: 'Conta Pessoal de Bob', type: 'checking' }, true);

    const accountsAlice = await getUserAccounts(USER_A, true, true);
    const accountsBob = await getUserAccounts(USER_B, true, true);

    assert.equal(accountsAlice.length, 1);
    assert.equal(accountsAlice[0].name, 'Conta Secreta de Alice');
    assert.equal(accountsAlice[0].userId, USER_A);

    assert.equal(accountsBob.length, 1);
    assert.equal(accountsBob[0].name, 'Conta Pessoal de Bob');
    assert.equal(accountsBob[0].userId, USER_B);
  });

  // 4. Registro de entrada
  it('4. deve registrar movimento de entrada (inflow) aumentando o saldo projetado', async () => {
    const acc = await createAccount(USER_A, { name: 'Itaú Salário', type: 'checking' }, true);

    const movement = await recordMovement(
      {
        accountId: acc.id,
        userId: USER_A,
        direction: 'inflow',
        amountCents: 350050, // R$ 3.500,50
        effectiveDate: '2026-11-10',
        originType: 'personal_income',
        originId: 'inc_salario_nov',
        description: 'Salário Mensal',
        authorUid: USER_A,
      },
      true
    );

    assert.equal(movement.direction, 'inflow');
    assert.equal(movement.amountCents, 350050);
    assert.equal(movement.confirmationStatus, 'cleared');

    const accounts = await getUserAccounts(USER_A, false, true);
    const updatedAcc = accounts.find((a) => a.id === acc.id);
    assert.equal(updatedAcc?.projectedBalanceCents, 350050);
  });

  // 5. Registro de saída
  it('5. deve registrar movimento de saída (outflow) decrementando o saldo projetado', async () => {
    const acc = await createAccount(USER_A, { name: 'Carteira Dinheiro', type: 'wallet' }, true);

    // Entrada inicial de R$ 200,00
    await recordMovement(
      {
        accountId: acc.id,
        userId: USER_A,
        direction: 'inflow',
        amountCents: 20000,
        effectiveDate: '2026-11-10',
        originType: 'manual_adjustment',
        originId: 'dep_01',
        description: 'Saque no caixa',
        authorUid: USER_A,
      },
      true
    );

    // Saída de R$ 45,50
    const outMov = await recordMovement(
      {
        accountId: acc.id,
        userId: USER_A,
        direction: 'outflow',
        amountCents: 4550,
        effectiveDate: '2026-11-10',
        originType: 'personal_expense',
        originId: 'exp_almoco',
        description: 'Almoço no restaurante',
        authorUid: USER_A,
      },
      true
    );

    assert.equal(outMov.direction, 'outflow');
    assert.equal(outMov.amountCents, 4550);

    const accounts = await getUserAccounts(USER_A, false, true);
    const updatedAcc = accounts.find((a) => a.id === acc.id);
    // 20000 - 4550 = 15450 centavos (R$ 154,50)
    assert.equal(updatedAcc?.projectedBalanceCents, 15450);
  });

  // 6. Cálculo do saldo
  it('6. deve calcular o saldo resultante com exatidão matemática a partir de centavos inteiros', () => {
    const movements: FinancialMovement[] = [
      buildFinancialMovement({
        accountId: 'acc_1',
        userId: USER_A,
        direction: 'inflow',
        amountCents: 100000, // R$ 1.000,00
        effectiveDate: '2026-11-01',
        originType: 'personal_income',
        originId: '1',
        description: 'Entrada 1',
        authorUid: USER_A,
      }),
      buildFinancialMovement({
        accountId: 'acc_1',
        userId: USER_A,
        direction: 'outflow',
        amountCents: 33333, // R$ 333,33
        effectiveDate: '2026-11-02',
        originType: 'personal_expense',
        originId: '2',
        description: 'Saída 1',
        authorUid: USER_A,
      }),
      buildFinancialMovement({
        accountId: 'acc_1',
        userId: USER_A,
        direction: 'outflow',
        amountCents: 33333, // R$ 333,33
        effectiveDate: '2026-11-03',
        originType: 'personal_expense',
        originId: '3',
        description: 'Saída 2',
        authorUid: USER_A,
      }),
    ];

    const balance = reconcileAccountBalance(movements);
    // 100000 - 33333 - 33333 = 33334 centavos
    assert.equal(balance, 33334);
    assert.equal(formatCentsToBRL(balance), 'R$ 333,34');
  });

  // 7. Reconciliação completa pelo histórico
  it('7. deve reconciliar e sincronizar a projeção de saldo com base no histórico integral', async () => {
    const acc = await createAccount(USER_A, { name: 'Conta Reconciliável', type: 'checking' }, true);

    await recordMovement(
      {
        accountId: acc.id,
        userId: USER_A,
        direction: 'inflow',
        amountCents: 50000, // R$ 500,00
        effectiveDate: '2026-11-01',
        originType: 'personal_income',
        originId: 'rec_1',
        description: 'Aporte A',
        authorUid: USER_A,
      },
      true
    );

    await recordMovement(
      {
        accountId: acc.id,
        userId: USER_A,
        direction: 'outflow',
        amountCents: 12500, // R$ 125,00
        effectiveDate: '2026-11-02',
        originType: 'personal_expense',
        originId: 'rec_2',
        description: 'Despesa B',
        authorUid: USER_A,
      },
      true
    );

    const result = await reconcileAndSyncAccountBalance(acc.id, USER_A, true);
    assert.equal(result.reconciledBalanceCents, 37500); // R$ 375,00
    assert.equal(result.differenceCents, 0);
  });

  // 8. Reversão de movimentação
  it('8. deve executar estorno criando movimento compensatório oposto sem modificar o original', async () => {
    const acc = await createAccount(USER_A, { name: 'Conta Estornável', type: 'checking' }, true);

    const original = await recordMovement(
      {
        accountId: acc.id,
        userId: USER_A,
        direction: 'outflow',
        amountCents: 8990, // R$ 89,90 debitado por engano
        effectiveDate: '2026-11-05',
        originType: 'personal_expense',
        originId: 'pix_errado',
        description: 'PIX duplicado acidental',
        authorUid: USER_A,
      },
      true
    );

    const reversal = await reverseMovement(
      acc.id,
      original.id,
      USER_A,
      'Cancelamento de envio duplicado',
      true
    );

    // O movimento compensatório deve ter direção contrária e mesmo montante
    assert.equal(reversal.compensatoryMovement.direction, 'inflow');
    assert.equal(reversal.compensatoryMovement.amountCents, 8990);
    assert.equal(reversal.compensatoryMovement.reversalOfMovementId, original.id);

    // O saldo deve se anular perfeitamente: (-8990) + (+8990) = 0
    const movements = await getAccountMovements(acc.id, USER_A, true);
    assert.equal(movements.length, 2);

    const reconciled = reconcileAccountBalance(movements);
    assert.equal(reconciled, 0);
  });

  // 9. Prevenção de reversão duplicada
  it('9. deve impedir estorno duplicado sobre a mesma movimentação', async () => {
    const acc = await createAccount(USER_A, { name: 'Conta Protegida', type: 'checking' }, true);

    const mov = await recordMovement(
      {
        accountId: acc.id,
        userId: USER_A,
        direction: 'inflow',
        amountCents: 10000,
        effectiveDate: '2026-11-05',
        originType: 'manual_adjustment',
        originId: 'orig_1',
        description: 'Depósito a estornar',
        authorUid: USER_A,
      },
      true
    );

    // Primeiro estorno tem sucesso
    await reverseMovement(acc.id, mov.id, USER_A, 'Primeiro estorno', true);

    // Segundo estorno deve falhar imediatamente
    await assert.rejects(
      async () => {
        await reverseMovement(acc.id, mov.id, USER_A, 'Tentativa de segundo estorno', true);
      },
      {
        message: /já possui um estorno compensatório/i,
      }
    );
  });

  // 10. Imutabilidade de movimentações
  it('10. deve assegurar que movimentações originais permanecem íntegras sem status reversed mutável', async () => {
    const acc = await createAccount(USER_A, { name: 'Conta Auditável', type: 'checking' }, true);

    const mov = await recordMovement(
      {
        accountId: acc.id,
        userId: USER_A,
        direction: 'inflow',
        amountCents: 50000,
        effectiveDate: '2026-11-08',
        originType: 'personal_income',
        originId: 'inc_audit',
        description: 'Entrada oficial auditada',
        authorUid: USER_A,
      },
      true
    );

    // Estorna
    await reverseMovement(acc.id, mov.id, USER_A, 'Estorno auditado', true);

    // Consulta os movimentos gravados
    const movements = await getAccountMovements(acc.id, USER_A, true);
    const originalPostReversal = movements.find((m) => m.id === mov.id);

    // Regra v3.1: O movimento original NUNCA muta para confirmationStatus: 'reversed'
    assert.equal(originalPostReversal?.confirmationStatus, 'cleared');
    assert.equal(originalPostReversal?.amountCents, 50000);
    assert.equal(originalPostReversal?.reversalOfMovementId, undefined);
  });

  // 11. Prevenção de valores inválidos
  it('11. deve rejeitar valores negativos, decimais não-inteiros ou nulos', () => {
    assert.equal(validatePositiveCents(-100), false);
    assert.equal(validatePositiveCents(0), false);
    assert.equal(validatePositiveCents(12.5), false);
    assert.equal(validatePositiveCents(NaN), false);
    assert.equal(validatePositiveCents(Infinity), false);
    assert.equal(validatePositiveCents('1000' as unknown as number), false);

    assert.throws(() => {
      buildFinancialMovement({
        accountId: 'acc_1',
        userId: USER_A,
        direction: 'inflow',
        amountCents: -500 as unknown as CentsInteger,
        effectiveDate: '2026-11-10',
        originType: 'manual_adjustment',
        originId: 'x',
        description: 'Inválido',
        authorUid: USER_A,
      });
    }, /positivo em centavos/i);
  });

  // 12. Prevenção de duplicidade por idempotência
  it('12. deve retornar o mesmo movimento se executado com a mesma chave de idempotência', async () => {
    const acc = await createAccount(USER_A, { name: 'Conta Idempotente', type: 'checking' }, true);

    const payload = {
      accountId: acc.id,
      userId: USER_A,
      direction: 'inflow' as const,
      amountCents: 15000,
      effectiveDate: '2026-11-10',
      originType: 'personal_income' as const,
      originId: 'tx_externa_12345',
      idempotencyKey: 'idem_pix_tx_externa_12345',
      description: 'PIX recebido de cliente',
      authorUid: USER_A,
    };

    const mov1 = await recordMovement(payload, true);
    const mov2 = await recordMovement(payload, true); // Re-execução da mesma operação

    assert.equal(mov1.id, mov2.id);

    // Saldo não pode ser duplicado
    const movements = await getAccountMovements(acc.id, USER_A, true);
    assert.equal(movements.length, 1);
    assert.equal(reconcileAccountBalance(movements), 15000);
  });

  // 13. Isolamento do modo demonstração
  it('13. deve isolar completamente as operações de demonstração sem poluir o Firestore', async () => {
    // Cria conta no modo demo
    const demoAcc = await createAccount(
      'demo_uid_test',
      { name: 'Conta Demo 100% Local', type: 'wallet' },
      true
    );

    await recordMovement(
      {
        accountId: demoAcc.id,
        userId: 'demo_uid_test',
        direction: 'inflow',
        amountCents: 50000,
        effectiveDate: '2026-11-10',
        originType: 'manual_adjustment',
        originId: 'demo_op_1',
        description: 'Aporte de demonstração',
        authorUid: 'demo_uid_test',
      },
      true
    );

    const demoAccounts = await getUserAccounts('demo_uid_test', false, true);
    assert.equal(demoAccounts.length, 1);
    assert.equal(demoAccounts[0].projectedBalanceCents, 50000);

    const demoMovs = await getAccountMovements(demoAcc.id, 'demo_uid_test', true);
    assert.equal(demoMovs.length, 1);
  });

  // 14. Consistência da projeção após reversões
  it('14. deve preservar a consistência perfeita da projeção de saldo após múltiplas reversões', async () => {
    const acc = await createAccount(USER_A, { name: 'Conta Consistente', type: 'checking' }, true);

    // 1. Entrada de R$ 1.000,00
    const m1 = await recordMovement(
      {
        accountId: acc.id,
        userId: USER_A,
        direction: 'inflow',
        amountCents: 100000,
        effectiveDate: '2026-11-01',
        originType: 'personal_income',
        originId: 'm1',
        description: 'Depósito 1',
        authorUid: USER_A,
      },
      true
    );

    // 2. Saída de R$ 300,00
    const m2 = await recordMovement(
      {
        accountId: acc.id,
        userId: USER_A,
        direction: 'outflow',
        amountCents: 30000,
        effectiveDate: '2026-11-02',
        originType: 'personal_expense',
        originId: 'm2',
        description: 'Compra 1',
        authorUid: USER_A,
      },
      true
    );

    // 3. Saída de R$ 200,00
    const m3 = await recordMovement(
      {
        accountId: acc.id,
        userId: USER_A,
        direction: 'outflow',
        amountCents: 20000,
        effectiveDate: '2026-11-03',
        originType: 'personal_expense',
        originId: 'm3',
        description: 'Compra 2',
        authorUid: USER_A,
      },
      true
    );

    // Saldo intermediário: 1000 - 300 - 200 = R$ 500,00 (50000 centavos)
    let movements = await getAccountMovements(acc.id, USER_A, true);
    assert.equal(reconcileAccountBalance(movements), 50000);

    // 4. Estorna a Compra 1 (R$ 300,00)
    await reverseMovement(acc.id, m2.id, USER_A, 'Devolução da compra 1', true);

    // Saldo atualizado: 500 + 300 = R$ 800,00 (80000 centavos)
    movements = await getAccountMovements(acc.id, USER_A, true);
    assert.equal(reconcileAccountBalance(movements), 80000);

    // 5. Estorna o Depósito 1 (R$ 1.000,00)
    await reverseMovement(acc.id, m1.id, USER_A, 'Estorno do depósito inicial', true);

    // Saldo final: 800 - 1000 = -R$ 200,00 (-20000 centavos)
    movements = await getAccountMovements(acc.id, USER_A, true);
    assert.equal(reconcileAccountBalance(movements), -20000);
    assert.equal(formatCentsToBRL(reconcileAccountBalance(movements)), '-R$ 200,00');
  });

  it('deve formatar e converter moedas com BRL sem perda de precisão', () => {
    assert.equal(parseBRLToCents('1250,90'), 125090);
    assert.equal(parseBRLToCents('R$ 0,05'), 5);
    assert.equal(parseBRLToCents('1.500.000,25'), 150000025);
    assert.equal(formatCentsToBRL(125090), 'R$ 1.250,90');
    assert.equal(formatCentsToBRL(0), 'R$ 0,00');
    assert.equal(formatCentsToBRL(-50), '-R$ 0,50');
  });

  it('deve permitir arquivar conta sem deletar registro histórico', async () => {
    const acc = await createAccount(USER_A, { name: 'Conta Antiga', type: 'checking' }, true);
    assert.equal(acc.isArchived, false);

    const archived = await archiveAccount(acc.id, USER_A, true, true);
    assert.equal(archived.isArchived, true);

    // Consulta padrão (não inclui arquivadas)
    const activeAccounts = await getUserAccounts(USER_A, false, true);
    assert.ok(!activeAccounts.some((a) => a.id === acc.id));

    // Consulta incluindo arquivadas
    const allAccounts = await getUserAccounts(USER_A, true, true);
    assert.ok(allAccounts.some((a) => a.id === acc.id && a.isArchived));
  });

  // Testes de Auditoria: Concorrência, Idempotência e Proteção de Saldo
  it('deve garantir que requisições concorrentes com a mesma idempotencyKey resultam em 1 único movimento e 1 única alteração de saldo', async () => {
    const acc = await createAccount(USER_A, { name: 'Conta Concorrente', type: 'checking' }, true);

    const movementParams = {
      accountId: acc.id,
      userId: USER_A,
      direction: 'inflow' as const,
      amountCents: 50000, // R$ 500,00
      effectiveDate: '2026-11-05',
      originType: 'personal_income' as const,
      originId: 'pix_concorrente_123',
      description: 'PIX Concorrente Recebido',
      authorUid: USER_A,
      idempotencyKey: 'idem_pix_concorrente_123',
    };

    // Dispara 3 requisições simultâneas em paralelo
    const results = await Promise.all([
      recordMovement(movementParams, true),
      recordMovement(movementParams, true),
      recordMovement(movementParams, true),
    ]);

    // Todas as 3 devem retornar a mesma referência canônica (mesmo ID)
    assert.equal(results[0].id, results[1].id);
    assert.equal(results[1].id, results[2].id);

    // O livro deve conter exatamente 1 movimento gravado
    const movements = await getAccountMovements(acc.id, USER_A, true);
    assert.equal(movements.length, 1);
    assert.equal(movements[0].amountCents, 50000);

    // O saldo deve ser exatamente R$ 500,00 (não R$ 1.500,00)
    const accounts = await getUserAccounts(USER_A, false, true);
    const updatedAcc = accounts.find((a) => a.id === acc.id);
    assert.equal(updatedAcc?.projectedBalanceCents, 50000);
    assert.equal(reconcileAccountBalance(movements), 50000);
  });

  it('deve garantir que pedidos concorrentes de reversão não criam dois estornos e não debitam o saldo duas vezes', async () => {
    const acc = await createAccount(USER_A, { name: 'Conta Reversão Concorrente', type: 'checking' }, true);

    const mOriginal = await recordMovement(
      {
        accountId: acc.id,
        userId: USER_A,
        direction: 'inflow',
        amountCents: 100000, // R$ 1.000,00
        effectiveDate: '2026-11-06',
        originType: 'personal_income',
        originId: 'deposito_a_estornar',
        description: 'Depósito a ser estornado',
        authorUid: USER_A,
      },
      true
    );

    // Duas tentativas concorrentes com suporte a retorno idempotente
    const [rev1, rev2] = await Promise.all([
      reverseMovement(acc.id, mOriginal.id, USER_A, 'Cancelamento pedido 1', true, { idempotent: true }),
      reverseMovement(acc.id, mOriginal.id, USER_A, 'Cancelamento pedido 1', true, { idempotent: true }),
    ]);

    // Devem referenciar exatamente o mesmo movimento compensatório determinístico
    assert.equal(rev1.compensatoryMovement.id, rev2.compensatoryMovement.id);
    assert.equal(rev1.newProjectedBalanceCents, 0);
    assert.equal(rev2.newProjectedBalanceCents, 0);

    // O livro deve ter exatamente 2 registros: 1 original + 1 compensatório
    const movements = await getAccountMovements(acc.id, USER_A, true);
    assert.equal(movements.length, 2);

    // Saldo final deve ser exatamente 0 (não -R$ 1.000,00)
    assert.equal(reconcileAccountBalance(movements), 0);
  });

  it('deve retornar o resultado anterior sem alterar saldo em uma repetição legítima da mesma requisição de estorno', async () => {
    const acc = await createAccount(USER_A, { name: 'Conta Retry Idempotente', type: 'checking' }, true);

    const mov = await recordMovement(
      {
        accountId: acc.id,
        userId: USER_A,
        direction: 'outflow',
        amountCents: 25000, // R$ 250,00
        effectiveDate: '2026-11-07',
        originType: 'personal_expense',
        originId: 'compra_farmacia',
        description: 'Farmácia',
        authorUid: USER_A,
      },
      true
    );

    // Primeira execução do estorno
    const firstCall = await reverseMovement(acc.id, mov.id, USER_A, 'Devolução produto', true);
    assert.equal(firstCall.newProjectedBalanceCents, 0);

    // Segunda execução da mesma requisição (retry de rede) com options.idempotent = true
    const retryCall = await reverseMovement(acc.id, mov.id, USER_A, 'Devolução produto', true, {
      idempotent: true,
    });

    // Deve retornar o mesmo registro compensatório e o mesmo saldo projetado (0)
    assert.equal(retryCall.compensatoryMovement.id, firstCall.compensatoryMovement.id);
    assert.equal(retryCall.newProjectedBalanceCents, 0);

    const movements = await getAccountMovements(acc.id, USER_A, true);
    assert.equal(movements.length, 2); // 1 original + 1 compensatório
    assert.equal(reconcileAccountBalance(movements), 0);
  });

  it('deve proibir o registro de novas movimentações e estornos em conta arquivada', async () => {
    const acc = await createAccount(USER_A, { name: 'Conta para Arquivamento', type: 'checking' }, true);
    
    // Cria um movimento enquanto a conta está ativa
    const mov = await recordMovement(
      {
        accountId: acc.id,
        userId: USER_A,
        direction: 'inflow',
        amountCents: 5000,
        effectiveDate: '2026-11-09',
        originType: 'personal_income',
        originId: 'dep_ativo',
        description: 'Depósito pré-arquivamento',
        authorUid: USER_A,
      },
      true
    );

    // Arquiva a conta
    await archiveAccount(acc.id, USER_A, true, true);

    // 1. Tentar gravar novo movimento deve ser sumariamente rejeitado
    await assert.rejects(
      async () => {
        await recordMovement(
          {
            accountId: acc.id,
            userId: USER_A,
            direction: 'inflow',
            amountCents: 1000,
            effectiveDate: '2026-11-09',
            originType: 'personal_income',
            originId: 'dep_bloqueado',
            description: 'Depósito em conta arquivada',
            authorUid: USER_A,
          },
          true
        );
      },
      {
        message: /está arquivada e não pode receber novas movimentações/i,
      }
    );

    // 2. Tentar estornar movimento em conta arquivada deve ser sumariamente rejeitado
    await assert.rejects(
      async () => {
        await reverseMovement(acc.id, mov.id, USER_A, 'Tentativa em conta arquivada', true);
      },
      {
        message: /não é possível estornar movimentações em contas arquivadas/i,
      }
    );
  });

  it('deve proibir a reversão de um movimento que já seja um estorno compensatório', async () => {
    const acc = await createAccount(USER_A, { name: 'Conta Teste Reversão Reversa', type: 'checking' }, true);
    const mov = await recordMovement(
      {
        accountId: acc.id,
        userId: USER_A,
        direction: 'inflow',
        amountCents: 10000,
        effectiveDate: '2026-11-08',
        originType: 'personal_income',
        originId: 'dep_100',
        description: 'Depósito R$ 100',
        authorUid: USER_A,
      },
      true
    );

    const rev = await reverseMovement(acc.id, mov.id, USER_A, 'Motivo 1', true);
    assert.ok(rev.compensatoryMovement.reversalOfMovementId);

    // Tentativa de estornar o estorno deve falhar
    await assert.rejects(
      async () => {
        await reverseMovement(acc.id, rev.compensatoryMovement.id, USER_A, 'Tentando estornar estorno', true);
      },
      {
        message: /já é um estorno compensatório e não pode ser re-estornado/i,
      }
    );
  });

  // ============================================================================
  // TESTES DE INTEGRIDADE, DETERMINISMO DE IDS E PREPARAÇÃO DE BACKEND (FASE 3 COMPL)
  // ============================================================================

  it('15. deve rejeitar tentativa de burlar o determinismo quando um ID manual arbitrário divergente é fornecido', () => {
    assert.throws(() => {
      buildFinancialMovement({
        id: 'mov_hacked_arbitrary_id_123',
        accountId: 'acc_test_1',
        userId: USER_A,
        direction: 'inflow',
        amountCents: 5000,
        effectiveDate: '2026-11-10',
        originType: 'manual_adjustment',
        originId: 'orig_1',
        description: 'Tentativa com ID forjado',
        authorUid: USER_A,
        idempotencyKey: 'chave_oficial_1',
      });
    }, /não coincide com o ID determinístico/i);
  });

  it('16. deve aceitar ID manual quando ele coincide perfeitamente com o ID determinístico derivado da chave', () => {
    const expectedId = generateMovementDocId('acc_test_1', 'chave_oficial_1');
    const mov = buildFinancialMovement({
      id: expectedId,
      accountId: 'acc_test_1',
      userId: USER_A,
      direction: 'inflow',
      amountCents: 5000,
      effectiveDate: '2026-11-10',
      originType: 'manual_adjustment',
      originId: 'orig_1',
      description: 'ID manual correto',
      authorUid: USER_A,
      idempotencyKey: 'chave_oficial_1',
    });

    assert.equal(mov.id, expectedId);
  });

  it('17. deve rejeitar reutilização da mesma chave de idempotência com valores divergentes (conflito de idempotência)', async () => {
    const acc = await createAccount(USER_A, { name: 'Conta Teste Conflito Valor', type: 'checking' }, true);

    const basePayload = {
      accountId: acc.id,
      userId: USER_A,
      direction: 'inflow' as const,
      amountCents: 10000, // R$ 100,00
      effectiveDate: '2026-11-10',
      originType: 'personal_income' as const,
      originId: 'pix_100',
      idempotencyKey: 'idem_pix_unico_123',
      description: 'PIX Original',
      authorUid: USER_A,
    };

    // Primeira chamada registra com sucesso
    await recordMovement(basePayload, true);

    // Segunda chamada com a MESMA chave mas montante diferente (R$ 200,00) deve ser rejeitada sumariamente
    await assert.rejects(
      async () => {
        await recordMovement(
          {
            ...basePayload,
            amountCents: 20000, // Divergência!
            description: 'PIX Divergente',
          },
          true
        );
      },
      {
        message: /Conflito de idempotência/i,
      }
    );
  });

  it('18. deve rejeitar reutilização da mesma chave de idempotência com direções divergentes (conflito de idempotência)', async () => {
    const acc = await createAccount(USER_A, { name: 'Conta Teste Conflito Direção', type: 'checking' }, true);

    const basePayload = {
      accountId: acc.id,
      userId: USER_A,
      direction: 'inflow' as const,
      amountCents: 7500,
      effectiveDate: '2026-11-10',
      originType: 'manual_adjustment' as const,
      originId: 'adj_1',
      idempotencyKey: 'idem_adj_direcao_123',
      description: 'Ajuste de crédito',
      authorUid: USER_A,
    };

    await recordMovement(basePayload, true);

    // Tentativa com mesma chave mas como outflow (saída) deve ser rejeitada
    await assert.rejects(
      async () => {
        await recordMovement(
          {
            ...basePayload,
            direction: 'outflow', // Divergência!
          },
          true
        );
      },
      {
        message: /Conflito de idempotência/i,
      }
    );
  });

  it('19. deve isolar a geração de IDs com a mesma chave em contas bancárias distintas', () => {
    const key = 'idem_operacao_compartilhada_global';
    const idConta1 = generateMovementDocId('acc_bradesco_01', key);
    const idConta2 = generateMovementDocId('acc_itau_02', key);

    // Graças ao escopo accountId + SHA-256, os IDs são completamente distintos
    assert.notEqual(idConta1, idConta2);
  });

  it('20. deve diferenciar chaves que antes colidiriam em normalizações ingênuas graças ao hash SHA-256 completo de 64 caracteres (pix:123/abc vs pix_123_abc)', () => {
    const keyA = 'pix:123/abc';
    const keyB = 'pix_123_abc';

    const idA = generateMovementDocId('acc_1', keyA);
    const idB = generateMovementDocId('acc_1', keyB);

    assert.notEqual(idA, idB);
    assert.ok(idA.startsWith('mov_'));
    assert.ok(idB.startsWith('mov_'));
    // Full 64-character SHA-256 hex digest suffix
    const hashSuffixA = idA.split('_').pop()!;
    const hashSuffixB = idB.split('_').pop()!;
    assert.equal(hashSuffixA.length, 64);
    assert.equal(hashSuffixB.length, 64);
    // Rejeita tentativa de passar params.id começando com rev_ sem coincidir com generateReversalDocId
    assert.throws(() => {
      buildFinancialMovement({
        id: 'rev_arbitrary_forged_id',
        accountId: 'acc_1',
        userId: USER_A,
        direction: 'inflow',
        amountCents: 1000,
        effectiveDate: '2026-11-10',
        originType: 'manual_adjustment',
        originId: 'orig_1',
        description: 'Bypass rev_ rejeitado',
        authorUid: USER_A,
        idempotencyKey: 'idem_test_1',
      });
    }, /não coincide com o ID determinístico/i);
  });

  it('21. deve auditar e detectar divergência intencional injetada no saldo projetado da conta', async () => {
    const acc = await createAccount(USER_A, { name: 'Conta Auditável com Divergência', type: 'checking' }, true);

    // Grava movimento legítimo de R$ 500,00
    await recordMovement(
      {
        accountId: acc.id,
        userId: USER_A,
        direction: 'inflow',
        amountCents: 50000,
        effectiveDate: '2026-11-10',
        originType: 'personal_income',
        originId: 'aud_1',
        description: 'Depósito Real',
        authorUid: USER_A,
      },
      true
    );

    // Auditoria sem divergência
    const auditClean = await auditAccountBalance(acc.id, USER_A, true);
    assert.equal(auditClean.hasDivergence, false);
    assert.equal(auditClean.differenceCents, 0);
    assert.equal(auditClean.projectedBalanceCents, 50000);
    assert.equal(auditClean.reconciledBalanceCents, 50000);

    // Injeta divergência artificial no cache da conta demo (ex: corrupção acidental para R$ 999,00)
    const accountsRaw = universalStorage.getItem('mpf_v3_demo_accounts');
    const accounts: Account[] = JSON.parse(accountsRaw || '[]');
    const idx = accounts.findIndex((a) => a.id === acc.id);
    accounts[idx].projectedBalanceCents = 99900;
    universalStorage.setItem('mpf_v3_demo_accounts', JSON.stringify(accounts));

    // Nova auditoria DEVE detectar a divergência
    const auditCorrupted = await auditAccountBalance(acc.id, USER_A, true);
    assert.equal(auditCorrupted.hasDivergence, true);
    assert.equal(auditCorrupted.projectedBalanceCents, 99900);
    assert.equal(auditCorrupted.reconciledBalanceCents, 50000);
    assert.equal(auditCorrupted.differenceCents, 50000 - 99900); // -49900 centavos

    // Ao executar a reconciliação e sincronização, a divergência deve ser sanada
    const syncRes = await reconcileAndSyncAccountBalance(acc.id, USER_A, true);
    assert.equal(syncRes.hasDivergence, true);
    assert.equal(syncRes.reconciledBalanceCents, 50000);

    // Pós-sincronização: saldo restabelecido com consistência contábil
    const auditFixed = await auditAccountBalance(acc.id, USER_A, true);
    assert.equal(auditFixed.hasDivergence, false);
    assert.equal(auditFixed.projectedBalanceCents, 50000);
  });

  it('22. deve executar fluxo autoritativo no TrustedFinancialLedgerBackend garantindo idempotência e reconciliação server-side', async () => {
    // Implementação de adaptador em memória para testes do backend autoritativo
    const inMemoryAccounts = new Map<string, Account>();
    const inMemoryMovements = new Map<string, FinancialMovement[]>();

    const mockDbAdapter: TrustedDbAdapter = {
      async getAccount(accountId: string) {
        return inMemoryAccounts.get(accountId) || null;
      },
      async getMovement(accountId: string, movementId: string) {
        const list = inMemoryMovements.get(accountId) || [];
        return list.find((m) => m.id === movementId) || null;
      },
      async getAllAccountMovements(accountId: string) {
        return inMemoryMovements.get(accountId) || [];
      },
      async runAcidTransaction<T>(updateFunction: any) {
        const tx = {
          getAccount: async (accountId: string) => inMemoryAccounts.get(accountId) || null,
          getMovement: async (accountId: string, movementId: string) => {
            const list = inMemoryMovements.get(accountId) || [];
            return list.find((m) => m.id === movementId) || null;
          },
          setMovement: (accountId: string, mov: FinancialMovement) => {
            const list = inMemoryMovements.get(accountId) || [];
            list.push(mov);
            inMemoryMovements.set(accountId, list);
          },
          updateAccountBalance: (accountId: string, newBalanceCents: CentsInteger) => {
            const acc = inMemoryAccounts.get(accountId);
            if (acc) {
              acc.projectedBalanceCents = newBalanceCents;
            }
          },
        };
        return await updateFunction(tx);
      },
    };

    // Cria conta no mock autoritativo
    inMemoryAccounts.set('acc_trusted_1', {
      id: 'acc_trusted_1',
      userId: USER_A,
      name: 'Conta Confiável Backend',
      type: 'checking',
      color: '#2563EB',
      icon: 'building',
      projectedBalanceCents: 0,
      isArchived: false,
      createdAt: '2026-11-10T10:00:00.000Z',
      updatedAt: '2026-11-10T10:00:00.000Z',
    });

    const trustedBackend = new TrustedFinancialLedgerBackend(mockDbAdapter);

    // 1. Grava movimento no backend
    const resp1 = await trustedBackend.recordMovement({
      accountId: 'acc_trusted_1',
      userId: USER_A,
      direction: 'inflow',
      amountCents: 80000, // R$ 800,00
      effectiveDate: '2026-11-10',
      originType: 'personal_income',
      originId: 'pix_servidor',
      description: 'Salário Server Authoritative',
      authorUid: USER_A,
      idempotencyKey: 'server_idem_salario_1',
    });

    assert.equal(resp1.isIdempotentReplay, false);
    assert.equal(resp1.newProjectedBalanceCents, 80000);

    // 2. Re-execução da mesma requisição no backend: replay puro e idempotente
    const resp2 = await trustedBackend.recordMovement({
      accountId: 'acc_trusted_1',
      userId: USER_A,
      direction: 'inflow',
      amountCents: 80000,
      effectiveDate: '2026-11-10',
      originType: 'personal_income',
      originId: 'pix_servidor',
      description: 'Salário Server Authoritative',
      authorUid: USER_A,
      idempotencyKey: 'server_idem_salario_1',
    });

    assert.equal(resp2.isIdempotentReplay, true);
    assert.equal(resp2.newProjectedBalanceCents, 80000);
    assert.equal(resp2.movement.id, resp1.movement.id);

    // 3. Estorno no backend
    const revResp = await trustedBackend.reverseMovement({
      accountId: 'acc_trusted_1',
      movementId: resp1.movement.id,
      authorUid: USER_A,
      reason: 'Estorno autorizado no servidor',
    });

    assert.equal(revResp.isIdempotentReplay, false);
    assert.equal(revResp.newProjectedBalanceCents, 0); // 80000 - 80000 = 0

    // 4. Reconciliação no backend
    const recResp = await trustedBackend.reconcileAccount({
      accountId: 'acc_trusted_1',
      authorUid: USER_A,
    });

    assert.equal(recResp.reconciledBalanceCents, 0);
    assert.equal(recResp.hasDivergence, false);
    assert.equal(recResp.movementsCount, 2); // 1 original + 1 compensatório
  });
});

