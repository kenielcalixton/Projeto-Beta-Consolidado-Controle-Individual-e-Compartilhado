import React, { useEffect, useState } from 'react';
import {
  Account,
  CascadeMode,
  Category,
  RecurrenceType,
  Space,
  SplitShare,
  Transaction,
  TransactionStatus,
  TransactionType,
} from '../types/finance';
import {
  calculateCreditCardInvoice,
  computeAutomatedStatus,
  formatCurrency,
  generateRecurrenceSeries,
  getTodayDateString,
} from '../utils/financeEngine';
import { sendTransactionalEmail } from '../services/emailService';

interface UniversalTransactionModalProps {
  isOpen: boolean;
  onClose: () => void;
  accounts: Account[];
  categories: Category[];
  spaces: Space[];
  userId: string;
  userEmail: string;
  userName: string;
  selectedMonth: string; // YYYY-MM
  editingTransaction: Transaction | null;
  presetAccountId?: string;
  presetSpaceId?: string;
  presetType?: TransactionType;
  presetDescription?: string;
  presetAmount?: number;
  onSaveSeries: (
    series: Omit<Transaction, 'id'>[],
    editingTx: Transaction | null,
    cascadeMode: CascadeMode
  ) => Promise<void>;
  onCreateCategory: (cat: Omit<Category, 'id' | 'userId'>) => Promise<Category>;
  onNotifyToast: (msg: string) => void;
}

const AVAILABLE_ICONS = [
  'ph-tag',
  'ph-shopping-cart',
  'ph-house-line',
  'ph-fork-knife',
  'ph-airplane-tilt',
  'ph-laptop',
  'ph-car',
  'ph-heartbeat',
  'ph-graduation-cap',
  'ph-briefcase',
];

const AVAILABLE_COLORS = [
  { id: 'indigo', label: 'Índigo' },
  { id: 'emerald', label: 'Esmeralda' },
  { id: 'rose', label: 'Rosa' },
  { id: 'amber', label: 'Âmbar' },
  { id: 'purple', label: 'Roxo' },
  { id: 'sky', label: 'Azul' },
];

const AUTOMATED_STATUS_META: Record<
  TransactionStatus,
  { label: string; badgeClass: string; icon: string; helper: string }
> = {
  pending: {
    label: 'Pendente (Padrão)',
    badgeClass: 'bg-amber-500/15 border-amber-500/40 text-amber-300',
    icon: 'ph-clock',
    helper: 'Status padrão automático até a data de vencimento ou efetivação.',
  },
  overdue: {
    label: 'Vencido (Automático)',
    badgeClass: 'bg-rose-500/15 border-rose-500/40 text-rose-300',
    icon: 'ph-warning-circle',
    helper: 'Calculado automaticamente pois a data de vencimento já passou.',
  },
  validating: {
    label: 'Em Validação (Rateio)',
    badgeClass: 'bg-purple-500/15 border-purple-500/40 text-purple-300',
    icon: 'ph-hourglass-high',
    helper: 'Automático: aguardando validação dos participantes no compartilhamento.',
  },
  rejected: {
    label: 'Recusado (Rateio)',
    badgeClass: 'bg-slate-700/60 border-slate-600 text-slate-300',
    icon: 'ph-x-circle',
    helper: 'Automático: rateio recusado no fluxo de compartilhamento.',
  },
  paid: {
    label: 'Pago / Efetivado',
    badgeClass: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300',
    icon: 'ph-check-circle',
    helper: 'Lançamento liquidado com data de pagamento registrada.',
  },
};

export const UniversalTransactionModal: React.FC<UniversalTransactionModalProps> = ({
  isOpen,
  onClose,
  accounts,
  categories,
  spaces,
  userId,
  userEmail,
  userName,
  selectedMonth,
  editingTransaction,
  presetAccountId,
  presetSpaceId,
  presetType,
  presetDescription,
  presetAmount,
  onSaveSeries,
  onCreateCategory,
  onNotifyToast,
}) => {
  const [type, setType] = useState<TransactionType>('expense');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [isPaid, setIsPaid] = useState(false);
  const [paymentDate, setPaymentDate] = useState('');
  const [accountId, setAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [competenceDate, setCompetenceDate] = useState(`${selectedMonth}-07`);
  const [dueDate, setDueDate] = useState(`${selectedMonth}-15`);
  const [recurrenceType, setRecurrenceType] = useState<RecurrenceType>('single');
  const [installmentTotal, setInstallmentTotal] = useState('2');
  const [cascadeMode, setCascadeMode] = useState<CascadeMode>('only_this');

  // Divisão em Espaço ou Rateio Avulso
  const [splitMode, setSplitMode] = useState<'none' | 'space' | 'adhoc'>('none');
  const [spaceId, setSpaceId] = useState('');
  const [paidByEmail, setPaidByEmail] = useState(userEmail);
  const [recipientEmail, setRecipientEmail] = useState(userEmail);
  const [spaceExpensePaymentMode, setSpaceExpensePaymentMode] = useState<
    'unpaid' | 'space_cash' | 'member_direct'
  >('unpaid');
  const [spaceAllocationMode, setSpaceAllocationMode] = useState<
    'equal' | 'percentage'
  >('equal');
  const [participantPercentages, setParticipantPercentages] = useState<
    Record<string, number>
  >({});
  const [adhocEmail, setAdhocEmail] = useState('');
  const [adhocName, setAdhocName] = useState('');
  const [customSplits, setCustomSplits] = useState<SplitShare[]>([]);

  // Criação rápida de categoria customizada
  const [showNewCatForm, setShowNewCatForm] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [newCatIcon, setNewCatIcon] = useState('ph-tag');
  const [newCatColor, setNewCatColor] = useState('indigo');

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setErrorMsg(null);

    if (editingTransaction) {
      setType(editingTransaction.type);
      setDescription(editingTransaction.description.replace(/\s*\(\d+\/\d+\)$/, ''));
      setAmount(String(editingTransaction.amount));
      const editingIsPaid = editingTransaction.status === 'paid';
      setIsPaid(editingIsPaid);
      setPaymentDate(
        editingIsPaid
          ? editingTransaction.paymentDate || editingTransaction.dueDate || getTodayDateString()
          : ''
      );
      setAccountId(editingTransaction.accountId);
      setCategoryId(editingTransaction.categoryId);
      setCompetenceDate(editingTransaction.competenceDate);
      setDueDate(editingTransaction.dueDate);
      setRecurrenceType(editingTransaction.recurrenceType);
      setInstallmentTotal(String(editingTransaction.installmentTotal || 2));
      setPaidByEmail(editingTransaction.paidByEmail || userEmail);
      setRecipientEmail(editingTransaction.recipientEmail || editingTransaction.ownerEmail || userEmail);

      if (editingTransaction.spaceId) {
        setSplitMode('space');
        setSpaceId(editingTransaction.spaceId);
        setCustomSplits(editingTransaction.splits || []);
        if (!editingIsPaid) {
          setSpaceExpensePaymentMode('unpaid');
        } else if (editingTransaction.paidByEmail === 'space_cash') {
          setSpaceExpensePaymentMode('space_cash');
        } else {
          setSpaceExpensePaymentMode('member_direct');
        }
        setSpaceAllocationMode('equal');
      } else if (editingTransaction.splits && editingTransaction.splits.length > 0) {
        setSplitMode('adhoc');
        setCustomSplits(editingTransaction.splits);
      } else {
        setSplitMode('none');
        setSpaceId('');
        setCustomSplits([]);
      }
    } else {
      const initialType: TransactionType = presetType || 'expense';
      setType(initialType);
      setDescription(
        presetDescription
          ? presetDescription
          : initialType === 'income' && presetSpaceId
          ? `Aporte Mensal - ${userName}`
          : ''
      );
      setAmount(
        typeof presetAmount === 'number' && presetAmount > 0
          ? String(presetAmount)
          : ''
      );
      // Padrão automático: Pendente (não pago, sem data de pagamento preenchida)
      setIsPaid(false);
      setPaymentDate('');
      setAccountId(presetAccountId || accounts[0]?.id || '');
      const matchingCats = categories.filter(
        (c) => c.type === initialType || c.type === 'both'
      );
      setCategoryId(matchingCats[0]?.id || categories[0]?.id || '');
      setCompetenceDate(`${selectedMonth}-07`);
      setDueDate(`${selectedMonth}-15`);
      setRecurrenceType('single');
      setInstallmentTotal('3');
      setPaidByEmail(userEmail);
      setSpaceExpensePaymentMode('unpaid');
      setSpaceAllocationMode('equal');

      if (presetSpaceId) {
        setSplitMode('space');
        setSpaceId(presetSpaceId);
        const spObj = spaces.find((s) => s.id === presetSpaceId);
        setRecipientEmail(spObj?.ownerEmail || userEmail);
      } else {
        setSplitMode('none');
        setSpaceId(spaces[0]?.id || '');
        setRecipientEmail(spaces[0]?.ownerEmail || userEmail);
      }
      setCustomSplits([]);
    }
  }, [
    isOpen,
    editingTransaction,
    presetAccountId,
    presetSpaceId,
    presetType,
    presetDescription,
    presetAmount,
    selectedMonth,
  ]);

  useEffect(() => {
    if (!isOpen) return;
    if (!accountId && accounts.length > 0) {
      setAccountId(presetAccountId || accounts[0].id);
    }
    if (!categoryId && categories.length > 0) {
      const matchingCats = categories.filter(
        (c) => c.type === type || c.type === 'both'
      );
      setCategoryId(matchingCats[0]?.id || categories[0].id);
    }
  }, [isOpen, accounts, categories, accountId, categoryId, presetAccountId, type]);

  const selectedAccount = accounts.find((a) => a.id === accountId) || accounts[0];
  const selectedCategory =
    categories.find((c) => c.id === categoryId) || categories[0];
  const selectedSpace = spaces.find((s) => s.id === spaceId);

  // Inicializa percentuais iguais quando troca de espaço
  useEffect(() => {
    if (!selectedSpace) return;
    const parts = selectedSpace.participants;
    const count = Math.max(1, parts.length);
    const basePct = Number((100 / count).toFixed(2));
    const map: Record<string, number> = {};
    parts.forEach((p, idx) => {
      map[p.email.toLowerCase()] =
        idx === 0 ? Number((100 - basePct * (count - 1)).toFixed(2)) : basePct;
    });
    setParticipantPercentages(map);
  }, [spaceId, spaces]);

  // Projeção automática de fatura de cartão quando muda data de competência ou conta
  const invoiceProjection =
    selectedAccount?.type === 'credit'
      ? calculateCreditCardInvoice(
          competenceDate,
          selectedAccount.closingDay,
          selectedAccount.dueDay
        )
      : null;

  const effectiveDueDate = invoiceProjection ? invoiceProjection.dueDate : dueDate;
  const effectiveSplits =
    splitMode === 'none' || type === 'income' ? [] : customSplits;

  // Status calculado automaticamente pelas regras de negócio
  const computedStatus: TransactionStatus = computeAutomatedStatus({
    isPaid,
    paymentDate,
    dueDate: effectiveDueDate,
    splits: effectiveSplits,
  });

  const handleTogglePaidButton = () => {
    if (!isPaid) {
      setIsPaid(true);
      setPaymentDate((prev) => prev || getTodayDateString());
      if (type === 'expense' && splitMode === 'space' && spaceExpensePaymentMode === 'unpaid') {
        setSpaceExpensePaymentMode('space_cash');
      }
    } else {
      setIsPaid(false);
      setPaymentDate('');
      if (type === 'expense' && splitMode === 'space') {
        setSpaceExpensePaymentMode('unpaid');
      }
    }
  };

  // Recalcula divisão (Igual ou Percentual) quando muda o espaço, valor total, modo de pagamento ou percentuais
  useEffect(() => {
    const numericAmount = Number(amount) || 0;
    if (type === 'expense' && splitMode === 'space' && selectedSpace) {
      const parts = selectedSpace.participants;
      const count = Math.max(1, parts.length);
      const shareVal = Number((numericAmount / count).toFixed(2));

      setCustomSplits(
        parts.map((p, idx) => {
          const emailKey = p.email.toLowerCase();
          const pct =
            participantPercentages[emailKey] ?? Number((100 / count).toFixed(2));
          const responsibility =
            spaceAllocationMode === 'percentage'
              ? Number(((numericAmount * pct) / 100).toFixed(2))
              : idx === 0
              ? Number((numericAmount - shareVal * (count - 1)).toFixed(2))
              : shareVal;

          const paidAmount =
            spaceExpensePaymentMode === 'member_direct' &&
            isPaid &&
            emailKey === paidByEmail.toLowerCase()
              ? numericAmount
              : 0;

          return {
            email: p.email,
            name: p.name,
            responsibility,
            paidAmount,
            // No Espaço Compartilhado, a despesa entra automaticamente no Livro-Razão do mês sem travar como 'Em Validação'
            status: 'accepted',
          };
        })
      );
    } else if (splitMode === 'none' || type === 'income') {
      setCustomSplits([]);
    }
  }, [
    type,
    splitMode,
    spaceId,
    amount,
    paidByEmail,
    isPaid,
    spaceExpensePaymentMode,
    spaceAllocationMode,
    participantPercentages,
  ]);

  // Trava a rolagem do body quando o modal universal está aberto para evitar barra de rolagem dupla
  useEffect(() => {
    if (!isOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleAddAdhocParticipant = () => {
    if (!adhocEmail.trim() || !adhocEmail.includes('@')) {
      setErrorMsg('Informe um e-mail válido para adicionar ao rateio avulso.');
      return;
    }
    setErrorMsg(null);
    const numericAmount = Number(amount) || 0;
    const baseParticipants =
      customSplits.length === 0
        ? [
            {
              email: userEmail,
              name: userName,
              responsibility: numericAmount / 2,
              paidAmount: numericAmount,
              status: 'accepted' as const,
            },
          ]
        : [...customSplits];

    const exists = baseParticipants.some(
      (p) => p.email.toLowerCase() === adhocEmail.trim().toLowerCase()
    );
    if (!exists) {
      baseParticipants.push({
        email: adhocEmail.trim().toLowerCase(),
        name: adhocName.trim() || adhocEmail.trim().split('@')[0],
        responsibility: 0,
        paidAmount: 0,
        status: 'pending',
      });
    }

    const count = baseParticipants.length;
    const shareVal = Number((numericAmount / count).toFixed(2));
    const rebalanced = baseParticipants.map((p, idx) => ({
      ...p,
      responsibility:
        idx === 0
          ? Number((numericAmount - shareVal * (count - 1)).toFixed(2))
          : shareVal,
      paidAmount:
        p.email.toLowerCase() === paidByEmail.toLowerCase() ? numericAmount : 0,
    }));

    setCustomSplits(rebalanced);
    setAdhocEmail('');
    setAdhocName('');
  };

  const handleCreateQuickCategory = async () => {
    if (!newCatName.trim()) return;
    const created = await onCreateCategory({
      name: newCatName.trim().slice(0, 60),
      type,
      icon: newCatIcon,
      color: newCatColor,
    });
    setCategoryId(created.id);
    setNewCatName('');
    setShowNewCatForm(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const numericAmount = Number(amount);
    if (!description.trim()) {
      setErrorMsg('Informe uma descrição para o lançamento.');
      return;
    }
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setErrorMsg('Informe um valor financeiro maior que zero.');
      return;
    }
    if (!selectedAccount) {
      setErrorMsg('Selecione uma conta bancária ou cartão de crédito.');
      return;
    }
    if (!selectedCategory) {
      setErrorMsg('Selecione uma categoria.');
      return;
    }
    if (isPaid && !paymentDate.trim()) {
      setErrorMsg('Informe a data de pagamento para efetivar o lançamento.');
      return;
    }

    setSaving(true);
    try {
      const participantEmails =
        splitMode === 'space' && selectedSpace
          ? Array.from(
              new Set([
                userEmail.toLowerCase(),
                ...selectedSpace.participantEmails.map((em) => em.toLowerCase()),
              ])
            ).slice(0, 20)
          : splitMode === 'adhoc' && customSplits.length > 0
          ? Array.from(
              new Set([
                userEmail.toLowerCase(),
                ...customSplits.map((s) => s.email.toLowerCase()),
              ])
            ).slice(0, 20)
          : [userEmail.toLowerCase()];

      const resolvedPaidByEmail =
        type === 'expense' && splitMode === 'space'
          ? spaceExpensePaymentMode === 'member_direct' && isPaid
            ? paidByEmail
            : 'space_cash'
          : paidByEmail;

      const series = generateRecurrenceSeries(
        {
          userId,
          ownerEmail: userEmail,
          ownerName: userName,
          description: description.trim(),
          amount: numericAmount,
          type,
          status: computedStatus,
          paymentDate: computedStatus === 'paid' ? paymentDate || getTodayDateString() : '',
          categoryId: selectedCategory.id,
          categoryName: selectedCategory.name,
          categoryIcon: selectedCategory.icon,
          categoryColor: selectedCategory.color,
          accountId: selectedAccount.id,
          accountName: selectedAccount.name,
          accountType: selectedAccount.type,
          competenceDate,
          dueDate: effectiveDueDate,
          recurrenceType,
          recurrenceGroupId:
            editingTransaction?.recurrenceGroupId || `grp_${Date.now()}`,
          spaceId: splitMode === 'space' && selectedSpace ? selectedSpace.id : '',
          spaceName: splitMode === 'space' && selectedSpace ? selectedSpace.name : '',
          paidByEmail: resolvedPaidByEmail,
          recipientEmail:
            type === 'income' && splitMode === 'space' ? recipientEmail : undefined,
          participantEmails,
          splits: effectiveSplits,
          disputeReason: editingTransaction?.disputeReason || '',
          proposedAmount: editingTransaction?.proposedAmount || 0,
        },
        selectedAccount,
        recurrenceType,
        Number(installmentTotal) || 2
      );

      await onSaveSeries(series, editingTransaction, cascadeMode);

      // Envia notificação via EmailJS para participantes de rateio avulso/espaço
      if (splitMode !== 'none' && customSplits.length > 1) {
        const externalParticipants = customSplits.filter(
          (s) => s.email.toLowerCase() !== userEmail.toLowerCase()
        );
        for (const ext of externalParticipants) {
          await sendTransactionalEmail({
            toEmail: ext.email,
            toName: ext.name,
            fromName: userName,
            subject: `Novo rateio compartilhado: ${description.trim()}`,
            spaceOrTransactionTitle: description.trim(),
            amountFormatted: formatCurrency(ext.responsibility),
            message: `${userName} incluiu você no rateio "${description.trim()}" (${
              selectedSpace ? selectedSpace.name : 'Rateio Avulso'
            }). Sua cota calculada é ${formatCurrency(ext.responsibility)}.`,
            type: 'split_notification',
          });
        }
        if (externalParticipants.length > 0) {
          onNotifyToast(
            `Lançamento salvo e ${externalParticipants.length} notificação(ões) de rateio disparada(s) via EmailJS.`
          );
        }
      }

      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-hidden"
      role="dialog"
      aria-modal="true"
      aria-label="Formulário Universal de Lançamento"
    >
      <div className="w-full max-w-2xl bg-slate-800 border-t sm:border border-slate-700 rounded-t-3xl sm:rounded-3xl p-5 sm:p-6 md:p-8 shadow-2xl max-h-[92dvh] overflow-y-auto overscroll-contain">
        <div className="flex items-center justify-between pb-4 border-b border-slate-700/80 mb-5">
          <div>
            <h2 className="text-lg font-bold text-white">
              {editingTransaction
                ? 'Editar Lançamento Financeiro'
                : 'Novo Lançamento Universal'}
            </h2>
            <p className="text-xs text-slate-400">
              Configure recorrência, projeção de fatura, datas de competência e divisão colaborativa.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar formulário"
            className="w-9 h-9 rounded-xl bg-slate-700/60 text-slate-400 hover:text-white flex items-center justify-center cursor-pointer"
          >
            <i className="ph-bold ph-x"></i>
          </button>
        </div>

        {errorMsg && (
          <div className="mb-4 p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300 flex items-center gap-2">
            <i className="ph-fill ph-warning-circle text-base"></i>
            <span>{errorMsg}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Tipo: Despesa vs Receita */}
          <div className="grid grid-cols-2 gap-2 p-1 bg-slate-900 rounded-2xl border border-slate-700/70">
            <button
              type="button"
              onClick={() => setType('expense')}
              className={`py-2.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-2 transition-all cursor-pointer ${
                type === 'expense'
                  ? 'bg-rose-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <i className="ph-bold ph-arrow-down-right"></i>
              <span>Despesa / Saída</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setType('income');
                if (splitMode === 'adhoc') {
                  setSplitMode('none');
                }
              }}
              className={`py-2.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-2 transition-all cursor-pointer ${
                type === 'income'
                  ? 'bg-emerald-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <i className="ph-bold ph-arrow-up-right"></i>
              <span>Receita / Entrada (ou Aporte)</span>
            </button>
          </div>

          {/* Descrição e Valor */}
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-4">
            <div className="sm:col-span-7">
              <label
                htmlFor="tx-desc"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                Descrição do Lançamento
              </label>
              <input
                id="tx-desc"
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={
                  type === 'income' && splitMode === 'space'
                    ? 'Ex: Aporte Mensal Casa - Marina'
                    : 'Ex: Supermercado, Passagem Aérea, Aluguel...'
                }
                className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white"
              />
            </div>

            <div className="sm:col-span-5">
              <label
                htmlFor="tx-amount"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                {recurrenceType === 'installment'
                  ? 'Valor Total da Compra (R$)'
                  : 'Valor (R$)'}
              </label>
              <input
                id="tx-amount"
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0,00"
                className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white font-mono"
              />
            </div>
          </div>

          {/* Conta/Cartão e Categoria */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="tx-account"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                Conta Bancária ou Cartão de Crédito
              </label>
              <select
                id="tx-account"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white"
              >
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.type === 'credit' ? `[Cartão] ${acc.name}` : `[Conta] ${acc.name}`}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label
                  htmlFor="tx-category"
                  className="block text-xs font-medium text-slate-300"
                >
                  Categoria
                </label>
                <button
                  type="button"
                  onClick={() => setShowNewCatForm(!showNewCatForm)}
                  className="text-xs text-indigo-400 hover:text-indigo-300 font-semibold cursor-pointer"
                >
                  {showNewCatForm ? 'Fechar criador' : '+ Criar categoria customizada'}
                </button>
              </div>

              <select
                id="tx-category"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white"
              >
                {categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {showNewCatForm && (
            <div className="p-4 rounded-2xl bg-slate-900 border border-slate-700 space-y-3">
              <div className="text-xs font-semibold text-slate-200">
                Nova Categoria Customizada (Ícone & Cor)
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <input
                  type="text"
                  value={newCatName}
                  onChange={(e) => setNewCatName(e.target.value)}
                  placeholder="Nome da categoria"
                  className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white"
                />
                <select
                  aria-label="Ícone da nova categoria"
                  value={newCatIcon}
                  onChange={(e) => setNewCatIcon(e.target.value)}
                  className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white"
                >
                  {AVAILABLE_ICONS.map((ic) => (
                    <option key={ic} value={ic}>
                      Ícone: {ic.replace('ph-', '')}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Cor da nova categoria"
                  value={newCatColor}
                  onChange={(e) => setNewCatColor(e.target.value)}
                  className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white"
                >
                  {AVAILABLE_COLORS.map((col) => (
                    <option key={col.id} value={col.id}>
                      Cor: {col.label}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={handleCreateQuickCategory}
                className="px-3.5 py-1.5 rounded-xl bg-indigo-600 text-white text-xs font-semibold cursor-pointer"
              >
                Adicionar Categoria
              </button>
            </div>
          )}

          {/* Status por Vencimento (Despesa) vs. Processo de Efetivação (Receita) */}
          <div className="p-4 rounded-2xl bg-slate-900/90 border border-slate-700/80 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <span className="block text-xs font-semibold text-slate-200">
                  {type === 'income'
                    ? 'Processo de Efetivação da Receita'
                    : 'Controle de Vencimento & Pagamento da Despesa'}
                </span>
                <div className="flex items-center gap-2 mt-1.5">
                  <span
                    className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-xl border text-xs font-bold ${AUTOMATED_STATUS_META[computedStatus].badgeClass}`}
                  >
                    <i
                      className={`ph-fill ${AUTOMATED_STATUS_META[computedStatus].icon}`}
                    ></i>
                    <span>
                      {type === 'income'
                        ? computedStatus === 'paid'
                          ? 'Receita Efetivada'
                          : 'Aguardando Efetivação'
                        : computedStatus === 'paid'
                        ? 'Despesa Paga'
                        : computedStatus === 'overdue'
                        ? 'Em Atraso (Vencida)'
                        : computedStatus === 'validating'
                        ? 'Aguardando Aceite (Rateio Avulso)'
                        : 'No Prazo (Controlada pelo Vencimento)'}
                    </span>
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 mt-1">
                  {type === 'income'
                    ? isPaid
                      ? 'Receita efetivada: já soma nas entradas confirmadas.'
                      : 'Receitas ficam aguardando efetivação até você confirmar que o valor realmente entrou.'
                    : isPaid
                    ? 'Despesa marcada como paga na data informada.'
                    : 'Despesas não precisam de efetivação: a data de vencimento define automaticamente se está no prazo ou em atraso.'}
                </p>
              </div>

              <div className="flex items-center gap-2 self-start sm:self-center">
                <button
                  type="button"
                  onClick={handleTogglePaidButton}
                  aria-pressed={isPaid}
                  className={`px-4 py-2.5 rounded-xl text-xs font-bold flex items-center gap-2 transition-all cursor-pointer whitespace-nowrap border ${
                    isPaid
                      ? 'bg-emerald-600 border-emerald-500 text-white shadow-lg shadow-emerald-600/25'
                      : 'bg-slate-800 hover:bg-emerald-600/20 border-slate-700 hover:border-emerald-500/50 text-slate-200 hover:text-emerald-300'
                  }`}
                >
                  <i
                    aria-hidden="true"
                    className={
                      isPaid
                        ? 'ph-fill ph-check-circle text-base'
                        : 'ph-bold ph-check-circle text-base'
                    }
                  ></i>
                  <span>
                    {type === 'income'
                      ? isPaid
                        ? 'Receita Efetivada (Ativo)'
                        : 'Efetivar Receita Agora'
                      : isPaid
                      ? 'Despesa Paga (Ativo)'
                      : 'Já foi Paga'}
                  </span>
                </button>
              </div>
            </div>

            {isPaid && (
              <div className="pt-3 border-t border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <label
                    htmlFor="tx-payment-date"
                    className="block text-xs font-semibold text-emerald-300"
                  >
                    {type === 'income'
                      ? 'Data de Efetivação da Receita'
                      : 'Data de Pagamento da Despesa'}
                  </label>
                  <span className="text-[11px] text-slate-400">
                    Preenchida automaticamente com a data de hoje. Você pode ajustar se necessário.
                  </span>
                </div>
                <input
                  id="tx-payment-date"
                  type="date"
                  value={paymentDate}
                  onChange={(e) => setPaymentDate(e.target.value)}
                  className="px-3.5 py-2 bg-slate-800 border border-emerald-500/50 rounded-xl text-xs text-emerald-300 font-mono font-bold"
                />
              </div>
            )}
          </div>

          {/* Datas de Competência vs. Vencimento & Projeção de Fatura */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 rounded-2xl bg-slate-900/80 border border-slate-700/70">
            <div>
              <label
                htmlFor="tx-competence"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                Data de Competência (Compra/Fato)
              </label>
              <input
                id="tx-competence"
                type="date"
                value={competenceDate}
                onChange={(e) => setCompetenceDate(e.target.value)}
                className="w-full px-3.5 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white font-mono"
              />
            </div>

            <div>
              <label
                htmlFor="tx-due"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                Data de Vencimento / Previsão
              </label>
              <input
                id="tx-due"
                type="date"
                value={effectiveDueDate}
                disabled={Boolean(invoiceProjection)}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-full px-3.5 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white font-mono disabled:opacity-70"
              />
            </div>

            {invoiceProjection && selectedAccount && (
              <div className="sm:col-span-2 text-xs text-purple-300 flex items-center gap-2 pt-1">
                <i className="ph-fill ph-sparkle text-purple-400"></i>
                <span>
                  Motor de Faturas: Compra em {competenceDate} (Corte dia{' '}
                  {selectedAccount.closingDay}) projetada automaticamente para a fatura{' '}
                  <strong className="font-mono">{invoiceProjection.invoiceMonth}</strong>{' '}
                  com vencimento em{' '}
                  <strong className="font-mono">{invoiceProjection.dueDate}</strong>.
                </span>
              </div>
            )}
          </div>

          {/* Motor de Recorrência Universal: Único, Fixo, Parcelado */}
          <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-700/70 space-y-3">
            <label className="block text-xs font-semibold text-slate-200">
              Motor de Recorrência Universal
            </label>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                disabled={Boolean(editingTransaction)}
                onClick={() => setRecurrenceType('single')}
                className={`py-2 px-3 rounded-xl text-xs font-semibold border transition-all cursor-pointer disabled:opacity-60 ${
                  recurrenceType === 'single'
                    ? 'bg-indigo-600/20 border-indigo-500 text-indigo-300'
                    : 'bg-slate-800 border-slate-700 text-slate-400'
                }`}
              >
                Único
              </button>
              <button
                type="button"
                disabled={Boolean(editingTransaction)}
                onClick={() => setRecurrenceType('fixed')}
                className={`py-2 px-3 rounded-xl text-xs font-semibold border transition-all cursor-pointer disabled:opacity-60 ${
                  recurrenceType === 'fixed'
                    ? 'bg-indigo-600/20 border-indigo-500 text-indigo-300'
                    : 'bg-slate-800 border-slate-700 text-slate-400'
                }`}
              >
                Fixo Mensal
              </button>
              <button
                type="button"
                disabled={Boolean(editingTransaction)}
                onClick={() => setRecurrenceType('installment')}
                className={`py-2 px-3 rounded-xl text-xs font-semibold border transition-all cursor-pointer disabled:opacity-60 ${
                  recurrenceType === 'installment'
                    ? 'bg-indigo-600/20 border-indigo-500 text-indigo-300'
                    : 'bg-slate-800 border-slate-700 text-slate-400'
                }`}
              >
                Parcelado
              </button>
            </div>

            {recurrenceType === 'installment' && !editingTransaction && (
              <div className="flex items-center justify-between gap-4 pt-2">
                <label htmlFor="tx-installments" className="text-xs text-slate-300">
                  Número de Parcelas (2x a 48x):
                </label>
                <input
                  id="tx-installments"
                  type="number"
                  min={2}
                  max={48}
                  value={installmentTotal}
                  onChange={(e) => setInstallmentTotal(e.target.value)}
                  className="w-28 px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white font-mono"
                />
              </div>
            )}

            {editingTransaction && editingTransaction.recurrenceType !== 'single' && (
              <div className="pt-2 space-y-1.5">
                <label
                  htmlFor="tx-cascade-mode"
                  className="block text-xs text-amber-300 font-semibold"
                >
                  Escopo da Alteração (Lançamento {editingTransaction.recurrenceType === 'fixed' ? 'Fixo Mensal' : 'Parcelado'} — Competência {editingTransaction.invoiceMonth}):
                </label>
                <select
                  id="tx-cascade-mode"
                  aria-label="Modo de edição em cascata"
                  value={cascadeMode}
                  onChange={(e) => setCascadeMode(e.target.value as CascadeMode)}
                  className="w-full px-3 py-2.5 bg-slate-800 border border-amber-500/40 rounded-xl text-xs text-white font-semibold"
                >
                  <option value="only_this">
                    Somente este lançamento ({editingTransaction.invoiceMonth}) — não altera outros meses
                  </option>
                  <option value="this_and_following">
                    Este ({editingTransaction.invoiceMonth}) e os seguintes da série
                  </option>
                  <option value="all">
                    Todos os lançamentos da série ({editingTransaction.installmentTotal} meses)
                  </option>
                </select>
                <p className="text-[11px] text-slate-400">
                  {cascadeMode === 'only_this'
                    ? `Apenas o registro de ${editingTransaction.invoiceMonth} terá seu valor/dados alterados. Os demais meses permanecem intactos.`
                    : cascadeMode === 'this_and_following'
                    ? `O novo valor será aplicado a partir de ${editingTransaction.invoiceMonth} em diante, sem mexer nos meses anteriores.`
                    : 'O novo valor será propagado para todos os meses desta série.'}
                </p>
              </div>
            )}
          </div>

          {/* Vínculo ao Espaço Compartilhado / Rateio (Disponível para Despesa e Receita!) */}
          <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-700/70 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-200">
                {type === 'income'
                  ? 'Destino da Receita (Individual ou Aporte para Espaço Compartilhado)'
                  : 'Divisão Colaborativa (Espaço Compartilhado & Rateios)'}
              </span>
            </div>

            <div
              className={`grid grid-cols-1 ${
                type === 'expense' ? 'sm:grid-cols-3' : 'sm:grid-cols-2'
              } gap-2`}
            >
              <button
                type="button"
                onClick={() => setSplitMode('none')}
                className={`py-2 px-3 rounded-xl text-xs font-semibold border cursor-pointer ${
                  splitMode === 'none'
                    ? 'bg-indigo-600/20 border-indigo-500 text-indigo-300'
                    : 'bg-slate-800 border-slate-700 text-slate-400'
                }`}
              >
                {type === 'income' ? 'Receita Pessoal (Individual)' : 'Individual'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setSplitMode('space');
                  if (!spaceId && spaces[0]) setSpaceId(spaces[0].id);
                }}
                className={`py-2 px-3 rounded-xl text-xs font-semibold border cursor-pointer ${
                  splitMode === 'space'
                    ? 'bg-emerald-600/20 border-emerald-500 text-emerald-300'
                    : 'bg-slate-800 border-slate-700 text-slate-400'
                }`}
              >
                {type === 'income'
                  ? 'Enviar Receita / Aporte ao Espaço'
                  : 'Espaço Compartilhado'}
              </button>
              {type === 'expense' && (
                <button
                  type="button"
                  onClick={() => setSplitMode('adhoc')}
                  className={`py-2 px-3 rounded-xl text-xs font-semibold border cursor-pointer ${
                    splitMode === 'adhoc'
                      ? 'bg-indigo-600/20 border-indigo-500 text-indigo-300'
                      : 'bg-slate-800 border-slate-700 text-slate-400'
                  }`}
                >
                  Rateio Avulso
                </button>
              )}
            </div>

            {/* Configuração de Receita / Aporte para o Espaço */}
            {type === 'income' && splitMode === 'space' && (
              <div className="space-y-3 pt-2 border-t border-slate-800">
                <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-200">
                  <strong>Como funciona o Aporte no Espaço:</strong> O valor enviado acumula nos pagamentos da pessoa que enviou e deduz o que ela deve no mês assim que o recebedor confirmar a efetivação.
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label
                      htmlFor="tx-income-space-select"
                      className="block text-xs text-slate-400 mb-1"
                    >
                      Espaço de Destino
                    </label>
                    <select
                      id="tx-income-space-select"
                      value={spaceId}
                      onChange={(e) => setSpaceId(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white"
                    >
                      {spaces.map((sp) => (
                        <option key={sp.id} value={sp.id}>
                          {sp.name} ({sp.participants.length} membros)
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="tx-income-sender-select"
                      className="block text-xs text-slate-400 mb-1"
                    >
                      Quem está enviando o aporte?
                    </label>
                    <select
                      id="tx-income-sender-select"
                      value={paidByEmail}
                      onChange={(e) => setPaidByEmail(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white"
                    >
                      {(selectedSpace?.participants || []).map((p) => (
                        <option key={p.email} value={p.email}>
                          {p.name} ({p.email})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="tx-income-recipient-select"
                      className="block text-xs text-slate-400 mb-1"
                    >
                      Quem recebe e confirma?
                    </label>
                    <select
                      id="tx-income-recipient-select"
                      value={recipientEmail}
                      onChange={(e) => setRecipientEmail(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white"
                    >
                      {(selectedSpace?.participants || []).map((p) => (
                        <option key={p.email} value={p.email}>
                          {p.name} ({p.email})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            )}

            {/* Configuração de Despesa no Espaço */}
            {type === 'expense' && splitMode === 'space' && (
              <div className="space-y-4 pt-2 border-t border-slate-800">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="tx-space-select"
                      className="block text-xs text-slate-400 mb-1"
                    >
                      Espaço Compartilhado
                    </label>
                    <select
                      id="tx-space-select"
                      value={spaceId}
                      onChange={(e) => setSpaceId(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white"
                    >
                      {spaces.map((sp) => (
                        <option key={sp.id} value={sp.id}>
                          {sp.name} ({sp.participants.length} membros)
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="tx-space-payment-mode"
                      className="block text-xs text-slate-400 mb-1"
                    >
                      Situação do Pagamento desta Despesa
                    </label>
                    <select
                      id="tx-space-payment-mode"
                      value={spaceExpensePaymentMode}
                      onChange={(e) => {
                        const mode = e.target.value as
                          | 'unpaid'
                          | 'space_cash'
                          | 'member_direct';
                        setSpaceExpensePaymentMode(mode);
                        if (mode === 'unpaid') {
                          setIsPaid(false);
                          setPaymentDate('');
                        } else {
                          setIsPaid(true);
                          setPaymentDate((prev) => prev || getTodayDateString());
                        }
                      }}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white"
                    >
                      <option value="unpaid">
                        Ainda não foi paga (Entra a pagar no mês)
                      </option>
                      <option value="space_cash">
                        Paga usando o Caixa / Receitas do Espaço
                      </option>
                      <option value="member_direct">
                        Paga direto do bolso de um membro (Abate cota / Reembolso)
                      </option>
                    </select>
                  </div>
                </div>

                {spaceExpensePaymentMode === 'member_direct' && (
                  <div>
                    <label
                      htmlFor="tx-paidby-select"
                      className="block text-xs text-slate-400 mb-1"
                    >
                      Qual participante pagou esta despesa do próprio bolso?
                    </label>
                    <select
                      id="tx-paidby-select"
                      value={paidByEmail}
                      onChange={(e) => setPaidByEmail(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white"
                    >
                      {(selectedSpace?.participants || []).map((p) => (
                        <option key={p.email} value={p.email}>
                          {p.name} ({p.email})
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Regra de Rateio: Divisão Igual (Padrão) vs. Por Percentual (%) */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-1">
                  <span className="text-xs font-semibold text-slate-300">
                    Regra de Rateio entre os Participantes:
                  </span>
                  <div className="flex items-center gap-1.5 bg-slate-800 p-1 rounded-xl border border-slate-700">
                    <button
                      type="button"
                      onClick={() => setSpaceAllocationMode('equal')}
                      className={`px-3 py-1 rounded-lg text-xs font-semibold cursor-pointer ${
                        spaceAllocationMode === 'equal'
                          ? 'bg-indigo-600 text-white'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      Divisão Igual (Padrão)
                    </button>
                    <button
                      type="button"
                      onClick={() => setSpaceAllocationMode('percentage')}
                      className={`px-3 py-1 rounded-lg text-xs font-semibold cursor-pointer ${
                        spaceAllocationMode === 'percentage'
                          ? 'bg-indigo-600 text-white'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      Por Percentual (%)
                    </button>
                  </div>
                </div>
              </div>
            )}

            {type === 'expense' && splitMode === 'adhoc' && (
              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
                  <input
                    type="text"
                    value={adhocName}
                    onChange={(e) => setAdhocName(e.target.value)}
                    placeholder="Nome do participante"
                    className="sm:col-span-4 px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white"
                  />
                  <input
                    type="email"
                    value={adhocEmail}
                    onChange={(e) => setAdhocEmail(e.target.value)}
                    placeholder="E-mail para convite/rateio"
                    className="sm:col-span-5 px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white"
                  />
                  <button
                    type="button"
                    onClick={handleAddAdhocParticipant}
                    className="sm:col-span-3 py-2 px-3 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl cursor-pointer"
                  >
                    + Incluir Pessoa
                  </button>
                </div>
              </div>
            )}

            {type === 'expense' && splitMode !== 'none' && customSplits.length > 0 && (
              <div className="space-y-2 pt-2 border-t border-slate-800">
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span>Participante</span>
                  <span>
                    {splitMode === 'space' && spaceAllocationMode === 'percentage'
                      ? 'Percentual (%) · Cota Calculada (R$)'
                      : 'Cota na Despesa (R$) · Desembolso Direto (R$)'}
                  </span>
                </div>
                {customSplits.map((sp, idx) => {
                  const emailKey = sp.email.toLowerCase();
                  const pctVal =
                    participantPercentages[emailKey] ??
                    Number((100 / Math.max(1, customSplits.length)).toFixed(2));
                  return (
                    <div
                      key={sp.email}
                      className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-2.5 rounded-xl bg-slate-800/90 border border-slate-700/60 text-xs"
                    >
                      <div className="min-w-0">
                        <span className="font-semibold text-white">{sp.name}</span>
                        <span className="text-slate-400 ml-1.5 text-[11px]">
                          ({sp.email})
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {splitMode === 'space' && spaceAllocationMode === 'percentage' && (
                          <>
                            <label className="text-[11px] text-indigo-300 font-semibold">
                              %:
                            </label>
                            <input
                              type="number"
                              step="0.1"
                              min={0}
                              max={100}
                              aria-label={`Percentual de ${sp.name}`}
                              value={pctVal}
                              onChange={(e) => {
                                const newPct = Number(e.target.value) || 0;
                                setParticipantPercentages((prev) => ({
                                  ...prev,
                                  [emailKey]: newPct,
                                }));
                              }}
                              className="w-20 px-2 py-1 bg-slate-900 border border-indigo-500/50 rounded-lg text-xs text-indigo-300 font-mono text-right"
                            />
                          </>
                        )}

                        <label className="text-[11px] text-slate-400">Cota:</label>
                        <input
                          type="number"
                          step="0.01"
                          aria-label={`Responsabilidade de ${sp.name}`}
                          value={sp.responsibility}
                          onChange={(e) => {
                            const updated = [...customSplits];
                            updated[idx] = {
                              ...updated[idx],
                              responsibility: Number(e.target.value) || 0,
                            };
                            setCustomSplits(updated);
                          }}
                          className="w-24 px-2 py-1 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white font-mono text-right"
                        />
                        <label className="text-[11px] text-slate-400">Pagou:</label>
                        <input
                          type="number"
                          step="0.01"
                          aria-label={`Valor pago por ${sp.name}`}
                          value={sp.paidAmount}
                          onChange={(e) => {
                            const updated = [...customSplits];
                            updated[idx] = {
                              ...updated[idx],
                              paidAmount: Number(e.target.value) || 0,
                            };
                            setCustomSplits(updated);
                          }}
                          className="w-24 px-2 py-1 bg-slate-900 border border-slate-700 rounded-lg text-xs text-emerald-400 font-mono text-right"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="pt-3 flex items-center justify-end gap-3 border-t border-slate-700/80">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-200 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white shadow-lg shadow-indigo-600/25 cursor-pointer"
            >
              {saving
                ? 'Processando...'
                : editingTransaction
                ? 'Salvar Alterações'
                : 'Registrar Lançamento'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
