import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { universalStorage } from '../utils/universalStorage';
import { createAccount, getUserAccounts } from './accountService';
import { reconcileAccountBalance, formatCentsToBRL } from '../utils/movementLedger';
import { getAccountMovements, reverseMovement } from './ledgerService';
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
  getPersonalTransactionPaymentReversals,
  calculateActivePaidAmountCents,
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

  // 11. Transporte de saldo restante (carry over / rotativo) para o próximo mês sem dupla contagem no limite
  it('11. deve transportar saldo residual de fatura com juros e encargos segregados sem duplicar o principal no limite disponível', async () => {
    const card = await createAccount(
      USER_ALICE,
      {
        name: 'Cartão Master',
        type: 'credit',
        creditLimitCents: 200000, // R$ 2.000,00
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

    // Fatura de origem (2026-11) teve seu saldo aberto zerado e marcado como 'carried_over'
    assert.equal(carryResult.sourceInvoice.remainingBalanceCents, 0);
    assert.equal(carryResult.sourceInvoice.invoiceStatus, 'carried_over');
    assert.equal(carryResult.sourceInvoice.carriedOverToMonth, '2026-12');
    assert.equal(carryResult.sourceInvoice.totalPaidAmountCents, 30000, 'Pagamento parcial real é preservado');

    // Fatura de Dezembro (2026-12) deve refletir:
    // carriedOverBalanceCents = 70000
    // interestAndFeesCents = 7000
    // totalDueAmountCents = 77000
    assert.equal(carryResult.targetInvoice.carriedOverBalanceCents, 70000);
    assert.equal(carryResult.targetInvoice.interestAndFeesCents, 7000);
    assert.equal(carryResult.targetInvoice.totalDueAmountCents, 77000);
    assert.equal(carryResult.targetInvoice.remainingBalanceCents, 77000);

    // Limite comprometido do cartão deve ser 77000 (NÃO 70000 + 77000 = 147000!)
    const limitCheck = await calculateCardAvailableLimit(card, USER_ALICE, true);
    assert.equal(limitCheck.usedAmountCents, 77000);
    assert.equal(limitCheck.availableLimitCents, 200000 - 77000);

    // Repetição idempotente da mesma operação de carry-over:
    const carryReplay = await carryOverInvoiceBalance(
      {
        cardAccount: card,
        sourceInvoiceMonth: '2026-11',
        targetInvoiceMonth: '2026-12',
        interestRateMonthly: 0.10,
        userId: USER_ALICE,
      },
      true
    );
    assert.equal(carryReplay.carryOver.id, carryResult.carryOver.id);
    assert.equal(carryReplay.targetInvoice.carriedOverBalanceCents, 70000);
    assert.equal(carryReplay.targetInvoice.interestAndFeesCents, 7000);
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

  // 13. Orçamentos individuais e derivação dos 3 indicadores (Realizado, Comprometido, Previsto)
  it('13. deve calcular os 3 indicadores do orçamento (Realizado, Comprometido, Previsto) sem dupla contagem ou distorção por canceladas', async () => {
    const catFood = await createCategory(USER_ALICE, { name: 'Alimentação', type: 'expense' }, true);
    const acc = await createAccount(USER_ALICE, { name: 'Conta Principal', type: 'checking' }, true);

    // Cria orçamento de R$ 1.000,00 para Alimentação em 2026-11
    await createPersonalBudget(
      USER_ALICE,
      {
        name: 'Orçamento Alimentação Nov/26',
        categoryIds: [catFood.id],
        competenceMonth: '2026-11',
        plannedAmountCents: 100000,
      },
      true
    );

    // 1. Despesa Paga: R$ 500,00 (Realizado += 50000)
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

    // 2. Despesa Parcialmente Paga: R$ 400,00 (amortizado R$ 350,00 -> Realizado += 35000, Comprometido += 5000)
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

    // 3. Despesa Prevista: R$ 100,00 (Previsto/forecastOnly += 10000)
    await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Jantar Previsto Fim do Mês',
        amountCents: 10000,
        type: 'expense',
        status: 'forecast',
        categoryId: catFood.id,
        categoryName: catFood.name,
        competenceDate: '2026-11-28',
      },
      true
    );

    // 4. Despesa Cancelada: R$ 200,00 (NÃO deve ser somada a nenhum indicador)
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

    // Realizado = 50000 + 35000 = 85000
    // Comprometido = 5000 (restante da parcialmente paga)
    // ForecastOnly = 10000
    // ForecastedTotal = 85000 + 5000 + 10000 = 100000
    assert.equal(progresses[0].spentAmountCents, 85000);
    assert.equal(progresses[0].realizedAmountCents, 85000);
    assert.equal(progresses[0].committedAmountCents, 5000);
    assert.equal(progresses[0].forecastOnlyAmountCents, 10000);
    assert.equal(progresses[0].forecastedAmountCents, 100000);
    assert.equal(progresses[0].remainingAmountCents, 15000);
    assert.equal(progresses[0].projectedRemainingAmountCents, 0);
    assert.equal(progresses[0].percentageUsed, 85);
    assert.equal(progresses[0].percentageCommitted, 90);
    assert.equal(progresses[0].percentageForecasted, 100);
    assert.equal(progresses[0].status, 'warning'); // >= 80%
  });

  // 14. Reembolsos individuais vinculados a despesas com originType 'personal_refund'
  it('14. deve registrar reembolso vinculado a despesa pessoal e gerar entrada no livro com originType personal_refund quando recebido', async () => {
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
    assert.equal(receiptResult.movement.originType, 'personal_refund');
    assert.equal(receiptResult.receipt.originType, 'personal_refund');
    assert.equal(receiptResult.receipt.originalTransactionId, dinnerTx.id);

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

  // 19. Cancelamento de despesa com múltiplos pagamentos parciais estorna todos os movimentos parciais
  it('19. deve estornar todas as movimentações de pagamentos parciais ao cancelar uma transação parcialmente ou totalmente liquidada por parcelas', async () => {
    const acc = await createAccount(USER_ALICE, { name: 'Conta Parcelas Cancelamento', type: 'checking' }, true);
    const cat = await createCategory(USER_ALICE, { name: 'Curso', type: 'expense' }, true);

    const tx = await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Curso Especialização',
        amountCents: 60000,
        type: 'expense',
        status: 'pending',
        categoryId: cat.id,
        categoryName: cat.name,
        accountId: acc.id,
        competenceDate: '2026-11-01',
      },
      true
    );

    // Pagamento parcial 1: R$ 200,00
    await recordPartialPayment(
      tx.id,
      USER_ALICE,
      {
        amountCents: 20000,
        paymentDate: '2026-11-02',
        accountId: acc.id,
        authorUid: USER_ALICE,
      },
      true
    );

    // Pagamento parcial 2: R$ 250,00
    await recordPartialPayment(
      tx.id,
      USER_ALICE,
      {
        amountCents: 25000,
        paymentDate: '2026-11-05',
        accountId: acc.id,
        authorUid: USER_ALICE,
      },
      true
    );

    // Saldo antes do cancelamento: -45000
    let accounts = await getUserAccounts(USER_ALICE, false, true);
    assert.equal(accounts[0].projectedBalanceCents, -45000);

    // Cancela a transação: deve estornar AMBOS os pagamentos parciais (20000 e 25000)
    await cancelPersonalTransaction(tx.id, USER_ALICE, 'Desistência do curso com reembolso total', true);

    accounts = await getUserAccounts(USER_ALICE, false, true);
    assert.equal(accounts[0].projectedBalanceCents, 0);

    const movs = await getAccountMovements(acc.id, USER_ALICE, true);
    // 2 saídas originais + 2 entradas compensatórias = 4 movimentos
    assert.equal(movs.length, 4);
    assert.equal(reconcileAccountBalance(movs), 0);
  });

  // 20. Validação Pontual da Apuração Orçamentária e Estorno (EXEC-FINANCE-CORE-34-HOMOLOGATION-CHECK-01)
  it('20. deve validar os 10 cenários de apuração orçamentária individual e estorno de movimentações', async () => {
    const acc = await createAccount(USER_ALICE, { name: 'Conta Principal', type: 'checking' }, true);
    const card = await createAccount(
      USER_ALICE,
      {
        name: 'Cartão Gold',
        type: 'credit',
        creditLimitCents: 100000,
        closingDay: 20,
        dueDay: 28,
      },
      true
    );
    const cat = await createCategory(USER_ALICE, { name: 'Despesas Gerais', type: 'expense' }, true);

    await createPersonalBudget(
      USER_ALICE,
      {
        name: 'Orçamento Teste',
        categoryIds: [cat.id],
        competenceMonth: '2026-11',
        plannedAmountCents: 100000, // R$ 1.000,00
      },
      true
    );

    // Cenário 1: Despesa de R$ 100,00 paga: realizado de R$ 100,00
    const txSc1 = await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Despesa Cenário 1',
        amountCents: 10000, // R$ 100,00
        type: 'expense',
        status: 'paid',
        categoryId: cat.id,
        categoryName: cat.name,
        accountId: acc.id,
        competenceDate: '2026-11-01',
      },
      true
    );
    let p = (await getUserBudgetsWithProgress(USER_ALICE, '2026-11', true))[0];
    assert.equal(p.realizedAmountCents, 10000, 'Cenário 1: Realizado deve ser R$ 100,00');
    assert.equal(p.committedAmountCents, 0, 'Cenário 1: Comprometido deve ser 0');
    assert.equal(p.forecastedAmountCents, 10000, 'Cenário 1: Previsto total deve ser R$ 100,00');

    // Cenário 2: Despesa de R$ 100,00 paga e posteriormente estornada: o orçamento deve refletir corretamente o efeito econômico do estorno
    // Estorna o movimento financeiro sem cancelar a obrigação
    assert.ok(txSc1.financialMovementId);
    await reverseMovement(acc.id, txSc1.financialMovementId, USER_ALICE, 'Estorno bancário do pagamento', true, { idempotent: true });
    p = (await getUserBudgetsWithProgress(USER_ALICE, '2026-11', true))[0];
    assert.equal(p.realizedAmountCents, 0, 'Cenário 2: Realizado após estorno financeiro deve voltar a zero');
    assert.equal(p.committedAmountCents, 10000, 'Cenário 2: Comprometido deve refletir a obrigação a pagar (R$ 100,00)');
    assert.equal(p.forecastedAmountCents, 10000, 'Cenário 2: Previsto total permanece R$ 100,00');

    // Cenário 10 (repetição concorrente/idempotente da reversão do Cenário 2): não duplica o efeito orçamentário
    await reverseMovement(acc.id, txSc1.financialMovementId, USER_ALICE, 'Estorno bancário repetido', true, { idempotent: true });
    p = (await getUserBudgetsWithProgress(USER_ALICE, '2026-11', true))[0];
    assert.equal(p.realizedAmountCents, 0, 'Cenário 10: Idempotência preserva realizado em zero');
    assert.equal(p.committedAmountCents, 10000, 'Cenário 10: Idempotência não duplica comprometido');

    // Cenário 9: Estorno de uma despesa sem apagar ou modificar o movimento original
    const movsSc1 = await getAccountMovements(acc.id, USER_ALICE, true);
    assert.equal(movsSc1.length, 2, 'Cenário 9: Movimento original e compensatório preservados (append-only)');
    assert.ok(movsSc1.some((m) => m.id === txSc1.financialMovementId), 'Cenário 9: Movimento original permanece intacto no livro');
    assert.ok(
      movsSc1.some((m) => m.reversalOfMovementId === txSc1.financialMovementId),
      'Cenário 9: Movimento compensatório vinculado registrado'
    );

    // Cancela formalmente txSc1 para limpar o orçamento para os próximos cenários
    await cancelPersonalTransaction(txSc1.id, USER_ALICE, 'Cancelamento da compra', true);
    p = (await getUserBudgetsWithProgress(USER_ALICE, '2026-11', true))[0];
    assert.equal(p.realizedAmountCents, 0);
    assert.equal(p.committedAmountCents, 0);
    assert.equal(p.forecastedAmountCents, 0);

    // Cenário 3: Despesa parcialmente paga de R$ 100,00, com R$ 60,00 pagos: realizado de R$ 60,00 e comprometido de R$ 40,00
    const txSc3 = await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Despesa Cenário 3',
        amountCents: 10000,
        type: 'expense',
        status: 'pending',
        categoryId: cat.id,
        categoryName: cat.name,
        accountId: acc.id,
        competenceDate: '2026-11-05',
      },
      true
    );
    await recordPartialPayment(
      txSc3.id,
      USER_ALICE,
      {
        amountCents: 6000, // R$ 60,00
        paymentDate: '2026-11-05',
        accountId: acc.id,
        authorUid: USER_ALICE,
      },
      true
    );
    p = (await getUserBudgetsWithProgress(USER_ALICE, '2026-11', true))[0];
    assert.equal(p.realizedAmountCents, 6000, 'Cenário 3: Realizado deve ser R$ 60,00');
    assert.equal(p.committedAmountCents, 4000, 'Cenário 3: Comprometido deve ser R$ 40,00');
    assert.equal(p.forecastedAmountCents, 10000, 'Cenário 3: Previsto total deve ser R$ 100,00');

    // Cenário 4: Despesa parcialmente paga e posteriormente cancelada: não manter valores indevidos no orçamento
    await cancelPersonalTransaction(txSc3.id, USER_ALICE, 'Acordo desfeito', true);
    p = (await getUserBudgetsWithProgress(USER_ALICE, '2026-11', true))[0];
    assert.equal(p.realizedAmountCents, 0, 'Cenário 4: Realizado zerado após cancelamento');
    assert.equal(p.committedAmountCents, 0, 'Cenário 4: Comprometido zerado após cancelamento');
    assert.equal(p.forecastedAmountCents, 0, 'Cenário 4: Previsto zerado após cancelamento');

    // Cenário 5: Despesa cancelada antes do pagamento: nenhum impacto
    const txSc5 = await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Despesa Cenário 5',
        amountCents: 5000,
        type: 'expense',
        status: 'pending',
        categoryId: cat.id,
        categoryName: cat.name,
        accountId: acc.id,
        competenceDate: '2026-11-06',
      },
      true
    );
    await cancelPersonalTransaction(txSc5.id, USER_ALICE, 'Desistência antes de pagar', true);
    p = (await getUserBudgetsWithProgress(USER_ALICE, '2026-11', true))[0];
    assert.equal(p.realizedAmountCents, 0, 'Cenário 5: Nenhum impacto no realizado');
    assert.equal(p.committedAmountCents, 0, 'Cenário 5: Nenhum impacto no comprometido');
    assert.equal(p.forecastedAmountCents, 0, 'Cenário 5: Nenhum impacto no previsto');

    // Cenário 6: Compra no cartão: reconhecer o consumo uma única vez
    await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Compra Mercado Cartão',
        amountCents: 25000, // R$ 250,00
        type: 'expense',
        status: 'paid',
        categoryId: cat.id,
        categoryName: cat.name,
        accountId: card.id,
        competenceDate: '2026-11-10',
        paymentDate: '2026-11-10',
      },
      true
    );
    p = (await getUserBudgetsWithProgress(USER_ALICE, '2026-11', true))[0];
    assert.equal(p.realizedAmountCents, 25000, 'Cenário 6: Reconhece consumo da compra no cartão uma única vez');
    assert.equal(p.committedAmountCents, 0);
    assert.equal(p.forecastedAmountCents, 25000);

    // Cenário 7: Pagamento da fatura: não duplicar a despesa
    await payCardInvoice(
      {
        cardAccountId: card.id,
        invoiceMonth: '2026-11',
        sourceAccountId: acc.id,
        amountPaidCents: 15000, // Paga R$ 150,00 da fatura
        paymentDate: '2026-11-25',
        userId: USER_ALICE,
      },
      true
    );
    p = (await getUserBudgetsWithProgress(USER_ALICE, '2026-11', true))[0];
    assert.equal(p.realizedAmountCents, 25000, 'Cenário 7: Pagamento de fatura não duplica despesa no orçamento');

    // Cenário 8: Carry-over de fatura: não criar consumo orçamentário duplicado
    await carryOverInvoiceBalance(
      {
        cardAccount: card,
        sourceInvoiceMonth: '2026-11',
        targetInvoiceMonth: '2026-12',
        interestRateMonthly: 0.10,
        userId: USER_ALICE,
      },
      true
    );
    p = (await getUserBudgetsWithProgress(USER_ALICE, '2026-11', true))[0];
    assert.equal(p.realizedAmountCents, 25000, 'Cenário 8: Carry-over não cria consumo orçamentário');
  });

  // 21. EXEC-FINANCE-CORE-34-FINAL-HISTORY-01
  // Consistência histórica entre PersonalTransaction, PersonalTransactionPayment e FinancialMovement após estornos
  it('21. deve validar a consistência histórica entre PersonalTransaction, PersonalTransactionPayment e FinancialMovement após estornos', async () => {
    const acc = await createAccount(USER_ALICE, { name: 'Conta Principal Histórico', type: 'checking' }, true);
    const cat = await createCategory(USER_ALICE, { name: 'Histórico e Auditoria', type: 'expense' }, true);
    await createPersonalBudget(
      USER_ALICE,
      {
        name: 'Orçamento Auditoria',
        categoryIds: [cat.id],
        competenceMonth: '2026-11',
        plannedAmountCents: 100000,
      },
      true
    );

    // =========================================================================
    // CENÁRIO 1: Despesa de R$ 100 paga integralmente e posteriormente estornada
    // =========================================================================
    const txSc1 = await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Despesa 100 Paga Integral',
        amountCents: 10000,
        type: 'expense',
        status: 'paid',
        categoryId: cat.id,
        categoryName: cat.name,
        accountId: acc.id,
        competenceDate: '2026-11-01',
        paymentDate: '2026-11-01',
        idempotencyKey: 'idem_sc1_hist_tx',
      },
      true
    );
    assert.equal(txSc1.status, 'paid');
    assert.equal(txSc1.paidAmountCents, 10000);
    assert.equal(txSc1.remainingAmountCents, 0);

    let paysSc1 = await getPersonalTransactionPayments(txSc1.id, USER_ALICE, true);
    assert.equal(paysSc1.length, 1, 'C1: Registro de pagamento inicial gerado na subcoleção');
    assert.equal(paysSc1[0].amountCents, 10000);
    assert.equal(paysSc1[0].isReversed, false);
    assert.equal(calculateActivePaidAmountCents(paysSc1), 10000);

    // Snapshot do armazenamento antes do estorno para demonstrar imutabilidade estrita
    const rawPaymentsBeforeSc1 = universalStorage.getItem('mpf_v3_demo_transaction_payments');

    // Estorna o pagamento
    const movSc1Id = txSc1.financialMovementId!;
    const revRes1 = await reverseMovement(acc.id, movSc1Id, USER_ALICE, 'Estorno integral C1', true, { idempotent: true });

    // Prova de Imutabilidade Estrita: o documento original em 'payments' permanece 100% inalterado
    const rawPaymentsAfterSc1 = universalStorage.getItem('mpf_v3_demo_transaction_payments');
    assert.equal(rawPaymentsBeforeSc1, rawPaymentsAfterSc1, 'C1: Documento original de pagamento permanece rigorosamente inalterado após estorno');

    // Verifica que o evento compensatório foi gravado na subcoleção 'payment_reversals'
    const revEventsSc1 = await getPersonalTransactionPaymentReversals(txSc1.id, USER_ALICE, true);
    assert.equal(revEventsSc1.length, 1, 'C1: Evento gravado na subcoleção payment_reversals');
    assert.equal(revEventsSc1[0].paymentId, paysSc1[0].id);
    assert.equal(revEventsSc1[0].amountCents, 10000);
    assert.equal(revEventsSc1[0].reversalMovementId, revRes1.compensatoryMovement.id);
    assert.ok(revEventsSc1[0].id.startsWith('payrev_'), 'C1: ID determinístico com prefixo payrev_');

    // Verifica estado da transação
    const txSc1After = (await getUserPersonalTransactions(USER_ALICE, {}, true)).find((t) => t.id === txSc1.id)!;
    assert.equal(txSc1After.status, 'pending', 'C1: Obrigação retorna para pending');
    assert.equal(txSc1After.paidAmountCents, 0);
    assert.equal(txSc1After.remainingAmountCents, 10000);

    // Verifica estado histórico do pagamento através da visão derivada
    paysSc1 = await getPersonalTransactionPayments(txSc1.id, USER_ALICE, true);
    assert.equal(paysSc1.length, 1, 'C1: Registro original de pagamento NÃO foi apagado (append-only)');
    assert.equal(paysSc1[0].amountCents, 10000, 'C1: Valor original preservado sem alteração retroativa');
    assert.equal(paysSc1[0].isReversed, true, 'C1: Marcado auditavelmente como estornado');
    assert.equal(paysSc1[0].reversalMovementId, revRes1.compensatoryMovement.id, 'C1: Vínculo auditável com movimento compensatório');
    assert.equal(calculateActivePaidAmountCents(paysSc1), 0, 'C1: Soma dos pagamentos ativos é zero');

    // =========================================================================
    // CENÁRIO 2: Despesa de R$ 100 com dois pagamentos de R$ 50, sendo um estornado
    // =========================================================================
    const txSc2 = await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Despesa 100 Dois Pagamentos',
        amountCents: 10000,
        type: 'expense',
        status: 'pending',
        categoryId: cat.id,
        categoryName: cat.name,
        accountId: acc.id,
        competenceDate: '2026-11-02',
        dueDate: '2026-11-20',
        idempotencyKey: 'idem_sc2_hist_tx',
      },
      true
    );

    // Pagamento 1: R$ 50,00
    const pay1 = await recordPartialPayment(
      txSc2.id,
      USER_ALICE,
      {
        amountCents: 5000,
        paymentDate: '2026-11-05',
        accountId: acc.id,
        authorUid: USER_ALICE,
        notes: 'Parcela 1 de 2',
        idempotencyKey: 'idem_sc2_pay1',
      },
      true
    );

    // Pagamento 2: R$ 50,00
    const pay2 = await recordPartialPayment(
      txSc2.id,
      USER_ALICE,
      {
        amountCents: 5000,
        paymentDate: '2026-11-06',
        accountId: acc.id,
        authorUid: USER_ALICE,
        notes: 'Parcela 2 de 2',
        idempotencyKey: 'idem_sc2_pay2',
      },
      true
    );

    let txSc2Loaded = (await getUserPersonalTransactions(USER_ALICE, {}, true)).find((t) => t.id === txSc2.id)!;
    assert.equal(txSc2Loaded.status, 'paid');
    assert.equal(txSc2Loaded.paidAmountCents, 10000);
    assert.equal(txSc2Loaded.remainingAmountCents, 0);

    // Snapshot antes do estorno
    const rawPaymentsBeforeSc2 = universalStorage.getItem('mpf_v3_demo_transaction_payments');

    // Estorna o Pagamento 1 (pay1)
    const revRes2 = await reverseMovement(acc.id, pay1.paymentRecord.financialMovementId, USER_ALICE, 'Estorno Parcela 1 C2', true, { idempotent: true });

    // Prova de imutabilidade estrita: nenhum pagamento sofreu update
    const rawPaymentsAfterSc2 = universalStorage.getItem('mpf_v3_demo_transaction_payments');
    assert.equal(rawPaymentsBeforeSc2, rawPaymentsAfterSc2, 'C2: Documentos originais de pagamento permanecem intactos');

    txSc2Loaded = (await getUserPersonalTransactions(USER_ALICE, {}, true)).find((t) => t.id === txSc2.id)!;
    assert.equal(txSc2Loaded.status, 'partially_paid', 'C2: Transação volta a partially_paid');
    assert.equal(txSc2Loaded.paidAmountCents, 5000, 'C2: Valor pago ajustado para R$ 50,00');
    assert.equal(txSc2Loaded.remainingAmountCents, 5000, 'C2: Restante ajustado para R$ 50,00');

    let paysSc2 = await getPersonalTransactionPayments(txSc2.id, USER_ALICE, true);
    assert.equal(paysSc2.length, 2, 'C2: Ambos os registros de pagamento preservados');
    const p1 = paysSc2.find((p) => p.id === pay1.paymentRecord.id)!;
    const p2 = paysSc2.find((p) => p.id === pay2.paymentRecord.id)!;
    assert.equal(p1.isReversed, true, 'C2: Pagamento 1 marcado como revertido');
    assert.equal(p1.reversalMovementId, revRes2.compensatoryMovement.id, 'C2: Vínculo auditável de p1');
    assert.equal(p2.isReversed, false, 'C2: Pagamento 2 permanece ativo');
    assert.equal(calculateActivePaidAmountCents(paysSc2), 5000, 'C2: Total ativo coincide com paidAmountCents');

    const revEventsSc2 = await getPersonalTransactionPaymentReversals(txSc2.id, USER_ALICE, true);
    assert.equal(revEventsSc2.length, 1, 'C2: Apenas o pagamento estornado gerou evento em payment_reversals');
    assert.equal(revEventsSc2[0].paymentId, p1.id);

    // =========================================================================
    // CENÁRIO 3: Despesa de R$ 100 com pagamento parcial de R$ 60, posteriormente estornado
    // =========================================================================
    const txSc3 = await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Despesa 100 Parcial 60',
        amountCents: 10000,
        type: 'expense',
        status: 'pending',
        categoryId: cat.id,
        categoryName: cat.name,
        accountId: acc.id,
        competenceDate: '2026-11-03',
        dueDate: '2026-11-20',
        idempotencyKey: 'idem_sc3_hist_tx',
      },
      true
    );

    const paySc3 = await recordPartialPayment(
      txSc3.id,
      USER_ALICE,
      {
        amountCents: 6000,
        paymentDate: '2026-11-07',
        accountId: acc.id,
        authorUid: USER_ALICE,
        notes: 'Amortização 60%',
        idempotencyKey: 'idem_sc3_pay60',
      },
      true
    );

    let bgt = (await getUserBudgetsWithProgress(USER_ALICE, '2026-11', true))[0];
    const prevRealized = bgt.realizedAmountCents;

    // Estorna os 60
    const revRes3 = await reverseMovement(acc.id, paySc3.paymentRecord.financialMovementId, USER_ALICE, 'Estorno 60% C3', true, { idempotent: true });

    const txSc3After = (await getUserPersonalTransactions(USER_ALICE, {}, true)).find((t) => t.id === txSc3.id)!;
    assert.equal(txSc3After.status, 'pending', 'C3: Obrigação retorna a pending');
    assert.equal(txSc3After.paidAmountCents, 0);
    assert.equal(txSc3After.remainingAmountCents, 10000);

    const paysSc3 = await getPersonalTransactionPayments(txSc3.id, USER_ALICE, true);
    assert.equal(paysSc3.length, 1);
    assert.equal(paysSc3[0].isReversed, true);
    assert.equal(paysSc3[0].reversalMovementId, revRes3.compensatoryMovement.id);
    assert.equal(calculateActivePaidAmountCents(paysSc3), 0);

    bgt = (await getUserBudgetsWithProgress(USER_ALICE, '2026-11', true))[0];
    assert.equal(bgt.realizedAmountCents, prevRealized - 6000, 'C3: Orçamento refletiu estorno deduzindo 60 do realizado');

    // =========================================================================
    // CENÁRIO 4: Estorno seguido de novo pagamento da mesma obrigação
    // =========================================================================
    // Na mesma txSc3 (que voltou para pending com remaining = 10000), realiza novo pagamento de R$ 70
    const paySc4New = await recordPartialPayment(
      txSc3.id,
      USER_ALICE,
      {
        amountCents: 7000,
        paymentDate: '2026-11-08',
        accountId: acc.id,
        authorUid: USER_ALICE,
        notes: 'Novo pagamento após estorno',
        idempotencyKey: 'idem_sc4_pay70',
      },
      true
    );

    const txSc3New = (await getUserPersonalTransactions(USER_ALICE, {}, true)).find((t) => t.id === txSc3.id)!;
    assert.equal(txSc3New.status, 'partially_paid', 'C4: Obrigação atualizada para partially_paid após novo pagamento');
    assert.equal(txSc3New.paidAmountCents, 7000);
    assert.equal(txSc3New.remainingAmountCents, 3000);

    const paysSc4 = await getPersonalTransactionPayments(txSc3.id, USER_ALICE, true);
    assert.equal(paysSc4.length, 2, 'C4: Histórico contém 2 pagamentos (1 estornado, 1 ativo)');
    assert.equal(calculateActivePaidAmountCents(paysSc4), 7000, 'C4: Total ativo coincide rigorosamente com paidAmountCents');

    // =========================================================================
    // CENÁRIO 5: Duas reversões concorrentes do mesmo pagamento
    // =========================================================================
    // Executa duas chamadas concorrentes para estornar paySc4New
    const movToRev = paySc4New.paymentRecord.financialMovementId;
    const [revA, revB] = await Promise.all([
      reverseMovement(acc.id, movToRev, USER_ALICE, 'Reversão concorrente A', true, { idempotent: true }),
      reverseMovement(acc.id, movToRev, USER_ALICE, 'Reversão concorrente B', true, { idempotent: true }),
    ]);

    assert.equal(revA.compensatoryMovement.id, revB.compensatoryMovement.id, 'C5: Mesma chave/documento de estorno');
    const allMovs = await getAccountMovements(acc.id, USER_ALICE, true);
    const revCount = allMovs.filter((m) => m.reversalOfMovementId === movToRev).length;
    assert.equal(revCount, 1, 'C5: Exatamente 1 movimento de estorno gravado no livro (sem duplicidade)');

    const revEventsSc5 = await getPersonalTransactionPaymentReversals(txSc3.id, USER_ALICE, true);
    const pSc4NewRevs = revEventsSc5.filter((r) => r.paymentId === paySc4New.paymentRecord.id);
    assert.equal(pSc4NewRevs.length, 1, 'C5: Exatamente 1 evento de reversão gravado em payment_reversals para o pagamento (idempotência)');

    // =========================================================================
    // CENÁRIO 6: Cancelamento de despesa com pagamentos anteriores e respectivos estornos
    // =========================================================================
    const txSc6 = await createPersonalTransaction(
      USER_ALICE,
      {
        description: 'Despesa para Cancelamento com Histórico',
        amountCents: 10000,
        type: 'expense',
        status: 'pending',
        categoryId: cat.id,
        categoryName: cat.name,
        accountId: acc.id,
        competenceDate: '2026-11-04',
        dueDate: '2026-11-20',
        idempotencyKey: 'idem_sc6_hist_tx',
      },
      true
    );

    // Pagamento 1: R$ 40,00
    const paySc6_1 = await recordPartialPayment(
      txSc6.id,
      USER_ALICE,
      {
        amountCents: 4000,
        paymentDate: '2026-11-09',
        accountId: acc.id,
        authorUid: USER_ALICE,
        notes: 'P1 40 reais',
        idempotencyKey: 'idem_sc6_p1',
      },
      true
    );

    // Pagamento 2: R$ 30,00
    const paySc6_2 = await recordPartialPayment(
      txSc6.id,
      USER_ALICE,
      {
        amountCents: 3000,
        paymentDate: '2026-11-10',
        accountId: acc.id,
        authorUid: USER_ALICE,
        notes: 'P2 30 reais',
        idempotencyKey: 'idem_sc6_p2',
      },
      true
    );

    // Estorna previamente apenas o Pagamento 1
    await reverseMovement(acc.id, paySc6_1.paymentRecord.financialMovementId, USER_ALICE, 'Estorno prévio P1 C6', true, { idempotent: true });

    // Saldo bancário antes do cancelamento
    const accBeforeCancel = (await getUserAccounts(USER_ALICE, false, true)).find((a) => a.id === acc.id)!;
    const balBeforeCancel = accBeforeCancel.projectedBalanceCents;

    // Snapshot dos pagamentos brutos antes do cancelamento para comprovar imutabilidade estrita
    const rawPaymentsBeforeCancel = universalStorage.getItem('mpf_v3_demo_transaction_payments');

    // Cancela a transação formalmente
    const cancelledTx = await cancelPersonalTransaction(txSc6.id, USER_ALICE, 'Cancelamento formal C6', true);
    assert.equal(cancelledTx.status, 'cancelled');
    assert.equal(cancelledTx.remainingAmountCents, 0);

    // Prova de Imutabilidade Estrita: NENHUM documento em 'payments' foi atualizado ou deletado
    const rawPaymentsAfterCancel = universalStorage.getItem('mpf_v3_demo_transaction_payments');
    assert.equal(rawPaymentsBeforeCancel, rawPaymentsAfterCancel, 'C6: Documentos originais de pagamento permaneceram 100% inalterados durante o cancelamento');

    // O estorno do cancelamento deve reverter apenas o Pagamento 2 (P2 = 30), pois P1 já foi revertido
    const accAfterCancel = (await getUserAccounts(USER_ALICE, false, true)).find((a) => a.id === acc.id)!;
    assert.equal(accAfterCancel.projectedBalanceCents, balBeforeCancel + 3000, 'C6: Apenas o pagamento ativo (P2) foi estornado no cancelamento');

    // Verifica que nenhum movimento foi apagado e que P1 não foi duplamente estornado
    const movsSc6 = await getAccountMovements(acc.id, USER_ALICE, true);
    const p1Reversals = movsSc6.filter((m) => m.reversalOfMovementId === paySc6_1.paymentRecord.financialMovementId);
    const p2Reversals = movsSc6.filter((m) => m.reversalOfMovementId === paySc6_2.paymentRecord.financialMovementId);
    assert.equal(p1Reversals.length, 1, 'C6: Pagamento 1 tem exatamente 1 estorno');
    assert.equal(p2Reversals.length, 1, 'C6: Pagamento 2 tem exatamente 1 estorno');

    // Verifica subcoleção payment_reversals: exatamente 2 eventos (um prévio de P1 e um de P2 gerado no cancelamento)
    const revsSc6 = await getPersonalTransactionPaymentReversals(txSc6.id, USER_ALICE, true);
    assert.equal(revsSc6.length, 2, 'C6: Subcoleção payment_reversals contém exatamente 2 eventos');
    const revP1 = revsSc6.find((r) => r.paymentId === paySc6_1.paymentRecord.id);
    const revP2 = revsSc6.find((r) => r.paymentId === paySc6_2.paymentRecord.id);
    assert.ok(revP1, 'C6: Evento de estorno de P1 preservado intacto');
    assert.ok(revP2, 'C6: Evento de estorno de P2 criado pelo cancelamento');
    assert.equal(revP1.reason, 'Estorno prévio P1 C6');
    assert.equal(revP2.reason, 'Cancelamento de transação: Cancelamento formal C6');

    // Verifica visão consolidada de pagamentos
    const paysSc6 = await getPersonalTransactionPayments(txSc6.id, USER_ALICE, true);
    assert.equal(paysSc6.length, 2, 'C6: Ambos os pagamentos permanecem registrados na subcoleção');
    assert.equal(paysSc6[0].isReversed, true);
    assert.equal(paysSc6[1].isReversed, true);
    assert.equal(calculateActivePaidAmountCents(paysSc6), 0, 'C6: Nenhum pagamento ativo');
  });
});
