import {
  Account,
  ADMIN_UID,
  AdminUserSummary,
  CascadeMode,
  Category,
  LedgerParticipantSummary,
  RecurrenceType,
  SettlementTransfer,
  Space,
  SplitShare,
  Transaction,
  TransactionStatus,
  UserProfile,
} from '../types/finance';

/**
 * Retorna a data de referência atual no formato YYYY-MM-DD.
 */
export function getTodayDateString(): string {
  const now = new Date();
  const yyyy = String(now.getFullYear()).padStart(4, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Motor de Status Automatizado:
 * - 'rejected': automatizado quando algum participante do compartilhamento avulso recusou o rateio.
 * - 'validating': automatizado APENAS para Rateio Avulso (sem spaceId) pendente de aceite ou em disputa.
 *   Lançamentos criados dentro de um Espaço Compartilhado (com spaceId) não exigem aceite no Inbox.
 * - 'paid': quando acionado pelo botão "Pago / Efetivado" (com data de pagamento preenchida).
 * - 'overdue': automatizado quando não foi pago e a data de vencimento (dueDate) já passou.
 * - 'pending': status padrão inicial quando ainda não venceu e não foi pago.
 */
export function computeAutomatedStatus(params: {
  isPaid: boolean;
  paymentDate?: string;
  dueDate: string;
  splits?: SplitShare[];
  spaceId?: string;
  todayDate?: string;
}): TransactionStatus {
  const today = params.todayDate || getTodayDateString();
  const splits = params.splits || [];
  const isSpaceTx = Boolean(params.spaceId && params.spaceId.trim().length > 0);

  // 1. Se algum participante do rateio avulso recusou, o status é Recusado
  if (!isSpaceTx && splits.length > 0 && splits.some((s) => s.status === 'rejected')) {
    return 'rejected';
  }

  // 2. Se foi marcado como Pago / Efetivado (com data de pagamento), é Pago
  if (params.isPaid || Boolean(params.paymentDate && params.paymentDate.trim().length > 0)) {
    return 'paid';
  }

  // 3. Se for Rateio Avulso (fora de espaço) com pendência de aceite ou disputa, fica Em Validação
  if (
    !isSpaceTx &&
    splits.length > 0 &&
    splits.some((s) => s.status === 'pending' || s.status === 'disputed')
  ) {
    return 'validating';
  }

  // 4. Se a data de vencimento já tiver passado, fica automaticamente Vencido
  if (params.dueDate && params.dueDate < today) {
    return 'overdue';
  }

  // 5. Padrão: Pendente
  return 'pending';
}

/**
 * Resolve o status efetivo de um lançamento existente considerando a data de hoje
 * e o estado do compartilhamento (apenas rateio avulso fora de espaço entra em validação).
 */
export function resolveTransactionStatus(
  tx: Pick<Transaction, 'status' | 'dueDate' | 'paymentDate' | 'splits'> & {
    spaceId?: string;
  },
  todayDate?: string
): TransactionStatus {
  const isSpaceTx = Boolean(tx.spaceId && tx.spaceId.trim().length > 0);
  if (!isSpaceTx && tx.status === 'rejected') return 'rejected';
  const splits = tx.splits || [];
  if (!isSpaceTx && splits.length > 0 && splits.some((s) => s.status === 'rejected')) {
    return 'rejected';
  }
  if (tx.status === 'paid') return 'paid';
  if (
    !isSpaceTx &&
    (tx.status === 'validating' ||
      (splits.length > 0 &&
        splits.some((s) => s.status === 'pending' || s.status === 'disputed')))
  ) {
    return 'validating';
  }
  const today = todayDate || getTodayDateString();
  if (tx.dueDate && tx.dueDate < today) {
    return 'overdue';
  }
  return 'pending';
}

/**
 * Formata um valor numérico para Moeda Brasileira (BRL).
 */
export function formatCurrency(value: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(Number.isFinite(value) ? value : 0);
}

/**
 * Adiciona N meses a uma data YYYY-MM-DD preservando o dia quando possível.
 */
export function addMonthsToDate(dateStr: string, monthsToAdd: number): string {
  const [yearStr, monthStr, dayStr] = dateStr.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr); // 1-12
  const day = Number(dayStr);

  const totalMonths = year * 12 + (month - 1) + monthsToAdd;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonthIndex = ((totalMonths % 12) + 12) % 12; // 0-11
  const maxDaysInTargetMonth = new Date(targetYear, targetMonthIndex + 1, 0).getDate();
  const clampedDay = Math.min(day, maxDaysInTargetMonth);

  const yyyy = String(targetYear).padStart(4, '0');
  const mm = String(targetMonthIndex + 1).padStart(2, '0');
  const dd = String(clampedDay).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Adiciona N meses a uma string YYYY-MM.
 */
export function addMonthsToYearMonth(yearMonth: string, monthsToAdd: number): string {
  const [yearStr, monthStr] = yearMonth.split('-');
  const totalMonths = Number(yearStr) * 12 + (Number(monthStr) - 1) + monthsToAdd;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = (((totalMonths % 12) + 12) % 12) + 1;
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}`;
}

/**
 * Motor de Faturas (Credit Card Invoice Projection Engine):
 * Calcula em qual mês de fatura (YYYY-MM) e qual a data de vencimento (YYYY-MM-DD)
 * uma compra no cartão de crédito cairá, com base na data de competência (compra),
 * no dia de fechamento/corte (closingDay) e no dia de vencimento (dueDay).
 *
 * Regra financeira:
 * - Se o dia da compra for MENOR que o closingDay, entra na fatura que fecha neste mesmo mês.
 * - Se o dia da compra for MAIOR OU IGUAL ao closingDay, entra na fatura que fecha no mês seguinte.
 * - Se dueDay < closingDay, o vencimento ocorre no mês seguinte ao fechamento.
 */
export function calculateCreditCardInvoice(
  competenceDate: string,
  closingDay: number,
  dueDay: number
): { invoiceMonth: string; dueDate: string } {
  const [yStr, mStr, dStr] = competenceDate.split('-');
  const purchaseDay = Number(dStr);
  const baseYearMonth = `${yStr}-${mStr}`;

  // Se comprou no dia do corte ou depois, vai para o fechamento do próximo mês
  const closingMonthOffset = purchaseDay >= closingDay ? 1 : 0;
  const closingYearMonth = addMonthsToYearMonth(baseYearMonth, closingMonthOffset);

  // Se o dia de vencimento é menor que o dia de fechamento, vence no mês seguinte ao fechamento
  const dueMonthOffset = dueDay < closingDay ? 1 : 0;
  const invoiceMonth = addMonthsToYearMonth(closingYearMonth, dueMonthOffset);

  const [invYearStr, invMonthStr] = invoiceMonth.split('-');
  const maxDays = new Date(Number(invYearStr), Number(invMonthStr), 0).getDate();
  const safeDueDay = String(Math.min(dueDay, maxDays)).padStart(2, '0');

  return {
    invoiceMonth,
    dueDate: `${invoiceMonth}-${safeDueDay}`,
  };
}

/**
 * Motor de Recorrência Universal:
 * Gera a série de lançamentos para Único ('single'), Fixo ('fixed' - projeta 12 meses)
 * ou Parcelado ('installment' - N parcelas com ajuste de centavos na 1ª parcela).
 */
export function generateRecurrenceSeries(
  baseTx: Omit<Transaction, 'id' | 'installmentIndex' | 'installmentTotal' | 'invoiceMonth' | 'dueDate' | 'competenceDate'> & {
    competenceDate: string;
    dueDate: string;
  },
  account: Pick<Account, 'type' | 'closingDay' | 'dueDay'>,
  recurrenceType: RecurrenceType,
  totalInstallments: number = 1
): Omit<Transaction, 'id'>[] {
  const count =
    recurrenceType === 'single'
      ? 1
      : recurrenceType === 'fixed'
      ? 12
      : Math.max(2, Math.min(360, Math.floor(totalInstallments)));

  const results: Omit<Transaction, 'id'>[] = [];

  // Cálculo de valor por parcela (para 'installment', divide o valor total; para 'fixed', mantém o valor mensal)
  const baseAmount = Number(baseTx.amount);
  const installmentRaw =
    recurrenceType === 'installment' ? Math.floor((baseAmount / count) * 100) / 100 : baseAmount;
  const remainderCents =
    recurrenceType === 'installment'
      ? Math.round((baseAmount - installmentRaw * count) * 100) / 100
      : 0;

  for (let i = 0; i < count; i++) {
    const stepCompetenceDate = addMonthsToDate(baseTx.competenceDate, i);
    let stepDueDate = addMonthsToDate(baseTx.dueDate, i);
    let stepInvoiceMonth = stepDueDate.slice(0, 7);

    if (account.type === 'credit') {
      const projected = calculateCreditCardInvoice(
        stepCompetenceDate,
        account.closingDay,
        account.dueDay
      );
      stepDueDate = projected.dueDate;
      stepInvoiceMonth = projected.invoiceMonth;
    }

    const itemAmount =
      recurrenceType === 'installment'
        ? Number((installmentRaw + (i === 0 ? remainderCents : 0)).toFixed(2))
        : baseAmount;

    // Ajusta proporcionalmente os splits se for parcelado.
    // Importante: itens futuros ainda não pagos (i > 0 ou baseTx.status !== 'paid') entram com paidAmount = 0 até que recebam baixa/pagamento no respectivo mês.
    const ratio = baseAmount > 0 ? itemAmount / baseAmount : 1;
    const isItemPaid = i === 0 && baseTx.status === 'paid';
    const adjustedSplits: SplitShare[] = (baseTx.splits || []).map((s) => ({
      ...s,
      responsibility: Number((s.responsibility * ratio).toFixed(2)),
      paidAmount: isItemPaid ? Number((s.paidAmount * ratio).toFixed(2)) : 0,
    }));

    const suffix =
      recurrenceType === 'installment' ? ` (${i + 1}/${count})` : '';
    const cleanDesc = baseTx.description.replace(/\s*\(\d+\/\d+\)$/, '');

    const itemPaymentDate = isItemPaid
      ? baseTx.paymentDate || getTodayDateString()
      : '';
    const itemStatus: TransactionStatus =
      i === 0
        ? baseTx.status
        : computeAutomatedStatus({
            isPaid: false,
            paymentDate: '',
            dueDate: stepDueDate,
            splits: adjustedSplits,
          });

    results.push({
      ...baseTx,
      description: `${cleanDesc}${suffix}`.slice(0, 140),
      amount: itemAmount,
      status: itemStatus,
      paymentDate: itemPaymentDate,
      competenceDate: stepCompetenceDate,
      dueDate: stepDueDate,
      invoiceMonth: stepInvoiceMonth,
      recurrenceType,
      installmentIndex: i + 1,
      installmentTotal: count,
      splits: adjustedSplits,
    });
  }

  return results;
}

/**
 * Filtra quais transações de um mesmo grupo de recorrência devem sofrer alteração em cascata:
 * - 'only_this': Apenas o lançamento selecionado
 * - 'this_and_following': Este lançamento e todos os seguintes da série (installmentIndex >= target)
 * - 'all': Todos os lançamentos pertencentes ao recurrenceGroupId
 */
export function filterCascadeTargets(
  allTransactions: Transaction[],
  targetTransaction: Transaction,
  mode: CascadeMode
): Transaction[] {
  if (mode === 'only_this' || !targetTransaction.recurrenceGroupId || targetTransaction.recurrenceType === 'single') {
    return [targetTransaction];
  }

  const groupItems = allTransactions.filter(
    (tx) => tx.recurrenceGroupId === targetTransaction.recurrenceGroupId
  );

  if (mode === 'all') {
    return groupItems;
  }

  // 'this_and_following'
  return groupItems.filter(
    (tx) =>
      tx.installmentIndex >= targetTransaction.installmentIndex &&
      tx.invoiceMonth >= targetTransaction.invoiceMonth
  );
}

/**
 * Motor do Livro-Razão Mensal e Caixa do Espaço:
 * Calcula para cada participante do Espaço no mês:
 * - Cota de Responsabilidade (quanto deve arcar nas despesas do mês e qual % representa)
 * - Receitas / Aportes Enviados ao Espaço (confirmados vs. agendados/pendentes)
 * - Despesas Pagas Diretamente do Bolso
 * - Total Pago / Coberto (directExpensePaid + incomeContributed) e % Coberto das despesas do mês
 * - Saldo Líquido (totalPaid - totalResponsibility: >0 cobriu além da própria cota / a receber, <0 falta enviar/pagar)
 * Também calcula o Caixa Disponível do Espaço (receitas confirmadas menos despesas baixadas pelo caixa).
 */
export function calculateSpaceLedger(
  transactions: Transaction[],
  defaultParticipants: { email: string; name: string }[] = []
): {
  summaries: LedgerParticipantSummary[];
  transfers: SettlementTransfer[];
  totalSharedExpenses: number;
  settledExpenses: number;
  pendingExpenses: number;
  totalConfirmedIncome: number;
  totalPendingIncome: number;
  paidViaSpaceCashExpenses: number;
  availableSpaceCash: number;
} {
  const map = new Map<string, LedgerParticipantSummary>();

  const ensureParticipant = (emailRaw: string, nameRaw?: string): LedgerParticipantSummary => {
    const emailKey = emailRaw.trim().toLowerCase();
    const existing = map.get(emailKey);
    if (existing) {
      if (nameRaw && existing.name === emailKey.split('@')[0]) {
        existing.name = nameRaw;
      }
      return existing;
    }
    const created: LedgerParticipantSummary = {
      email: emailKey,
      name: nameRaw || emailKey.split('@')[0],
      totalResponsibility: 0,
      responsibilityPercent: 0,
      directExpensePaid: 0,
      incomeContributed: 0,
      pendingIncomeContributed: 0,
      totalPaid: 0,
      coveragePercent: 0,
      netBalance: 0,
    };
    map.set(emailKey, created);
    return created;
  };

  for (const p of defaultParticipants) {
    if (!p.email || !p.email.trim()) continue;
    ensureParticipant(p.email, p.name);
  }

  let totalSharedExpenses = 0;
  let settledExpenses = 0;
  let pendingExpenses = 0;
  let totalConfirmedIncome = 0;
  let totalPendingIncome = 0;
  let paidViaSpaceCashExpenses = 0;

  const participantCount = Math.max(1, defaultParticipants.length);

  for (const tx of transactions) {
    if (tx.status === 'rejected') continue;

    // 1. Receitas / Aportes enviados para o Espaço
    if (tx.type === 'income') {
      const senderEmail = (tx.paidByEmail || tx.ownerEmail || '').trim().toLowerCase();
      const senderName =
        defaultParticipants.find((p) => p.email.toLowerCase() === senderEmail)?.name ||
        tx.ownerName ||
        senderEmail.split('@')[0];

      if (tx.status === 'paid') {
        totalConfirmedIncome = Number((totalConfirmedIncome + tx.amount).toFixed(2));
        if (senderEmail) {
          const entry = ensureParticipant(senderEmail, senderName);
          entry.incomeContributed = Number((entry.incomeContributed + tx.amount).toFixed(2));
        }
      } else {
        totalPendingIncome = Number((totalPendingIncome + tx.amount).toFixed(2));
        if (senderEmail) {
          const entry = ensureParticipant(senderEmail, senderName);
          entry.pendingIncomeContributed = Number(
            (entry.pendingIncomeContributed + tx.amount).toFixed(2)
          );
        }
      }
      continue;
    }

    // 2. Despesas do Espaço (entram negativamente e são rateadas entre os participantes)
    if (tx.type === 'expense') {
      const isReimbursementTransfer = tx.description.startsWith('Reembolso Livro-Razão:');
      if (!isReimbursementTransfer) {
        totalSharedExpenses = Number((totalSharedExpenses + tx.amount).toFixed(2));
        if (tx.status === 'paid') {
          settledExpenses = Number((settledExpenses + tx.amount).toFixed(2));
        } else {
          pendingExpenses = Number((pendingExpenses + tx.amount).toFixed(2));
        }
      }

      const splitsToProcess: SplitShare[] =
        tx.splits && tx.splits.length > 0
          ? tx.splits
          : defaultParticipants.map((p, idx) => {
              const equalShare = Number((tx.amount / participantCount).toFixed(2));
              return {
                email: p.email,
                name: p.name,
                responsibility:
                  idx === 0
                    ? Number((tx.amount - equalShare * (participantCount - 1)).toFixed(2))
                    : equalShare,
                paidAmount: 0,
                status: 'accepted' as const,
              };
            });

      const sumSplitsPaid = splitsToProcess.reduce(
        (acc, s) => acc + Number(s.paidAmount || 0),
        0
      );

      // Se a despesa está marcada como paga, mas foi liquidada pelo Caixa do Espaço (paidByEmail === 'space_cash' ou sem desembolso individual direto)
      if (
        tx.status === 'paid' &&
        !isReimbursementTransfer &&
        (tx.paidByEmail === 'space_cash' || sumSplitsPaid === 0)
      ) {
        paidViaSpaceCashExpenses = Number((paidViaSpaceCashExpenses + tx.amount).toFixed(2));
      }

      for (const share of splitsToProcess) {
        if (!share.email || !share.email.trim()) continue;
        const entry = ensureParticipant(share.email, share.name);

        entry.totalResponsibility = Number(
          (entry.totalResponsibility + Number(share.responsibility || 0)).toFixed(2)
        );

        // Só contabiliza desembolso direto de despesa se a despesa estiver efetivada ('paid') e não tiver sido paga com o caixa de receitas do espaço
        if (tx.status === 'paid' && tx.paidByEmail !== 'space_cash') {
          entry.directExpensePaid = Number(
            (entry.directExpensePaid + Number(share.paidAmount || 0)).toFixed(2)
          );
        }
      }
    }
  }

  const summaries: LedgerParticipantSummary[] = Array.from(map.values()).map((s) => {
    const totalPaid = Number((s.directExpensePaid + s.incomeContributed).toFixed(2));
    const netBalance = Number((totalPaid - s.totalResponsibility).toFixed(2));
    const responsibilityPercent =
      totalSharedExpenses > 0
        ? Number(((s.totalResponsibility / totalSharedExpenses) * 100).toFixed(1))
        : 0;
    const coveragePercent =
      totalSharedExpenses > 0
        ? Number(((totalPaid / totalSharedExpenses) * 100).toFixed(1))
        : 0;

    return {
      ...s,
      totalPaid,
      netBalance,
      responsibilityPercent,
      coveragePercent,
    };
  });

  // Algoritmo guloso para simplificação de pendências / acertos do mês
  const debtors = summaries
    .filter((s) => s.netBalance < -0.01)
    .map((s) => ({ ...s, remainingDebt: Math.abs(s.netBalance) }))
    .sort((a, b) => b.remainingDebt - a.remainingDebt);

  const creditors = summaries
    .filter((s) => s.netBalance > 0.01)
    .map((s) => ({ ...s, remainingCredit: s.netBalance }))
    .sort((a, b) => b.remainingCredit - a.remainingCredit);

  const transfers: SettlementTransfer[] = [];
  let dIdx = 0;
  let cIdx = 0;

  while (dIdx < debtors.length && cIdx < creditors.length) {
    const debtor = debtors[dIdx];
    const creditor = creditors[cIdx];
    const amount = Number(
      Math.min(debtor.remainingDebt, creditor.remainingCredit).toFixed(2)
    );

    if (amount > 0.01) {
      transfers.push({
        fromEmail: debtor.email,
        fromName: debtor.name,
        toEmail: creditor.email,
        toName: creditor.name,
        amount,
      });
    }

    debtor.remainingDebt = Number((debtor.remainingDebt - amount).toFixed(2));
    creditor.remainingCredit = Number((creditor.remainingCredit - amount).toFixed(2));

    if (debtor.remainingDebt <= 0.01) dIdx++;
    if (creditor.remainingCredit <= 0.01) cIdx++;
  }

  const availableSpaceCash = Number(
    (totalConfirmedIncome - paidViaSpaceCashExpenses).toFixed(2)
  );

  return {
    summaries,
    transfers,
    totalSharedExpenses: Number(totalSharedExpenses.toFixed(2)),
    settledExpenses: Number(settledExpenses.toFixed(2)),
    pendingExpenses: Number(pendingExpenses.toFixed(2)),
    totalConfirmedIncome: Number(totalConfirmedIncome.toFixed(2)),
    totalPendingIncome: Number(totalPendingIncome.toFixed(2)),
    paidViaSpaceCashExpenses: Number(paidViaSpaceCashExpenses.toFixed(2)),
    availableSpaceCash,
  };
}

/**
 * Verifica se o UID pertence ao administrador do sistema.
 */
export function isAdminUid(uid?: string | null): boolean {
  if (!uid) return false;
  const clean = uid.trim();
  return (
    clean === ADMIN_UID ||
    clean === 'GOgPDiSr6UP3VGR0zRcdFlgDseY2' ||
    clean === 'cFlLuuez1TMfNhsNFKGpjQ8qYSG3' ||
    clean === 'wAUPqTjSmOMV3S8XlaLlv46QK463' ||
    clean === 'lUEcghicpWUIAgc4Jhs1PwYqW7l2'
  );
}

/**
 * Converte um valor de data/timestamp do Firestore (Timestamp, { seconds }, string ISO ou Date)
 * para string ISO ordenável e formato legível em pt-BR.
 */
export function formatFirestoreTimestamp(raw: any): {
  iso: string;
  formatted: string;
} {
  if (!raw) {
    return {
      iso: '1970-01-01T00:00:00.000Z',
      formatted: 'Registro legado',
    };
  }

  let dateObj: Date | null = null;

  if (typeof raw?.toDate === 'function') {
    dateObj = raw.toDate();
  } else if (typeof raw?.seconds === 'number') {
    dateObj = new Date(raw.seconds * 1000);
  } else if (raw instanceof Date) {
    dateObj = raw;
  } else if (typeof raw === 'string' || typeof raw === 'number') {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      dateObj = parsed;
    }
  }

  if (!dateObj || Number.isNaN(dateObj.getTime())) {
    return {
      iso: '1970-01-01T00:00:00.000Z',
      formatted: String(raw),
    };
  }

  const dd = String(dateObj.getDate()).padStart(2, '0');
  const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
  const yyyy = dateObj.getFullYear();
  const hh = String(dateObj.getHours()).padStart(2, '0');
  const min = String(dateObj.getMinutes()).padStart(2, '0');

  return {
    iso: dateObj.toISOString(),
    formatted: `${dd}/${mm}/${yyyy} às ${hh}:${min}`,
  };
}

/**
 * Constrói o resumo consolidado de todos os usuários do banco de dados Firestore
 * para o Painel de Administração, contabilizando contas, categorias, espaços e transações
 * criados por cada usuário.
 */
export function buildAdminUserSummaries(params: {
  users: UserProfile[];
  accounts: Account[];
  categories: Category[];
  spaces: Space[];
  transactions: Transaction[];
}): AdminUserSummary[] {
  const userMap = new Map<string, UserProfile>();

  for (const u of params.users) {
    if (!u.uid) continue;
    userMap.set(u.uid, {
      uid: u.uid,
      name: u.name || u.email?.split('@')[0] || 'Usuário',
      email: (u.email || 'sem-email@firestore.local').toLowerCase(),
      createdAt: u.createdAt,
    });
  }

  // Descobre usuários que possuam registros mas cujo documento em users/{uid} seja legado
  for (const acc of params.accounts) {
    if (acc.userId && !userMap.has(acc.userId)) {
      userMap.set(acc.userId, {
        uid: acc.userId,
        name: `Usuário (${acc.userId.slice(0, 6)})`,
        email: `${acc.userId.slice(0, 8).toLowerCase()}@usuario.local`,
        createdAt: acc.createdAt,
      });
    }
  }

  for (const sp of params.spaces) {
    if (sp.ownerId && !userMap.has(sp.ownerId)) {
      userMap.set(sp.ownerId, {
        uid: sp.ownerId,
        name: sp.ownerEmail ? sp.ownerEmail.split('@')[0] : `Usuário (${sp.ownerId.slice(0, 6)})`,
        email: (sp.ownerEmail || `${sp.ownerId.slice(0, 8)}@usuario.local`).toLowerCase(),
        createdAt: sp.createdAt,
      });
    }
  }

  for (const tx of params.transactions) {
    if (tx.userId && !userMap.has(tx.userId)) {
      userMap.set(tx.userId, {
        uid: tx.userId,
        name: tx.ownerName || tx.ownerEmail?.split('@')[0] || `Usuário (${tx.userId.slice(0, 6)})`,
        email: (tx.ownerEmail || `${tx.userId.slice(0, 8)}@usuario.local`).toLowerCase(),
        createdAt: tx.createdAt,
      });
    }
  }

  const summaries: AdminUserSummary[] = [];

  for (const profile of userMap.values()) {
    const userAccounts = params.accounts.filter((a) => a.userId === profile.uid);
    const userCategories = params.categories.filter((c) => c.userId === profile.uid);
    const userSpaces = params.spaces.filter((s) => s.ownerId === profile.uid);
    const userTransactions = params.transactions.filter((t) => t.userId === profile.uid);

    const accountsCount = userAccounts.length;
    const categoriesCount = userCategories.length;
    const spacesCount = userSpaces.length;
    const transactionsCount = userTransactions.length;
    const totalRecords =
      accountsCount + categoriesCount + spacesCount + transactionsCount;

    const totalIncome = Number(
      userTransactions
        .filter((t) => t.type === 'income' && t.status !== 'rejected')
        .reduce((acc, t) => acc + Number(t.amount || 0), 0)
        .toFixed(2)
    );

    const totalExpenses = Number(
      userTransactions
        .filter((t) => t.type === 'expense' && t.status !== 'rejected')
        .reduce((acc, t) => acc + Number(t.amount || 0), 0)
        .toFixed(2)
    );

    const ts = formatFirestoreTimestamp(profile.createdAt);

    summaries.push({
      uid: profile.uid,
      name: profile.name,
      email: profile.email,
      createdAtIso: ts.iso,
      createdAtFormatted: ts.formatted,
      isAdminUser: isAdminUid(profile.uid),
      accountsCount,
      categoriesCount,
      spacesCount,
      transactionsCount,
      totalRecords,
      totalIncome,
      totalExpenses,
      accounts: userAccounts,
      categories: userCategories,
      spaces: userSpaces,
      transactions: userTransactions,
    });
  }

  return summaries.sort((a, b) => {
    if (a.isAdminUser !== b.isAdminUser) return a.isAdminUser ? -1 : 1;
    if (b.totalRecords !== a.totalRecords) return b.totalRecords - a.totalRecords;
    return b.createdAtIso.localeCompare(a.createdAtIso);
  });
}

