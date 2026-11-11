import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { universalStorage } from '../utils/universalStorage';
import { createAccount, getUserAccounts } from './accountService';
import { reconcileAccountBalance, formatCentsToBRL } from '../utils/movementLedger';
import { getAccountMovements } from './ledgerService';
import {
  createCategory,
  getUserCategories,
  archiveCategory,
  ensureDefaultCategories,
} from './categoryService';
import {
  createPersonalTransaction,
  recordPartialPayment,
  cancelPersonalTransaction,
  getUserPersonalTransactions,
  getPersonalTransactionPayments,
} from './personalTransactionService';
import {
  executeInternalTransfer,
  getUserTransfers,
} from './transferService';
import {
  calculateInvoiceMonth,
  getOrCreateCardInvoice,
  payCardInvoice,
  carryOverInvoiceBalance,
  calculateCardAvailableLimit,
  getCardInvoices,
} from './creditCardService';
import {
  createPersonalBudget,
  getUserBudgetsWithProgress,
  updatePersonalBudget,
} from './budgetService';
import {
  createPersonalRefund,
  recordRefundReceipt,
  getUserRefunds,
  getRefundReceipts,
} from './refundService';

describe('FASE 4 — Financeiro Individual (Arquitetura v3.1)', () => {
  const USER_ALICE = 'usr_alice_v3_phase4';
  const USER_BOB = 'usr_bob_v3_phase4';

  beforeEach(() => {
    universalStorage.clear();
  });

  // 1. Isolamento financeiro entre usuários
  it('1. deve garantir isolamento financeiro total entre usuários (Alice vs Bob)', async () => {
    // Alice cria categoria, conta e receita
    const catAlice = await createCategory(
      USER_ALICE,
      { name: 'Consultoria Alice', type: 'income' },
      true
    );
    const accAlice = await createAccount(
      USER_ALICE,
      { name: 'Banco Alice', type: 'checking' },
      true
    );
    await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Honorários Alice',
        amountCents: 500000,
        type: 'income',
        status: 'paid',
        categoryId: catAlice.id,
        categoryName: catAlice.name,
        accountId: accAlice.id,
        competenceDate: '2026-11-01',
      },
      true
    );

    // Bob consulta suas categorias, contas e transações
    const catsBob = await getUserCategories(USER_BOB, true, true);
    const accsBob = await getUserAccounts(USER_BOB, true, true);
    const txsBob = await getUserPersonalTransactions(USER_BOB, {}, true);

    assert.equal(catsBob.length, 0);
    assert.equal(accsBob.length, 0);
    assert.equal(txsBob.length, 0);
  });

  // 2. Receitas: Prevista não altera saldo; Recebida altera saldo oficial
  it('2. deve registrar receita prevista sem alterar saldo, e receita recebida gerando entrada no livro', async () => {
    const acc = await createAccount(USER_ALICE, { name: 'Itaú Alice', type: 'checking' }, true);
    const cat = await createCategory(USER_ALICE, { name: 'Salário', type: 'income' }, true);

    // 1. Receita Prevista (forecast)
    const txForecast = await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Bônus Previsto de Final de Ano',
        amountCents: 150000, // R$ 1.500,00
        type: 'income',
        status: 'forecast',
        categoryId: cat.id,
        categoryName: cat.name,
        accountId: acc.id,
        competenceDate: '2026-12-20',
      },
      true
    );

    assert.equal(txForecast.status, 'forecast');
    assert.equal(txForecast.financialMovementId, undefined);

    // Saldo da conta deve permanecer zero
    let accounts = await getUserAccounts(USER_ALICE, false, true);
    assert.equal(accounts[0].projectedBalanceCents, 0);

    // 2. Receita Efetivada (paid)
    const txPaid = await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Salário Novembro',
        amountCents: 450000, // R$ 4.500,00
        type: 'income',
        status: 'paid',
        categoryId: cat.id,
        categoryName: cat.name,
        accountId: acc.id,
        competenceDate: '2026-11-05',
      },
      true
    );

    assert.equal(txPaid.status, 'paid');
    assert.ok(txPaid.financialMovementId);

    // Saldo agora deve refletir exatamente R$ 4.500,00
    accounts = await getUserAccounts(USER_ALICE, false, true);
    assert.equal(accounts[0].projectedBalanceCents, 450000);

    const movs = await getAccountMovements(acc.id, USER_ALICE, true);
    assert.equal(movs.length, 1);
    assert.equal(movs[0].direction, 'inflow');
    assert.equal(movs[0].amountCents, 450000);
  });

  // 3. Recebimentos parciais com histórico
  it('3. deve suportar recebimento parcial de receita com histórico de amortizações', async () => {
    const acc = await createAccount(USER_ALICE, { name: 'Conta Depósito', type: 'checking' }, true);
    const cat = await createCategory(USER_ALICE, { name: 'Venda de Bens', type: 'income' }, true);

    // Receita de R$ 1.000,00 pendente
    const tx = await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Venda de Computador Usado',
        amountCents: 100000,
        type: 'income',
        status: 'pending',
        categoryId: cat.id,
        categoryName: cat.name,
        accountId: acc.id,
        competenceDate: '2026-11-10',
      },
      true
    );

    // Primeiro recebimento parcial: R$ 400,00
    const part1 = await recordPartialPayment(
      tx.id,
      USER_ALICE,
      {
        amountCents: 40000,
        paymentDate: '2026-11-10',
        accountId: acc.id,
        authorUid: USER_ALICE,
        notes: 'Entrada via PIX',
      },
      true
    );

    assert.equal(part1.transaction.status, 'partially_paid');
    assert.equal(part1.transaction.paidAmountCents, 40000);
    assert.equal(part1.transaction.remainingAmountCents, 60000);

    // Segundo recebimento: restante de R$ 600,00
    const part2 = await recordPartialPayment(
      tx.id,
      USER_ALICE,
      {
        amountCents: 60000,
        paymentDate: '2026-11-12',
        accountId: acc.id,
        authorUid: USER_ALICE,
        notes: 'Segunda parcela final',
      },
      true
    );

    assert.equal(part2.transaction.status, 'paid');
    assert.equal(part2.transaction.paidAmountCents, 100000);
    assert.equal(part2.transaction.remainingAmountCents, 0);

    // Saldo deve ser R$ 1.000,00
    const accounts = await getUserAccounts(USER_ALICE, false, true);
    assert.equal(accounts[0].projectedBalanceCents, 100000);

    // Histórico de pagamentos parciais
    const payments = await getPersonalTransactionPayments(tx.id, USER_ALICE, true);
    assert.equal(payments.length, 2);
  });

  // 4. Despesas: Pendente não altera saldo; Paga gera saída no livro
  it('4. deve registrar despesa pendente sem afetar saldo e despesa paga debitando no livro', async () => {
    const acc = await createAccount(USER_ALICE, { name: 'Conta Corrente', type: 'checking' }, true);
    const cat = await createCategory(USER_ALICE, { name: 'Aluguel', type: 'expense' }, true);

    // Despesa pendente de R$ 1.200,00
    const expPending = await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Aluguel do Mês',
        amountCents: 120000,
        type: 'expense',
        status: 'pending',
        categoryId: cat.id,
        categoryName: cat.name,
        accountId: acc.id,
        competenceDate: '2026-11-01',
        dueDate: '2026-11-20',
      },
      true
    );

    assert.equal(expPending.status, 'pending');
    let accounts = await getUserAccounts(USER_ALICE, false, true);
    assert.equal(accounts[0].projectedBalanceCents, 0);

    // Despesa paga de R$ 85,00
    const expPaid = await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Conta de Energia',
        amountCents: 8500,
        type: 'expense',
        status: 'paid',
        categoryId: cat.id,
        categoryName: cat.name,
        accountId: acc.id,
        competenceDate: '2026-11-03',
      },
      true
    );

    assert.equal(expPaid.status, 'paid');
    accounts = await getUserAccounts(USER_ALICE, false, true);
    assert.equal(accounts[0].projectedBalanceCents, -8500); // Saldo debitado em centavos
  });

  // 5. Pagamentos parciais de despesas e prevenção de excedente
  it('5. deve controlar pagamentos parciais de despesa e impedir excedente sem autorização', async () => {
    const acc = await createAccount(USER_ALICE, { name: 'Carteira Dinheiro', type: 'wallet' }, true);
    const cat = await createCategory(USER_ALICE, { name: 'Serviços', type: 'expense' }, true);

    const exp = await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Reforma do Banheiro',
        amountCents: 50000, // R$ 500,00
        type: 'expense',
        status: 'pending',
        categoryId: cat.id,
        categoryName: cat.name,
        accountId: acc.id,
        competenceDate: '2026-11-10',
      },
      true
    );

    // Pagamento 1: R$ 200,00
    await recordPartialPayment(
      exp.id,
      USER_ALICE,
      {
        amountCents: 20000,
        paymentDate: '2026-11-10',
        accountId: acc.id,
        authorUid: USER_ALICE,
      },
      true
    );

    // Pagamento 2: R$ 150,00
    const res2 = await recordPartialPayment(
      exp.id,
      USER_ALICE,
      {
        amountCents: 15000,
        paymentDate: '2026-11-11',
        accountId: acc.id,
        authorUid: USER_ALICE,
      },
      true
    );

    // Saldo restante deve ser R$ 150,00 (15000 centavos)
    assert.equal(res2.transaction.remainingAmountCents, 15000);
    assert.equal(res2.transaction.paidAmountCents, 35000);

    // Tentativa de pagar R$ 200,00 (excedente em relação aos R$ 150,00 restantes) DEVE ser rejeitada
    await assert.rejects(
      async () => {
        await recordPartialPayment(
          exp.id,
          USER_ALICE,
          {
            amountCents: 20000,
            paymentDate: '2026-11-12',
            accountId: acc.id,
            authorUid: USER_ALICE,
          },
          true
        );
      },
      {
        message: /ultrapassa o saldo devedor restante/i,
      }
    );
  });

  // 6. Cancelamento de transações preserva histórico
  it('6. deve cancelar despesa sem apagar histórico contábil e estornando movimentos já pagos', async () => {
    const acc = await createAccount(USER_ALICE, { name: 'Conta Teste Cancelamento', type: 'checking' }, true);
    const cat = await createCategory(USER_ALICE, { name: 'Diversos', type: 'expense' }, true);

    const tx = await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Compra com devolução',
        amountCents: 12000, // R$ 120,00
        type: 'expense',
        status: 'paid',
        categoryId: cat.id,
        categoryName: cat.name,
        accountId: acc.id,
        competenceDate: '2026-11-05',
      },
      true
    );

    let accounts = await getUserAccounts(USER_ALICE, false, true);
    assert.equal(accounts[0].projectedBalanceCents, -12000);

    // Cancelamento
    const cancelled = await cancelPersonalTransaction(tx.id, USER_ALICE, 'Produto com defeito devolvido', true);
    assert.equal(cancelled.status, 'cancelled');

    // Saldo deve ser restabelecido a zero via estorno compensatório
    accounts = await getUserAccounts(USER_ALICE, false, true);
    assert.equal(accounts[0].projectedBalanceCents, 0);

    // O livro-razão deve conter o movimento original + o estorno compensatório
    const movs = await getAccountMovements(acc.id, USER_ALICE, true);
    assert.equal(movs.length, 2);
    assert.equal(reconcileAccountBalance(movs), 0);
  });

  // 7. Transferências entre contas próprias
  it('7. deve executar transferência entre contas próprias gerando 2 movimentos vinculados sem alterar o saldo consolidado', async () => {
    // Cria Conta Corrente A com R$ 1.000,00
    const accA = await createAccount(USER_ALICE, { name: 'Banco A', type: 'checking' }, true);
    // Cria Carteira B com R$ 0,00
    const accB = await createAccount(USER_ALICE, { name: 'Carteira B', type: 'wallet' }, true);
    const cat = await createCategory(USER_ALICE, { name: 'Salário', type: 'income' }, true);

    // Aporte inicial de R$ 1.000,00 na Conta A
    await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Depósito Inicial',
        amountCents: 100000,
        type: 'income',
        status: 'paid',
        categoryId: cat.id,
        categoryName: cat.name,
        accountId: accA.id,
        competenceDate: '2026-11-01',
      },
      true
    );

    // Executa transferência de R$ 350,00 da Conta A para a Carteira B
    const xfer = await executeInternalTransfer(
      USER_ALICE,
      {
        sourceAccountId: accA.id,
        destinationAccountId: accB.id,
        amountCents: 35000,
        transferDate: '2026-11-05',
        description: 'Saque para despesas do dia a dia',
      },
      true
    );

    assert.equal(xfer.transfer.amountCents, 35000);
    assert.equal(xfer.sourceMovement.direction, 'outflow');
    assert.equal(xfer.destinationMovement.direction, 'inflow');

    // Verifica saldos individuais
    const accounts = await getUserAccounts(USER_ALICE, false, true);
    const updatedA = accounts.find((a) => a.id === accA.id);
    const updatedB = accounts.find((a) => a.id === accB.id);

    assert.equal(updatedA?.projectedBalanceCents, 65000); // 1000 - 350 = 650
    assert.equal(updatedB?.projectedBalanceCents, 35000); // 0 + 350 = 350

    // Saldo Consolidado Total deve permanecer exatamente R$ 1.000,00
    const totalBalance = accounts.reduce((acc, curr) => acc + curr.projectedBalanceCents, 0);
    assert.equal(totalBalance, 100000);
  });

  // 8. Prevenção de transferências entre usuários diferentes
  it('8. deve proibir transferências entre contas pertencentes a usuários distintos', async () => {
    const accAlice = await createAccount(USER_ALICE, { name: 'Conta Alice', type: 'checking' }, true);
    const accBob = await createAccount(USER_BOB, { name: 'Conta Bob', type: 'checking' }, true);

    await assert.rejects(
      async () => {
        await executeInternalTransfer(
          USER_ALICE,
          {
            sourceAccountId: accAlice.id,
            destinationAccountId: accBob.id,
            amountCents: 10000,
            transferDate: '2026-11-05',
          },
          true
        );
      },
      {
        message: /contas do mesmo usuário/i,
      }
    );
  });

  // 9. Compras no cartão de crédito alocadas na fatura sem débito bancário imediato
  it('9. deve alocar compras no cartão de crédito na fatura correta sem debitar saldo bancário', async () => {
    const card = await createAccount(
      USER_ALICE,
      {
        name: 'Nubank Ultravioleta',
        type: 'credit',
        creditLimitCents: 1000000, // Limite R$ 10.000,00
        closingDay: 20,
        dueDay: 28,
      },
      true
    );
    const cat = await createCategory(USER_ALICE, { name: 'Mercado', type: 'expense' }, true);

    // Compra no dia 15 (antes do fechamento no dia 20) -> Fatura 2026-11
    const tx1 = await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Supermercado 1',
        amountCents: 35000, // R$ 350,00
        type: 'expense',
        status: 'paid',
        categoryId: cat.id,
        categoryName: cat.name,
        accountId: card.id,
        competenceDate: '2026-11-15',
      },
      true
    );

    assert.equal(tx1.invoiceMonth, '2026-11');

    // Compra no dia 22 (após fechamento no dia 20) -> Fatura 2026-12
    const tx2 = await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Supermercado 2',
        amountCents: 20000, // R$ 200,00
        type: 'expense',
        status: 'paid',
        categoryId: cat.id,
        categoryName: cat.name,
        accountId: card.id,
        competenceDate: '2026-11-22',
      },
      true
    );

    assert.equal(tx2.invoiceMonth, '2026-12');

    // Nenhuma movimentação bancária deve ter sido gerada nas contas correntes
    const movsCard = await getAccountMovements(card.id, USER_ALICE, true);
    assert.equal(movsCard.length, 0);

    // Verifica limite disponível calculado
    const limits = await calculateCardAvailableLimit(card, USER_ALICE, true);
    // Limite disponível: 10.000,00 - (350 + 200) = R$ 9.450,00 (945000 centavos)
    assert.equal(limits.usedAmountCents, 55000);
    assert.equal(limits.availableLimitCents, 945000);
  });

  // 10. Pagamento de fatura de cartão e prevenção de dupla despesa
  it('10. deve amortizar fatura de cartão via débito em conta corrente sem duplicar a despesa das compras', async () => {
    // 1. Cria conta corrente com saldo de R$ 2.000,00
    const checking = await createAccount(USER_ALICE, { name: 'Bradesco Corrente', type: 'checking' }, true);
    const card = await createAccount(
      USER_ALICE,
      {
        name: 'Cartão Visa',
        type: 'credit',
        creditLimitCents: 500000,
        closingDay: 15,
        dueDay: 25,
      },
      true
    );
    const catIncome = await createCategory(USER_ALICE, { name: 'Salário', type: 'income' }, true);
    const catShop = await createCategory(USER_ALICE, { name: 'Shopping', type: 'expense' }, true);

    // Saldo inicial no banco: R$ 2.000,00
    await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Aporte Inicial',
        amountCents: 200000,
        type: 'income',
        status: 'paid',
        categoryId: catIncome.id,
        categoryName: catIncome.name,
        accountId: checking.id,
        competenceDate: '2026-11-01',
      },
      true
    );

    // Compra no cartão de R$ 600,00
    await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Tênis Esportivo',
        amountCents: 60000,
        type: 'expense',
        status: 'paid',
        categoryId: catShop.id,
        categoryName: catShop.name,
        accountId: card.id,
        competenceDate: '2026-11-05',
      },
      true
    );

    // Fatura deve totalizar R$ 600,00
    const invoices = await getCardInvoices(card.id, USER_ALICE, true);
    assert.equal(invoices[0].totalDueAmountCents, 60000);
    assert.equal(invoices[0].remainingBalanceCents, 60000);

    // Paga R$ 400,00 da fatura (pagamento parcial) usando a conta Bradesco
    const payResult = await payCardInvoice(
      {
        cardAccountId: card.id,
        invoiceMonth: '2026-11',
        sourceAccountId: checking.id,
        amountPaidCents: 40000,
        paymentDate: '2026-11-25',
        userId: USER_ALICE,
      },
      true
    );

    assert.equal(payResult.invoice.invoiceStatus, 'partially_paid');
    assert.equal(payResult.invoice.totalPaidAmountCents, 40000);
    assert.equal(payResult.invoice.remainingBalanceCents, 20000);

    // A conta corrente foi debitada em R$ 400,00: Saldo = 2000 - 400 = 160000 centavos
    const accounts = await getUserAccounts(USER_ALICE, false, true);
    const updatedChecking = accounts.find((a) => a.id === checking.id);
    assert.equal(updatedChecking?.projectedBalanceCents, 160000);

    // O movimento contábil gerado é credit_card_payment (não uma nova despesa!)
    assert.equal(payResult.movement.originType, 'credit_card_payment');
  });

  // 11. Transporte de saldo restante (carry over / rotativo) para o próximo mês
  it('11. deve transportar saldo residual de fatura com juros e encargos segregados para a próxima competência', async () => {
    const card = await createAccount(
      USER_ALICE,
      {
        name: 'Cartão Master',
        type: 'credit',
        closingDay: 15,
        dueDay: 25,
      },
      true
    );
    const cat = await createCategory(USER_ALICE, { name: 'Eletrônicos', type: 'expense' }, true);

    // Compra de R$ 1.000,00 na fatura 2026-11
    await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Monitor',
        amountCents: 100000,
        type: 'expense',
        status: 'paid',
        categoryId: cat.id,
        categoryName: cat.name,
        accountId: card.id,
        competenceDate: '2026-11-05',
      },
      true
    );

    // Cria conta corrente e paga apenas R$ 300,00 da fatura
    const checking = await createAccount(USER_ALICE, { name: 'Conta Pagadora', type: 'checking' }, true);
    await payCardInvoice(
      {
        cardAccountId: card.id,
        invoiceMonth: '2026-11',
        sourceAccountId: checking.id,
        amountPaidCents: 30000,
        paymentDate: '2026-11-25',
        userId: USER_ALICE,
      },
      true
    );

    // Saldo não pago na fatura 2026-11 = R$ 700,00 (70000 centavos)
    // Executa transporte (carry-over) com taxa de 10% (0.10)
    const carryResult = await carryOverInvoiceBalance(
      {
        cardAccount: card,
        sourceInvoiceMonth: '2026-11',
        targetInvoiceMonth: '2026-12',
        interestRateMonthly: 0.10,
        userId: USER_ALICE,
      },
      true
    );

    // Principal não pago: 70000; Juros aplicados: 7000 centavos
    assert.equal(carryResult.carryOver.unpaidPrincipalCents, 70000);
    assert.equal(carryResult.carryOver.appliedInterestCents, 7000);

    // Fatura de Dezembro (2026-12) deve refletir:
    // carriedOverBalanceCents = 70000
    // interestAndFeesCents = 7000
    // totalDueAmountCents = 77000
    assert.equal(carryResult.targetInvoice.carriedOverBalanceCents, 70000);
    assert.equal(carryResult.targetInvoice.interestAndFeesCents, 7000);
    assert.equal(carryResult.targetInvoice.totalDueAmountCents, 77000);
    assert.equal(carryResult.targetInvoice.remainingBalanceCents, 77000);
  });

  // 12. Categorias arquivadas não permitidas em novos lançamentos mas preservadas
  it('12. deve permitir arquivar categorias sem romper registros históricos existentes', async () => {
    const cat = await createCategory(USER_ALICE, { name: 'Streaming Antigo', type: 'expense' }, true);
    const acc = await createAccount(USER_ALICE, { name: 'Conta Débito', type: 'checking' }, true);

    // Cria transação com a categoria ativa
    const tx = await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Mensalidade Outubro',
        amountCents: 4500,
        type: 'expense',
        status: 'paid',
        categoryId: cat.id,
        categoryName: cat.name,
        accountId: acc.id,
        competenceDate: '2026-10-10',
      },
      true
    );

    assert.equal(tx.categoryId, cat.id);

    // Arquiva a categoria
    await archiveCategory(cat.id, USER_ALICE, true, true);

    // Consulta padrão de categorias ativas não deve incluir a arquivada
    const activeCats = await getUserCategories(USER_ALICE, false, true);
    assert.ok(!activeCats.some((c) => c.id === cat.id));

    // A transação histórica permanece íntegra referenciando a categoria
    const txs = await getUserPersonalTransactions(USER_ALICE, {}, true);
    assert.equal(txs[0].categoryId, cat.id);
  });

  // 13. Orçamentos individuais e derivação exata de consumo
  it('13. deve calcular o consumo de orçamento a partir das despesas reconhecidas do período', async () => {
    const catFood = await createCategory(USER_ALICE, { name: 'Alimentação', type: 'expense' }, true);
    const acc = await createAccount(USER_ALICE, { name: 'Conta Principal', type: 'checking' }, true);

    // Cria orçamento de R$ 1.000,00 para Alimentação em 2026-11
    const budget = await createPersonalBudget(
      USER_ALICE,
      {
        name: 'Orçamento Alimentação Nov/26',
        categoryIds: [catFood.id],
        competenceMonth: '2026-11',
        plannedAmountCents: 100000,
      },
      true
    );

    // 1. Despesa Paga: R$ 500,00
    await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Feira Semanal',
        amountCents: 50000,
        type: 'expense',
        status: 'paid',
        categoryId: catFood.id,
        categoryName: catFood.name,
        accountId: acc.id,
        competenceDate: '2026-11-04',
      },
      true
    );

    // 2. Despesa Parcialmente Paga: R$ 400,00 (amortizado R$ 350,00)
    const txPart = await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Restaurante Fim de Semana',
        amountCents: 40000,
        type: 'expense',
        status: 'pending',
        categoryId: catFood.id,
        categoryName: catFood.name,
        accountId: acc.id,
        competenceDate: '2026-11-08',
      },
      true
    );
    await recordPartialPayment(
      txPart.id,
      USER_ALICE,
      {
        amountCents: 35000,
        paymentDate: '2026-11-08',
        accountId: acc.id,
        authorUid: USER_ALICE,
      },
      true
    );

    // 3. Despesa Cancelada: R$ 200,00 (NÃO deve ser somada ao consumo)
    const txCancel = await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Pedido Cancelado',
        amountCents: 20000,
        type: 'expense',
        status: 'pending',
        categoryId: catFood.id,
        categoryName: catFood.name,
        accountId: acc.id,
        competenceDate: '2026-11-10',
      },
      true
    );
    await cancelPersonalTransaction(txCancel.id, USER_ALICE, 'Erro no pedido', true);

    // Consulta progresso do orçamento
    const progresses = await getUserBudgetsWithProgress(USER_ALICE, '2026-11', true);
    assert.equal(progresses.length, 1);

    // Consumo = 50000 (despesa 1) + 35000 (despesa 2 parcial) = 85000 centavos (R$ 850,00)
    assert.equal(progresses[0].spentAmountCents, 85000);
    assert.equal(progresses[0].remainingAmountCents, 15000);
    assert.equal(progresses[0].percentageUsed, 85);
    assert.equal(progresses[0].status, 'warning'); // >= 80%
  });

  // 14. Reembolsos individuais vinculados a despesas
  it('14. deve registrar reembolso vinculado a despesa pessoal e gerar entrada no livro quando recebido', async () => {
    const acc = await createAccount(USER_ALICE, { name: 'Conta Corrente', type: 'checking' }, true);
    const cat = await createCategory(USER_ALICE, { name: 'Restaurante', type: 'expense' }, true);

    // Alice paga jantar de R$ 300,00
    const dinnerTx = await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Jantar com Amigo',
        amountCents: 30000,
        type: 'expense',
        status: 'paid',
        categoryId: cat.id,
        categoryName: cat.name,
        accountId: acc.id,
        competenceDate: '2026-11-08',
      },
      true
    );

    // Saldo atual de Alice: -R$ 300,00 (-30000 centavos)
    let accounts = await getUserAccounts(USER_ALICE, false, true);
    assert.equal(accounts[0].projectedBalanceCents, -30000);

    // Amigo deve reembolsar R$ 100,00
    const refund = await createPersonalRefund(
      USER_ALICE,
      {
        originalTransactionId: dinnerTx.id,
        debtorName: 'Carlos Amigo',
        amountDueCents: 10000,
        description: 'Parte do Carlos no jantar',
      },
      true
    );

    assert.equal(refund.status, 'pending');
    assert.equal(refund.remainingAmountCents, 10000);

    // Carlos faz PIX de R$ 100,00 para Alice
    const receiptResult = await recordRefundReceipt(
      USER_ALICE,
      {
        refundId: refund.id,
        amountCents: 10000,
        receiptDate: '2026-11-09',
        destinationAccountId: acc.id,
        authorUid: USER_ALICE,
      },
      true
    );

    assert.equal(receiptResult.refund.status, 'received');
    assert.equal(receiptResult.refund.remainingAmountCents, 0);
    assert.equal(receiptResult.movement.direction, 'inflow');

    // O saldo de Alice foi recomposto: -300 + 100 = -R$ 200,00 (-20000 centavos)
    accounts = await getUserAccounts(USER_ALICE, false, true);
    assert.equal(accounts[0].projectedBalanceCents, -20000);

    // Recibo auditável gravado
    const receipts = await getRefundReceipts(refund.id, USER_ALICE, true);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].amountCents, 10000);
  });

  // 15. Prevenção de transferências duplicadas (Idempotência)
  it('15. deve prevenir transferências duplicadas através de chave determinística de idempotência', async () => {
    const accA = await createAccount(USER_ALICE, { name: 'Conta Origem Idem', type: 'checking' }, true);
    const accB = await createAccount(USER_ALICE, { name: 'Conta Destino Idem', type: 'wallet' }, true);

    const transferPayload = {
      sourceAccountId: accA.id,
      destinationAccountId: accB.id,
      amountCents: 25000,
      transferDate: '2026-11-10',
      description: 'Transferência Idempotente',
      idempotencyKey: 'idem_xfer_unica_123',
    };

    // Primeira execução
    const firstCall = await executeInternalTransfer(USER_ALICE, transferPayload, true);
    assert.equal(firstCall.isIdempotentReplay, false);

    // Segunda execução da MESMA transferência (retry de rede)
    const secondCall = await executeInternalTransfer(USER_ALICE, transferPayload, true);
    assert.equal(secondCall.isIdempotentReplay, true);
    assert.equal(secondCall.transfer.id, firstCall.transfer.id);

    // Saldo das contas deve ter sofrido apenas 1 débito e 1 crédito
    const accounts = await getUserAccounts(USER_ALICE, false, true);
    const updatedA = accounts.find((a) => a.id === accA.id);
    const updatedB = accounts.find((a) => a.id === accB.id);

    assert.equal(updatedA?.projectedBalanceCents, -25000);
    assert.equal(updatedB?.projectedBalanceCents, 25000);

    const transfers = await getUserTransfers(USER_ALICE, true);
    assert.equal(transfers.length, 1);
  });

  // 16. Múltiplos pagamentos parciais de fatura até liquidação completa
  it('16. deve permitir múltiplos pagamentos parciais de fatura até a quitação integral', async () => {
    const checking = await createAccount(USER_ALICE, { name: 'Banco Pagador', type: 'checking' }, true);
    const card = await createAccount(
      USER_ALICE,
      {
        name: 'Cartão Elo',
        type: 'credit',
        closingDay: 15,
        dueDay: 25,
      },
      true
    );
    const cat = await createCategory(USER_ALICE, { name: 'Viagem', type: 'expense' }, true);

    // Compra no cartão de R$ 900,00
    await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Passagem Aérea',
        amountCents: 90000,
        type: 'expense',
        status: 'paid',
        categoryId: cat.id,
        categoryName: cat.name,
        accountId: card.id,
        competenceDate: '2026-11-05',
      },
      true
    );

    // 1º Pagamento parcial: R$ 300,00
    const pay1 = await payCardInvoice(
      {
        cardAccountId: card.id,
        invoiceMonth: '2026-11',
        sourceAccountId: checking.id,
        amountPaidCents: 30000,
        paymentDate: '2026-11-20',
        userId: USER_ALICE,
      },
      true
    );
    assert.equal(pay1.invoice.invoiceStatus, 'partially_paid');
    assert.equal(pay1.invoice.remainingBalanceCents, 60000);

    // 2º Pagamento parcial: R$ 400,00
    const pay2 = await payCardInvoice(
      {
        cardAccountId: card.id,
        invoiceMonth: '2026-11',
        sourceAccountId: checking.id,
        amountPaidCents: 40000,
        paymentDate: '2026-11-22',
        userId: USER_ALICE,
      },
      true
    );
    assert.equal(pay2.invoice.invoiceStatus, 'partially_paid');
    assert.equal(pay2.invoice.remainingBalanceCents, 20000);

    // 3º Pagamento final: R$ 200,00
    const pay3 = await payCardInvoice(
      {
        cardAccountId: card.id,
        invoiceMonth: '2026-11',
        sourceAccountId: checking.id,
        amountPaidCents: 20000,
        paymentDate: '2026-11-24',
        userId: USER_ALICE,
      },
      true
    );
    assert.equal(pay3.invoice.invoiceStatus, 'paid');
    assert.equal(pay3.invoice.remainingBalanceCents, 0);
    assert.equal(pay3.invoice.totalPaidAmountCents, 90000);
  });

  // 17. Reconciliação dos saldos a partir do histórico completo de movimentos
  it('17. deve reconciliar e atestar a consistência contábil de todos os saldos derivados do livro', async () => {
    const acc = await createAccount(USER_ALICE, { name: 'Conta Reconciliação', type: 'checking' }, true);
    const catInc = await createCategory(USER_ALICE, { name: 'Salário', type: 'income' }, true);
    const catExp = await createCategory(USER_ALICE, { name: 'Contas', type: 'expense' }, true);

    // Entrada de R$ 5.000,00
    await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Salário Integral',
        amountCents: 500000,
        type: 'income',
        status: 'paid',
        categoryId: catInc.id,
        categoryName: catInc.name,
        accountId: acc.id,
        competenceDate: '2026-11-01',
      },
      true
    );

    // Saída de R$ 1.250,50
    await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Pagamento de Contas',
        amountCents: 125050,
        type: 'expense',
        status: 'paid',
        categoryId: catExp.id,
        categoryName: catExp.name,
        accountId: acc.id,
        competenceDate: '2026-11-05',
      },
      true
    );

    // Consulta histórico de movimentos
    const movements = await getAccountMovements(acc.id, USER_ALICE, true);
    assert.equal(movements.length, 2);

    // Reconciliação canônica matemática
    const officialBalance = reconcileAccountBalance(movements);
    // 500000 - 125050 = 374950 centavos (R$ 3.749,50)
    assert.equal(officialBalance, 374950);
    assert.equal(formatCentsToBRL(officialBalance), 'R$ 3.749,50');
  });

  // 18. Inicialização de categorias sugeridas padrão
  it('18. deve provisionar categorias sugeridas padrão para novos usuários', async () => {
    const defaultCats = await ensureDefaultCategories(USER_BOB, true);
    assert.ok(defaultCats.length >= 10);
    assert.ok(defaultCats.some((c) => c.name.includes('Alimentação')));
    assert.ok(defaultCats.some((c) => c.name.includes('Salário')));

    // Segunda chamada não duplica
    const sameCats = await ensureDefaultCategories(USER_BOB, true);
    assert.equal(sameCats.length, defaultCats.length);
  });
});
