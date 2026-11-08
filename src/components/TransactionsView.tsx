import React, { useEffect, useState } from 'react';
import {
  CascadeMode,
  Transaction,
  TransactionStatus,
} from '../types/finance';
import {
  formatCurrency,
  getTodayDateString,
  resolveTransactionStatus,
} from '../utils/financeEngine';

interface TransactionsViewProps {
  transactions: Transaction[];
  selectedMonth: string; // YYYY-MM
  onOpenNewModal: () => void;
  onSelectTransaction: (tx: Transaction) => void;
  onEditTransaction: (tx: Transaction) => void;
  onRequestSettleTransaction: (tx: Transaction) => void;
  onUpdateStatusCascade: (
    tx: Transaction,
    newStatus: TransactionStatus,
    mode: CascadeMode,
    paymentDate?: string
  ) => Promise<void>;
  onDeleteCascade: (tx: Transaction, mode: CascadeMode) => Promise<void>;
}

const STATUS_LABELS: Record<
  TransactionStatus,
  { label: string; colorClass: string; badgeBg: string; icon: string }
> = {
  paid: {
    label: 'Pago / Efetivado',
    colorClass: 'text-emerald-300',
    badgeBg: 'bg-emerald-500/15 border-emerald-500/30',
    icon: 'ph-check-circle',
  },
  pending: {
    label: 'No Prazo / Pendente',
    colorClass: 'text-amber-300',
    badgeBg: 'bg-amber-500/15 border-amber-500/30',
    icon: 'ph-clock',
  },
  overdue: {
    label: 'Atrasado / Vencido',
    colorClass: 'text-rose-300',
    badgeBg: 'bg-rose-500/15 border-rose-500/30',
    icon: 'ph-warning-circle',
  },
  validating: {
    label: 'Aguardando Aceite (Rateio Avulso)',
    colorClass: 'text-purple-300',
    badgeBg: 'bg-purple-500/15 border-purple-500/30',
    icon: 'ph-hourglass-high',
  },
  rejected: {
    label: 'Recusado (Rateio)',
    colorClass: 'text-slate-400',
    badgeBg: 'bg-slate-700/50 border-slate-600/60',
    icon: 'ph-x-circle',
  },
};

function getContextualStatusBadge(
  tx: Transaction,
  effectiveStatus: TransactionStatus
): { label: string; colorClass: string; badgeBg: string; icon: string } {
  const base = STATUS_LABELS[effectiveStatus] || STATUS_LABELS.pending;
  if (tx.type === 'income') {
    if (effectiveStatus === 'paid') {
      return { ...base, label: 'Receita Efetivada' };
    }
    return {
      ...STATUS_LABELS.pending,
      label: 'Aguardando Efetivação',
    };
  }
  // Despesa: regida por data de vencimento (No Prazo vs Atrasada) ou Paga
  if (effectiveStatus === 'paid') {
    return { ...base, label: 'Pago' };
  }
  if (effectiveStatus === 'overdue') {
    return { ...base, label: 'Em Atraso (Vencida)' };
  }
  if (effectiveStatus === 'validating') {
    return base;
  }
  return { ...base, label: 'No Prazo (A Pagar)' };
}

export const TransactionsView: React.FC<TransactionsViewProps> = ({
  transactions,
  selectedMonth,
  onOpenNewModal,
  onSelectTransaction,
  onEditTransaction,
  onRequestSettleTransaction,
  onUpdateStatusCascade,
  onDeleteCascade,
}) => {
  const [typeFilter, setTypeFilter] = useState<'all' | 'income' | 'expense'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | TransactionStatus>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [cascadeDialog, setCascadeDialog] = useState<{
    tx: Transaction;
    actionType: 'delete' | 'status';
    targetStatus?: TransactionStatus;
  } | null>(null);
  const [cascadePaymentDate, setCascadePaymentDate] = useState<string>(
    getTodayDateString()
  );

  // Evita rolagem dupla do fundo quando o modal de cascata está aberto
  useEffect(() => {
    if (!cascadeDialog) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [cascadeDialog]);

  const filtered = transactions
    .filter((tx) => tx.invoiceMonth === selectedMonth)
    .filter((tx) => (typeFilter === 'all' ? true : tx.type === typeFilter))
    .filter((tx) => {
      if (statusFilter === 'all') return true;
      return resolveTransactionStatus(tx) === statusFilter;
    })
    .filter((tx) => {
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        tx.description.toLowerCase().includes(q) ||
        tx.categoryName.toLowerCase().includes(q) ||
        tx.accountName.toLowerCase().includes(q) ||
        (tx.spaceName && tx.spaceName.toLowerCase().includes(q))
      );
    })
    .sort((a, b) => b.competenceDate.localeCompare(a.competenceDate));

  const handleMarkPaidClick = (tx: Transaction) => {
    onRequestSettleTransaction(tx);
  };

  const handleRevertPendingClick = (tx: Transaction) => {
    if (tx.recurrenceType === 'single') {
      onUpdateStatusCascade(tx, 'pending', 'only_this', '');
    } else {
      setCascadePaymentDate('');
      setCascadeDialog({
        tx,
        actionType: 'status',
        targetStatus: 'pending',
      });
    }
  };

  const handleDeleteRequest = (tx: Transaction) => {
    if (tx.recurrenceType === 'single') {
      onDeleteCascade(tx, 'only_this');
    } else {
      setCascadeDialog({
        tx,
        actionType: 'delete',
      });
    }
  };

  return (
    <div className="space-y-6">
      {/* Cabeçalho e Filtros */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3.5 bg-slate-800 border border-slate-700/80 p-3.5 sm:p-4 rounded-3xl">
        {/* Abas Todos / Receitas / Despesas + Seletor de Status */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
          <div className="grid grid-cols-3 sm:flex items-center p-1 bg-slate-900 rounded-2xl border border-slate-700/70">
            <button
              type="button"
              onClick={() => setTypeFilter('all')}
              className={`px-3 py-2 sm:py-1.5 rounded-xl text-xs font-semibold transition-all cursor-pointer whitespace-nowrap text-center ${
                typeFilter === 'all'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Todos
            </button>
            <button
              type="button"
              onClick={() => setTypeFilter('income')}
              className={`px-3 py-2 sm:py-1.5 rounded-xl text-xs font-semibold transition-all cursor-pointer whitespace-nowrap text-center ${
                typeFilter === 'income'
                  ? 'bg-emerald-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Receitas
            </button>
            <button
              type="button"
              onClick={() => setTypeFilter('expense')}
              className={`px-3 py-2 sm:py-1.5 rounded-xl text-xs font-semibold transition-all cursor-pointer whitespace-nowrap text-center ${
                typeFilter === 'expense'
                  ? 'bg-rose-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Despesas
            </button>
          </div>

          <select
            aria-label="Filtrar por status do lançamento"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            className="w-full sm:w-auto bg-slate-900 border border-slate-700 rounded-2xl px-3.5 py-2.5 sm:py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
          >
            <option value="all">Todos os Status</option>
            <option value="paid">Pago / Efetivado</option>
            <option value="pending">Pendente</option>
            <option value="overdue">Vencido</option>
            <option value="validating">Em Validação (Rateio)</option>
            <option value="rejected">Recusado (Rateio)</option>
          </select>
        </div>

        {/* Busca e Ação Principal */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
          <div className="relative flex-1 sm:w-64">
            <i className="ph ph-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"></i>
            <input
              type="text"
              aria-label="Buscar lançamentos"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar descrição, conta, espaço..."
              className="w-full pl-9 pr-3.5 py-2.5 sm:py-2 bg-slate-900 border border-slate-700 rounded-2xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <button
            type="button"
            onClick={onOpenNewModal}
            className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-2xl shadow-lg shadow-indigo-600/20 flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap"
          >
            <i className="ph-bold ph-plus"></i>
            <span>Novo Lançamento</span>
          </button>
        </div>
      </div>

      {/* Container de Lançamentos: Cards verticais no Mobile (md:hidden) + Tabela no Desktop (hidden md:block) */}
      <div className="bg-slate-800 border border-slate-700/80 rounded-3xl overflow-hidden">
        {/* VISÃO MOBILE (Cards empilhados sem rolagem horizontal; toque abre os detalhes do lançamento) */}
        <div className="md:hidden divide-y divide-slate-700/60">
          {filtered.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-400">
              Nenhum lançamento encontrado para os filtros selecionados em{' '}
              <span className="font-mono text-slate-200">{selectedMonth}</span>.
            </div>
          ) : (
            filtered.map((tx) => {
              const effectiveStatus = resolveTransactionStatus(tx);
              const st = getContextualStatusBadge(tx, effectiveStatus);
              const recurrenceLabel =
                tx.recurrenceType === 'single'
                  ? 'Único'
                  : tx.recurrenceType === 'fixed'
                  ? `Fixo (${tx.installmentIndex}/${tx.installmentTotal})`
                  : `Parcelado (${tx.installmentIndex}/${tx.installmentTotal})`;

              return (
                <div
                  key={tx.id}
                  onClick={() => onSelectTransaction(tx)}
                  className="p-4 space-y-3 hover:bg-slate-700/25 active:bg-slate-700/40 transition-colors cursor-pointer"
                >
                  {/* Topo do Card: Descrição + Valor */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-bold text-slate-100 text-sm leading-snug break-words flex items-center gap-1.5">
                        <span>{tx.description}</span>
                        <i className="ph-bold ph-caret-right text-xs text-indigo-400 shrink-0"></i>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400 mt-1">
                        <span className="px-2 py-0.5 rounded-md bg-slate-900/90 border border-slate-700/80 text-slate-300 font-medium">
                          {recurrenceLabel}
                        </span>
                        {tx.splits && tx.splits.length > 0 && (
                          <span className="px-2 py-0.5 rounded-md bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 font-medium">
                            Rateio ({tx.splits.length} pessoas)
                          </span>
                        )}
                      </div>
                    </div>

                    <div
                      className={`font-mono tabular-nums font-bold text-base shrink-0 text-right ${
                        tx.type === 'income' ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {tx.type === 'income' ? '+' : '-'}
                      {formatCurrency(tx.amount)}
                    </div>
                  </div>

                  {/* Grade 2x2 de Metadados (Categoria/Espaço, Conta/Fatura, Datas, Status) */}
                  <div className="grid grid-cols-2 gap-2 p-3 rounded-2xl bg-slate-900/70 border border-slate-700/60 text-xs">
                    <div className="min-w-0">
                      <span className="text-[10px] uppercase tracking-wider text-slate-400 block">
                        Categoria & Espaço
                      </span>
                      <div className="flex items-center gap-1.5 text-slate-200 font-semibold truncate mt-0.5">
                        <i
                          className={`ph-fill ${
                            tx.categoryIcon || 'ph-tag'
                          } text-indigo-400 shrink-0`}
                        ></i>
                        <span className="truncate">{tx.categoryName}</span>
                      </div>
                      <span className="text-[11px] text-slate-400 truncate block">
                        {tx.spaceName ? `Espaço: ${tx.spaceName}` : 'Individual'}
                      </span>
                    </div>

                    <div className="min-w-0">
                      <span className="text-[10px] uppercase tracking-wider text-slate-400 block">
                        Conta / Cartão
                      </span>
                      <div className="text-slate-200 font-semibold truncate mt-0.5">
                        {tx.accountName}
                      </div>
                      <span className="text-[11px] text-slate-400 truncate block">
                        {tx.accountType === 'credit'
                          ? `Fatura ${tx.invoiceMonth}`
                          : 'Conta Bancária'}
                      </span>
                    </div>

                    <div className="col-span-2 pt-2 border-t border-slate-800 flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-slate-300">
                      <span>Comp: {tx.competenceDate}</span>
                      <span>Venc: {tx.dueDate}</span>
                      {effectiveStatus === 'paid' && (
                        <span className="text-emerald-400 font-bold flex items-center gap-1">
                          <i
                            className="ph-fill ph-calendar-check"
                            aria-hidden="true"
                          ></i>
                          <span>
                            {tx.type === 'income' ? 'Efetivada: ' : 'Pago: '}
                            {tx.paymentDate || tx.dueDate}
                          </span>
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Rodapé do Card Mobile: Status + Botão Efetivar/Pagar + Detalhes/Editar/Excluir */}
                  <div
                    className="flex flex-wrap items-center justify-between gap-2 pt-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl border text-xs font-bold ${st.badgeBg} ${st.colorClass}`}
                      >
                        <i className={`ph-fill ${st.icon}`} aria-hidden="true"></i>
                        <span>{st.label}</span>
                      </span>

                      {effectiveStatus !== 'paid' &&
                        effectiveStatus !== 'rejected' && (
                          <button
                            type="button"
                            onClick={() => handleMarkPaidClick(tx)}
                            aria-label={
                              tx.type === 'income'
                                ? `Efetivar Receita: ${tx.description}`
                                : `Registrar Pagamento: ${tx.description}`
                            }
                            className="px-3 py-1.5 rounded-xl bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/40 text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer"
                          >
                            <i
                              className="ph-bold ph-check-circle"
                              aria-hidden="true"
                            ></i>
                            <span>
                              {tx.type === 'income'
                                ? 'Efetivar Receita'
                                : 'Registrar Pagamento'}
                            </span>
                          </button>
                        )}

                      {effectiveStatus === 'paid' && (
                        <button
                          type="button"
                          onClick={() => handleRevertPendingClick(tx)}
                          aria-label={`Reverter para Pendente: ${tx.description}`}
                          className="text-xs text-slate-400 hover:text-amber-300 underline cursor-pointer px-1 py-1"
                        >
                          Desfazer
                        </button>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                      <button
                        type="button"
                        onClick={() => onSelectTransaction(tx)}
                        aria-label={`Ver detalhes de ${tx.description}`}
                        title="Ver detalhes"
                        className="px-2.5 h-9 rounded-xl bg-slate-900 hover:bg-slate-700 border border-slate-700/80 text-indigo-300 text-xs font-semibold flex items-center gap-1 cursor-pointer"
                      >
                        <i className="ph-bold ph-eye text-sm"></i>
                        <span>Detalhes</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onEditTransaction(tx)}
                        aria-label={`Editar ${tx.description}`}
                        className="w-9 h-9 rounded-xl bg-slate-900 hover:bg-slate-700 border border-slate-700/80 text-slate-200 flex items-center justify-center cursor-pointer"
                      >
                        <i className="ph ph-pencil-simple text-sm"></i>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteRequest(tx)}
                        aria-label={`Excluir ${tx.description}`}
                        className="w-9 h-9 rounded-xl bg-slate-900 hover:bg-rose-500/20 border border-slate-700/80 text-slate-400 hover:text-rose-400 flex items-center justify-center cursor-pointer"
                      >
                        <i className="ph ph-trash text-sm"></i>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* VISÃO DESKTOP/TABLET (Tabela Completa; clique na linha abre Detalhes do Lançamento) */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-700/80 text-[11px] font-semibold text-slate-400 bg-slate-900/50">
                <th className="py-3.5 px-5">Descrição & Recorrência</th>
                <th className="py-3.5 px-4">Categoria & Espaço</th>
                <th className="py-3.5 px-4">Conta / Cartão</th>
                <th className="py-3.5 px-4">Competência, Vencimento & Baixa</th>
                <th className="py-3.5 px-4">Status (Vencimento / Receita)</th>
                <th className="py-3.5 px-5 text-right">Valor Total</th>
                <th className="py-3.5 px-5 text-right">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50 text-xs">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-400">
                    Nenhum lançamento encontrado para os filtros selecionados em{' '}
                    <span className="font-mono text-slate-200">{selectedMonth}</span>.
                  </td>
                </tr>
              ) : (
                filtered.map((tx) => {
                  const effectiveStatus = resolveTransactionStatus(tx);
                  const st = getContextualStatusBadge(tx, effectiveStatus);
                  const recurrenceLabel =
                    tx.recurrenceType === 'single'
                      ? 'Único'
                      : tx.recurrenceType === 'fixed'
                      ? `Fixo Mensal (${tx.installmentIndex}/${tx.installmentTotal})`
                      : `Parcelado (${tx.installmentIndex}/${tx.installmentTotal})`;

                  return (
                    <tr
                      key={tx.id}
                      onClick={() => onSelectTransaction(tx)}
                      className="hover:bg-slate-700/35 transition-colors cursor-pointer group"
                    >
                      <td className="py-3.5 px-5">
                        <div className="font-semibold text-slate-100 group-hover:text-indigo-300 transition-colors text-sm flex items-center gap-1.5">
                          <span>{tx.description}</span>
                          <i className="ph-bold ph-eye text-xs text-slate-500 group-hover:text-indigo-400"></i>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-slate-400 mt-0.5">
                          <span>{recurrenceLabel}</span>
                          {tx.splits && tx.splits.length > 0 && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-indigo-400">
                                Rateio ({tx.splits.length} pessoas)
                              </span>
                            </>
                          )}
                        </div>
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-2 text-slate-200 font-medium">
                          <i
                            className={`ph-fill ${tx.categoryIcon || 'ph-tag'} text-indigo-400`}
                          ></i>
                          <span>{tx.categoryName}</span>
                        </div>
                        <div className="text-slate-400 text-[11px] mt-0.5">
                          {tx.spaceName ? `Espaço: ${tx.spaceName}` : 'Individual'}
                        </div>
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="text-slate-200 font-medium">{tx.accountName}</div>
                        <div className="text-slate-400 text-[11px] mt-0.5">
                          {tx.accountType === 'credit'
                            ? `Fatura ${tx.invoiceMonth}`
                            : 'Conta Bancária'}
                        </div>
                      </td>

                      <td className="py-3.5 px-4 font-mono tabular-nums text-slate-300 space-y-0.5 whitespace-nowrap">
                        <div>Comp: {tx.competenceDate}</div>
                        <div className="text-slate-400 text-[11px]">
                          Venc: {tx.dueDate}
                        </div>
                        {effectiveStatus === 'paid' && (
                          <div className="text-emerald-400 font-bold text-[11px] flex items-center gap-1 pt-0.5">
                            <i className="ph-fill ph-calendar-check" aria-hidden="true"></i>
                            <span>
                              {tx.type === 'income' ? 'Efetivada em: ' : 'Pago em: '}
                              {tx.paymentDate || tx.dueDate}
                            </span>
                          </div>
                        )}
                      </td>

                      <td
                        className="py-3.5 px-4 whitespace-nowrap"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex flex-col items-start gap-1.5">
                          <span
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl border text-xs font-bold whitespace-nowrap ${st.badgeBg} ${st.colorClass}`}
                          >
                            <i className={`ph-fill ${st.icon}`} aria-hidden="true"></i>
                            <span>{st.label}</span>
                          </span>

                          {effectiveStatus !== 'paid' &&
                            effectiveStatus !== 'rejected' && (
                              <button
                                type="button"
                                onClick={() => handleMarkPaidClick(tx)}
                                aria-label={
                                  tx.type === 'income'
                                    ? `Efetivar Receita: ${tx.description}`
                                    : `Registrar Pagamento: ${tx.description}`
                                }
                                className="px-2.5 py-1 rounded-lg bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/40 text-[11px] font-bold flex items-center gap-1 transition-all cursor-pointer whitespace-nowrap"
                              >
                                <i className="ph-bold ph-check-circle" aria-hidden="true"></i>
                                <span>
                                  {tx.type === 'income'
                                    ? 'Efetivar Receita'
                                    : 'Registrar Pagamento'}
                                </span>
                              </button>
                            )}

                          {effectiveStatus === 'paid' && (
                            <button
                              type="button"
                              onClick={() => handleRevertPendingClick(tx)}
                              aria-label={`Reverter para Pendente: ${tx.description}`}
                              className="text-[11px] text-slate-400 hover:text-amber-300 underline cursor-pointer"
                            >
                              {tx.type === 'income'
                                ? 'Desfazer efetivação'
                                : 'Desfazer pagamento'}
                            </button>
                          )}
                        </div>
                      </td>

                      <td
                        className={`py-3.5 px-5 text-right font-mono tabular-nums font-bold text-sm ${
                          tx.type === 'income' ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {tx.type === 'income' ? '+' : '-'}
                        {formatCurrency(tx.amount)}
                      </td>

                      <td
                        className="py-3.5 px-5 text-right"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => onSelectTransaction(tx)}
                            aria-label={`Ver detalhes de ${tx.description}`}
                            title="Ver detalhes"
                            className="p-2 rounded-xl bg-slate-900 hover:bg-slate-700 text-indigo-300 hover:text-white transition-colors cursor-pointer"
                          >
                            <i className="ph ph-eye"></i>
                          </button>
                          <button
                            type="button"
                            onClick={() => onEditTransaction(tx)}
                            aria-label={`Editar ${tx.description}`}
                            className="p-2 rounded-xl bg-slate-900 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors cursor-pointer"
                          >
                            <i className="ph ph-pencil-simple"></i>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteRequest(tx)}
                            aria-label={`Excluir ${tx.description}`}
                            className="p-2 rounded-xl bg-slate-900 hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition-colors cursor-pointer"
                          >
                            <i className="ph ph-trash"></i>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal de Edição / Exclusão / Efetivação em Cascata (Somente este, Este e seguintes, Todos) */}
      {cascadeDialog && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-xs flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Opções de propagação em cascata"
        >
          <div className="w-full max-w-md bg-slate-800 border border-slate-700 rounded-3xl p-6 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-2xl bg-indigo-500/15 text-indigo-400 flex items-center justify-center">
                <i className="ph-fill ph-arrows-clockwise text-xl"></i>
              </div>
              <div>
                <h3 className="text-base font-bold text-white">
                  Lançamento Recorrente / Parcelado
                </h3>
                <p className="text-xs text-slate-400">
                  Escolha como aplicar a alteração na série "{cascadeDialog.tx.description}"
                </p>
              </div>
            </div>

            {cascadeDialog.actionType === 'status' &&
              cascadeDialog.targetStatus === 'paid' && (
                <div className="p-3.5 rounded-2xl bg-slate-900 border border-emerald-500/40 mb-4 flex items-center justify-between gap-3">
                  <div>
                    <label
                      htmlFor="cascade-payment-date"
                      className="block text-xs font-bold text-emerald-300"
                    >
                      Data de Pagamento
                    </label>
                    <span className="text-[11px] text-slate-400">
                      Preenchida automaticamente
                    </span>
                  </div>
                  <input
                    id="cascade-payment-date"
                    type="date"
                    value={cascadePaymentDate}
                    onChange={(e) => setCascadePaymentDate(e.target.value)}
                    className="px-3 py-1.5 bg-slate-800 border border-emerald-500/50 rounded-xl text-xs text-emerald-300 font-mono font-bold"
                  />
                </div>
              )}

            <div className="space-y-2.5 my-5">
              <button
                type="button"
                onClick={async () => {
                  if (cascadeDialog.actionType === 'delete') {
                    await onDeleteCascade(cascadeDialog.tx, 'only_this');
                  } else if (cascadeDialog.targetStatus) {
                    await onUpdateStatusCascade(
                      cascadeDialog.tx,
                      cascadeDialog.targetStatus,
                      'only_this',
                      cascadePaymentDate
                    );
                  }
                  setCascadeDialog(null);
                }}
                className="w-full p-3.5 rounded-2xl bg-slate-900 hover:bg-slate-700/80 border border-slate-700 text-left flex items-center justify-between cursor-pointer"
              >
                <div>
                  <div className="text-xs font-bold text-white">Somente este lançamento</div>
                  <div className="text-[11px] text-slate-400">
                    Altera apenas a parcela {cascadeDialog.tx.installmentIndex}/
                    {cascadeDialog.tx.installmentTotal} ({cascadeDialog.tx.invoiceMonth})
                  </div>
                </div>
                <i className="ph-bold ph-caret-right text-slate-400"></i>
              </button>

              <button
                type="button"
                onClick={async () => {
                  if (cascadeDialog.actionType === 'delete') {
                    await onDeleteCascade(cascadeDialog.tx, 'this_and_following');
                  } else if (cascadeDialog.targetStatus) {
                    await onUpdateStatusCascade(
                      cascadeDialog.tx,
                      cascadeDialog.targetStatus,
                      'this_and_following',
                      cascadePaymentDate
                    );
                  }
                  setCascadeDialog(null);
                }}
                className="w-full p-3.5 rounded-2xl bg-slate-900 hover:bg-slate-700/80 border border-slate-700 text-left flex items-center justify-between cursor-pointer"
              >
                <div>
                  <div className="text-xs font-bold text-indigo-400">
                    Este e os seguintes
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Propaga em cascata da parcela {cascadeDialog.tx.installmentIndex} até{' '}
                    {cascadeDialog.tx.installmentTotal}
                  </div>
                </div>
                <i className="ph-bold ph-caret-right text-indigo-400"></i>
              </button>

              <button
                type="button"
                onClick={async () => {
                  if (cascadeDialog.actionType === 'delete') {
                    await onDeleteCascade(cascadeDialog.tx, 'all');
                  } else if (cascadeDialog.targetStatus) {
                    await onUpdateStatusCascade(
                      cascadeDialog.tx,
                      cascadeDialog.targetStatus,
                      'all',
                      cascadePaymentDate
                    );
                  }
                  setCascadeDialog(null);
                }}
                className="w-full p-3.5 rounded-2xl bg-slate-900 hover:bg-slate-700/80 border border-slate-700 text-left flex items-center justify-between cursor-pointer"
              >
                <div>
                  <div className="text-xs font-bold text-amber-400">
                    Todos os lançamentos da série
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Aplica a todas as {cascadeDialog.tx.installmentTotal} ocorrências vinculadas
                  </div>
                </div>
                <i className="ph-bold ph-caret-right text-amber-400"></i>
              </button>
            </div>

            <button
              type="button"
              onClick={() => setCascadeDialog(null)}
              className="w-full py-2.5 rounded-xl bg-slate-700 text-xs font-semibold text-slate-200 cursor-pointer"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
