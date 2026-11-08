import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateCreditCardInvoice,
  generateRecurrenceSeries,
  filterCascadeTargets,
  calculateSpaceLedger,
  computeAutomatedStatus,
  resolveTransactionStatus,
  isAdminUid,
  buildAdminUserSummaries,
} from './financeEngine';
import { ADMIN_UID, Transaction } from '../types/finance';

test('Motor de Faturas: projeta compra antes e depois da data de corte corretamente', () => {
  // Cartão fecha dia 10 e vence dia 17 do mesmo mês
  const beforeCut = calculateCreditCardInvoice('2026-11-05', 10, 17);
  assert.equal(beforeCut.invoiceMonth, '2026-11');
  assert.equal(beforeCut.dueDate, '2026-11-17');

  // Compra no dia 10 (dia do corte) ou após vai para a fatura do mês seguinte
  const afterCut = calculateCreditCardInvoice('2026-11-12', 10, 17);
  assert.equal(afterCut.invoiceMonth, '2026-12');
  assert.equal(afterCut.dueDate, '2026-12-17');

  // Cartão que fecha dia 25 e vence dia 05 do mês seguinte
  const crossMonthDue = calculateCreditCardInvoice('2026-11-26', 25, 5);
  assert.equal(crossMonthDue.invoiceMonth, '2027-01');
  assert.equal(crossMonthDue.dueDate, '2027-01-05');
});

test('Motor de Recorrência Universal: divide parcelas com ajuste exato de centavos na 1a parcela', () => {
  const series = generateRecurrenceSeries(
    {
      userId: 'user_1',
      ownerEmail: 'ana@teste.com',
      ownerName: 'Ana',
      description: 'Notebook Dell',
      amount: 100,
      type: 'expense',
      status: 'paid',
      paymentDate: '2026-11-05',
      categoryId: 'cat_tech',
      categoryName: 'Tecnologia',
      categoryIcon: 'ph-laptop',
      categoryColor: 'indigo',
      accountId: 'acc_card',
      accountName: 'Nubank Ultravioleta',
      accountType: 'credit',
      competenceDate: '2026-11-05',
      dueDate: '2026-11-17',
      recurrenceType: 'installment',
      recurrenceGroupId: 'grp_123',
      spaceId: '',
      spaceName: '',
      paidByEmail: 'ana@teste.com',
      participantEmails: ['ana@teste.com'],
      splits: [],
      disputeReason: '',
      proposedAmount: 0,
    },
    { type: 'credit', closingDay: 10, dueDay: 17 },
    'installment',
    3
  );

  assert.equal(series.length, 3);
  assert.equal(series[0].amount, 33.34);
  assert.equal(series[0].status, 'paid');
  assert.equal(series[0].paymentDate, '2026-11-05');
  assert.equal(series[1].amount, 33.33);
  assert.equal(series[1].status, 'pending');
  assert.equal(series[1].paymentDate, '');
  assert.equal(series[2].amount, 33.33);
  assert.equal(series[0].description, 'Notebook Dell (1/3)');
  assert.equal(series[1].invoiceMonth, '2026-12');
  assert.equal(series[2].invoiceMonth, '2027-01');
});

test('Motor de Status Automatizado: Pendente padrão, Vencido por data, Em Validação/Recusado por rateio e Pago com data', () => {
  const today = '2026-11-07';

  // 1. Padrão Pendente quando vencimento é futuro/hoje e não há rateio pendente
  assert.equal(
    computeAutomatedStatus({
      isPaid: false,
      dueDate: '2026-11-15',
      splits: [],
      todayDate: today,
    }),
    'pending'
  );

  // 2. Vencido automaticamente quando a data de vencimento já passou
  assert.equal(
    computeAutomatedStatus({
      isPaid: false,
      dueDate: '2026-11-03',
      splits: [],
      todayDate: today,
    }),
    'overdue'
  );

  // 3. Em Validação automaticamente quando há rateio com participante pendente
  assert.equal(
    computeAutomatedStatus({
      isPaid: false,
      dueDate: '2026-11-20',
      splits: [
        { email: 'a@b.com', name: 'A', responsibility: 50, paidAmount: 100, status: 'accepted' },
        { email: 'c@d.com', name: 'C', responsibility: 50, paidAmount: 0, status: 'pending' },
      ],
      todayDate: today,
    }),
    'validating'
  );

  // 4. Recusado automaticamente quando participante do rateio recusou
  assert.equal(
    computeAutomatedStatus({
      isPaid: false,
      dueDate: '2026-11-20',
      splits: [
        { email: 'a@b.com', name: 'A', responsibility: 50, paidAmount: 100, status: 'accepted' },
        { email: 'c@d.com', name: 'C', responsibility: 50, paidAmount: 0, status: 'rejected' },
      ],
      todayDate: today,
    }),
    'rejected'
  );

  // 5. Pago / Efetivado quando botão Pago/Efetivado é acionado e data de pagamento preenchida
  assert.equal(
    computeAutomatedStatus({
      isPaid: true,
      paymentDate: '2026-11-07',
      dueDate: '2026-11-01',
      splits: [],
      todayDate: today,
    }),
    'paid'
  );

  // 6. resolveTransactionStatus converte pendente com vencimento passado em 'overdue'
  assert.equal(
    resolveTransactionStatus(
      {
        status: 'pending',
        dueDate: '2026-11-02',
        paymentDate: '',
        splits: [],
      },
      today
    ),
    'overdue'
  );
});

test('Edição em Cascata: filtra Somente este, Este e seguintes, e Todos', () => {
  const items = [1, 2, 3].map((idx) => ({
    id: `tx_${idx}`,
    recurrenceGroupId: 'grp_1',
    recurrenceType: 'installment',
    installmentIndex: idx,
    invoiceMonth: `2026-0${idx}`,
  })) as unknown as Transaction[];

  assert.equal(filterCascadeTargets(items, items[1], 'only_this').length, 1);
  assert.equal(filterCascadeTargets(items, items[1], 'this_and_following').length, 2);
  assert.equal(filterCascadeTargets(items, items[1], 'all').length, 3);
});

test('Livro-Razão (Splitwise Engine): calcula Responsabilidade vs Valor Pago e quem deve a quem', () => {
  const txs: Transaction[] = [
    {
      id: 't1',
      userId: 'u1',
      ownerEmail: 'keniel@teste.com',
      ownerName: 'Keniel',
      description: 'Supermercado Mensal',
      amount: 600,
      type: 'expense',
      status: 'paid',
      paymentDate: '2026-11-02',
      categoryId: 'c1',
      categoryName: 'Mercado',
      categoryIcon: 'ph-shopping-cart',
      categoryColor: 'emerald',
      accountId: 'a1',
      accountName: 'Itaú',
      accountType: 'checking',
      competenceDate: '2026-11-02',
      dueDate: '2026-11-02',
      invoiceMonth: '2026-11',
      recurrenceType: 'single',
      recurrenceGroupId: 'g1',
      installmentIndex: 1,
      installmentTotal: 1,
      spaceId: 'sp_casa',
      spaceName: 'Casa',
      paidByEmail: 'keniel@teste.com',
      participantEmails: ['keniel@teste.com', 'marina@teste.com', 'lucas@teste.com'],
      splits: [
        { email: 'keniel@teste.com', name: 'Keniel', responsibility: 200, paidAmount: 600, status: 'accepted' },
        { email: 'marina@teste.com', name: 'Marina', responsibility: 200, paidAmount: 0, status: 'accepted' },
        { email: 'lucas@teste.com', name: 'Lucas', responsibility: 200, paidAmount: 0, status: 'accepted' },
      ],
      disputeReason: '',
      proposedAmount: 0,
    },
  ];

  const ledger = calculateSpaceLedger(txs);
  assert.equal(ledger.totalSharedExpenses, 600);
  const keniel = ledger.summaries.find((s) => s.email === 'keniel@teste.com')!;
  assert.equal(keniel.totalResponsibility, 200);
  assert.equal(keniel.totalPaid, 600);
  assert.equal(keniel.netBalance, 400); // A receber R$ 400

  assert.equal(ledger.transfers.length, 2);
  assert.equal(ledger.transfers[0].toEmail, 'keniel@teste.com');
  assert.equal(ledger.transfers[0].amount, 200);
});

test('Painel Admin: identifica ADMIN_UID e agrega contagem de registros e dados por usuário', () => {
  assert.equal(isAdminUid('cFlLuuez1TMfNhsNFKGpjQ8qYSG3'), true);
  assert.equal(isAdminUid('lUEcghicpWUIAgc4Jhs1PwYqW7l2'), true);
  assert.equal(isAdminUid('outro_uid_qualquer'), false);

  const summaries = buildAdminUserSummaries({
    users: [
      {
        uid: ADMIN_UID,
        name: 'Admin User',
        email: 'admin@painel.com',
        createdAt: '2026-10-01T10:00:00.000Z',
      },
      {
        uid: 'u_2',
        name: 'Marina Costa',
        email: 'marina@painel.com',
        createdAt: '2026-11-01T12:30:00.000Z',
      },
    ],
    accounts: [
      {
        id: 'acc_1',
        userId: 'u_2',
        name: 'Bradesco',
        type: 'checking',
        balance: 5000,
        limit: 0,
        closingDay: 1,
        dueDay: 1,
        color: 'indigo',
        icon: 'ph-bank',
      },
    ],
    categories: [],
    spaces: [
      {
        id: 'sp_1',
        ownerId: 'u_2',
        ownerEmail: 'marina@painel.com',
        name: 'Viagem',
        description: 'Grupo',
        icon: 'ph-mountains',
        color: 'purple',
        participantEmails: ['marina@painel.com'],
        participants: [{ email: 'marina@painel.com', name: 'Marina', status: 'active' }],
      },
    ],
    transactions: [],
  });

  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].uid, ADMIN_UID);
  assert.equal(summaries[0].isAdminUser, true);
  assert.equal(summaries[1].uid, 'u_2');
  assert.equal(summaries[1].accountsCount, 1);
  assert.equal(summaries[1].spacesCount, 1);
  assert.equal(summaries[1].totalRecords, 2);
});

test('Livro-Razão Mensal com Caixa do Espaço: contabiliza receitas enviadas, % de cobertura e baixa pelo caixa', () => {
  const txs: Transaction[] = [
    // Despesa 1: R$ 600 ainda em aberto (não paga por ninguém ainda, rateada por igual 300/300)
    {
      id: 'exp_open',
      userId: 'u1',
      ownerEmail: 'keniel@teste.com',
      ownerName: 'Keniel',
      description: 'Aluguel Mensal',
      amount: 600,
      type: 'expense',
      status: 'pending',
      paymentDate: '',
      categoryId: 'c1',
      categoryName: 'Moradia',
      categoryIcon: 'ph-house-line',
      categoryColor: 'indigo',
      accountId: 'a1',
      accountName: 'Itaú',
      accountType: 'checking',
      competenceDate: '2026-11-05',
      dueDate: '2026-11-10',
      invoiceMonth: '2026-11',
      recurrenceType: 'fixed',
      recurrenceGroupId: 'g_aluguel',
      installmentIndex: 1,
      installmentTotal: 12,
      spaceId: 'sp_casa',
      spaceName: 'Casa',
      paidByEmail: 'space_cash',
      participantEmails: ['keniel@teste.com', 'marina@teste.com'],
      splits: [
        { email: 'keniel@teste.com', name: 'Keniel', responsibility: 300, paidAmount: 0, status: 'accepted' },
        { email: 'marina@teste.com', name: 'Marina', responsibility: 300, paidAmount: 0, status: 'accepted' },
      ],
      disputeReason: '',
      proposedAmount: 0,
    },
    // Despesa 2: R$ 400 já quitada usando o Caixa do Espaço (rateada 200/200)
    {
      id: 'exp_cash_paid',
      userId: 'u1',
      ownerEmail: 'keniel@teste.com',
      ownerName: 'Keniel',
      description: 'Energia + Internet',
      amount: 400,
      type: 'expense',
      status: 'paid',
      paymentDate: '2026-11-06',
      categoryId: 'c1',
      categoryName: 'Moradia',
      categoryIcon: 'ph-house-line',
      categoryColor: 'indigo',
      accountId: 'a1',
      accountName: 'Itaú',
      accountType: 'checking',
      competenceDate: '2026-11-06',
      dueDate: '2026-11-06',
      invoiceMonth: '2026-11',
      recurrenceType: 'single',
      recurrenceGroupId: 'g_luz',
      installmentIndex: 1,
      installmentTotal: 1,
      spaceId: 'sp_casa',
      spaceName: 'Casa',
      paidByEmail: 'space_cash',
      participantEmails: ['keniel@teste.com', 'marina@teste.com'],
      splits: [
        { email: 'keniel@teste.com', name: 'Keniel', responsibility: 200, paidAmount: 0, status: 'accepted' },
        { email: 'marina@teste.com', name: 'Marina', responsibility: 200, paidAmount: 0, status: 'accepted' },
      ],
      disputeReason: '',
      proposedAmount: 0,
    },
    // Receita 1: Marina enviou R$ 700 confirmados para o Caixa do Espaço (cobrindo 70% das despesas totais de R$ 1.000)
    {
      id: 'inc_marina',
      userId: 'u2',
      ownerEmail: 'marina@teste.com',
      ownerName: 'Marina',
      description: 'Aporte Mensal Marina',
      amount: 700,
      type: 'income',
      status: 'paid',
      paymentDate: '2026-11-05',
      categoryId: 'c_inc',
      categoryName: 'Aporte',
      categoryIcon: 'ph-hand-coins',
      categoryColor: 'emerald',
      accountId: 'a1',
      accountName: 'Itaú',
      accountType: 'checking',
      competenceDate: '2026-11-05',
      dueDate: '2026-11-05',
      invoiceMonth: '2026-11',
      recurrenceType: 'single',
      recurrenceGroupId: 'g_inc_1',
      installmentIndex: 1,
      installmentTotal: 1,
      spaceId: 'sp_casa',
      spaceName: 'Casa',
      paidByEmail: 'marina@teste.com',
      recipientEmail: 'keniel@teste.com',
      participantEmails: ['keniel@teste.com', 'marina@teste.com'],
      splits: [],
      disputeReason: '',
      proposedAmount: 0,
    },
  ];

  const ledger = calculateSpaceLedger(txs, [
    { email: 'keniel@teste.com', name: 'Keniel' },
    { email: 'marina@teste.com', name: 'Marina' },
  ]);

  assert.equal(ledger.totalSharedExpenses, 1000);
  assert.equal(ledger.settledExpenses, 400);
  assert.equal(ledger.pendingExpenses, 600);
  assert.equal(ledger.totalConfirmedIncome, 700);
  assert.equal(ledger.paidViaSpaceCashExpenses, 400);
  assert.equal(ledger.availableSpaceCash, 300); // 700 recebidos - 400 usados p/ dar baixa = 300 livres no caixa

  const marina = ledger.summaries.find((s) => s.email === 'marina@teste.com')!;
  const keniel = ledger.summaries.find((s) => s.email === 'keniel@teste.com')!;

  assert.equal(marina.totalResponsibility, 500);
  assert.equal(marina.responsibilityPercent, 50);
  assert.equal(marina.incomeContributed, 700);
  assert.equal(marina.totalPaid, 700);
  assert.equal(marina.coveragePercent, 70); // Cobriu 70% das despesas do mês!
  assert.equal(marina.netBalance, 200); // Pagou R$ 200 além da sua cota de R$ 500

  assert.equal(keniel.totalResponsibility, 500);
  assert.equal(keniel.totalPaid, 0);
  assert.equal(keniel.coveragePercent, 0);
  assert.equal(keniel.netBalance, -500); // Falta aportar/pagar R$ 500
});

test('Regras de Espaço vs Rateio Avulso: Lançamento de Espaço não vai para validação no Inbox e Aceite de Rateio Avulso mantém vencimento (não marca como pago)', () => {
  const today = '2026-11-08';

  // Despesa dentro de Espaço Compartilhado nunca fica 'validating', segue a data de vencimento ('pending' ou 'overdue')
  const spaceExpenseStatus = computeAutomatedStatus({
    isPaid: false,
    dueDate: '2026-11-20',
    spaceId: 'space_apartamento',
    splits: [
      { email: 'a@b.com', name: 'A', responsibility: 100, paidAmount: 0, status: 'pending' },
    ],
    todayDate: today,
  });
  assert.equal(spaceExpenseStatus, 'pending');

  // Despesa Avulsa (fora de grupo, spaceId vazio) vai para 'validating' enquanto houver participante pendente
  const adhocPendingStatus = computeAutomatedStatus({
    isPaid: false,
    dueDate: '2026-11-20',
    spaceId: '',
    splits: [
      { email: 'a@b.com', name: 'A', responsibility: 100, paidAmount: 200, status: 'accepted' },
      { email: 'c@d.com', name: 'C', responsibility: 100, paidAmount: 0, status: 'pending' },
    ],
    todayDate: today,
  });
  assert.equal(adhocPendingStatus, 'validating');

  // Quando o participante dá aceite no Rateio Avulso, o lançamento NÃO vira 'paid' — permanece 'pending' (No Prazo) até a baixa do pagamento
  const adhocAfterAcceptStatus = computeAutomatedStatus({
    isPaid: false,
    paymentDate: '',
    dueDate: '2026-11-20',
    spaceId: '',
    splits: [
      { email: 'a@b.com', name: 'A', responsibility: 100, paidAmount: 200, status: 'accepted' },
      { email: 'c@d.com', name: 'C', responsibility: 100, paidAmount: 0, status: 'accepted' },
    ],
    todayDate: today,
  });
  assert.equal(adhocAfterAcceptStatus, 'pending');
});

test('Isolamento de Lançamento Fixo: alterar apenas Janeiro de 2027 (only_this) não altera Novembro/2026 nem os demais meses', () => {
  const fixedSeries = generateRecurrenceSeries(
    {
      userId: 'user_1',
      ownerEmail: 'keniel@teste.com',
      ownerName: 'Keniel',
      description: 'Condomínio Mensal',
      amount: 800,
      type: 'expense',
      status: 'pending',
      paymentDate: '',
      categoryId: 'cat_moradia',
      categoryName: 'Moradia',
      categoryIcon: 'ph-house-line',
      categoryColor: 'indigo',
      accountId: 'acc_itau',
      accountName: 'Itaú',
      accountType: 'checking',
      competenceDate: '2026-11-05',
      dueDate: '2026-11-10',
      recurrenceType: 'fixed',
      recurrenceGroupId: 'grp_condominio',
      spaceId: '',
      spaceName: '',
      paidByEmail: 'keniel@teste.com',
      participantEmails: ['keniel@teste.com'],
      splits: [],
      disputeReason: '',
      proposedAmount: 0,
    },
    { type: 'checking', closingDay: 1, dueDay: 10 },
    'fixed',
    12
  ).map((item, idx) => ({ ...item, id: `tx_fixed_${idx + 1}` }));

  const jan2027Item = fixedSeries.find((t) => t.invoiceMonth === '2027-01')!;
  assert.ok(jan2027Item);

  const targetsOnlyJan = filterCascadeTargets(fixedSeries, jan2027Item, 'only_this');
  assert.equal(targetsOnlyJan.length, 1);
  assert.equal(targetsOnlyJan[0].invoiceMonth, '2027-01');

  const updatedSeries = fixedSeries.map((tx) =>
    targetsOnlyJan.some((target) => target.id === tx.id)
      ? { ...tx, amount: 950 }
      : tx
  );

  assert.equal(updatedSeries.find((t) => t.invoiceMonth === '2026-11')!.amount, 800);
  assert.equal(updatedSeries.find((t) => t.invoiceMonth === '2026-12')!.amount, 800);
  assert.equal(updatedSeries.find((t) => t.invoiceMonth === '2027-01')!.amount, 950);
  assert.equal(updatedSeries.find((t) => t.invoiceMonth === '2027-02')!.amount, 800);
});



