import React, { useEffect, useState } from 'react';
import { Account, AccountType, Transaction } from '../types/finance';
import { addMonthsToYearMonth, formatCurrency } from '../utils/financeEngine';

interface AccountsCardsViewProps {
  accounts: Account[];
  transactions: Transaction[];
  selectedMonth: string; // YYYY-MM
  onCreateAccount: (acc: Omit<Account, 'id' | 'userId'>) => Promise<void>;
  onUpdateAccount: (
    accountId: string,
    acc: Omit<Account, 'id' | 'userId'>
  ) => Promise<void>;
  onDeleteAccount: (accountId: string) => Promise<void>;
  onPayInvoice: (
    card: Account,
    invoiceMonth: string,
    sourceCheckingId: string
  ) => Promise<void>;
  onOpenNewTransactionForAccount: (accountId: string) => void;
  onSelectTransaction: (tx: Transaction) => void;
}

export const AccountsCardsView: React.FC<AccountsCardsViewProps> = ({
  accounts,
  transactions,
  selectedMonth,
  onCreateAccount,
  onUpdateAccount,
  onDeleteAccount,
  onPayInvoice,
  onOpenNewTransactionForAccount,
  onSelectTransaction,
}) => {
  const [drawerAccount, setDrawerAccount] = useState<Account | null>(null);
  const [drawerMonth, setDrawerMonth] = useState<string>(selectedMonth);
  const [paySourceId, setPaySourceId] = useState<string>('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [deletingAccount, setDeletingAccount] = useState<Account | null>(null);

  // Estado do formulário (Criação e Edição)
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<AccountType>('checking');
  const [newBalance, setNewBalance] = useState('0');
  const [newLimit, setNewLimit] = useState('10000');
  const [newClosingDay, setNewClosingDay] = useState('10');
  const [newDueDay, setNewDueDay] = useState('17');
  const [newColor, setNewColor] = useState('indigo');
  const [newIcon, setNewIcon] = useState('ph-bank');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Trava a rolagem do body quando a gaveta de extrato ou modal está aberta (elimina dupla barra de rolagem)
  useEffect(() => {
    const anyOpen = Boolean(drawerAccount || isModalOpen || deletingAccount);
    if (!anyOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [drawerAccount, isModalOpen, deletingAccount]);

  const checkingAccounts = accounts.filter((a) => a.type === 'checking');
  const creditCards = accounts.filter((a) => a.type === 'credit');

  // Calcula o saldo dinâmico da conta corrente (saldo inicial + receitas pagas - despesas pagas)
  const getCheckingDynamicBalance = (acc: Account): number => {
    const accTxs = transactions.filter(
      (tx) => tx.accountId === acc.id && tx.status === 'paid'
    );
    const delta = accTxs.reduce(
      (sum, tx) => sum + (tx.type === 'income' ? tx.amount : -tx.amount),
      0
    );
    return Number((acc.balance + delta).toFixed(2));
  };

  // Calcula fatura de um cartão em determinado mês YYYY-MM
  const getCardInvoiceSummary = (card: Account, ym: string) => {
    const items = transactions.filter(
      (tx) =>
        tx.accountId === card.id &&
        tx.invoiceMonth === ym &&
        tx.status !== 'rejected'
    );
    const totalInvoice = items.reduce(
      (sum, tx) => sum + (tx.type === 'expense' ? tx.amount : -tx.amount),
      0
    );
    const unpaidInvoice = items
      .filter((tx) => tx.status !== 'paid')
      .reduce(
        (sum, tx) => sum + (tx.type === 'expense' ? tx.amount : -tx.amount),
        0
      );

    // Limite comprometido total (todas as parcelas pendentes/em validação em qualquer mês)
    const totalUsedLimit = transactions
      .filter(
        (tx) =>
          tx.accountId === card.id &&
          tx.type === 'expense' &&
          tx.status !== 'paid' &&
          tx.status !== 'rejected'
      )
      .reduce((sum, tx) => sum + tx.amount, 0);

    return {
      items,
      totalInvoice: Math.max(0, Number(totalInvoice.toFixed(2))),
      unpaidInvoice: Math.max(0, Number(unpaidInvoice.toFixed(2))),
      totalUsedLimit: Math.max(0, Number(totalUsedLimit.toFixed(2))),
      allPaid: items.length > 0 && unpaidInvoice <= 0.01,
    };
  };

  const openAccountDrawer = (acc: Account) => {
    setDrawerAccount(acc);
    setDrawerMonth(selectedMonth);
    if (checkingAccounts.length > 0) {
      setPaySourceId(checkingAccounts[0].id);
    }
  };

  const handleOpenCreateModal = () => {
    setEditingAccount(null);
    setFormError(null);
    setNewName('');
    setNewType('checking');
    setNewBalance('0');
    setNewLimit('10000');
    setNewClosingDay('10');
    setNewDueDay('17');
    setNewColor('indigo');
    setNewIcon('ph-bank');
    setIsModalOpen(true);
  };

  const handleOpenEditModal = (acc: Account) => {
    setEditingAccount(acc);
    setFormError(null);
    setNewName(acc.name);
    setNewType(acc.type);
    setNewBalance(String(acc.balance ?? 0));
    setNewLimit(String(acc.limit ?? 10000));
    setNewClosingDay(String(acc.closingDay ?? 10));
    setNewDueDay(String(acc.dueDay ?? 17));
    setNewColor(acc.color || (acc.type === 'credit' ? 'purple' : 'indigo'));
    setNewIcon(acc.icon || (acc.type === 'credit' ? 'ph-credit-card' : 'ph-bank'));
    setIsModalOpen(true);
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!newName.trim()) {
      setFormError('Informe o nome da conta ou cartão.');
      return;
    }

    const payload: Omit<Account, 'id' | 'userId'> = {
      name: newName.trim().slice(0, 80),
      type: newType,
      balance: newType === 'checking' ? Number(newBalance) || 0 : 0,
      limit: newType === 'credit' ? Math.max(100, Number(newLimit) || 5000) : 0,
      closingDay:
        newType === 'credit'
          ? Math.min(31, Math.max(1, Number(newClosingDay) || 10))
          : 1,
      dueDay:
        newType === 'credit'
          ? Math.min(31, Math.max(1, Number(newDueDay) || 17))
          : 1,
      color: newColor,
      icon: newType === 'credit' ? 'ph-credit-card' : newIcon,
    };

    setSubmitting(true);
    try {
      if (editingAccount) {
        await onUpdateAccount(editingAccount.id, payload);
        if (drawerAccount && drawerAccount.id === editingAccount.id) {
          setDrawerAccount({ ...drawerAccount, ...payload });
        }
      } else {
        await onCreateAccount(payload);
      }
      setNewName('');
      setEditingAccount(null);
      setIsModalOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingAccount) return;
    setSubmitting(true);
    try {
      await onDeleteAccount(deletingAccount.id);
      if (drawerAccount && drawerAccount.id === deletingAccount.id) {
        setDrawerAccount(null);
      }
      setDeletingAccount(null);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Cabeçalho da Seção */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white">Contas Bancárias & Cartões</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Gerencie saldos, limites, datas de corte/vencimento, edite ou exclua contas e cartões.
          </p>
        </div>

        <button
          type="button"
          onClick={handleOpenCreateModal}
          className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl shadow-lg shadow-indigo-600/20 flex items-center gap-2 self-start sm:self-auto cursor-pointer whitespace-nowrap"
        >
          <i className="ph-bold ph-plus"></i>
          <span>Nova Conta ou Cartão</span>
        </button>
      </div>

      {/* Grupo 1: Contas Bancárias (Carteira) */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
            <i className="ph-fill ph-bank text-indigo-400 text-lg"></i>
            <span>Contas Bancárias & Carteira ({checkingAccounts.length})</span>
          </h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {checkingAccounts.map((acc) => {
            const currentBal = getCheckingDynamicBalance(acc);
            const monthCount = transactions.filter(
              (tx) => tx.accountId === acc.id && tx.invoiceMonth === selectedMonth
            ).length;

            return (
              <div
                key={acc.id}
                className="bg-slate-800 border border-slate-700/80 hover:border-indigo-500/50 rounded-3xl p-6 transition-all flex flex-col justify-between group"
              >
                <div>
                  <div className="flex items-start justify-between gap-3 mb-5">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-11 h-11 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 text-indigo-400 flex items-center justify-center shrink-0">
                        <i className={`ph-fill ${acc.icon || 'ph-bank'} text-xl`}></i>
                      </div>
                      <div className="min-w-0">
                        <h4 className="text-base font-bold text-white truncate">
                          {acc.name}
                        </h4>
                        <span className="text-xs text-slate-400">
                          Conta Corrente · Liquidez Imediata
                        </span>
                      </div>
                    </div>

                    {/* Ações diretas de Editar e Excluir no card */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        aria-label={`Editar ${acc.name}`}
                        title="Editar Conta"
                        onClick={() => handleOpenEditModal(acc)}
                        className="w-8 h-8 rounded-xl bg-slate-900 hover:bg-slate-700 text-slate-300 hover:text-white flex items-center justify-center transition-colors cursor-pointer"
                      >
                        <i className="ph ph-pencil-simple text-sm"></i>
                      </button>
                      <button
                        type="button"
                        aria-label={`Excluir ${acc.name}`}
                        title="Excluir Conta"
                        onClick={() => setDeletingAccount(acc)}
                        className="w-8 h-8 rounded-xl bg-slate-900 hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 flex items-center justify-center transition-colors cursor-pointer"
                      >
                        <i className="ph ph-trash text-sm"></i>
                      </button>
                    </div>
                  </div>

                  <div className="mb-5">
                    <span className="text-xs text-slate-400 block mb-1">
                      Saldo Atual Disponível
                    </span>
                    <span
                      className={`text-2xl font-bold font-mono tabular-nums ${
                        currentBal >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {formatCurrency(currentBal)}
                    </span>
                  </div>
                </div>

                <div className="pt-4 border-t border-slate-700/60 flex items-center justify-between text-xs">
                  <span className="text-slate-400 font-mono tabular-nums">
                    {monthCount} lançamentos em {selectedMonth}
                  </span>
                  <button
                    type="button"
                    aria-label={`Ver Extrato de ${acc.name}`}
                    onClick={() => openAccountDrawer(acc)}
                    className="text-indigo-400 hover:text-indigo-300 font-semibold flex items-center gap-1 cursor-pointer"
                  >
                    <span>Ver Extrato</span>
                    <i className="ph-bold ph-arrow-right"></i>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Grupo 2: Cartões de Crédito */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
            <i className="ph-fill ph-credit-card text-purple-400 text-lg"></i>
            <span>Cartões de Crédito ({creditCards.length})</span>
          </h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {creditCards.map((card) => {
            const summary = getCardInvoiceSummary(card, selectedMonth);
            const usedPercentage =
              card.limit > 0
                ? Math.min(100, Math.round((summary.totalUsedLimit / card.limit) * 100))
                : 0;
            const availableLimit = Math.max(0, card.limit - summary.totalUsedLimit);

            return (
              <div
                key={card.id}
                className="bg-slate-800 border border-slate-700/80 hover:border-purple-500/50 rounded-3xl p-6 transition-all flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-start justify-between gap-3 mb-5">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-11 h-11 rounded-2xl bg-purple-500/15 border border-purple-500/30 text-purple-400 flex items-center justify-center shrink-0">
                        <i className="ph-fill ph-credit-card text-xl"></i>
                      </div>
                      <div className="min-w-0">
                        <h4 className="text-base font-bold text-white truncate">
                          {card.name}
                        </h4>
                        <div className="flex items-center gap-2 text-xs text-slate-400 mt-0.5 font-mono tabular-nums">
                          <span>Corte dia {String(card.closingDay).padStart(2, '0')}</span>
                          <span aria-hidden="true">·</span>
                          <span>Vence dia {String(card.dueDay).padStart(2, '0')}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs font-semibold text-purple-300 hidden sm:inline">
                        {summary.allPaid ? 'Fatura Paga' : `Fatura ${selectedMonth}`}
                      </span>

                      <button
                        type="button"
                        aria-label={`Editar ${card.name}`}
                        title="Editar Cartão"
                        onClick={() => handleOpenEditModal(card)}
                        className="w-8 h-8 rounded-xl bg-slate-900 hover:bg-slate-700 text-slate-300 hover:text-white flex items-center justify-center transition-colors cursor-pointer"
                      >
                        <i className="ph ph-pencil-simple text-sm"></i>
                      </button>
                      <button
                        type="button"
                        aria-label={`Excluir ${card.name}`}
                        title="Excluir Cartão"
                        onClick={() => setDeletingAccount(card)}
                        className="w-8 h-8 rounded-xl bg-slate-900 hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 flex items-center justify-center transition-colors cursor-pointer"
                      >
                        <i className="ph ph-trash text-sm"></i>
                      </button>
                    </div>
                  </div>

                  {/* Fatura do Mês vs Limite Disponível */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 mb-5 p-3.5 sm:p-4 rounded-2xl bg-slate-900/60 border border-slate-700/60">
                    <div className="flex sm:block items-center justify-between">
                      <span className="text-xs text-slate-400 block sm:mb-1">
                        Fatura em {selectedMonth}
                      </span>
                      <span className="text-lg sm:text-xl font-bold text-rose-400 font-mono tabular-nums">
                        {formatCurrency(summary.totalInvoice)}
                      </span>
                    </div>
                    <div className="flex sm:block items-center justify-between sm:text-right pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-800">
                      <span className="text-xs text-slate-400 block sm:mb-1">
                        Limite Disponível
                      </span>
                      <span className="text-lg sm:text-xl font-bold text-emerald-400 font-mono tabular-nums">
                        {formatCurrency(availableLimit)}
                      </span>
                    </div>
                  </div>

                  {/* Barra de Progresso de Limite */}
                  <div className="mb-5">
                    <div className="flex flex-wrap items-center justify-between gap-1 text-xs mb-1.5 font-mono tabular-nums">
                      <span className="text-slate-400">
                        Comprometido: {formatCurrency(summary.totalUsedLimit)} ({usedPercentage}%)
                      </span>
                      <span className="text-slate-300">
                        Limite Total: {formatCurrency(card.limit)}
                      </span>
                    </div>
                    <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          usedPercentage > 80
                            ? 'bg-rose-500'
                            : usedPercentage > 50
                            ? 'bg-amber-500'
                            : 'bg-purple-500'
                        }`}
                        style={{ width: `${usedPercentage}%` }}
                      />
                    </div>
                  </div>
                </div>

                <div className="pt-4 border-t border-slate-700/60 flex flex-wrap items-center justify-between gap-2.5">
                  <button
                    type="button"
                    onClick={() => onOpenNewTransactionForAccount(card.id)}
                    className="text-xs text-slate-300 hover:text-white font-medium flex items-center gap-1.5 cursor-pointer"
                  >
                    <i className="ph-bold ph-plus-circle text-purple-400"></i>
                    <span>Lançar no Cartão</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => openAccountDrawer(card)}
                    className="px-3.5 py-2 rounded-xl bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/30 text-purple-300 text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
                  >
                    <i className="ph-fill ph-receipt"></i>
                    <span>Abrir Fatura & Extrato</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Gaveta Lateral (Drawer) de Extrato da Conta / Fatura do Cartão com Rolagem Única */}
      {drawerAccount && (
        <div
          className="fixed inset-0 z-40 bg-slate-950/80 backdrop-blur-xs flex justify-end"
          role="dialog"
          aria-modal="true"
          aria-label={`Extrato de ${drawerAccount.name}`}
          onClick={() => setDrawerAccount(null)}
        >
          <div
            className="w-full max-w-xl bg-slate-900 border-l border-slate-800 h-dvh flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Topo Fixo do Drawer */}
            <div className="p-4 sm:p-6 pb-4 border-b border-slate-800 shrink-0">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 ${
                      drawerAccount.type === 'credit'
                        ? 'bg-purple-500/15 text-purple-400'
                        : 'bg-indigo-500/15 text-indigo-400'
                    }`}
                  >
                    <i
                      className={`ph-fill ${
                        drawerAccount.type === 'credit' ? 'ph-credit-card' : 'ph-bank'
                      } text-xl`}
                    ></i>
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-base sm:text-lg font-bold text-white truncate">
                      {drawerAccount.name}
                    </h3>
                    <p className="text-xs text-slate-400">
                      {drawerAccount.type === 'credit'
                        ? `Cartão de Crédito · Corte dia ${drawerAccount.closingDay} · Vence dia ${drawerAccount.dueDay}`
                        : 'Extrato de Conta Bancária / Carteira'}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleOpenEditModal(drawerAccount)}
                    aria-label={`Editar configurações de ${drawerAccount.name}`}
                    className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                  >
                    <i className="ph ph-pencil-simple"></i>
                    <span className="hidden sm:inline">Editar</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setDrawerAccount(null)}
                    aria-label="Fechar gaveta de extrato"
                    className="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center cursor-pointer"
                  >
                    <i className="ph-bold ph-x"></i>
                  </button>
                </div>
              </div>

              {/* Paginação de Faturas / Meses */}
              <div className="mt-4 flex items-center justify-between gap-2 bg-slate-800 border border-slate-700/80 p-2 sm:p-2.5 rounded-2xl">
                <button
                  type="button"
                  onClick={() => setDrawerMonth(addMonthsToYearMonth(drawerMonth, -1))}
                  className="px-2.5 sm:px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-700 text-[11px] sm:text-xs font-semibold text-slate-300 flex items-center gap-1 cursor-pointer shrink-0"
                >
                  <i className="ph-bold ph-caret-left"></i>
                  <span>Anterior</span>
                </button>

                <div className="text-center min-w-0">
                  <span className="text-[11px] sm:text-xs text-slate-400 block truncate">
                    {drawerAccount.type === 'credit'
                      ? 'Competência da Fatura'
                      : 'Período do Extrato'}
                  </span>
                  <span className="text-xs sm:text-sm font-bold text-white font-mono tabular-nums">
                    {drawerMonth}
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => setDrawerMonth(addMonthsToYearMonth(drawerMonth, 1))}
                  className="px-2.5 sm:px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-700 text-[11px] sm:text-xs font-semibold text-slate-300 flex items-center gap-1 cursor-pointer shrink-0"
                >
                  <span>Próximo</span>
                  <i className="ph-bold ph-caret-right"></i>
                </button>
              </div>
            </div>

            {/* Corpo Rolável Único do Extrato */}
            <div className="p-4 sm:p-6 overflow-y-auto flex-1 overscroll-contain">
              {(() => {
                const summary = getCardInvoiceSummary(drawerAccount, drawerMonth);
                return (
                  <div className="space-y-5">
                    <div className="p-4 rounded-2xl bg-slate-800/90 border border-slate-700/80 flex items-center justify-between">
                      <div>
                        <span className="text-xs text-slate-400 block">
                          {drawerAccount.type === 'credit'
                            ? `Total da Fatura (${drawerMonth})`
                            : `Movimentação Líquida (${drawerMonth})`}
                        </span>
                        <span className="text-2xl font-bold text-white font-mono tabular-nums">
                          {formatCurrency(
                            drawerAccount.type === 'credit'
                              ? summary.totalInvoice
                              : getCheckingDynamicBalance(drawerAccount)
                          )}
                        </span>
                      </div>

                      {drawerAccount.type === 'credit' && (
                        <div className="text-right">
                          <span className="text-xs text-slate-400 block">Em Aberto</span>
                          <span
                            className={`text-sm font-bold font-mono tabular-nums ${
                              summary.unpaidInvoice > 0
                                ? 'text-amber-400'
                                : 'text-emerald-400'
                            }`}
                          >
                            {summary.unpaidInvoice > 0
                              ? formatCurrency(summary.unpaidInvoice)
                              : 'Fatura Quitada'}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Botão de Pagamento de Fatura para Cartão de Crédito */}
                    {drawerAccount.type === 'credit' && summary.unpaidInvoice > 0 && (
                      <div className="p-4 rounded-2xl bg-purple-500/10 border border-purple-500/30 space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-purple-200">
                            Liquidar Fatura de {drawerMonth}
                          </span>
                          <span className="text-xs font-mono text-purple-300">
                            {formatCurrency(summary.unpaidInvoice)}
                          </span>
                        </div>
                        <div className="flex flex-col sm:flex-row gap-2">
                          <select
                            aria-label="Conta bancária para debitar pagamento da fatura"
                            value={paySourceId}
                            onChange={(e) => setPaySourceId(e.target.value)}
                            className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white"
                          >
                            {checkingAccounts.map((ca) => (
                              <option key={ca.id} value={ca.id}>
                                Debitar de: {ca.name}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() =>
                              onPayInvoice(drawerAccount, drawerMonth, paySourceId)
                            }
                            className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                          >
                            <i className="ph-bold ph-check-circle"></i>
                            <span>Pagar Fatura Agora</span>
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Lista de Lançamentos da Conta/Fatura (Clique abre Detalhes do Lançamento) */}
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="text-xs font-semibold text-slate-400">
                          Lançamentos do Período ({summary.items.length})
                        </h4>
                        <span className="text-[11px] text-indigo-400">
                          Toque em um item para ver detalhes
                        </span>
                      </div>

                      {summary.items.length === 0 ? (
                        <div className="p-8 rounded-2xl bg-slate-800/50 border border-slate-800 text-center">
                          <p className="text-xs text-slate-400">
                            Nenhum lançamento registrado para {drawerMonth} nesta conta.
                          </p>
                        </div>
                      ) : (
                        <div className="space-y-2.5">
                          {summary.items.map((tx) => (
                            <button
                              key={tx.id}
                              type="button"
                              onClick={() => onSelectTransaction(tx)}
                              className="w-full text-left p-3.5 rounded-2xl bg-slate-800/80 hover:bg-slate-800 border border-slate-700/70 hover:border-indigo-500/40 flex items-center justify-between gap-3 transition-all cursor-pointer group"
                            >
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-semibold text-white group-hover:text-indigo-300 truncate flex items-center gap-1.5">
                                  <span className="truncate">{tx.description}</span>
                                  <i className="ph-bold ph-caret-right text-xs text-slate-500 group-hover:text-indigo-400 shrink-0"></i>
                                </p>
                                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 mt-0.5 font-mono tabular-nums">
                                  <span>Compra: {tx.competenceDate}</span>
                                  <span aria-hidden="true">·</span>
                                  <span>Venc: {tx.dueDate}</span>
                                  <span aria-hidden="true">·</span>
                                  <span
                                    className={
                                      tx.status === 'paid'
                                        ? 'text-emerald-400 font-semibold'
                                        : 'text-amber-400'
                                    }
                                  >
                                    {tx.status === 'paid'
                                      ? `Pago em ${tx.paymentDate || tx.dueDate}`
                                      : 'Em aberto'}
                                  </span>
                                </div>
                              </div>
                              <div
                                className={`text-sm font-bold font-mono tabular-nums shrink-0 ${
                                  tx.type === 'income'
                                    ? 'text-emerald-400'
                                    : 'text-rose-400'
                                }`}
                              >
                                {tx.type === 'income' ? '+' : '-'}
                                {formatCurrency(tx.amount)}
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Rodapé Fixo do Drawer */}
            <div className="p-4 sm:px-6 border-t border-slate-800 bg-slate-900 flex items-center justify-between shrink-0">
              <button
                type="button"
                onClick={() => setDeletingAccount(drawerAccount)}
                className="text-xs text-rose-400 hover:text-rose-300 font-medium flex items-center gap-1.5 cursor-pointer"
              >
                <i className="ph ph-trash"></i>
                <span>Excluir Conta/Cartão</span>
              </button>

              <button
                type="button"
                onClick={() => setDrawerAccount(null)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 cursor-pointer"
              >
                Fechar Extrato
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Criar ou Editar Conta / Cartão */}
      {isModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-xs flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={
            editingAccount ? 'Editar Conta ou Cartão' : 'Cadastrar Conta ou Cartão'
          }
        >
          <div className="w-full max-w-md bg-slate-800 border border-slate-700 rounded-3xl p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-bold text-white">
                {editingAccount
                  ? `Editar: ${editingAccount.name}`
                  : 'Nova Conta ou Cartão'}
              </h3>
              <button
                type="button"
                onClick={() => {
                  setIsModalOpen(false);
                  setEditingAccount(null);
                }}
                aria-label="Fechar modal"
                className="w-8 h-8 rounded-xl bg-slate-700/60 text-slate-400 hover:text-white flex items-center justify-center cursor-pointer"
              >
                <i className="ph-bold ph-x"></i>
              </button>
            </div>

            {formError && (
              <div className="mb-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
                {formError}
              </div>
            )}

            <form onSubmit={handleFormSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-2 p-1 bg-slate-900 rounded-2xl">
                <button
                  type="button"
                  onClick={() => {
                    setNewType('checking');
                    setNewColor('indigo');
                  }}
                  className={`py-2 rounded-xl text-xs font-semibold transition-all cursor-pointer ${
                    newType === 'checking'
                      ? 'bg-indigo-600 text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Conta Bancária
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setNewType('credit');
                    setNewColor('purple');
                  }}
                  className={`py-2 rounded-xl text-xs font-semibold transition-all cursor-pointer ${
                    newType === 'credit'
                      ? 'bg-purple-600 text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Cartão de Crédito
                </button>
              </div>

              <div>
                <label
                  htmlFor="new-acc-name"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  Nome de Identificação
                </label>
                <input
                  id="new-acc-name"
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={
                    newType === 'checking'
                      ? 'Ex: Bradesco Principal'
                      : 'Ex: Cartão C6 Carbon'
                  }
                  className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white"
                />
              </div>

              {newType === 'checking' ? (
                <div>
                  <label
                    htmlFor="new-acc-balance"
                    className="block text-xs font-medium text-slate-300 mb-1"
                  >
                    Saldo Inicial / Base (R$)
                  </label>
                  <input
                    id="new-acc-balance"
                    type="number"
                    step="0.01"
                    value={newBalance}
                    onChange={(e) => setNewBalance(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white font-mono"
                  />
                </div>
              ) : (
                <>
                  <div>
                    <label
                      htmlFor="new-acc-limit"
                      className="block text-xs font-medium text-slate-300 mb-1"
                    >
                      Limite Total de Crédito (R$)
                    </label>
                    <input
                      id="new-acc-limit"
                      type="number"
                      step="100"
                      value={newLimit}
                      onChange={(e) => setNewLimit(e.target.value)}
                      className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white font-mono"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label
                        htmlFor="new-acc-closing"
                        className="block text-xs font-medium text-slate-300 mb-1"
                      >
                        Dia de Corte (Fechamento)
                      </label>
                      <input
                        id="new-acc-closing"
                        type="number"
                        min={1}
                        max={31}
                        value={newClosingDay}
                        onChange={(e) => setNewClosingDay(e.target.value)}
                        className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white font-mono"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="new-acc-due"
                        className="block text-xs font-medium text-slate-300 mb-1"
                      >
                        Dia de Vencimento
                      </label>
                      <input
                        id="new-acc-due"
                        type="number"
                        min={1}
                        max={31}
                        value={newDueDay}
                        onChange={(e) => setNewDueDay(e.target.value)}
                        className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white font-mono"
                      />
                    </div>
                  </div>
                </>
              )}

              <div className="pt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsModalOpen(false);
                    setEditingAccount(null);
                  }}
                  className="px-4 py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-200 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-semibold text-white cursor-pointer"
                >
                  {submitting
                    ? 'Salvando...'
                    : editingAccount
                    ? 'Salvar Alterações'
                    : 'Salvar Cadastro'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal de Confirmação de Exclusão */}
      {deletingAccount && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-xs flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Confirmar exclusão de ${deletingAccount.name}`}
        >
          <div className="w-full max-w-md bg-slate-800 border border-slate-700 rounded-3xl p-6 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-11 h-11 rounded-2xl bg-rose-500/15 border border-rose-500/30 text-rose-400 flex items-center justify-center shrink-0">
                <i className="ph-fill ph-trash text-xl"></i>
              </div>
              <div>
                <h3 className="text-base font-bold text-white">
                  Excluir {deletingAccount.type === 'credit' ? 'Cartão' : 'Conta'}?
                </h3>
                <p className="text-xs text-slate-400">
                  Você está prestes a remover <strong>{deletingAccount.name}</strong>.
                </p>
              </div>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed mb-6">
              Esta ação removerá a conta/cartão da sua listagem no banco de dados. Deseja confirmar a exclusão?
            </p>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeletingAccount(null)}
                className="px-4 py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-200 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={handleConfirmDelete}
                className="px-4 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer"
              >
                <i className="ph-bold ph-trash"></i>
                <span>{submitting ? 'Excluindo...' : 'Confirmar Exclusão'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
