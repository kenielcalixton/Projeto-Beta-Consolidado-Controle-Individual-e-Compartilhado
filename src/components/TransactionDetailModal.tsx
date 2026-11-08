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

interface TransactionDetailModalProps {
  transaction: Transaction | null;
  allTransactions?: Transaction[];
  onClose: () => void;
  onEdit: (tx: Transaction) => void;
  onRequestSettleTransaction: (tx: Transaction) => void;
  onUpdateStatusCascade: (
    tx: Transaction,
    newStatus: TransactionStatus,
    mode: CascadeMode,
    paymentDate?: string
  ) => Promise<void>;
  onDeleteCascade: (tx: Transaction, mode: CascadeMode) => Promise<void>;
}

const STATUS_META: Record<
  TransactionStatus,
  { label: string; colorClass: string; badgeBg: string; icon: string; desc: string }
> = {
  paid: {
    label: 'Pago / Efetivado',
    colorClass: 'text-emerald-300',
    badgeBg: 'bg-emerald-500/15 border-emerald-500/30',
    icon: 'ph-check-circle',
    desc: 'Lançamento liquidado.',
  },
  pending: {
    label: 'No Prazo / Pendente',
    colorClass: 'text-amber-300',
    badgeBg: 'bg-amber-500/15 border-amber-500/30',
    icon: 'ph-clock',
    desc: 'Dentro do prazo de vencimento.',
  },
  overdue: {
    label: 'Em Atraso (Vencido)',
    colorClass: 'text-rose-300',
    badgeBg: 'bg-rose-500/15 border-rose-500/30',
    icon: 'ph-warning-circle',
    desc: 'A data de vencimento já passou e o pagamento ainda não foi registrado.',
  },
  validating: {
    label: 'Aguardando Aceite (Rateio Avulso)',
    colorClass: 'text-purple-300',
    badgeBg: 'bg-purple-500/15 border-purple-500/30',
    icon: 'ph-hourglass-high',
    desc: 'Rateio avulso aguardando confirmação de cota pelos participantes.',
  },
  rejected: {
    label: 'Recusado (Rateio)',
    colorClass: 'text-slate-400',
    badgeBg: 'bg-slate-700/50 border-slate-600/60',
    icon: 'ph-x-circle',
    desc: 'Rateio avulso recusado por um dos participantes.',
  },
};

export const TransactionDetailModal: React.FC<TransactionDetailModalProps> = ({
  transaction,
  allTransactions = [],
  onClose,
  onEdit,
  onRequestSettleTransaction,
  onUpdateStatusCascade,
  onDeleteCascade,
}) => {
  const [cascadeStep, setCascadeStep] = useState<{
    action: 'unpay' | 'delete';
  } | null>(null);
  const [confirmSingleDelete, setConfirmSingleDelete] = useState(false);
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    if (transaction) {
      setCascadeStep(null);
      setConfirmSingleDelete(false);
    }
  }, [transaction]);

  // Trava a rolagem do body enquanto o detalhe estiver aberto para evitar barra de rolagem dupla
  useEffect(() => {
    if (!transaction) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [transaction]);

  if (!transaction) return null;

  const effectiveStatus = resolveTransactionStatus(transaction);
  const baseSt = STATUS_META[effectiveStatus] || STATUS_META.pending;
  const st =
    transaction.type === 'income'
      ? effectiveStatus === 'paid'
        ? {
            ...baseSt,
            label: 'Receita Efetivada',
            desc: 'Receita confirmada e contabilizada na conta / caixa.',
          }
        : {
            ...STATUS_META.pending,
            label: 'Aguardando Efetivação',
            desc: 'Confirme a efetivação quando o valor entrar na conta.',
          }
      : effectiveStatus === 'paid'
      ? {
          ...baseSt,
          label: 'Pago',
          desc: 'Despesa paga e baixada.',
        }
      : baseSt;

  const isSeries = transaction.recurrenceType !== 'single';

  const relatedSeries =
    isSeries && transaction.recurrenceGroupId
      ? allTransactions
          .filter((t) => t.recurrenceGroupId === transaction.recurrenceGroupId)
          .sort((a, b) => a.installmentIndex - b.installmentIndex)
      : [];

  const handleRevertPending = async (mode: CascadeMode = 'only_this') => {
    setProcessing(true);
    try {
      await onUpdateStatusCascade(transaction, 'pending', mode, '');
      setCascadeStep(null);
      onClose();
    } finally {
      setProcessing(false);
    }
  };

  const handleDelete = async (mode: CascadeMode = 'only_this') => {
    setProcessing(true);
    try {
      await onDeleteCascade(transaction, mode);
      setCascadeStep(null);
      setConfirmSingleDelete(false);
      onClose();
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Detalhes do lançamento ${transaction.description}`}
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-xl bg-slate-900 sm:bg-slate-800 border-t sm:border border-slate-700 rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[92dvh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Cabeçalho Fixo da Gaveta/Modal de Detalhes */}
        <div className="px-5 py-4 bg-slate-800/95 border-b border-slate-700/80 flex items-start justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 border ${
                transaction.type === 'income'
                  ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
                  : 'bg-indigo-500/15 border-indigo-500/30 text-indigo-400'
              }`}
            >
              <i
                className={`ph-fill ${
                  transaction.categoryIcon || 'ph-receipt'
                } text-xl`}
              ></i>
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider ${
                    transaction.type === 'income'
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'bg-rose-500/20 text-rose-300'
                  }`}
                >
                  {transaction.type === 'income' ? 'Receita / Entrada' : 'Despesa / Saída'}
                </span>
                <span className="text-xs text-slate-400 font-mono">
                  Fatura/Mês: {transaction.invoiceMonth}
                </span>
              </div>
              <h3 className="text-base sm:text-lg font-bold text-white leading-snug break-words mt-0.5">
                {transaction.description}
              </h3>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar detalhes do lançamento"
            className="w-9 h-9 rounded-xl bg-slate-900/90 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center cursor-pointer shrink-0"
          >
            <i className="ph-bold ph-x"></i>
          </button>
        </div>

        {/* Corpo com Rolagem Única */}
        <div className="p-5 overflow-y-auto flex-1 space-y-5 overscroll-contain">
          {/* Bloco Principal: Valor + Status Atual */}
          <div className="p-4 rounded-2xl bg-slate-950/60 border border-slate-700/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <span className="text-xs text-slate-400 block">
                Valor do Lançamento
              </span>
              <span
                className={`text-2xl sm:text-3xl font-bold font-mono tabular-nums ${
                  transaction.type === 'income'
                    ? 'text-emerald-400'
                    : 'text-rose-400'
                }`}
              >
                {transaction.type === 'income' ? '+' : '-'}
                {formatCurrency(transaction.amount)}
              </span>
            </div>

            <div className="sm:text-right">
              <span
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-xl border text-xs font-bold ${st.badgeBg} ${st.colorClass}`}
              >
                <i className={`ph-fill ${st.icon}`} aria-hidden="true"></i>
                <span>{st.label}</span>
              </span>
              <p className="text-[11px] text-slate-400 mt-1 max-w-xs">
                {st.desc}
              </p>
            </div>
          </div>

          {/* Grade de Informações Detalhadas */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="p-3.5 rounded-2xl bg-slate-900/70 border border-slate-700/60">
              <span className="text-[11px] text-slate-400 block">
                Categoria
              </span>
              <div className="flex items-center gap-2 text-sm font-semibold text-white mt-1">
                <i
                  className={`ph-fill ${
                    transaction.categoryIcon || 'ph-tag'
                  } text-indigo-400`}
                ></i>
                <span>{transaction.categoryName}</span>
              </div>
            </div>

            <div className="p-3.5 rounded-2xl bg-slate-900/70 border border-slate-700/60">
              <span className="text-[11px] text-slate-400 block">
                Conta Bancária / Cartão
              </span>
              <div className="flex items-center gap-2 text-sm font-semibold text-white mt-1">
                <i
                  className={`ph-fill ${
                    transaction.accountType === 'credit'
                      ? 'ph-credit-card text-purple-400'
                      : 'ph-bank text-indigo-400'
                  }`}
                ></i>
                <span>{transaction.accountName}</span>
              </div>
              <span className="text-[11px] text-slate-400 block mt-0.5">
                {transaction.accountType === 'credit'
                  ? `Cartão de Crédito · Fatura ${transaction.invoiceMonth}`
                  : 'Conta Corrente / Carteira'}
              </span>
            </div>

            <div className="p-3.5 rounded-2xl bg-slate-900/70 border border-slate-700/60">
              <span className="text-[11px] text-slate-400 block">
                Datas do Registro
              </span>
              <div className="space-y-1 mt-1 font-mono text-xs text-slate-200">
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Competência:</span>
                  <span>{transaction.competenceDate}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Vencimento:</span>
                  <span>{transaction.dueDate}</span>
                </div>
                {effectiveStatus === 'paid' && (
                  <div className="flex items-center justify-between text-emerald-400 font-bold pt-0.5 border-t border-slate-800">
                    <span>Pago em:</span>
                    <span>{transaction.paymentDate || transaction.dueDate}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="p-3.5 rounded-2xl bg-slate-900/70 border border-slate-700/60">
              <span className="text-[11px] text-slate-400 block">
                Recorrência & Escopo
              </span>
              <div className="text-sm font-semibold text-white mt-1">
                {transaction.recurrenceType === 'single'
                  ? 'Lançamento Único'
                  : transaction.recurrenceType === 'fixed'
                  ? `Despesa Fixa (${transaction.installmentIndex}/${transaction.installmentTotal})`
                  : `Compra Parcelada (${transaction.installmentIndex}/${transaction.installmentTotal})`}
              </div>
              <span className="text-[11px] text-indigo-300 block mt-0.5">
                {transaction.spaceName
                  ? `Espaço Compartilhado: ${transaction.spaceName}`
                  : 'Escopo Individual (Pessoal)'}
              </span>
            </div>
          </div>

          {/* Detalhamento de Rateio / Divisão entre Participantes (se houver) */}
          {transaction.splits && transaction.splits.length > 0 && (
            <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-700/70 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold text-slate-200 flex items-center gap-2">
                  <i className="ph-fill ph-users-three text-indigo-400"></i>
                  <span>
                    Divisão / Rateio ({transaction.splits.length} participantes)
                  </span>
                </h4>
                <span className="text-[11px] text-slate-400 font-mono">
                  Pago por: {transaction.paidByEmail}
                </span>
              </div>

              <div className="divide-y divide-slate-800">
                {transaction.splits.map((sp) => (
                  <div
                    key={sp.email}
                    className="py-2.5 first:pt-0 last:pb-0 flex items-center justify-between gap-2 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-white truncate">
                        {sp.name}
                      </div>
                      <div className="text-[11px] text-slate-400 font-mono truncate">
                        {sp.email}
                      </div>
                    </div>
                    <div className="text-right font-mono shrink-0">
                      <div className="text-slate-200 font-bold">
                        Cota: {formatCurrency(sp.responsibility)}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        Pagou: {formatCurrency(sp.paidAmount)} ·{' '}
                        <span
                          className={
                            sp.status === 'accepted'
                              ? 'text-emerald-400 font-semibold'
                              : sp.status === 'rejected'
                              ? 'text-rose-400 font-semibold'
                              : 'text-amber-300 font-semibold'
                          }
                        >
                          {sp.status === 'accepted'
                            ? 'Aceito'
                            : sp.status === 'rejected'
                            ? 'Recusado'
                            : 'Pendente'}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Outras parcelas da mesma série (se for parcelado ou fixo) */}
          {relatedSeries.length > 1 && (
            <div className="p-4 rounded-2xl bg-slate-900/70 border border-slate-700/60 space-y-2.5">
              <h4 className="text-xs font-bold text-slate-300 flex items-center gap-2">
                <i className="ph-fill ph-arrows-clockwise text-indigo-400"></i>
                <span>
                  Parcelas / Ocorrências Vinculadas ({relatedSeries.length})
                </span>
              </h4>
              <div className="max-h-36 overflow-y-auto space-y-1.5 pr-1">
                {relatedSeries.map((item) => {
                  const itemSt = resolveTransactionStatus(item);
                  const isCurrent = item.id === transaction.id;
                  return (
                    <div
                      key={item.id}
                      className={`px-3 py-2 rounded-xl flex items-center justify-between text-xs font-mono ${
                        isCurrent
                          ? 'bg-indigo-600/20 border border-indigo-500/40 text-white font-bold'
                          : 'bg-slate-800/70 text-slate-300'
                      }`}
                    >
                      <span>
                        {item.installmentIndex}/{item.installmentTotal} ·{' '}
                        {item.invoiceMonth}
                      </span>
                      <div className="flex items-center gap-2">
                        <span>{formatCurrency(item.amount)}</span>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded ${
                            itemSt === 'paid'
                              ? 'bg-emerald-500/20 text-emerald-300'
                              : 'bg-slate-700 text-slate-300'
                          }`}
                        >
                          {itemSt === 'paid' ? 'Pago' : 'Aberto'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Seção Rápida para Efetivar Receita ou Registrar Pagamento de Despesa (com Validação de Valor) */}
          {effectiveStatus !== 'paid' && effectiveStatus !== 'rejected' && !cascadeStep && (
            <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 space-y-3">
              <div>
                <span className="text-xs font-bold text-emerald-300 block">
                  {transaction.type === 'income'
                    ? 'Efetivação de Receita (Com Validação de Valor)'
                    : 'Registro de Pagamento da Despesa (Com Validação de Valor)'}
                </span>
                <span className="text-[11px] text-slate-300">
                  {transaction.type === 'income'
                    ? 'Ao clicar abaixo, você poderá confirmar se o valor que entrou foi exatamente este ou ajustá-lo antes de efetivar.'
                    : 'Despesas são controladas pela data de vencimento. Clique abaixo para validar o valor pago e dar baixa.'}
                </span>
              </div>
              <button
                type="button"
                disabled={processing}
                onClick={() => {
                  onClose();
                  onRequestSettleTransaction(transaction);
                }}
                className="w-full py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-lg shadow-emerald-600/25 flex items-center justify-center gap-2 cursor-pointer transition-colors"
              >
                <i className="ph-bold ph-check-circle text-base"></i>
                <span>
                  {transaction.type === 'income'
                    ? 'Validar Valor & Efetivar Receita'
                    : 'Validar Valor & Registrar Pagamento'}
                </span>
              </button>
            </div>
          )}

          {/* Confirmação de Propagação em Cascata (quando for série fixa/parcelada) */}
          {cascadeStep && (
            <div className="p-4 rounded-2xl bg-slate-950 border border-indigo-500/40 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-indigo-300">
                  {cascadeStep.action === 'delete'
                    ? 'Como deseja excluir esta série?'
                    : 'Reverter status em quais parcelas?'}
                </span>
                <button
                  type="button"
                  onClick={() => setCascadeStep(null)}
                  className="text-xs text-slate-400 hover:text-white cursor-pointer"
                >
                  Cancelar
                </button>
              </div>
              <div className="grid grid-cols-1 gap-2">
                {(
                  [
                    {
                      mode: 'only_this' as CascadeMode,
                      title: 'Somente este lançamento',
                      sub: `Apenas a ocorrência ${transaction.installmentIndex}/${transaction.installmentTotal} (${transaction.invoiceMonth})`,
                    },
                    {
                      mode: 'this_and_following' as CascadeMode,
                      title: 'Este e os seguintes',
                      sub: `Da parcela ${transaction.installmentIndex} até ${transaction.installmentTotal}`,
                    },
                    {
                      mode: 'all' as CascadeMode,
                      title: 'Toda a série',
                      sub: `Todas as ${transaction.installmentTotal} ocorrências`,
                    },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.mode}
                    type="button"
                    disabled={processing}
                    onClick={() => {
                      if (cascadeStep.action === 'delete') handleDelete(opt.mode);
                      else handleRevertPending(opt.mode);
                    }}
                    className="p-3 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-left flex items-center justify-between cursor-pointer"
                  >
                    <div>
                      <div className="text-xs font-bold text-white">{opt.title}</div>
                      <div className="text-[11px] text-slate-400">{opt.sub}</div>
                    </div>
                    <i className="ph-bold ph-caret-right text-indigo-400"></i>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Confirmação simples para exclusão de lançamento único */}
          {confirmSingleDelete && !isSeries && (
            <div className="p-4 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-between gap-3">
              <span className="text-xs text-rose-200 font-medium">
                Tem certeza que deseja excluir este lançamento?
              </span>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setConfirmSingleDelete(false)}
                  className="px-3 py-1.5 rounded-xl bg-slate-800 text-xs text-slate-300 cursor-pointer"
                >
                  Não
                </button>
                <button
                  type="button"
                  disabled={processing}
                  onClick={() => handleDelete('only_this')}
                  className="px-3 py-1.5 rounded-xl bg-rose-600 text-xs font-bold text-white cursor-pointer"
                >
                  Sim, Excluir
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Rodapé Fixo com Ações Rápidas: Editar, Desfazer Pagamento, Excluir e Fechar */}
        <div className="px-5 py-3.5 bg-slate-800/95 border-t border-slate-700/80 flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                onClose();
                onEdit(transaction);
              }}
              className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
            >
              <i className="ph-bold ph-pencil-simple"></i>
              <span>Editar</span>
            </button>

            {effectiveStatus === 'paid' && (
              <button
                type="button"
                onClick={() => {
                  if (isSeries) setCascadeStep({ action: 'unpay' });
                  else handleRevertPending('only_this');
                }}
                className="px-3.5 py-2 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-300 text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
              >
                <i className="ph-bold ph-arrow-counter-clockwise"></i>
                <span>Desfazer Pagamento</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                if (isSeries) setCascadeStep({ action: 'delete' });
                else setConfirmSingleDelete(true);
              }}
              className="px-3.5 py-2 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
            >
              <i className="ph-bold ph-trash"></i>
              <span>Excluir</span>
            </button>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-200 cursor-pointer ml-auto"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
};
