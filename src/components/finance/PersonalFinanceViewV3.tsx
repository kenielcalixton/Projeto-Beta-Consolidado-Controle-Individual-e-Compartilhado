import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Wallet,
  Building2,
  CreditCard,
  Plus,
  RefreshCw,
  ArrowDownLeft,
  ArrowUpRight,
  ArrowLeftRight,
  AlertCircle,
  CheckCircle2,
  Calendar,
  X,
  DollarSign,
  ShieldCheck,
  Tag,
  Target,
  RotateCcw,
  SlidersHorizontal,
  ChevronRight,
  TrendingUp,
  Receipt,
  FileText,
  Clock,
  Ban,
  CheckCircle,
} from 'lucide-react';
import {
  Account,
  CentsInteger,
  CompetenceMonthString,
  CreditCardInvoice,
  DateString,
  InternalAccountTransfer,
  PersonalBudgetProgress,
  PersonalCategory,
  PersonalRefund,
  PersonalTransaction,
  PersonalTransactionStatus,
  PersonalTransactionType,
} from '../../types/financeV3';
import { getUserAccounts } from '../../services/accountService';
import {
  getUserCategories,
  createCategory,
  archiveCategory,
  ensureDefaultCategories,
} from '../../services/categoryService';
import {
  createPersonalTransaction,
  recordPartialPayment,
  cancelPersonalTransaction,
  getUserPersonalTransactions,
  getPersonalTransactionPayments,
} from '../../services/personalTransactionService';
import {
  executeInternalTransfer,
  getUserTransfers,
} from '../../services/transferService';
import {
  getCardInvoices,
  payCardInvoice,
  carryOverInvoiceBalance,
  calculateCardAvailableLimit,
} from '../../services/creditCardService';
import {
  getUserBudgetsWithProgress,
  createPersonalBudget,
  deletePersonalBudget,
} from '../../services/budgetService';
import {
  createPersonalRefund,
  recordRefundReceipt,
  getUserRefunds,
  getRefundReceipts,
} from '../../services/refundService';
import {
  formatCentsToBRL,
  parseBRLToCents,
  validatePositiveCents,
} from '../../utils/movementLedger';

interface PersonalFinanceViewV3Props {
  userId: string;
  isDemo?: boolean;
}

type MainTab =
  | 'transactions'
  | 'invoices'
  | 'transfers'
  | 'budgets'
  | 'refunds'
  | 'categories';

export const PersonalFinanceViewV3: React.FC<PersonalFinanceViewV3Props> = ({
  userId,
  isDemo = false,
}) => {
  const [activeTab, setActiveTab] = useState<MainTab>('transactions');
  const [selectedMonth, setSelectedMonth] = useState<CompetenceMonthString>(() => {
    const now = new Date();
    return `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}`;
  });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successToast, setSuccessToast] = useState<string | null>(null);

  // Dados carregados
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<PersonalCategory[]>([]);
  const [transactions, setTransactions] = useState<PersonalTransaction[]>([]);
  const [invoices, setInvoices] = useState<CreditCardInvoice[]>([]);
  const [transfers, setTransfers] = useState<InternalAccountTransfer[]>([]);
  const [budgets, setBudgets] = useState<PersonalBudgetProgress[]>([]);
  const [refunds, setRefunds] = useState<PersonalRefund[]>([]);

  // Filtros de Transações
  const [filterType, setFilterType] = useState<'all' | 'income' | 'expense'>('all');
  const [filterStatus, setFilterStatus] = useState<'all' | PersonalTransactionStatus>('all');
  const [filterCategory, setFilterCategory] = useState<string>('all');

  // Modais
  const [isTxModalOpen, setIsTxModalOpen] = useState(false);
  const [txType, setTxType] = useState<PersonalTransactionType>('expense');
  const [txDesc, setTxDesc] = useState('');
  const [txAmount, setTxAmount] = useState('');
  const [txCategory, setTxCategory] = useState('');
  const [txAccount, setTxAccount] = useState('');
  const [txDate, setTxDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [txStatus, setTxStatus] = useState<PersonalTransactionStatus>('paid');
  const [txNotes, setTxNotes] = useState('');
  const [txIdempotencyKey, setTxIdempotencyKey] = useState('');
  const [txSubmitting, setTxSubmitting] = useState(false);

  // Modal Pagamento Parcial
  const [partialTx, setPartialTx] = useState<PersonalTransaction | null>(null);
  const [partialAmount, setPartialAmount] = useState('');
  const [partialAccount, setPartialAccount] = useState('');
  const [partialDate, setPartialDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [partialNotes, setPartialNotes] = useState('');
  const [partialIdempotencyKey, setPartialIdempotencyKey] = useState('');
  const [partialSubmitting, setPartialSubmitting] = useState(false);

  // Modal Transferência
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
  const [xferSource, setXferSource] = useState('');
  const [xferDest, setXferDest] = useState('');
  const [xferAmount, setXferAmount] = useState('');
  const [xferDate, setXferDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [xferDesc, setXferDesc] = useState('');
  const [xferIdempotencyKey, setXferIdempotencyKey] = useState('');
  const [xferSubmitting, setXferSubmitting] = useState(false);

  // Modal Pagar Fatura
  const [payInvoiceModal, setPayInvoiceModal] = useState<CreditCardInvoice | null>(null);
  const [payInvSourceAcc, setPayInvSourceAcc] = useState('');
  const [payInvAmount, setPayInvAmount] = useState('');
  const [payInvDate, setPayInvDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [payInvIdempotencyKey, setPayInvIdempotencyKey] = useState('');
  const [payInvSubmitting, setPayInvSubmitting] = useState(false);

  // Modal Orçamento
  const [isBudgetModalOpen, setIsBudgetModalOpen] = useState(false);
  const [budgetName, setBudgetName] = useState('');
  const [budgetCatIds, setBudgetCatIds] = useState<string[]>([]);
  const [budgetAmount, setBudgetAmount] = useState('');
  const [budgetSubmitting, setBudgetSubmitting] = useState(false);

  // Modal Reembolso
  const [isRefundModalOpen, setIsRefundModalOpen] = useState(false);
  const [refTxId, setRefTxId] = useState('');
  const [refDebtor, setRefDebtor] = useState('');
  const [refAmount, setRefAmount] = useState('');
  const [refDesc, setRefDesc] = useState('');
  const [refIdempotencyKey, setRefIdempotencyKey] = useState('');
  const [refSubmitting, setRefSubmitting] = useState(false);

  // Modal Receber Reembolso
  const [receiveRefundModal, setReceiveRefundModal] = useState<PersonalRefund | null>(null);
  const [receiveAmount, setReceiveAmount] = useState('');
  const [receiveAccount, setReceiveAccount] = useState('');
  const [receiveDate, setReceiveDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [receiveIdempotencyKey, setReceiveIdempotencyKey] = useState('');
  const [receiveSubmitting, setReceiveSubmitting] = useState(false);

  // Modal Nova Categoria
  const [isCategoryModalOpen, setIsCategoryModalOpen] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [newCatType, setNewCatType] = useState<'income' | 'expense'>('expense');
  const [newCatColor, setNewCatColor] = useState('#2563EB');
  const [newCatSubmitting, setNewCatSubmitting] = useState(false);

  const showToast = (msg: string) => {
    setSuccessToast(msg);
    setTimeout(() => setSuccessToast(null), 4000);
  };

  // Carregamento principal de dados
  const loadAllData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 1. Contas
      const accList = await getUserAccounts(userId, true, isDemo);
      setAccounts(accList);

      // 2. Categorias (garante padrão inicial)
      const catList = await ensureDefaultCategories(userId, isDemo);
      setCategories(catList);

      // 3. Transações do Mês
      const txList = await getUserPersonalTransactions(
        userId,
        { competenceMonth: selectedMonth },
        isDemo
      );
      setTransactions(txList);

      // 4. Faturas de Cartão
      const cardAccounts = accList.filter((a) => a.type === 'credit');
      const allInvoices: CreditCardInvoice[] = [];
      for (const card of cardAccounts) {
        const invs = await getCardInvoices(card.id, userId, isDemo);
        allInvoices.push(...invs);
      }
      setInvoices(allInvoices);

      // 5. Transferências
      const xferList = await getUserTransfers(userId, isDemo);
      setTransfers(xferList);

      // 6. Orçamentos com Progresso
      const bgtList = await getUserBudgetsWithProgress(userId, selectedMonth, isDemo);
      setBudgets(bgtList);

      // 7. Reembolsos
      const refList = await getUserRefunds(userId, isDemo);
      setRefunds(refList);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao carregar dados financeiros';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [userId, selectedMonth, isDemo]);

  useEffect(() => {
    loadAllData();
  }, [loadAllData]);

  // Indicadores e Métricas
  const totalBalanceCents = useMemo(() => {
    return accounts
      .filter((a) => !a.isArchived && a.type !== 'credit')
      .reduce((sum, a) => sum + (a.projectedBalanceCents || 0), 0);
  }, [accounts]);

  const monthIncomeCents = useMemo(() => {
    return transactions
      .filter((t) => t.type === 'income' && t.status === 'paid')
      .reduce((sum, t) => sum + t.amountCents, 0);
  }, [transactions]);

  const monthExpenseCents = useMemo(() => {
    return transactions
      .filter((t) => t.type === 'expense' && t.status === 'paid')
      .reduce((sum, t) => sum + t.amountCents, 0);
  }, [transactions]);

  const pendingExpenseCents = useMemo(() => {
    return transactions
      .filter((t) => t.type === 'expense' && (t.status === 'pending' || t.status === 'forecast' || t.status === 'partially_paid'))
      .reduce((sum, t) => sum + (t.remainingAmountCents ?? t.amountCents), 0);
  }, [transactions]);

  // Transações Filtradas
  const filteredTransactions = useMemo(() => {
    return transactions.filter((t) => {
      if (filterType !== 'all' && t.type !== filterType) return false;
      if (filterStatus !== 'all' && t.status !== filterStatus) return false;
      if (filterCategory !== 'all' && t.categoryId !== filterCategory) return false;
      return true;
    });
  }, [transactions, filterType, filterStatus, filterCategory]);

  // 1. Gravar Nova Transação (Receita ou Despesa)
  const handleCreateTransaction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!txDesc.trim()) {
      setError('Descrição é obrigatória.');
      return;
    }
    let cents = 0;
    try {
      cents = parseBRLToCents(txAmount);
      validatePositiveCents(cents);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Valor inválido';
      setError(msg);
      return;
    }

    if (!txCategory) {
      setError('Selecione uma categoria.');
      return;
    }

    setTxSubmitting(true);
    setError(null);
    try {
      const activeKey =
        txIdempotencyKey ||
        `idem_ui_ptx_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (!txIdempotencyKey) setTxIdempotencyKey(activeKey);

      const selectedCat = categories.find((c) => c.id === txCategory);
      await createPersonalTransaction(
        userId,
        {
          description: txDesc.trim(),
          amountCents: cents,
          type: txType,
          status: txStatus,
          categoryId: txCategory,
          categoryName: selectedCat?.name || 'Geral',
          accountId: txAccount || undefined,
          competenceDate: txDate,
          dueDate: txDate,
          paymentDate: txStatus === 'paid' ? txDate : undefined,
          notes: txNotes.trim() || undefined,
          idempotencyKey: activeKey,
        },
        isDemo
      );

      showToast(
        `${txType === 'income' ? 'Receita' : 'Despesa'} registrada com sucesso!`
      );
      setIsTxModalOpen(false);
      resetTxForm();
      await loadAllData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha ao registrar transação';
      setError(msg);
    } finally {
      setTxSubmitting(false);
    }
  };

  const resetTxForm = () => {
    setTxDesc('');
    setTxAmount('');
    setTxCategory('');
    setTxAccount('');
    setTxNotes('');
    setTxStatus('paid');
    setTxIdempotencyKey(
      `idem_ui_ptx_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    );
  };

  // 2. Amortização / Pagamento Parcial
  const handleExecutePartialPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!partialTx) return;

    let cents = 0;
    try {
      cents = parseBRLToCents(partialAmount);
      validatePositiveCents(cents);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Valor inválido';
      setError(msg);
      return;
    }

    if (!partialAccount) {
      setError('Selecione a conta para débito/crédito.');
      return;
    }

    setPartialSubmitting(true);
    setError(null);
    try {
      const activeKey =
        partialIdempotencyKey ||
        `idem_ui_txpay_${partialTx.id}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (!partialIdempotencyKey) setPartialIdempotencyKey(activeKey);

      await recordPartialPayment(
        partialTx.id,
        userId,
        {
          amountCents: cents,
          paymentDate: partialDate,
          accountId: partialAccount,
          notes: partialNotes.trim() || undefined,
          authorUid: userId,
          idempotencyKey: activeKey,
        },
        isDemo
      );

      showToast(`Amortização de ${formatCentsToBRL(cents)} registrada com sucesso!`);
      setPartialTx(null);
      setPartialAmount('');
      setPartialNotes('');
      setPartialIdempotencyKey('');
      await loadAllData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha na amortização';
      setError(msg);
    } finally {
      setPartialSubmitting(false);
    }
  };

  // 3. Cancelamento de Transação
  const handleCancelTx = async (tx: PersonalTransaction) => {
    const reason = window.prompt(
      `Confirma o cancelamento da transação "${tx.description}"?\nInforme o motivo obrigatório:`
    );
    if (!reason || !reason.trim()) return;

    try {
      await cancelPersonalTransaction(tx.id, userId, reason.trim(), isDemo);
      showToast('Transação cancelada com sucesso.');
      await loadAllData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha ao cancelar transação';
      setError(msg);
    }
  };

  // 4. Transferência entre Contas Próprias
  const handleExecuteTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!xferSource || !xferDest) {
      setError('Selecione conta de origem e conta de destino.');
      return;
    }
    if (xferSource === xferDest) {
      setError('Origem e destino não podem ser a mesma conta.');
      return;
    }

    let cents = 0;
    try {
      cents = parseBRLToCents(xferAmount);
      validatePositiveCents(cents);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Valor inválido';
      setError(msg);
      return;
    }

    setXferSubmitting(true);
    setError(null);
    try {
      const activeKey =
        xferIdempotencyKey ||
        `idem_ui_xfer_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (!xferIdempotencyKey) setXferIdempotencyKey(activeKey);

      await executeInternalTransfer(
        userId,
        {
          sourceAccountId: xferSource,
          destinationAccountId: xferDest,
          amountCents: cents,
          transferDate: xferDate,
          description: xferDesc.trim() || undefined,
          idempotencyKey: activeKey,
        },
        isDemo
      );

      showToast(`Transferência de ${formatCentsToBRL(cents)} executada com sucesso!`);
      setIsTransferModalOpen(false);
      setXferAmount('');
      setXferDesc('');
      setXferIdempotencyKey('');
      await loadAllData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha na transferência';
      setError(msg);
    } finally {
      setXferSubmitting(false);
    }
  };

  // 5. Pagar Fatura de Cartão
  const handleExecutePayInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payInvoiceModal) return;
    if (!payInvSourceAcc) {
      setError('Selecione a conta corrente/carteira pagadora.');
      return;
    }

    let cents = 0;
    try {
      cents = parseBRLToCents(payInvAmount);
      validatePositiveCents(cents);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Valor inválido';
      setError(msg);
      return;
    }

    setPayInvSubmitting(true);
    setError(null);
    try {
      const activeKey =
        payInvIdempotencyKey ||
        `idem_ui_invpay_${payInvoiceModal.accountId}_${payInvoiceModal.invoiceMonth}_${Date.now()}`;
      if (!payInvIdempotencyKey) setPayInvIdempotencyKey(activeKey);

      await payCardInvoice(
        {
          cardAccountId: payInvoiceModal.accountId,
          invoiceMonth: payInvoiceModal.invoiceMonth,
          sourceAccountId: payInvSourceAcc,
          amountPaidCents: cents,
          paymentDate: payInvDate,
          userId,
          idempotencyKey: activeKey,
        },
        isDemo
      );

      showToast(`Pagamento de fatura gravado: ${formatCentsToBRL(cents)} debitado na conta!`);
      setPayInvoiceModal(null);
      setPayInvAmount('');
      setPayInvIdempotencyKey('');
      await loadAllData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha no pagamento da fatura';
      setError(msg);
    } finally {
      setPayInvSubmitting(false);
    }
  };

  // 6. Criar Orçamento
  const handleCreateBudget = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!budgetName.trim()) {
      setError('Nome do orçamento é obrigatório.');
      return;
    }
    if (budgetCatIds.length === 0) {
      setError('Selecione ao menos uma categoria para o orçamento.');
      return;
    }
    let cents = 0;
    try {
      cents = parseBRLToCents(budgetAmount);
      validatePositiveCents(cents);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Valor inválido';
      setError(msg);
      return;
    }

    setBudgetSubmitting(true);
    setError(null);
    try {
      await createPersonalBudget(
        userId,
        {
          name: budgetName.trim(),
          categoryIds: budgetCatIds,
          competenceMonth: selectedMonth,
          plannedAmountCents: cents,
        },
        isDemo
      );

      showToast('Orçamento planejado com sucesso!');
      setIsBudgetModalOpen(false);
      setBudgetName('');
      setBudgetAmount('');
      setBudgetCatIds([]);
      await loadAllData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha ao criar orçamento';
      setError(msg);
    } finally {
      setBudgetSubmitting(false);
    }
  };

  // 7. Criar Reembolso
  const handleCreateRefund = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!refDebtor.trim()) {
      setError('Nome do devedor é obrigatório.');
      return;
    }
    if (!refTxId) {
      setError('Selecione a despesa original vinculada.');
      return;
    }
    let cents = 0;
    try {
      cents = parseBRLToCents(refAmount);
      validatePositiveCents(cents);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Valor inválido';
      setError(msg);
      return;
    }

    setRefSubmitting(true);
    setError(null);
    try {
      const activeKey =
        refIdempotencyKey ||
        `idem_ui_ref_${userId}_${refTxId}_${Date.now()}`;
      if (!refIdempotencyKey) setRefIdempotencyKey(activeKey);

      await createPersonalRefund(
        userId,
        {
          originalTransactionId: refTxId,
          debtorName: refDebtor.trim(),
          amountDueCents: cents,
          description: refDesc.trim() || undefined,
          idempotencyKey: activeKey,
        },
        isDemo
      );

      showToast('Reembolso registrado com sucesso!');
      setIsRefundModalOpen(false);
      setRefDebtor('');
      setRefAmount('');
      setRefDesc('');
      setRefTxId('');
      setRefIdempotencyKey('');
      await loadAllData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha ao registrar reembolso';
      setError(msg);
    } finally {
      setRefSubmitting(false);
    }
  };

  // 8. Receber Reembolso
  const handleExecuteReceiveRefund = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!receiveRefundModal) return;
    if (!receiveAccount) {
      setError('Selecione a conta para recebimento do crédito.');
      return;
    }
    let cents = 0;
    try {
      cents = parseBRLToCents(receiveAmount);
      validatePositiveCents(cents);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Valor inválido';
      setError(msg);
      return;
    }

    setReceiveSubmitting(true);
    setError(null);
    try {
      const activeKey =
        receiveIdempotencyKey ||
        `idem_ui_refrec_${receiveRefundModal.id}_${Date.now()}`;
      if (!receiveIdempotencyKey) setReceiveIdempotencyKey(activeKey);

      await recordRefundReceipt(
        userId,
        {
          refundId: receiveRefundModal.id,
          amountCents: cents,
          receiptDate: receiveDate,
          destinationAccountId: receiveAccount,
          authorUid: userId,
          idempotencyKey: activeKey,
        },
        isDemo
      );

      showToast(`Recebimento de reembolso creditado: ${formatCentsToBRL(cents)}!`);
      setReceiveRefundModal(null);
      setReceiveAmount('');
      setReceiveIdempotencyKey('');
      await loadAllData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha ao receber reembolso';
      setError(msg);
    } finally {
      setReceiveSubmitting(false);
    }
  };

  // 9. Criar Categoria
  const handleCreateCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCatName.trim()) {
      setError('Nome da categoria é obrigatório.');
      return;
    }

    setNewCatSubmitting(true);
    setError(null);
    try {
      await createCategory(
        userId,
        {
          name: newCatName.trim(),
          type: newCatType,
          color: newCatColor,
        },
        isDemo
      );

      showToast('Categoria criada com sucesso!');
      setIsCategoryModalOpen(false);
      setNewCatName('');
      await loadAllData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha ao criar categoria';
      setError(msg);
    } finally {
      setNewCatSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Toast de Sucesso */}
      {successToast && (
        <div className="fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3 bg-emerald-600 text-white rounded-xl shadow-xl transition-all">
          <CheckCircle2 className="w-5 h-5 shrink-0" />
          <span className="text-sm font-medium">{successToast}</span>
        </div>
      )}

      {/* Alerta de Erro */}
      {error && (
        <div className="flex items-center justify-between p-4 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 shrink-0 text-rose-600" />
            <span className="text-sm font-medium">{error}</span>
          </div>
          <button
            onClick={() => setError(null)}
            className="text-rose-600 hover:text-rose-800 text-sm font-bold ml-4"
          >
            ✕
          </button>
        </div>
      )}

      {/* Header Principal do Financeiro Individual */}
      <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 text-xs font-semibold tracking-wider uppercase bg-blue-50 text-blue-700 rounded-md border border-blue-200">
              Financeiro Individual v3.1
            </span>
            {isDemo && (
              <span className="px-2.5 py-0.5 text-xs font-semibold tracking-wider uppercase bg-amber-50 text-amber-700 rounded-md border border-amber-200">
                Modo Demonstração (Isolado)
              </span>
            )}
          </div>
          <h1 className="text-2xl font-black text-slate-900 mt-1">
            Gestão Financeira Pessoal
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Controle independente de receitas, despesas, faturas, transferências, orçamentos e reembolsos.
          </p>
        </div>

        {/* Seletor de Mês e Botão de Ação Rápida */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 rounded-xl text-xs font-semibold text-slate-700">
            <Calendar className="w-4 h-4 text-slate-500" />
            <input
              type="month"
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value as CompetenceMonthString)}
              className="bg-transparent border-0 focus:outline-none cursor-pointer text-slate-800 font-bold"
            />
          </div>

          <button
            onClick={() => {
              setTxType('expense');
              resetTxForm();
              setIsTxModalOpen(true);
            }}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold rounded-xl shadow-xs transition-all"
          >
            <ArrowUpRight className="w-4 h-4" />
            Nova Despesa
          </button>

          <button
            onClick={() => {
              setTxType('income');
              resetTxForm();
              setIsTxModalOpen(true);
            }}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-xl shadow-xs transition-all"
          >
            <ArrowDownLeft className="w-4 h-4" />
            Nova Receita
          </button>
        </div>
      </div>

      {/* Cards de Métricas Consolidadas do Mês */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Saldo Líquido Consolidado */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              Saldo Consolidado
            </span>
            <div className="p-2 bg-blue-50 text-blue-600 rounded-xl">
              <DollarSign className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-black text-slate-900">
            {formatCentsToBRL(totalBalanceCents)}
          </div>
          <div className="text-[11px] text-slate-400 mt-1">
            Contas correntes, poupanças e carteiras
          </div>
        </div>

        {/* Receitas Efetivadas */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              Receitas do Mês
            </span>
            <div className="p-2 bg-emerald-50 text-emerald-600 rounded-xl">
              <ArrowDownLeft className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-black text-emerald-600">
            {formatCentsToBRL(monthIncomeCents)}
          </div>
          <div className="text-[11px] text-slate-400 mt-1">
            Total recebido e creditado em caixa
          </div>
        </div>

        {/* Despesas Reconhecidas */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              Despesas Realizadas
            </span>
            <div className="p-2 bg-rose-50 text-rose-600 rounded-xl">
              <ArrowUpRight className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-black text-rose-600">
            {formatCentsToBRL(monthExpenseCents)}
          </div>
          <div className="text-[11px] text-slate-400 mt-1">
            Pagas via conta ou cartão na competência
          </div>
        </div>

        {/* Despesas Pendentes */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              Contas a Pagar
            </span>
            <div className="p-2 bg-amber-50 text-amber-600 rounded-xl">
              <Clock className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-black text-amber-600">
            {formatCentsToBRL(pendingExpenseCents)}
          </div>
          <div className="text-[11px] text-slate-400 mt-1">
            Obrigações pendentes ou parciais
          </div>
        </div>
      </div>

      {/* Navegação por Abas Funcionais */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-2">
        <div className="flex flex-wrap items-center gap-1.5 p-1 bg-slate-100 rounded-xl">
          <button
            onClick={() => setActiveTab('transactions')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
              activeTab === 'transactions'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            Receitas & Despesas ({transactions.length})
          </button>

          <button
            onClick={() => setActiveTab('invoices')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
              activeTab === 'invoices'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <CreditCard className="w-3.5 h-3.5" />
            Cartões & Faturas ({invoices.length})
          </button>

          <button
            onClick={() => setActiveTab('transfers')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
              activeTab === 'transfers'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <ArrowLeftRight className="w-3.5 h-3.5" />
            Transferências ({transfers.length})
          </button>

          <button
            onClick={() => setActiveTab('budgets')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
              activeTab === 'budgets'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Target className="w-3.5 h-3.5" />
            Orçamentos ({budgets.length})
          </button>

          <button
            onClick={() => setActiveTab('refunds')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
              activeTab === 'refunds'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reembolsos ({refunds.length})
          </button>

          <button
            onClick={() => setActiveTab('categories')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
              activeTab === 'categories'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Tag className="w-3.5 h-3.5" />
            Categorias ({categories.length})
          </button>
        </div>

        <button
          onClick={loadAllData}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded-lg border border-slate-200 bg-white"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Atualizar Dados
        </button>
      </div>

      {/* ABA 1: TRANSAÇÕES (RECEITAS & DESPESAS) */}
      {activeTab === 'transactions' && (
        <div className="space-y-4">
          {/* Barra de Filtros */}
          <div className="bg-white p-4 rounded-xl border border-slate-100 shadow-xs flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Filtros:
              </span>
              <select
                value={filterType}
                onChange={(e) => setFilterType(e.target.value as any)}
                className="px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="all">Todos os Tipos</option>
                <option value="income">Apenas Receitas</option>
                <option value="expense">Apenas Despesas</option>
              </select>

              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value as any)}
                className="px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="all">Todos os Status</option>
                <option value="paid">Pagas / Recebidas</option>
                <option value="pending">Pendentes</option>
                <option value="partially_paid">Parcialmente Pagas</option>
                <option value="forecast">Previstas</option>
                <option value="cancelled">Canceladas</option>
              </select>

              <select
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value)}
                className="px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="all">Todas as Categorias</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="text-xs text-slate-500 font-medium">
              Exibindo <strong>{filteredTransactions.length}</strong> lançamento(s)
            </div>
          </div>

          {/* Listagem de Transações */}
          {loading ? (
            <div className="text-center py-12 bg-white rounded-xl">
              <RefreshCw className="w-6 h-6 animate-spin text-blue-600 mx-auto" />
              <p className="text-xs text-slate-400 mt-2">Carregando transações...</p>
            </div>
          ) : filteredTransactions.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-2xl border border-dashed border-slate-200 p-8">
              <FileText className="w-10 h-10 text-slate-300 mx-auto mb-2" />
              <p className="text-sm font-semibold text-slate-700">
                Nenhum lançamento encontrado
              </p>
              <p className="text-xs text-slate-400 mt-0.5">
                Utilize os botões "Nova Receita" ou "Nova Despesa" acima para registrar transações.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredTransactions.map((tx) => {
                const isIncome = tx.type === 'income';
                const isPaid = tx.status === 'paid';
                const isPartiallyPaid = tx.status === 'partially_paid';
                const isCancelled = tx.status === 'cancelled';

                return (
                  <div
                    key={tx.id}
                    className={`p-4 rounded-xl border transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                      isCancelled
                        ? 'bg-slate-50 border-slate-200 opacity-60'
                        : 'bg-white border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${
                          isCancelled
                            ? 'bg-slate-200 text-slate-600'
                            : isIncome
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-rose-100 text-rose-800'
                        }`}
                      >
                        {isCancelled ? (
                          <Ban className="w-4 h-4" />
                        ) : isIncome ? (
                          <ArrowDownLeft className="w-4 h-4" />
                        ) : (
                          <ArrowUpRight className="w-4 h-4" />
                        )}
                      </div>

                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-bold text-slate-900 text-sm">
                            {tx.description}
                          </span>
                          <span className="px-2 py-0.5 text-[10px] font-semibold bg-slate-100 text-slate-700 rounded-md">
                            {tx.categoryName}
                          </span>
                          <span
                            className={`px-2 py-0.5 text-[10px] font-bold rounded-md ${
                              isPaid
                                ? 'bg-emerald-50 text-emerald-700'
                                : isPartiallyPaid
                                ? 'bg-amber-50 text-amber-700'
                                : isCancelled
                                ? 'bg-slate-200 text-slate-700'
                                : 'bg-blue-50 text-blue-700'
                            }`}
                          >
                            {tx.status.toUpperCase()}
                          </span>
                          {tx.invoiceMonth && (
                            <span className="px-2 py-0.5 text-[10px] font-medium bg-purple-50 text-purple-700 rounded-md">
                              Fatura: {tx.invoiceMonth}
                            </span>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400 mt-1">
                          <span>Data: {tx.competenceDate}</span>
                          {tx.dueDate && tx.dueDate !== tx.competenceDate && (
                            <span>• Vence: {tx.dueDate}</span>
                          )}
                          {isPartiallyPaid && (
                            <span className="text-amber-700 font-semibold">
                              • Amortizado: {formatCentsToBRL(tx.paidAmountCents || 0)} (Resta:{' '}
                              {formatCentsToBRL(tx.remainingAmountCents || 0)})
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-100">
                      <div className="text-right">
                        <span
                          className={`text-base font-black ${
                            isIncome ? 'text-emerald-600' : 'text-rose-600'
                          }`}
                        >
                          {isIncome ? '+ ' : '- '}
                          {formatCentsToBRL(tx.amountCents)}
                        </span>
                      </div>

                      {/* Botões de Ação */}
                      <div className="flex items-center gap-1.5">
                        {!isPaid && !isCancelled && (
                          <button
                            onClick={() => {
                              setPartialTx(tx);
                              setPartialAmount('');
                              setPartialNotes('');
                              setPartialAccount(tx.accountId || '');
                            }}
                            className="px-2.5 py-1 text-xs font-semibold bg-blue-50 text-blue-700 hover:bg-blue-100 rounded-lg transition-all"
                            title="Registrar pagamento ou recebimento parcial"
                          >
                            Amortizar
                          </button>
                        )}

                        {!isCancelled && (
                          <button
                            onClick={() => handleCancelTx(tx)}
                            className="px-2.5 py-1 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 rounded-lg transition-all"
                            title="Cancelar lançamento"
                          >
                            Cancelar
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ABA 2: CARTÕES & FATURAS */}
      {activeTab === 'invoices' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-slate-900">
                Faturas de Cartões de Crédito
              </h2>
              <p className="text-xs text-slate-500">
                Compras alocadas e pagamentos de fatura sem dupla contagem contábil.
              </p>
            </div>
          </div>

          {invoices.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-2xl border border-dashed border-slate-200 p-8">
              <CreditCard className="w-10 h-10 text-slate-300 mx-auto mb-2" />
              <p className="text-sm font-semibold text-slate-700">
                Nenhuma fatura encontrada
              </p>
              <p className="text-xs text-slate-400 mt-0.5">
                Cadastre um cartão de crédito na aba de Contas e registre compras no cartão para gerar faturas.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {invoices.map((inv) => {
                const card = accounts.find((a) => a.id === inv.accountId);
                const isPaid = inv.invoiceStatus === 'paid';
                const isCarriedOver = inv.invoiceStatus === 'carried_over';
                const isSettled = isPaid || isCarriedOver;

                return (
                  <div
                    key={`${inv.accountId}-${inv.invoiceMonth}`}
                    className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2.5">
                          <div className="p-2 bg-purple-50 text-purple-700 rounded-xl">
                            <CreditCard className="w-5 h-5" />
                          </div>
                          <div>
                            <h3 className="font-bold text-slate-900 text-sm">
                              {card?.name || 'Cartão de Crédito'}
                            </h3>
                            <span className="text-xs text-slate-400">
                              Fatura {inv.invoiceMonth}
                            </span>
                          </div>
                        </div>

                        <span
                          className={`px-2 py-0.5 text-[10px] font-bold rounded-md ${
                            isPaid
                              ? 'bg-emerald-50 text-emerald-700'
                              : isCarriedOver
                              ? 'bg-amber-100 text-amber-800 border border-amber-300'
                              : inv.invoiceStatus === 'partially_paid'
                              ? 'bg-amber-50 text-amber-700'
                              : 'bg-purple-50 text-purple-700'
                          }`}
                        >
                          {isCarriedOver ? 'SALDO TRANSPORTADO' : inv.invoiceStatus.toUpperCase()}
                        </span>
                      </div>

                      {/* Valores da Fatura */}
                      <div className="mt-4 pt-3 border-t border-slate-100 space-y-1.5 text-xs">
                        <div className="flex justify-between text-slate-500">
                          <span>Compras do período:</span>
                          <span className="font-semibold text-slate-800">
                            {formatCentsToBRL(inv.totalPurchasesAmountCents)}
                          </span>
                        </div>
                        {inv.carriedOverBalanceCents > 0 && (
                          <div className="flex justify-between text-amber-700 font-medium">
                            <span>Saldo rotativo transportado:</span>
                            <span>{formatCentsToBRL(inv.carriedOverBalanceCents)}</span>
                          </div>
                        )}
                        {inv.interestAndFeesCents > 0 && (
                          <div className="flex justify-between text-rose-700 font-medium">
                            <span>Juros e encargos:</span>
                            <span>{formatCentsToBRL(inv.interestAndFeesCents)}</span>
                          </div>
                        )}
                        <div className="flex justify-between text-slate-500">
                          <span>Total pago:</span>
                          <span className="font-semibold text-emerald-600">
                            {formatCentsToBRL(inv.totalPaidAmountCents)}
                          </span>
                        </div>
                        <div className="flex justify-between text-sm font-bold pt-2 border-t border-slate-100">
                          <span>Saldo Restante:</span>
                          <span className={inv.remainingBalanceCents > 0 ? 'text-rose-600' : 'text-slate-900'}>
                            {formatCentsToBRL(inv.remainingBalanceCents)}
                          </span>
                        </div>
                      </div>

                      <div className="text-[11px] text-slate-400 mt-3">
                        Vencimento: <strong>{inv.dueDate}</strong> • Fechamento: {inv.closingDate}
                      </div>
                    </div>

                    {/* Botão Pagar Fatura */}
                    <div className="mt-4 pt-3 border-t border-slate-100 flex items-center gap-2">
                      {!isSettled && (
                        <button
                          onClick={() => {
                            setPayInvoiceModal(inv);
                            setPayInvAmount('');
                            setPayInvSourceAcc('');
                          }}
                          className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl transition-all shadow-xs"
                        >
                          Pagar Fatura
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ABA 3: TRANSFERÊNCIAS */}
      {activeTab === 'transfers' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-slate-900">
                Transferências entre Contas Próprias
              </h2>
              <p className="text-xs text-slate-500">
                Movimentação interna entre contas do usuário sem afetar receita ou despesa.
              </p>
            </div>

            <button
              onClick={() => setIsTransferModalOpen(true)}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl shadow-xs transition-all"
            >
              <ArrowLeftRight className="w-4 h-4" />
              Nova Transferência
            </button>
          </div>

          {transfers.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-2xl border border-dashed border-slate-200 p-8">
              <ArrowLeftRight className="w-10 h-10 text-slate-300 mx-auto mb-2" />
              <p className="text-sm font-semibold text-slate-700">
                Nenhuma transferência realizada
              </p>
              <p className="text-xs text-slate-400 mt-0.5">
                Transfira recursos entre suas contas correntes e carteiras de forma atômica e rastreável.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {transfers.map((xfer) => {
                const srcAcc = accounts.find((a) => a.id === xfer.sourceAccountId);
                const dstAcc = accounts.find((a) => a.id === xfer.destinationAccountId);

                return (
                  <div
                    key={xfer.id}
                    className="p-4 bg-white rounded-xl border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-xs"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
                        <ArrowLeftRight className="w-4 h-4" />
                      </div>
                      <div>
                        <div className="text-sm font-bold text-slate-900">
                          {xfer.description}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-2">
                          <span>
                            De: <strong>{srcAcc?.name || xfer.sourceAccountId}</strong>
                          </span>
                          <span>→</span>
                          <span>
                            Para: <strong>{dstAcc?.name || xfer.destinationAccountId}</strong>
                          </span>
                          <span>• {xfer.transferDate}</span>
                        </div>
                      </div>
                    </div>

                    <div className="text-right">
                      <div className="text-base font-black text-slate-900">
                        {formatCentsToBRL(xfer.amountCents)}
                      </div>
                      <span className="text-[10px] text-slate-400 uppercase font-semibold">
                        Invariante no Saldo Geral
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ABA 4: ORÇAMENTOS */}
      {activeTab === 'budgets' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-slate-900">
                Orçamentos Planejados ({selectedMonth})
              </h2>
              <p className="text-xs text-slate-500">
                Acompanhamento de consumo derivado das despesas efetivas da competência.
              </p>
            </div>

            <button
              onClick={() => setIsBudgetModalOpen(true)}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl shadow-xs transition-all"
            >
              <Plus className="w-4 h-4" />
              Novo Orçamento
            </button>
          </div>

          {budgets.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-2xl border border-dashed border-slate-200 p-8">
              <Target className="w-10 h-10 text-slate-300 mx-auto mb-2" />
              <p className="text-sm font-semibold text-slate-700">
                Nenhum orçamento definido para este mês
              </p>
              <p className="text-xs text-slate-400 mt-0.5">
                Defina limites de gastos por categoria para controlar suas finanças planejadas.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {budgets.map((b) => {
                const isExceeded = b.status === 'exceeded';
                const isWarning = b.status === 'warning';

                return (
                  <div
                    key={b.id}
                    className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2.5">
                          <div className="p-2 bg-blue-50 text-blue-600 rounded-xl">
                            <Target className="w-5 h-5" />
                          </div>
                          <div>
                            <h3 className="font-bold text-slate-900 text-sm">
                              {b.name}
                            </h3>
                            <span className="text-[11px] text-slate-400">
                              {b.categoryIds.length} categoria(s) vinculada(s)
                            </span>
                          </div>
                        </div>

                        <span
                          className={`px-2 py-0.5 text-[10px] font-bold rounded-md ${
                            isExceeded
                              ? 'bg-rose-100 text-rose-700'
                              : isWarning
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-emerald-100 text-emerald-700'
                          }`}
                        >
                          {b.percentageUsed}%
                        </span>
                      </div>

                      {/* Barra de Progresso */}
                      <div className="mt-4">
                        <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${
                              isExceeded
                                ? 'bg-rose-500'
                                : isWarning
                                ? 'bg-amber-500'
                                : 'bg-emerald-500'
                            }`}
                            style={{ width: `${Math.min(100, b.percentageUsed)}%` }}
                          />
                        </div>
                      </div>

                      {/* Valores: 3 indicadores distintos (Realizado, Comprometido, Previsto) */}
                      <div className="mt-4 pt-3 border-t border-slate-100 space-y-1 text-xs">
                        <div className="flex justify-between text-slate-500">
                          <span>Planejado:</span>
                          <span className="font-semibold text-slate-900">
                            {formatCentsToBRL(b.plannedAmountCents)}
                          </span>
                        </div>
                        <div className="flex justify-between text-slate-500">
                          <span>Realizado (Pago):</span>
                          <span className="font-semibold text-rose-600">
                            {formatCentsToBRL(b.realizedAmountCents ?? b.spentAmountCents)}
                          </span>
                        </div>
                        <div className="flex justify-between text-slate-500">
                          <span>Comprometido (Pendente):</span>
                          <span className="font-semibold text-amber-600">
                            {formatCentsToBRL(b.committedAmountCents ?? 0)}
                          </span>
                        </div>
                        <div className="flex justify-between text-slate-500">
                          <span>Previsto (Projeção Total):</span>
                          <span className="font-semibold text-blue-600">
                            {formatCentsToBRL(b.forecastedAmountCents ?? b.spentAmountCents)} ({b.percentageForecasted ?? b.percentageUsed}%)
                          </span>
                        </div>
                        <div className="flex justify-between text-xs font-bold pt-1.5 border-t border-slate-100">
                          <span>Saldo Disponível (Real):</span>
                          <span className={b.remainingAmountCents < 0 ? 'text-rose-600' : 'text-emerald-600'}>
                            {formatCentsToBRL(b.remainingAmountCents)}
                          </span>
                        </div>
                        <div className="flex justify-between text-[11px] font-medium text-slate-500">
                          <span>Saldo Projetado Final:</span>
                          <span className={(b.projectedRemainingAmountCents ?? b.remainingAmountCents) < 0 ? 'text-rose-600' : 'text-slate-700'}>
                            {formatCentsToBRL(b.projectedRemainingAmountCents ?? b.remainingAmountCents)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ABA 5: REEMBOLSOS */}
      {activeTab === 'refunds' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-slate-900">
                Reembolsos Vinculados a Despesas
              </h2>
              <p className="text-xs text-slate-500">
                Controle de valores antecipados com crédito em caixa no recebimento.
              </p>
            </div>

            <button
              onClick={() => setIsRefundModalOpen(true)}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl shadow-xs transition-all"
            >
              <Plus className="w-4 h-4" />
              Novo Reembolso
            </button>
          </div>

          {refunds.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-2xl border border-dashed border-slate-200 p-8">
              <RotateCcw className="w-10 h-10 text-slate-300 mx-auto mb-2" />
              <p className="text-sm font-semibold text-slate-700">
                Nenhum reembolso cadastrado
              </p>
              <p className="text-xs text-slate-400 mt-0.5">
                Vincule expectativas de devolução a despesas pagas por você para recompor seu caixa quando receber.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {refunds.map((ref) => {
                const isReceived = ref.status === 'received';

                return (
                  <div
                    key={ref.id}
                    className="p-4 bg-white rounded-xl border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-xs"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl bg-purple-50 text-purple-700 flex items-center justify-center shrink-0">
                        <RotateCcw className="w-4 h-4" />
                      </div>
                      <div>
                        <div className="text-sm font-bold text-slate-900">
                          {ref.description} (Devedor: <strong>{ref.debtorName}</strong>)
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          Status: <strong>{ref.status.toUpperCase()}</strong> • Recebido:{' '}
                          {formatCentsToBRL(ref.amountReceivedCents)} de {formatCentsToBRL(ref.amountDueCents)}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0">
                      <div className="text-right">
                        <div className="text-sm font-black text-slate-900">
                          Resta: {formatCentsToBRL(ref.remainingAmountCents)}
                        </div>
                      </div>

                      {!isReceived && (
                        <button
                          onClick={() => {
                            setReceiveRefundModal(ref);
                            setReceiveAmount('');
                            setReceiveAccount('');
                          }}
                          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-lg shadow-xs transition-all"
                        >
                          Receber
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ABA 6: CATEGORIAS */}
      {activeTab === 'categories' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-slate-900">
                Categorias Individuais
              </h2>
              <p className="text-xs text-slate-500">
                Classificação própria para receitas e despesas com suporte a arquivamento seguro.
              </p>
            </div>

            <button
              onClick={() => setIsCategoryModalOpen(true)}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl shadow-xs transition-all"
            >
              <Plus className="w-4 h-4" />
              Nova Categoria
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {categories.map((cat) => (
              <div
                key={cat.id}
                className={`p-3.5 rounded-xl border bg-white flex items-center justify-between gap-2 shadow-xs ${
                  cat.isArchived ? 'opacity-50 bg-slate-50' : 'border-slate-200'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <div
                    className="w-4 h-4 rounded-full shrink-0"
                    style={{ backgroundColor: cat.color || '#2563EB' }}
                  />
                  <div>
                    <div className="text-xs font-bold text-slate-900 leading-tight">
                      {cat.name}
                    </div>
                    <span className="text-[10px] text-slate-400 capitalize">
                      {cat.type === 'income' ? 'Receita' : 'Despesa'}
                    </span>
                  </div>
                </div>

                <button
                  onClick={async () => {
                    const nextState = !cat.isArchived;
                    await archiveCategory(cat.id, userId, nextState, isDemo);
                    showToast(`Categoria ${nextState ? 'arquivada' : 'ativada'}.`);
                    await loadAllData();
                  }}
                  className="text-[11px] text-slate-400 hover:text-slate-700 px-2 py-1 rounded bg-slate-50 hover:bg-slate-100"
                >
                  {cat.isArchived ? 'Desarquivar' : 'Arquivar'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* MODAL: NOVA TRANSAÇÃO */}
      {isTxModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-slate-100">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="text-base font-bold text-slate-900">
                {txType === 'income' ? 'Nova Receita' : 'Nova Despesa'}
              </h3>
              <button
                onClick={() => setIsTxModalOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-600 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateTransaction} className="space-y-3.5 mt-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                  Descrição *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Salário, Aluguel, Supermercado..."
                  value={txDesc}
                  onChange={(e) => setTxDesc(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                    Valor (R$) *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="0,00"
                    value={txAmount}
                    onChange={(e) => setTxAmount(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 font-bold"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                    Data *
                  </label>
                  <input
                    type="date"
                    required
                    value={txDate}
                    onChange={(e) => setTxDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                  Categoria *
                </label>
                <select
                  required
                  value={txCategory}
                  onChange={(e) => setTxCategory(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Selecione...</option>
                  {categories
                    .filter((c) => !c.isArchived && (c.type === txType || c.type === 'both'))
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                  Status *
                </label>
                <select
                  value={txStatus}
                  onChange={(e) => setTxStatus(e.target.value as PersonalTransactionStatus)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="paid">{txType === 'income' ? 'Recebido (Crédito em Conta)' : 'Pago (Débito em Conta/Cartão)'}</option>
                  <option value="pending">Pendente (A pagar/receber)</option>
                  <option value="forecast">Previsto (Planejamento futuro)</option>
                </select>
              </div>

              {txStatus === 'paid' && (
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                    Conta / Cartão *
                  </label>
                  <select
                    required
                    value={txAccount}
                    onChange={(e) => setTxAccount(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">Selecione...</option>
                    {accounts
                      .filter((a) => !a.isArchived)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name} ({a.type === 'credit' ? 'Cartão de Crédito' : 'Conta/Carteira'})
                        </option>
                      ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                  Observações (Opcional)
                </label>
                <input
                  type="text"
                  placeholder="Anotações internas..."
                  value={txNotes}
                  onChange={(e) => setTxNotes(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsTxModalOpen(false)}
                  className="px-3 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={txSubmitting}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl shadow-xs disabled:opacity-50"
                >
                  {txSubmitting ? 'Salvando...' : 'Gravar Lançamento'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: AMORTIZAÇÃO / PAGAMENTO PARCIAL */}
      {partialTx && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-blue-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="text-base font-bold text-slate-900">
                Amortização Parcial
              </h3>
              <button
                onClick={() => setPartialTx(null)}
                className="p-1 text-slate-400 hover:text-slate-600 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="my-3 p-3 bg-blue-50 rounded-xl text-xs space-y-1 text-blue-900">
              <div>Lançamento: <strong>{partialTx.description}</strong></div>
              <div>Valor Original: <strong>{formatCentsToBRL(partialTx.amountCents)}</strong></div>
              <div>
                Saldo Devedor Restante:{' '}
                <strong className="text-rose-600">
                  {formatCentsToBRL(partialTx.remainingAmountCents ?? partialTx.amountCents)}
                </strong>
              </div>
            </div>

            <form onSubmit={handleExecutePartialPayment} className="space-y-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                  Valor da Amortização (R$) *
                </label>
                <input
                  type="text"
                  required
                  placeholder="0,00"
                  value={partialAmount}
                  onChange={(e) => setPartialAmount(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 font-bold"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                  Conta para Movimentação *
                </label>
                <select
                  required
                  value={partialAccount}
                  onChange={(e) => setPartialAccount(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Selecione...</option>
                  {accounts
                    .filter((a) => !a.isArchived)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.type})
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                  Data Efetiva *
                </label>
                <input
                  type="date"
                  required
                  value={partialDate}
                  onChange={(e) => setPartialDate(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPartialTx(null)}
                  className="px-3 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={partialSubmitting}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl shadow-xs disabled:opacity-50"
                >
                  {partialSubmitting ? 'Gravando...' : 'Confirmar Amortização'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: TRANSFERÊNCIA ENTRE CONTAS PRÓPRIAS */}
      {isTransferModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-slate-100">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="text-base font-bold text-slate-900">
                Transferência entre Contas Próprias
              </h3>
              <button
                onClick={() => setIsTransferModalOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-600 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleExecuteTransfer} className="space-y-3.5 mt-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                  Conta de Origem (Saída) *
                </label>
                <select
                  required
                  value={xferSource}
                  onChange={(e) => setXferSource(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Selecione...</option>
                  {accounts
                    .filter((a) => !a.isArchived && a.type !== 'credit')
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({formatCentsToBRL(a.projectedBalanceCents)})
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                  Conta de Destino (Entrada) *
                </label>
                <select
                  required
                  value={xferDest}
                  onChange={(e) => setXferDest(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Selecione...</option>
                  {accounts
                    .filter((a) => !a.isArchived && a.type !== 'credit' && a.id !== xferSource)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({formatCentsToBRL(a.projectedBalanceCents)})
                      </option>
                    ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                    Valor (R$) *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="0,00"
                    value={xferAmount}
                    onChange={(e) => setXferAmount(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 font-bold"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                    Data da Transferência *
                  </label>
                  <input
                    type="date"
                    required
                    value={xferDate}
                    onChange={(e) => setXferDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                  Descrição (Opcional)
                </label>
                <input
                  type="text"
                  placeholder="Ex: Saque para carteira, Reserva de emergência..."
                  value={xferDesc}
                  onChange={(e) => setXferDesc(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsTransferModalOpen(false)}
                  className="px-3 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={xferSubmitting}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl shadow-xs disabled:opacity-50"
                >
                  {xferSubmitting ? 'Transferindo...' : 'Executar Transferência'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: PAGAR FATURA DE CARTÃO */}
      {payInvoiceModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-purple-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="text-base font-bold text-slate-900">
                Pagar Fatura {payInvoiceModal.invoiceMonth}
              </h3>
              <button
                onClick={() => setPayInvoiceModal(null)}
                className="p-1 text-slate-400 hover:text-slate-600 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="my-3 p-3 bg-purple-50 rounded-xl text-xs space-y-1 text-purple-900">
              <div>Total Devido: <strong>{formatCentsToBRL(payInvoiceModal.totalDueAmountCents)}</strong></div>
              <div>Já Pago: <strong>{formatCentsToBRL(payInvoiceModal.totalPaidAmountCents)}</strong></div>
              <div>
                Saldo Devedor Restante:{' '}
                <strong className="text-rose-600">
                  {formatCentsToBRL(payInvoiceModal.remainingBalanceCents)}
                </strong>
              </div>
            </div>

            <form onSubmit={handleExecutePayInvoice} className="space-y-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                  Conta para Débito (Corrente / Carteira) *
                </label>
                <select
                  required
                  value={payInvSourceAcc}
                  onChange={(e) => setPayInvSourceAcc(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Selecione...</option>
                  {accounts
                    .filter((a) => !a.isArchived && a.type !== 'credit')
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({formatCentsToBRL(a.projectedBalanceCents)})
                      </option>
                    ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                    Valor a Pagar (R$) *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="0,00"
                    value={payInvAmount}
                    onChange={(e) => setPayInvAmount(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 font-bold"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                    Data do Pagamento *
                  </label>
                  <input
                    type="date"
                    required
                    value={payInvDate}
                    onChange={(e) => setPayInvDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPayInvoiceModal(null)}
                  className="px-3 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={payInvSubmitting}
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white text-xs font-semibold rounded-xl shadow-xs disabled:opacity-50"
                >
                  {payInvSubmitting ? 'Processando...' : 'Confirmar Pagamento'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: NOVO ORÇAMENTO */}
      {isBudgetModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-slate-100">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="text-base font-bold text-slate-900">
                Novo Orçamento Mensal ({selectedMonth})
              </h3>
              <button
                onClick={() => setIsBudgetModalOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-600 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateBudget} className="space-y-3.5 mt-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                  Nome do Orçamento *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Limite Alimentação, Gastos com Lazer..."
                  value={budgetName}
                  onChange={(e) => setBudgetName(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                  Valor Planejado (R$) *
                </label>
                <input
                  type="text"
                  required
                  placeholder="0,00"
                  value={budgetAmount}
                  onChange={(e) => setBudgetAmount(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 font-bold"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                  Categorias Incluídas *
                </label>
                <div className="max-h-36 overflow-y-auto space-y-1.5 p-2 bg-slate-50 rounded-xl border border-slate-200">
                  {categories
                    .filter((c) => !c.isArchived && (c.type === 'expense' || c.type === 'both'))
                    .map((c) => {
                      const isChecked = budgetCatIds.includes(c.id);
                      return (
                        <label
                          key={c.id}
                          className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={(e) => {
                              if (e.target.checked) setBudgetCatIds([...budgetCatIds, c.id]);
                              else setBudgetCatIds(budgetCatIds.filter((id) => id !== c.id));
                            }}
                            className="rounded text-blue-600 focus:ring-blue-500"
                          />
                          <span>{c.name}</span>
                        </label>
                      );
                    })}
                </div>
              </div>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsBudgetModalOpen(false)}
                  className="px-3 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={budgetSubmitting}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl shadow-xs disabled:opacity-50"
                >
                  {budgetSubmitting ? 'Salvando...' : 'Salvar Orçamento'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: NOVO REEMBOLSO */}
      {isRefundModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-slate-100">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="text-base font-bold text-slate-900">
                Novo Reembolso a Receber
              </h3>
              <button
                onClick={() => setIsRefundModalOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-600 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateRefund} className="space-y-3 mt-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                  Despesa Original Vinculada *
                </label>
                <select
                  required
                  value={refTxId}
                  onChange={(e) => setRefTxId(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Selecione a despesa...</option>
                  {transactions
                    .filter((t) => t.type === 'expense' && t.status !== 'cancelled')
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.description} ({formatCentsToBRL(t.amountCents)}) - {t.competenceDate}
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                  Nome do Devedor / Amigo *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Carlos, Ana..."
                  value={refDebtor}
                  onChange={(e) => setRefDebtor(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                  Valor a Reembolsar (R$) *
                </label>
                <input
                  type="text"
                  required
                  placeholder="0,00"
                  value={refAmount}
                  onChange={(e) => setRefAmount(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 font-bold"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                  Descrição (Opcional)
                </label>
                <input
                  type="text"
                  placeholder="Ex: Parte do almoço..."
                  value={refDesc}
                  onChange={(e) => setRefDesc(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsRefundModalOpen(false)}
                  className="px-3 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={refSubmitting}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl shadow-xs disabled:opacity-50"
                >
                  {refSubmitting ? 'Salvando...' : 'Salvar Reembolso'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: RECEBER REEMBOLSO */}
      {receiveRefundModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-emerald-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="text-base font-bold text-slate-900">
                Receber Reembolso ({receiveRefundModal.debtorName})
              </h3>
              <button
                onClick={() => setReceiveRefundModal(null)}
                className="p-1 text-slate-400 hover:text-slate-600 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="my-3 p-3 bg-emerald-50 rounded-xl text-xs space-y-1 text-emerald-900">
              <div>Total Devido: <strong>{formatCentsToBRL(receiveRefundModal.amountDueCents)}</strong></div>
              <div>Já Recebido: <strong>{formatCentsToBRL(receiveRefundModal.amountReceivedCents)}</strong></div>
              <div>Resta: <strong className="text-emerald-700">{formatCentsToBRL(receiveRefundModal.remainingAmountCents)}</strong></div>
            </div>

            <form onSubmit={handleExecuteReceiveRefund} className="space-y-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                  Conta para Crédito (Entrada) *
                </label>
                <select
                  required
                  value={receiveAccount}
                  onChange={(e) => setReceiveAccount(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Selecione...</option>
                  {accounts
                    .filter((a) => !a.isArchived && a.type !== 'credit')
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({formatCentsToBRL(a.projectedBalanceCents)})
                      </option>
                    ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                    Valor Recebido (R$) *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="0,00"
                    value={receiveAmount}
                    onChange={(e) => setReceiveAmount(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 font-bold"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                    Data do Recebimento *
                  </label>
                  <input
                    type="date"
                    required
                    value={receiveDate}
                    onChange={(e) => setReceiveDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setReceiveRefundModal(null)}
                  className="px-3 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={receiveSubmitting}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-xl shadow-xs disabled:opacity-50"
                >
                  {receiveSubmitting ? 'Gravando...' : 'Confirmar Recebimento'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: NOVA CATEGORIA */}
      {isCategoryModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-slate-100">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="text-base font-bold text-slate-900">
                Nova Categoria Individual
              </h3>
              <button
                onClick={() => setIsCategoryModalOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-600 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateCategory} className="space-y-3 mt-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                  Nome da Categoria *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Farmácia, Viagens, Freelance..."
                  value={newCatName}
                  onChange={(e) => setNewCatName(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                  Tipo *
                </label>
                <select
                  value={newCatType}
                  onChange={(e) => setNewCatType(e.target.value as any)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="expense">Despesa</option>
                  <option value="income">Receita</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 uppercase mb-1">
                  Cor
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={newCatColor}
                    onChange={(e) => setNewCatColor(e.target.value)}
                    className="w-9 h-9 rounded-xl cursor-pointer border border-slate-200 p-0.5 bg-white"
                  />
                  <span className="text-xs font-mono text-slate-500">{newCatColor}</span>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsCategoryModalOpen(false)}
                  className="px-3 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={newCatSubmitting}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl shadow-xs disabled:opacity-50"
                >
                  {newCatSubmitting ? 'Salvando...' : 'Salvar Categoria'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
