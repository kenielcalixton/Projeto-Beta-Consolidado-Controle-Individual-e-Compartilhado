import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CreditCard,
  X,
  ArrowLeft,
  RefreshCw,
  ArrowUpRight,
  Calendar,
  CheckCircle2,
  AlertCircle,
  DollarSign,
  Receipt,
  Layers,
  Clock,
  History,
  Ban,
  Search,
  ShieldCheck,
  Eye,
} from 'lucide-react';
import {
  Account,
  CreditCardInvoice,
  CreditCardInvoiceCharge,
  CreditCardInvoiceStatus,
} from '../../types/financeV3';
import { UniversalTransactionPreset } from '../../types/finance';
import {
  CardLedgerOverview,
  calculateInvoiceMonth,
  getCardLedgerOverview,
  payCardInvoice,
} from '../../services/creditCardService';
import { cancelPersonalTransaction } from '../../services/personalTransactionService';
import { cancelInstallmentContract } from '../../services/recurrenceService';
import { formatIsoDateBR } from '../../services/ledgerService';
import { formatCentsToBRL, parseBRLToCents } from '../../utils/movementLedger';
import { resolveHexColor } from '../../utils/visualPickerUtils';

interface CreditCardLedgerModalProps {
  cardAccount: Account;
  accounts: Account[];
  userId: string;
  isDemo?: boolean;
  refreshTrigger?: number;
  onClose: () => void;
  onUpdated: () => void;
  onOpenNewTransaction?: (preset?: UniversalTransactionPreset) => void;
}

type CardTabKey = 'current_invoice' | 'purchases' | 'future_invoices' | 'paid_invoices';

function getTodayIsoLocal(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatMonthLabel(monthStr: string): string {
  const m = monthStr.match(/^(\d{4})-(\d{2})$/);
  if (!m) return monthStr;
  const months = [
    'Jan',
    'Fev',
    'Mar',
    'Abr',
    'Mai',
    'Jun',
    'Jul',
    'Ago',
    'Set',
    'Out',
    'Nov',
    'Dez',
  ];
  const idx = parseInt(m[2], 10) - 1;
  return `${months[idx] || m[2]}/${m[1]}`;
}

function getInvoiceStatusBadge(status: CreditCardInvoiceStatus) {
  switch (status) {
    case 'paid':
      return {
        label: 'Paga',
        cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
      };
    case 'partially_paid':
      return {
        label: 'Paga Parcialmente',
        cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
      };
    case 'closed':
      return {
        label: 'Fechada',
        cls: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
      };
    case 'overdue':
      return {
        label: 'Em Atraso',
        cls: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
      };
    case 'carried_over':
      return {
        label: 'Transportada (Rotativo)',
        cls: 'bg-slate-700/60 text-slate-300 border-slate-600/60',
      };
    case 'open':
    default:
      return {
        label: 'Aberta',
        cls: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
      };
  }
}

export const CreditCardLedgerModal: React.FC<CreditCardLedgerModalProps> = ({
  cardAccount,
  accounts,
  userId,
  isDemo = false,
  refreshTrigger = 0,
  onClose,
  onUpdated,
  onOpenNewTransaction,
}) => {
  const [overview, setOverview] = useState<CardLedgerOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<CardTabKey>('current_invoice');

  const todayIso = useMemo(() => getTodayIsoLocal(), []);
  const defaultCurrentMonth = useMemo(
    () => calculateInvoiceMonth(todayIso, cardAccount.closingDay || 20),
    [todayIso, cardAccount.closingDay]
  );
  const [selectedInvoiceMonth, setSelectedInvoiceMonth] = useState<string>(defaultCurrentMonth);

  // Filtros do Histórico de Compras
  const [purchaseMonthFilter, setPurchaseMonthFilter] = useState<string>('all');
  const [purchaseSearch, setPurchaseSearch] = useState<string>('');

  // Formulário de Pagamento de Fatura
  const payingAccounts = useMemo(
    () => accounts.filter((a) => !a.isArchived && a.type !== 'credit'),
    [accounts]
  );
  const [isPayFormOpen, setIsPayFormOpen] = useState(false);
  const [paySourceAccountId, setPaySourceAccountId] = useState<string>('');
  const [payAmountInput, setPayAmountInput] = useState<string>('');
  const [payDate, setPayDate] = useState<string>(todayIso);
  const [payNotes, setPayNotes] = useState<string>('');
  const [paySubmitting, setPaySubmitting] = useState(false);

  // Cancelamento / Estorno de Compra
  const [chargeToCancel, setChargeToCancel] = useState<CreditCardInvoiceCharge | null>(null);
  const [cancelReason, setCancelReason] = useState<string>('');
  const [cancelSubmitting, setCancelSubmitting] = useState(false);

  // Inspeção detalhada de Fatura Paga
  const [inspectedPaidMonth, setInspectedPaidMonth] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getCardLedgerOverview(cardAccount, userId, isDemo);
      setOverview(data);

      setSelectedInvoiceMonth((prev) => {
        if (prev && data.invoices.some((i) => i.invoiceMonth === prev)) {
          return prev;
        }
        if (data.invoices.some((i) => i.invoiceMonth === defaultCurrentMonth)) {
          return defaultCurrentMonth;
        }
        const firstOpen = data.invoices.find(
          (i) => i.invoiceStatus !== 'paid' && i.invoiceStatus !== 'carried_over'
        );
        return firstOpen?.invoiceMonth || data.invoices[0]?.invoiceMonth || defaultCurrentMonth;
      });
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : 'Erro ao carregar livro-razão do cartão de crédito.'
      );
    } finally {
      setLoading(false);
    }
  }, [cardAccount, userId, isDemo, defaultCurrentMonth]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview, refreshTrigger]);

  useEffect(() => {
    if (!paySourceAccountId && payingAccounts.length > 0) {
      setPaySourceAccountId(payingAccounts[0].id);
    }
  }, [payingAccounts, paySourceAccountId]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const showSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(null), 4500);
  };

  const accountNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const acc of accounts) {
      map.set(acc.id, acc.name);
    }
    return map;
  }, [accounts]);

  const availableMonths = useMemo(() => {
    const set = new Set<string>([defaultCurrentMonth]);
    if (overview) {
      for (const inv of overview.invoices) set.add(inv.invoiceMonth);
      for (const ch of overview.charges) {
        if (ch.invoiceMonth) set.add(ch.invoiceMonth);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [overview, defaultCurrentMonth]);

  const currentInvoice: CreditCardInvoice | null = useMemo(() => {
    if (!overview) return null;
    const found = overview.invoices.find((i) => i.invoiceMonth === selectedInvoiceMonth);
    if (found) return found;
    return {
      id: selectedInvoiceMonth,
      accountId: cardAccount.id,
      userId,
      invoiceMonth: selectedInvoiceMonth,
      closingDate: `${selectedInvoiceMonth}-${String(cardAccount.closingDay || 20).padStart(2, '0')}`,
      dueDate: `${selectedInvoiceMonth}-${String(cardAccount.dueDay || 27).padStart(2, '0')}`,
      totalPurchasesAmountCents: 0,
      carriedOverBalanceCents: 0,
      interestAndFeesCents: 0,
      totalDueAmountCents: 0,
      totalPaidAmountCents: 0,
      remainingBalanceCents: 0,
      invoiceStatus: 'open',
      updatedAt: new Date().toISOString(),
    };
  }, [overview, selectedInvoiceMonth, cardAccount, userId]);

  const currentInvoiceCharges = useMemo(() => {
    if (!overview) return [];
    return overview.charges.filter((c) => c.invoiceMonth === selectedInvoiceMonth);
  }, [overview, selectedInvoiceMonth]);

  const currentInvoiceSplit = useMemo(() => {
    let singleCount = 0;
    let singleTotalCents = 0;
    let installmentCount = 0;
    let installmentTotalCents = 0;

    for (const ch of currentInvoiceCharges) {
      if (ch.status === 'cancelled') continue;
      if (ch.contractId || (ch.totalInstallments && ch.totalInstallments > 1)) {
        installmentCount++;
        installmentTotalCents += ch.amountCents || 0;
      } else {
        singleCount++;
        singleTotalCents += ch.amountCents || 0;
      }
    }
    return {
      activeCount: singleCount + installmentCount,
      singleCount,
      singleTotalCents,
      installmentCount,
      installmentTotalCents,
    };
  }, [currentInvoiceCharges]);

  const filteredPurchases = useMemo(() => {
    if (!overview) return [];
    return overview.charges.filter((ch) => {
      if (purchaseMonthFilter !== 'all' && ch.invoiceMonth !== purchaseMonthFilter) {
        return false;
      }
      if (purchaseSearch.trim()) {
        const q = purchaseSearch.trim().toLowerCase();
        const hay = `${ch.description} ${ch.categoryName || ''} ${ch.invoiceMonth}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [overview, purchaseMonthFilter, purchaseSearch]);

  const futureInvoicesData = useMemo(() => {
    if (!overview) return { list: [] as Array<{ month: string; invoice?: CreditCardInvoice; charges: CreditCardInvoiceCharge[]; totalCents: number }>, grandTotalCents: 0 };

    const monthSet = new Set<string>();
    for (const inv of overview.invoices) {
      if (inv.invoiceMonth > defaultCurrentMonth && inv.invoiceStatus !== 'paid') {
        monthSet.add(inv.invoiceMonth);
      }
    }
    for (const ch of overview.charges) {
      if (ch.invoiceMonth > defaultCurrentMonth && ch.status !== 'cancelled') {
        monthSet.add(ch.invoiceMonth);
      }
    }

    const months = Array.from(monthSet).sort((a, b) => a.localeCompare(b));
    const list = months.map((month) => {
      const invoice = overview.invoices.find((i) => i.invoiceMonth === month);
      const charges = overview.charges.filter(
        (c) => c.invoiceMonth === month && c.status !== 'cancelled'
      );
      const chargesSum = charges.reduce((s, c) => s + (c.amountCents || 0), 0);
      const totalCents = invoice ? invoice.remainingBalanceCents : chargesSum;
      return { month, invoice, charges, totalCents };
    });

    const grandTotalCents = list.reduce((s, item) => s + item.totalCents, 0);
    return { list, grandTotalCents };
  }, [overview, defaultCurrentMonth]);

  const paidInvoicesData = useMemo(() => {
    if (!overview) return { paidInvoices: [] as CreditCardInvoice[], payments: [] as CardLedgerOverview['payments'] };
    const paidInvoices = overview.invoices.filter(
      (i) => i.invoiceStatus === 'paid' || i.totalPaidAmountCents > 0
    );
    return { paidInvoices, payments: overview.payments };
  }, [overview]);

  const handleOpenPayForm = () => {
    if (!currentInvoice || currentInvoice.remainingBalanceCents <= 0) return;
    setError(null);
    setPayAmountInput((currentInvoice.remainingBalanceCents / 100).toFixed(2).replace('.', ','));
    setPayDate(todayIso);
    setPayNotes('');
    if (!paySourceAccountId && payingAccounts.length > 0) {
      setPaySourceAccountId(payingAccounts[0].id);
    }
    setIsPayFormOpen(true);
  };

  const handleExecutePayInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentInvoice) return;
    setError(null);

    if (!paySourceAccountId) {
      setError('Selecione uma conta corrente ou carteira para pagar a fatura.');
      return;
    }

    let amountPaidCents = 0;
    try {
      amountPaidCents = parseBRLToCents(payAmountInput);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Valor de pagamento inválido.');
      return;
    }

    if (amountPaidCents <= 0) {
      setError('Informe um valor positivo para pagamento da fatura.');
      return;
    }
    if (amountPaidCents > currentInvoice.remainingBalanceCents) {
      setError(
        `O valor excede o saldo restante da fatura (${formatCentsToBRL(
          currentInvoice.remainingBalanceCents
        )}).`
      );
      return;
    }

    setPaySubmitting(true);
    try {
      const composedNotes = `Pagamento de fatura ${selectedInvoiceMonth} - ${cardAccount.name}${
        payNotes.trim() ? ` | ${payNotes.trim()}` : ''
      }`;
      await payCardInvoice(
        {
          cardAccountId: cardAccount.id,
          invoiceMonth: selectedInvoiceMonth,
          sourceAccountId: paySourceAccountId,
          amountPaidCents,
          paymentDate: payDate || todayIso,
          userId,
          notes: composedNotes,
        },
        isDemo
      );
      setIsPayFormOpen(false);
      showSuccess(
        `Fatura ${formatMonthLabel(selectedInvoiceMonth)} paga (${formatCentsToBRL(
          amountPaidCents
        )}) sem duplicar despesa!`
      );
      await loadOverview();
      onUpdated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Falha ao pagar fatura.');
    } finally {
      setPaySubmitting(false);
    }
  };

  const handleConfirmCancelPurchase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chargeToCancel) return;
    if (!cancelReason.trim()) {
      setError('Informe a justificativa do cancelamento da compra.');
      return;
    }
    setError(null);
    setCancelSubmitting(true);
    try {
      if (chargeToCancel.contractId) {
        const res = await cancelInstallmentContract(
          {
            contractId: chargeToCancel.contractId,
            cancellationReason: cancelReason.trim(),
          },
          isDemo
        );
        showSuccess(
          `Parcelamento cancelado (${res.cancelledCount} parcela(s) futura(s) cancelada(s); parcelas já faturadas/pagas preservadas).`
        );
      } else {
        await cancelPersonalTransaction(
          chargeToCancel.transactionId || chargeToCancel.id,
          userId,
          cancelReason.trim(),
          isDemo
        );
        showSuccess('Compra no cartão cancelada e abatida da fatura com rastreabilidade.');
      }
      setChargeToCancel(null);
      setCancelReason('');
      await loadOverview();
      onUpdated();
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : 'Não foi possível cancelar a compra no cartão.'
      );
    } finally {
      setCancelSubmitting(false);
    }
  };

  const limitSummary = overview?.limitSummary || {
    creditLimitCents: cardAccount.creditLimitCents || 0,
    usedAmountCents: 0,
    availableLimitCents: cardAccount.creditLimitCents || 0,
  };
  const utilizationPct =
    limitSummary.creditLimitCents > 0
      ? Math.min(
          100,
          Math.round((limitSummary.usedAmountCents / limitSummary.creditLimitCents) * 100)
        )
      : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 backdrop-blur-sm sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 w-full h-[100dvh] sm:h-auto sm:max-h-[90dvh] sm:max-w-5xl sm:rounded-3xl border border-slate-700/80 shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 1. CABEÇALHO DO CARTÃO */}
        <div className="p-4 sm:p-6 bg-slate-900 text-white border-b border-slate-700/80 shrink-0 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition-colors cursor-pointer"
            >
              <ArrowLeft className="w-4 h-4" />
              Voltar às Contas
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={loadOverview}
                disabled={loading}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition-colors cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                Atualizar
              </button>

              {!cardAccount.isArchived && onOpenNewTransaction && (
                <button
                  type="button"
                  onClick={() =>
                    onOpenNewTransaction({
                      presetAccountId: cardAccount.id,
                      presetType: 'expense',
                      presetIsPaid: true,
                    })
                  }
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-xs transition-all cursor-pointer"
                >
                  <ArrowUpRight className="w-4 h-4" />
                  Nova Compra
                </button>
              )}

              <button
                type="button"
                onClick={onClose}
                className="p-2 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition-all cursor-pointer"
                title="Fechar Livro do Cartão"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-3.5 min-w-0">
              <div
                className="w-12 h-12 rounded-2xl flex items-center justify-center text-white shrink-0 shadow-inner"
                style={{ backgroundColor: resolveHexColor(cardAccount.color, '#4F46E5') }}
              >
                <CreditCard className="w-6 h-6" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] uppercase tracking-wider text-indigo-300 font-bold">
                    Livro-Razão do Cartão de Crédito
                  </span>
                  {cardAccount.isArchived && (
                    <span className="px-2 py-0.5 text-[10px] bg-amber-500/20 text-amber-300 rounded font-bold border border-amber-500/30">
                      Arquivado (Somente Leitura)
                    </span>
                  )}
                </div>
                <h2 className="text-xl font-black text-white truncate mt-0.5">
                  {cardAccount.name}
                </h2>
                <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400 mt-0.5">
                  <span className="flex items-center gap-1">
                    <Calendar className="w-3.5 h-3.5 text-slate-500" />
                    Fecha dia <strong className="text-slate-200">{cardAccount.closingDay || 20}</strong>
                  </span>
                  <span>•</span>
                  <span>
                    Vence dia <strong className="text-slate-200">{cardAccount.dueDay || 27}</strong>
                  </span>
                  <span>•</span>
                  <span>
                    Utilização: <strong className="text-slate-200">{utilizationPct}%</strong>
                  </span>
                </div>
              </div>
            </div>

            {/* Cards de Limite */}
            <div className="grid grid-cols-3 gap-2.5 shrink-0">
              <div className="bg-slate-800/80 px-3.5 py-2 rounded-xl border border-slate-700/80">
                <span className="text-[10px] text-slate-400 uppercase font-semibold block">
                  Limite Total
                </span>
                <span className="text-sm sm:text-base font-black font-mono text-white">
                  {formatCentsToBRL(limitSummary.creditLimitCents)}
                </span>
              </div>
              <div className="bg-slate-800/80 px-3.5 py-2 rounded-xl border border-slate-700/80">
                <span className="text-[10px] text-slate-400 uppercase font-semibold block">
                  Comprometido
                </span>
                <span className="text-sm sm:text-base font-black font-mono text-amber-300">
                  {formatCentsToBRL(limitSummary.usedAmountCents)}
                </span>
              </div>
              <div className="bg-slate-800/80 px-3.5 py-2 rounded-xl border border-slate-700/80">
                <span className="text-[10px] text-slate-400 uppercase font-semibold block">
                  Disponível
                </span>
                <span
                  className={`text-sm sm:text-base font-black font-mono ${
                    limitSummary.availableLimitCents > 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {formatCentsToBRL(limitSummary.availableLimitCents)}
                </span>
              </div>
            </div>
          </div>

          {/* Barra de Abas Específicas do Cartão */}
          <div className="flex flex-wrap items-center gap-1.5 p-1 bg-slate-950/70 border border-slate-800 rounded-xl">
            <button
              type="button"
              onClick={() => setActiveTab('current_invoice')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                activeTab === 'current_invoice'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Receipt className="w-3.5 h-3.5" />
              Fatura Atual
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('purchases')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                activeTab === 'purchases'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              Histórico de Compras ({overview?.charges.length || 0})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('future_invoices')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                activeTab === 'future_invoices'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Clock className="w-3.5 h-3.5" />
              Faturas Futuras ({futureInvoicesData.list.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('paid_invoices')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                activeTab === 'paid_invoices'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <History className="w-3.5 h-3.5" />
              Faturas Pagas ({paidInvoicesData.payments.length})
            </button>
          </div>
        </div>

        {/* Banner Regra v3.1 */}
        <div className="bg-indigo-950/40 border-b border-indigo-900/50 px-5 py-2 flex items-center gap-2 text-xs text-indigo-200 shrink-0">
          <ShieldCheck className="w-4 h-4 text-indigo-400 shrink-0" />
          <span>
            <strong>Regra Financeira v3.1:</strong> Compras contabilizam a despesa na competência; o pagamento da fatura debita sua conta corrente sem gerar despesa duplicada.
          </span>
        </div>

        {/* Conteúdo Scrollável */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
          {successMsg && (
            <div className="flex items-center gap-2 p-3.5 bg-emerald-500/15 border border-emerald-500/30 text-emerald-200 rounded-xl text-xs font-medium">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{successMsg}</span>
            </div>
          )}

          {error && (
            <div className="flex items-center justify-between gap-2 p-3.5 bg-rose-500/15 border border-rose-500/30 text-rose-200 rounded-xl text-xs font-medium">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{error}</span>
              </div>
              <button
                type="button"
                onClick={() => setError(null)}
                className="text-rose-300 hover:text-white font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>
          )}

          {loading ? (
            <div className="text-center py-14">
              <RefreshCw className="w-7 h-7 animate-spin text-indigo-400 mx-auto" />
              <p className="text-xs text-slate-400 mt-2">
                Carregando faturas, parcelas e compras do cartão...
              </p>
            </div>
          ) : (
            <>
              {/* TAB 1: FATURA ATUAL */}
              {activeTab === 'current_invoice' && currentInvoice && (
                <div className="space-y-5">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-800/70 p-4 rounded-2xl border border-slate-700/80">
                    <div>
                      <span className="text-xs text-slate-400 font-semibold uppercase tracking-wider">
                        Competência da Fatura
                      </span>
                      <div className="flex items-center gap-2.5 mt-1 flex-wrap">
                        <select
                          value={selectedInvoiceMonth}
                          onChange={(e) => {
                            setSelectedInvoiceMonth(e.target.value);
                            setIsPayFormOpen(false);
                          }}
                          className="px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-xl text-sm font-bold text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        >
                          {availableMonths.map((m) => (
                            <option key={m} value={m}>
                              {formatMonthLabel(m)} ({m})
                              {m === defaultCurrentMonth ? ' — Vigente' : ''}
                            </option>
                          ))}
                        </select>
                        {(() => {
                          const badge = getInvoiceStatusBadge(currentInvoice.invoiceStatus);
                          return (
                            <span
                              className={`px-2.5 py-1 text-xs font-bold rounded-lg border ${badge.cls}`}
                            >
                              {badge.label}
                            </span>
                          );
                        })()}
                      </div>
                      <div className="text-xs text-slate-400 mt-1.5 flex flex-wrap gap-3">
                        <span>
                          Fechamento:{' '}
                          <strong className="text-slate-200">
                            {formatIsoDateBR(currentInvoice.closingDate)}
                          </strong>
                        </span>
                        <span>•</span>
                        <span>
                          Vencimento:{' '}
                          <strong className="text-slate-200">
                            {formatIsoDateBR(currentInvoice.dueDate)}
                          </strong>
                        </span>
                      </div>
                    </div>

                    {currentInvoice.remainingBalanceCents > 0 && !cardAccount.isArchived && (
                      <button
                        type="button"
                        onClick={handleOpenPayForm}
                        className="flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl shadow-sm transition-all cursor-pointer shrink-0"
                      >
                        <DollarSign className="w-4 h-4" />
                        Pagar Fatura ({formatCentsToBRL(currentInvoice.remainingBalanceCents)})
                      </button>
                    )}
                  </div>

                  {/* Resumo Numérico da Fatura */}
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    <div className="p-4 rounded-2xl bg-slate-800/80 border border-slate-700/80">
                      <span className="text-[11px] text-slate-400 uppercase font-semibold block">
                        Valor Acumulado
                      </span>
                      <span className="text-lg font-black font-mono text-white mt-1 block">
                        {formatCentsToBRL(currentInvoice.totalDueAmountCents)}
                      </span>
                      <span className="text-[11px] text-slate-400 mt-0.5 block">
                        Saldo a pagar:{' '}
                        <strong className="text-amber-300">
                          {formatCentsToBRL(currentInvoice.remainingBalanceCents)}
                        </strong>
                      </span>
                    </div>

                    <div className="p-4 rounded-2xl bg-slate-800/80 border border-slate-700/80">
                      <span className="text-[11px] text-slate-400 uppercase font-semibold block">
                        Compras na Fatura
                      </span>
                      <span className="text-lg font-black font-mono text-white mt-1 block">
                        {currentInvoiceSplit.activeCount}
                      </span>
                      <span className="text-[11px] text-slate-400 mt-0.5 block">
                        Já amortizado: {formatCentsToBRL(currentInvoice.totalPaidAmountCents)}
                      </span>
                    </div>

                    <div className="p-4 rounded-2xl bg-slate-800/80 border border-slate-700/80">
                      <span className="text-[11px] text-slate-400 uppercase font-semibold block">
                        Compras à Vista
                      </span>
                      <span className="text-lg font-black font-mono text-indigo-300 mt-1 block">
                        {formatCentsToBRL(currentInvoiceSplit.singleTotalCents)}
                      </span>
                      <span className="text-[11px] text-slate-400 mt-0.5 block">
                        {currentInvoiceSplit.singleCount} lançamento(s)
                      </span>
                    </div>

                    <div className="p-4 rounded-2xl bg-slate-800/80 border border-slate-700/80">
                      <span className="text-[11px] text-slate-400 uppercase font-semibold block">
                        Parcelas do Mês
                      </span>
                      <span className="text-lg font-black font-mono text-amber-300 mt-1 block">
                        {formatCentsToBRL(currentInvoiceSplit.installmentTotalCents)}
                      </span>
                      <span className="text-[11px] text-slate-400 mt-0.5 block">
                        {currentInvoiceSplit.installmentCount} parcela(s)
                      </span>
                    </div>
                  </div>

                  {/* Formulário de Pagamento de Fatura */}
                  {isPayFormOpen && (
                    <form
                      onSubmit={handleExecutePayInvoice}
                      className="p-4 rounded-2xl bg-emerald-950/25 border border-emerald-700/50 space-y-3"
                    >
                      <div className="flex items-center justify-between">
                        <h4 className="text-sm font-bold text-emerald-200">
                          Amortizar Fatura {formatMonthLabel(selectedInvoiceMonth)}
                        </h4>
                        <button
                          type="button"
                          onClick={() => setIsPayFormOpen(false)}
                          className="text-xs text-slate-400 hover:text-white cursor-pointer"
                        >
                          Cancelar
                        </button>
                      </div>

                      {payingAccounts.length === 0 ? (
                        <div className="text-xs text-amber-300 p-3 rounded-xl bg-amber-950/40 border border-amber-700/50">
                          Cadastre uma Conta Corrente ou Carteira ativa para realizar o pagamento da fatura.
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          <div>
                            <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                              Conta Pagadora *
                            </label>
                            <select
                              required
                              value={paySourceAccountId}
                              onChange={(e) => setPaySourceAccountId(e.target.value)}
                              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                            >
                              {payingAccounts.map((acc) => (
                                <option key={acc.id} value={acc.id}>
                                  {acc.name} ({formatCentsToBRL(acc.projectedBalanceCents)})
                                </option>
                              ))}
                            </select>
                          </div>

                          <div>
                            <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                              Valor do Pagamento (R$) *
                            </label>
                            <input
                              type="text"
                              required
                              value={payAmountInput}
                              onChange={(e) => setPayAmountInput(e.target.value)}
                              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
                            />
                          </div>

                          <div>
                            <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                              Data do Pagamento *
                            </label>
                            <input
                              type="date"
                              required
                              value={payDate}
                              onChange={(e) => setPayDate(e.target.value)}
                              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                            />
                          </div>
                        </div>
                      )}

                      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                        <input
                          type="text"
                          placeholder="Observação opcional (ex: Pagamento integral via PIX)"
                          value={payNotes}
                          onChange={(e) => setPayNotes(e.target.value)}
                          className="flex-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                        {payingAccounts.length > 0 && (
                          <button
                            type="submit"
                            disabled={paySubmitting}
                            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl transition-all disabled:opacity-50 cursor-pointer"
                          >
                            {paySubmitting ? 'Processando...' : 'Confirmar Pagamento'}
                          </button>
                        )}
                      </div>
                    </form>
                  )}

                  {/* Itens da Fatura Selecionada */}
                  <div className="space-y-2.5">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                      Compras e Parcelas nesta Fatura ({currentInvoiceCharges.length})
                    </h4>
                    {currentInvoiceCharges.length === 0 ? (
                      <div className="text-center py-10 bg-slate-800/40 rounded-2xl border border-dashed border-slate-700">
                        <Receipt className="w-8 h-8 text-slate-500 mx-auto mb-2" />
                        <p className="text-xs font-semibold text-slate-300">
                          Nenhuma compra lançada na fatura de {formatMonthLabel(selectedInvoiceMonth)}.
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {currentInvoiceCharges.map((ch) => (
                          <div
                            key={ch.id}
                            className={`p-3.5 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 ${
                              ch.status === 'cancelled'
                                ? 'bg-slate-900/50 border-slate-800 opacity-60'
                                : 'bg-slate-800/60 border-slate-700/70'
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-bold text-white truncate">
                                  {ch.description}
                                </span>
                                <span className="px-2 py-0.5 text-[10px] font-semibold rounded bg-slate-800 border border-slate-700 text-slate-300">
                                  {ch.categoryName || 'Geral'}
                                </span>
                                {ch.installmentNumber && ch.totalInstallments ? (
                                  <span className="px-2 py-0.5 text-[10px] font-bold rounded bg-indigo-500/15 border border-indigo-500/30 text-indigo-300">
                                    Parcela {ch.installmentNumber}/{ch.totalInstallments}
                                  </span>
                                ) : (
                                  <span className="px-2 py-0.5 text-[10px] font-semibold rounded bg-slate-800 border border-slate-700 text-slate-400">
                                    À vista
                                  </span>
                                )}
                                {ch.status === 'cancelled' && (
                                  <span className="px-2 py-0.5 text-[10px] font-bold rounded bg-rose-500/15 border border-rose-500/30 text-rose-300">
                                    Cancelada
                                  </span>
                                )}
                              </div>
                              <div className="text-xs text-slate-400 mt-1">
                                Compra em {formatIsoDateBR(ch.purchaseDate)} • Fatura{' '}
                                {formatMonthLabel(ch.invoiceMonth)}
                              </div>
                            </div>

                            <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0">
                              <span className="text-sm font-black font-mono text-white">
                                {formatCentsToBRL(ch.amountCents)}
                              </span>
                              {ch.status !== 'cancelled' && !cardAccount.isArchived && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setChargeToCancel(ch);
                                    setCancelReason('');
                                  }}
                                  className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-rose-300 bg-rose-950/50 hover:bg-rose-900/60 border border-rose-800/60 rounded-lg transition-all cursor-pointer"
                                >
                                  <Ban className="w-3 h-3" />
                                  Cancelar
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 2: HISTÓRICO DE COMPRAS */}
              {activeTab === 'purchases' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-slate-800/70 p-3.5 rounded-2xl border border-slate-700/80">
                    <div className="relative">
                      <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                      <input
                        type="text"
                        placeholder="Buscar por descrição, categoria ou fatura..."
                        value={purchaseSearch}
                        onChange={(e) => setPurchaseSearch(e.target.value)}
                        className="w-full pl-9 pr-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <select
                      value={purchaseMonthFilter}
                      onChange={(e) => setPurchaseMonthFilter(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-xs text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="all">Todas as competências de fatura</option>
                      {availableMonths.map((m) => (
                        <option key={m} value={m}>
                          Fatura {formatMonthLabel(m)} ({m})
                        </option>
                      ))}
                    </select>
                  </div>

                  {filteredPurchases.length === 0 ? (
                    <div className="text-center py-12 bg-slate-800/40 rounded-2xl border border-dashed border-slate-700">
                      <Layers className="w-9 h-9 text-slate-500 mx-auto mb-2" />
                      <p className="text-xs font-semibold text-slate-300">
                        Nenhuma compra encontrada no histórico deste cartão.
                      </p>
                    </div>
                  ) : (
                    <>
                      {/* Desktop Table */}
                      <div className="hidden md:block overflow-x-auto rounded-2xl border border-slate-700/80 bg-slate-900/70">
                        <table className="w-full text-left text-xs">
                          <thead className="bg-slate-800/90 text-slate-300 uppercase text-[10px] tracking-wider border-b border-slate-700">
                            <tr>
                              <th className="px-4 py-3">Data</th>
                              <th className="px-4 py-3">Descrição</th>
                              <th className="px-4 py-3">Categoria</th>
                              <th className="px-4 py-3">Parcela</th>
                              <th className="px-4 py-3">Fatura</th>
                              <th className="px-4 py-3">Status</th>
                              <th className="px-4 py-3 text-right">Valor</th>
                              <th className="px-4 py-3 text-right">Ação</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-800">
                            {filteredPurchases.map((ch) => (
                              <tr key={ch.id} className="hover:bg-slate-800/40">
                                <td className="px-4 py-3 font-mono text-slate-300 whitespace-nowrap">
                                  {formatIsoDateBR(ch.purchaseDate)}
                                </td>
                                <td className="px-4 py-3 font-semibold text-white">
                                  {ch.description}
                                </td>
                                <td className="px-4 py-3 text-slate-300">
                                  {ch.categoryName || 'Geral'}
                                </td>
                                <td className="px-4 py-3">
                                  {ch.installmentNumber && ch.totalInstallments
                                    ? `${ch.installmentNumber}/${ch.totalInstallments}`
                                    : 'À vista'}
                                </td>
                                <td className="px-4 py-3 font-mono text-indigo-300">
                                  {formatMonthLabel(ch.invoiceMonth)}
                                </td>
                                <td className="px-4 py-3">
                                  <span
                                    className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                                      ch.status === 'cancelled'
                                        ? 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                                        : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                                    }`}
                                  >
                                    {ch.status === 'cancelled' ? 'Cancelada' : 'Ativa'}
                                  </span>
                                </td>
                                <td className="px-4 py-3 text-right font-mono font-bold text-white whitespace-nowrap">
                                  {formatCentsToBRL(ch.amountCents)}
                                </td>
                                <td className="px-4 py-3 text-right whitespace-nowrap">
                                  {ch.status !== 'cancelled' && !cardAccount.isArchived ? (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setChargeToCancel(ch);
                                        setCancelReason('');
                                      }}
                                      className="px-2.5 py-1 text-[11px] font-semibold text-rose-300 bg-rose-950/50 hover:bg-rose-900/60 border border-rose-800/60 rounded-lg cursor-pointer"
                                    >
                                      Cancelar
                                    </button>
                                  ) : (
                                    <span className="text-slate-600">—</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {/* Mobile Cards */}
                      <div className="md:hidden space-y-2.5">
                        {filteredPurchases.map((ch) => (
                          <div
                            key={ch.id}
                            className="p-3.5 rounded-xl bg-slate-800/60 border border-slate-700/70 space-y-2"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <div className="text-sm font-bold text-white">
                                  {ch.description}
                                </div>
                                <div className="text-xs text-slate-400">
                                  {formatIsoDateBR(ch.purchaseDate)} • {ch.categoryName || 'Geral'}
                                </div>
                              </div>
                              <span className="font-mono font-black text-sm text-white">
                                {formatCentsToBRL(ch.amountCents)}
                              </span>
                            </div>
                            <div className="flex items-center justify-between text-xs pt-2 border-t border-slate-700/60">
                              <div className="flex items-center gap-2">
                                <span className="text-indigo-300 font-semibold">
                                  Fatura {formatMonthLabel(ch.invoiceMonth)}
                                </span>
                                <span className="text-slate-400">
                                  {ch.installmentNumber && ch.totalInstallments
                                    ? `${ch.installmentNumber}/${ch.totalInstallments}`
                                    : 'À vista'}
                                </span>
                              </div>
                              {ch.status !== 'cancelled' && !cardAccount.isArchived && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setChargeToCancel(ch);
                                    setCancelReason('');
                                  }}
                                  className="px-2 py-1 text-[11px] font-semibold text-rose-300 bg-rose-950/50 border border-rose-800/60 rounded-lg cursor-pointer"
                                >
                                  Cancelar
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* TAB 3: FATURAS FUTURAS */}
              {activeTab === 'future_invoices' && (
                <div className="space-y-4">
                  <div className="p-4 rounded-2xl bg-slate-800/70 border border-slate-700/80 flex items-center justify-between">
                    <div>
                      <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                        Compromissos em Faturas Futuras
                      </span>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Parcelas e compras programadas para competências posteriores a{' '}
                        {formatMonthLabel(defaultCurrentMonth)}.
                      </p>
                    </div>
                    <div className="text-right">
                      <span className="text-lg font-black font-mono text-amber-300">
                        {formatCentsToBRL(futureInvoicesData.grandTotalCents)}
                      </span>
                      <span className="block text-[11px] text-slate-400">
                        {futureInvoicesData.list.length} fatura(s) futura(s)
                      </span>
                    </div>
                  </div>

                  {futureInvoicesData.list.length === 0 ? (
                    <div className="text-center py-12 bg-slate-800/40 rounded-2xl border border-dashed border-slate-700">
                      <Clock className="w-9 h-9 text-slate-500 mx-auto mb-2" />
                      <p className="text-xs font-semibold text-slate-300">
                        Nenhuma parcela ou fatura futura comprometida neste cartão.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {futureInvoicesData.list.map((item) => (
                        <div
                          key={item.month}
                          className="p-4 rounded-2xl bg-slate-800/60 border border-slate-700/80 space-y-2.5"
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <h4 className="text-sm font-bold text-white">
                                Fatura {formatMonthLabel(item.month)} ({item.month})
                              </h4>
                              <span className="text-xs text-slate-400">
                                {item.charges.length} lançamento(s) previsto(s)
                              </span>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="text-base font-black font-mono text-amber-300">
                                {formatCentsToBRL(item.totalCents)}
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedInvoiceMonth(item.month);
                                  setActiveTab('current_invoice');
                                }}
                                className="px-2.5 py-1 text-xs font-semibold text-indigo-300 bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 rounded-lg cursor-pointer"
                              >
                                Abrir Fatura
                              </button>
                            </div>
                          </div>

                          {item.charges.length > 0 && (
                            <div className="pt-2 border-t border-slate-700/60 space-y-1.5">
                              {item.charges.map((ch) => (
                                <div
                                  key={ch.id}
                                  className="flex items-center justify-between text-xs text-slate-300"
                                >
                                  <span className="truncate pr-2">
                                    {ch.description}
                                    {ch.installmentNumber && ch.totalInstallments
                                      ? ` (${ch.installmentNumber}/${ch.totalInstallments})`
                                      : ''}
                                  </span>
                                  <span className="font-mono font-semibold text-white shrink-0">
                                    {formatCentsToBRL(ch.amountCents)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* TAB 4: HISTÓRICO DE FATURAS PAGAS */}
              {activeTab === 'paid_invoices' && (
                <div className="space-y-4">
                  {paidInvoicesData.payments.length === 0 &&
                  paidInvoicesData.paidInvoices.length === 0 ? (
                    <div className="text-center py-12 bg-slate-800/40 rounded-2xl border border-dashed border-slate-700">
                      <History className="w-9 h-9 text-slate-500 mx-auto mb-2" />
                      <p className="text-xs font-semibold text-slate-300">
                        Nenhum pagamento de fatura registrado para este cartão ainda.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {paidInvoicesData.payments.map((pay) => {
                        const inv = overview?.invoices.find(
                          (i) => i.invoiceMonth === pay.invoiceMonth
                        );
                        const sourceAccName =
                          accountNameById.get(pay.sourceAccountId) || pay.sourceAccountId;
                        const isExpanded = inspectedPaidMonth === pay.invoiceMonth;
                        const invCharges =
                          overview?.charges.filter((c) => c.invoiceMonth === pay.invoiceMonth) ||
                          [];

                        return (
                          <div
                            key={pay.id}
                            className="p-4 rounded-2xl bg-slate-800/60 border border-slate-700/80 space-y-2.5"
                          >
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                              <div>
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-sm font-bold text-white">
                                    Fatura {formatMonthLabel(pay.invoiceMonth)} ({pay.invoiceMonth})
                                  </span>
                                  <span
                                    className={`px-2 py-0.5 text-[10px] font-bold rounded border ${
                                      inv?.invoiceStatus === 'paid'
                                        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                                        : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                                    }`}
                                  >
                                    {inv?.invoiceStatus === 'paid' ? 'Paga' : 'Parcial'}
                                  </span>
                                </div>
                                <div className="text-xs text-slate-400 mt-1">
                                  Pago em{' '}
                                  <strong className="text-slate-200">
                                    {formatIsoDateBR(pay.paymentDate)}
                                  </strong>{' '}
                                  via conta{' '}
                                  <strong className="text-indigo-300">{sourceAccName}</strong>
                                </div>
                              </div>

                              <div className="flex items-center gap-3">
                                <div className="text-right">
                                  <span className="text-sm font-black font-mono text-emerald-400 block">
                                    {formatCentsToBRL(pay.amountPaidCents)}
                                  </span>
                                  {inv && (
                                    <span className="text-[10px] text-slate-400">
                                      Total da fatura: {formatCentsToBRL(inv.totalDueAmountCents)}
                                    </span>
                                  )}
                                </div>

                                <button
                                  type="button"
                                  onClick={() =>
                                    setInspectedPaidMonth(isExpanded ? null : pay.invoiceMonth)
                                  }
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg cursor-pointer"
                                >
                                  <Eye className="w-3.5 h-3.5" />
                                  {isExpanded ? 'Ocultar' : 'Inspecionar'}
                                </button>
                              </div>
                            </div>

                            {isExpanded && (
                              <div className="pt-2.5 border-t border-slate-700/60 space-y-1.5">
                                <div className="text-[11px] font-bold uppercase text-slate-400">
                                  Composição da Fatura ({invCharges.length} item(ns))
                                </div>
                                {invCharges.length === 0 ? (
                                  <div className="text-xs text-slate-400">
                                    Sem itens detalhados disponíveis.
                                  </div>
                                ) : (
                                  invCharges.map((ch) => (
                                    <div
                                      key={ch.id}
                                      className="flex items-center justify-between text-xs text-slate-300"
                                    >
                                      <span>
                                        {formatIsoDateBR(ch.purchaseDate)} — {ch.description}
                                      </span>
                                      <span className="font-mono font-semibold text-white">
                                        {formatCentsToBRL(ch.amountCents)}
                                      </span>
                                    </div>
                                  ))
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Submodal de Confirmação de Cancelamento de Compra / Parcelamento */}
        {chargeToCancel && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs">
            <div className="bg-slate-900 rounded-2xl max-w-md w-full p-5 border border-rose-800/60 shadow-2xl space-y-4">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <h3 className="text-base font-bold text-white">
                  {chargeToCancel.contractId
                    ? 'Cancelar Parcelamento no Cartão'
                    : 'Cancelar Compra no Cartão'}
                </h3>
                <button
                  type="button"
                  onClick={() => setChargeToCancel(null)}
                  className="p-1 text-slate-400 hover:text-white cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-3 rounded-xl bg-rose-950/30 border border-rose-800/50 text-xs text-rose-200 space-y-1">
                <div>
                  Compra: <strong className="text-white">{chargeToCancel.description}</strong>
                </div>
                <div>
                  Valor:{' '}
                  <strong className="text-white">
                    {formatCentsToBRL(chargeToCancel.amountCents)}
                  </strong>
                </div>
                {chargeToCancel.contractId && (
                  <p className="text-[11px] text-rose-300 pt-1">
                    Apenas parcelas futuras agendadas serão canceladas; parcelas já faturadas ou pagas permanecerão preservadas no histórico.
                  </p>
                )}
              </div>

              <form onSubmit={handleConfirmCancelPurchase} className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Justificativa obrigatória *
                  </label>
                  <textarea
                    required
                    rows={3}
                    placeholder="Ex: Compra duplicada, estorno combinado com a loja..."
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-rose-500"
                  />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setChargeToCancel(null)}
                    className="px-3.5 py-2 text-xs font-semibold text-slate-400 hover:text-white cursor-pointer"
                  >
                    Voltar
                  </button>
                  <button
                    type="submit"
                    disabled={cancelSubmitting}
                    className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-xl disabled:opacity-50 cursor-pointer"
                  >
                    {cancelSubmitting ? 'Cancelando...' : 'Confirmar Cancelamento'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
