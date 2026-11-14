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
  UniversalTransactionExtra,
} from '../types/finance';
import {
  calculateCreditCardInvoice,
  computeAutomatedStatus,
  formatCurrency,
  generateRecurrenceSeries,
  getTodayDateString,
} from '../utils/financeEngine';
import { sendTransactionalEmail } from '../services/emailService';
import { calculateExpenseSplit } from '../utils/splitEngine';
import { IconGridPicker, ColorPalettePicker } from './ui/VisualPickers';

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
  presetRecurrenceType?: RecurrenceType;
  presetFixedNature?: 'fixed' | 'recurring';
  presetIsPaid?: boolean;
  presetDescription?: string;
  presetAmount?: number;
  onSaveSeries: (
    series: Omit<Transaction, 'id'>[],
    editingTx: Transaction | null,
    cascadeMode: CascadeMode,
    extra?: UniversalTransactionExtra
  ) => Promise<void>;
  onCreateCategory: (cat: Omit<Category, 'id' | 'userId'>) => Promise<Category>;
  onNotifyToast: (msg: string) => void;
}

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
  presetRecurrenceType,
  presetFixedNature,
  presetIsPaid,
  presetDescription,
  presetAmount,
  onSaveSeries,
  onCreateCategory,
  onNotifyToast,
}) => {
  const [type, setType] = useState<TransactionType>('expense');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [isPaid, setIsPaid] = useState(false);
  const [paymentDate, setPaymentDate] = useState('');
  const [accountId, setAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [competenceDate, setCompetenceDate] = useState(`${selectedMonth}-07`);
  const [dueDate, setDueDate] = useState(`${selectedMonth}-15`);
  const [recurrenceType, setRecurrenceType] = useState<RecurrenceType>('single');
  const [fixedNature, setFixedNature] = useState<'fixed' | 'recurring'>('fixed');
  const [frequency, setFrequency] = useState<'monthly' | 'weekly' | 'yearly'>('monthly');
  const [installmentTotal, setInstallmentTotal] = useState('2');
  const [installmentOngoing, setInstallmentOngoing] = useState(false);
  const [initialInstallmentNumber, setInitialInstallmentNumber] = useState('2');
  const [installmentAmountMode, setInstallmentAmountMode] = useState<'remaining' | 'total'>('remaining');
  const [cascadeMode, setCascadeMode] = useState<CascadeMode>('only_this');

  // Divisão em Espaço ou Rateio Avulso
  const [splitMode, setSplitMode] = useState<'none' | 'space' | 'adhoc'>('none');
  const [spaceId, setSpaceId] = useState('');
  const [paidByEmail, setPaidByEmail] = useState(userEmail);
  const [recipientEmail, setRecipientEmail] = useState(userEmail);
  const [responsibleUid, setResponsibleUid] = useState(userId);
  const [payerUid, setPayerUid] = useState(userId);
  const [includedSpaceMemberEmails, setIncludedSpaceMemberEmails] = useState<string[]>([]);
  const [spaceExpensePaymentMode, setSpaceExpensePaymentMode] = useState<
    'unpaid' | 'space_cash' | 'member_direct'
  >('unpaid');
  const [spaceAllocationMode, setSpaceAllocationMode] = useState<
    'equal' | 'percentage' | 'custom_value'
  >('equal');
  const [participantPercentages, setParticipantPercentages] = useState<
    Record<string, number>
  >({});
  const [participantCustomValues, setParticipantCustomValues] = useState<
    Record<string, string>
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
      setNotes('');
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
      setFixedNature('fixed');
      setFrequency('monthly');
      setInstallmentTotal(String(editingTransaction.installmentTotal || 2));
      setInstallmentOngoing(false);
      setInitialInstallmentNumber('2');
      setInstallmentAmountMode('remaining');
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
      setNotes('');
      const shouldBePaid = Boolean(presetIsPaid);
      setIsPaid(shouldBePaid);
      setPaymentDate(shouldBePaid ? getTodayDateString() : '');
      const fallbackAcc =
        presetAccountId ||
        (initialType === 'income'
          ? accounts.find((a) => a.type !== 'credit')?.id || accounts[0]?.id || ''
          : accounts[0]?.id || '');
      setAccountId(fallbackAcc);
      const matchingCats = categories.filter(
        (c) => c.type === initialType || c.type === 'both'
      );
      setCategoryId(matchingCats[0]?.id || categories[0]?.id || '');
      setCompetenceDate(`${selectedMonth}-07`);
      setDueDate(`${selectedMonth}-15`);
      setRecurrenceType(presetRecurrenceType || 'single');
      setFixedNature(presetFixedNature || 'fixed');
      setFrequency('monthly');
      setInstallmentTotal('3');
      setInstallmentOngoing(false);
      setInitialInstallmentNumber('2');
      setInstallmentAmountMode('remaining');
      setPaidByEmail(userEmail);
      setResponsibleUid(userId);
      setPayerUid(userId);
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
    presetRecurrenceType,
    presetFixedNature,
    presetIsPaid,
    presetDescription,
    presetAmount,
    selectedMonth,
  ]);

  useEffect(() => {
    if (!isOpen) return;
    if (!accountId && accounts.length > 0) {
      const fallbackAcc =
        presetAccountId ||
        (type === 'income'
          ? accounts.find((a) => a.type !== 'credit')?.id || accounts[0].id
          : accounts[0].id);
      setAccountId(fallbackAcc);
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

  // Inicializa percentuais iguais, participantes incluídos e responsáveis quando troca de espaço
  useEffect(() => {
    if (!selectedSpace) return;
    const activeParts = selectedSpace.participants.filter(
      (p) => p.status !== 'invited'
    );
    const parts = activeParts.length > 0 ? activeParts : selectedSpace.participants;
    const count = Math.max(1, parts.length);
    const basePct = Number((100 / count).toFixed(2));
    const map: Record<string, number> = {};
    const customMap: Record<string, string> = {};
    parts.forEach((p, idx) => {
      const key = p.email.toLowerCase();
      map[key] = idx === 0 ? Number((100 - basePct * (count - 1)).toFixed(2)) : basePct;
      customMap[key] = '';
    });
    setParticipantPercentages(map);
    setParticipantCustomValues(customMap);
    setIncludedSpaceMemberEmails(parts.map((p) => p.email.toLowerCase()));
    const selfMatch = parts.find(
      (p) => p.uid === userId || p.email.toLowerCase() === userEmail.toLowerCase()
    );
    const fallbackUid = selfMatch?.uid || parts[0]?.uid || userId;
    setResponsibleUid(fallbackUid);
    setPayerUid(fallbackUid);
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

  // Recalcula divisão (Igual, Percentual ou Personalizado) quando muda espaço, valor, membros ou modo
  useEffect(() => {
    const numericAmount = Number(amount) || 0;
    if (type === 'expense' && splitMode === 'space' && selectedSpace) {
      const allParts = selectedSpace.participants;
      const activeParts =
        includedSpaceMemberEmails.length > 0
          ? allParts.filter((p) =>
              includedSpaceMemberEmails.includes(p.email.toLowerCase())
            )
          : allParts;
      const parts = activeParts.length > 0 ? activeParts : allParts;
      const count = Math.max(1, parts.length);
      const shareVal = Number((numericAmount / count).toFixed(2));

      setCustomSplits(
        parts.map((p, idx) => {
          const emailKey = p.email.toLowerCase();
          const pct =
            participantPercentages[emailKey] ?? Number((100 / count).toFixed(2));
          const customRaw = participantCustomValues[emailKey];
          const customNum =
            customRaw !== undefined && customRaw !== ''
              ? Number(String(customRaw).replace(',', '.')) || 0
              : 0;

          const responsibility =
            spaceAllocationMode === 'custom_value'
              ? customNum
              : spaceAllocationMode === 'percentage'
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
    participantCustomValues,
    includedSpaceMemberEmails,
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

  const handleRemoveAdhocParticipant = (targetEmail: string) => {
    const remaining = customSplits.filter(
      (p) => p.email.toLowerCase() !== targetEmail.toLowerCase()
    );
    if (remaining.length <= 1) {
      setCustomSplits([]);
      return;
    }
    const numericAmount = Number(amount) || 0;
    const count = remaining.length;
    const shareVal = Number((numericAmount / count).toFixed(2));
    const rebalanced = remaining.map((p, idx) => ({
      ...p,
      responsibility:
        idx === 0
          ? Number((numericAmount - shareVal * (count - 1)).toFixed(2))
          : shareVal,
    }));
    setCustomSplits(rebalanced);
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

    const isSharedExpenseLaunch = splitMode === 'space' && type === 'expense';
    if (!isSharedExpenseLaunch && !selectedAccount) {
      setErrorMsg('Selecione uma conta bancária ou cartão de crédito.');
      return;
    }
    if (
      !isSharedExpenseLaunch &&
      type === 'income' &&
      selectedAccount?.type === 'credit' &&
      recurrenceType === 'single'
    ) {
      setErrorMsg(
        'Receitas não podem ser creditadas diretamente em cartão de crédito. Selecione uma conta corrente ou carteira.'
      );
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

    const parsedInstTotal = Number(installmentTotal) || 2;
    const parsedInitialInst = installmentOngoing
      ? Math.max(2, Number(initialInstallmentNumber) || 2)
      : 1;
    if (recurrenceType === 'installment' && !editingTransaction) {
      if (parsedInstTotal < 2 || parsedInstTotal > 48) {
        setErrorMsg('O número de parcelas deve estar entre 2x e 48x.');
        return;
      }
      if (installmentOngoing && parsedInitialInst > parsedInstTotal) {
        setErrorMsg(
          `A parcela atual (${parsedInitialInst}) não pode ser maior que o total de parcelas (${parsedInstTotal}).`
        );
        return;
      }
    }

    // Validação matemática estrita de rateio em espaço compartilhado
    let sharedParticipantUids: string[] | undefined;
    let sharedPercentagesByUid: Record<string, number> | undefined;
    let sharedCustomValuesCentsByUid: Record<string, number> | undefined;

    if (isSharedExpenseLaunch) {
      if (!selectedSpace) {
        setErrorMsg('Selecione um espaço compartilhado.');
        return;
      }
      const chosenParts = selectedSpace.participants.filter((p) =>
        includedSpaceMemberEmails.includes(p.email.toLowerCase())
      );
      if (chosenParts.length === 0) {
        setErrorMsg('Selecione ao menos 1 participante para o rateio no espaço.');
        return;
      }

      const totalCents = Math.round(numericAmount * 100);
      const splitParticipants = chosenParts.map((p) => ({
        uid: p.uid || p.email.toLowerCase(),
        name: p.name,
      }));
      sharedParticipantUids = splitParticipants.map((p) => p.uid);

      const pctByUid: Record<string, number> = {};
      const customByUid: Record<string, number> = {};
      for (const p of chosenParts) {
        const uidKey = p.uid || p.email.toLowerCase();
        const emailKey = p.email.toLowerCase();
        pctByUid[uidKey] = participantPercentages[emailKey] ?? 0;
        const customRaw = participantCustomValues[emailKey];
        const customNum =
          customRaw !== undefined && customRaw !== ''
            ? Number(String(customRaw).replace(',', '.'))
            : 0;
        customByUid[uidKey] = Number.isFinite(customNum) ? Math.round(customNum * 100) : 0;
      }
      sharedPercentagesByUid = pctByUid;
      sharedCustomValuesCentsByUid = customByUid;

      try {
        calculateExpenseSplit({
          totalAmountCents: totalCents,
          splitMethod: spaceAllocationMode,
          participants: splitParticipants,
          percentages: pctByUid,
          customValues: customByUid,
        });
      } catch (splitErr: any) {
        setErrorMsg(splitErr?.message || 'Erro na validação matemática do rateio.');
        return;
      }
    }

    if (splitMode === 'adhoc' && type === 'expense') {
      if (customSplits.length < 2) {
        setErrorMsg(
          'Inclua pelo menos 1 participante convidado além de você no rateio avulso.'
        );
        return;
      }
      const totalCents = Math.round(numericAmount * 100);
      let sumCents = 0;
      for (const sp of customSplits) {
        if (!sp.email || !sp.email.includes('@')) {
          setErrorMsg('Todos os participantes do rateio avulso precisam de um e-mail válido.');
          return;
        }
        const shareCents = Math.round((Number(sp.responsibility) || 0) * 100);
        if (shareCents < 0) {
          setErrorMsg('A cota de um participante não pode ser negativa.');
          return;
        }
        sumCents += shareCents;
      }
      if (Math.abs(sumCents - totalCents) > 1) {
        setErrorMsg(
          `A soma das cotas (${formatCurrency(sumCents / 100)}) deve corresponder ao valor total da despesa (${formatCurrency(numericAmount)}).`
        );
        return;
      }
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

      const fallbackAccount: Account = selectedAccount || {
        id: '',
        userId,
        name: 'Espaço Compartilhado',
        type: 'checking',
        balance: 0,
        limit: 0,
        closingDay: 20,
        dueDay: 10,
        color: '#6366f1',
        icon: 'ph-users-three',
      };

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
          accountId: fallbackAccount.id,
          accountName: fallbackAccount.name,
          accountType: fallbackAccount.type,
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
        fallbackAccount,
        recurrenceType,
        parsedInstTotal
      );

      const extraPayload: UniversalTransactionExtra = {
        fixedNature,
        frequency,
        installmentOngoing,
        initialInstallmentNumber: parsedInitialInst,
        installmentAmountMode,
        installmentFundingSource:
          fallbackAccount.type === 'credit' ? 'credit_card' : 'personal_loan',
        sharedSplitMethod: isSharedExpenseLaunch ? spaceAllocationMode : undefined,
        sharedResponsibleUid: isSharedExpenseLaunch ? responsibleUid : undefined,
        sharedPayerUid: isSharedExpenseLaunch ? payerUid : undefined,
        sharedParticipantUids,
        sharedPercentagesByUid,
        sharedCustomValuesCentsByUid,
        notes: notes.trim() || undefined,
      };

      await onSaveSeries(series, editingTransaction, cascadeMode, extraPayload);

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
    } catch (err: any) {
      setErrorMsg(err?.message || 'Erro ao salvar lançamento. Verifique os dados e tente novamente.');
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
      <div className="w-full max-w-2xl bg-slate-800 border-t sm:border border-slate-700 rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col max-h-[95dvh] sm:max-h-[90dvh] overflow-hidden">
        <div className="shrink-0 flex items-center justify-between px-5 sm:px-6 md:px-8 pt-5 pb-4 border-b border-slate-700/80 bg-slate-800">
          <div className="min-w-0 pr-3">
            <h2 className="text-base sm:text-lg font-bold text-white truncate">
              {editingTransaction
                ? 'Editar Lançamento Financeiro'
                : 'Novo Lançamento Universal'}
            </h2>
            <p className="text-[11px] sm:text-xs text-slate-400">
              Configure recorrência, projeção de fatura, datas de competência e divisão colaborativa.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar formulário"
            className="w-9 h-9 rounded-xl bg-slate-700/60 text-slate-400 hover:text-white flex items-center justify-center shrink-0 cursor-pointer"
          >
            <i className="ph-bold ph-x"></i>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <div className="flex-1 overflow-y-auto overscroll-contain px-5 sm:px-6 md:px-8 py-4 space-y-5">
            {errorMsg && (
              <div className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300 flex items-center gap-2">
                <i className="ph-fill ph-warning-circle text-base shrink-0"></i>
                <span>{errorMsg}</span>
              </div>
            )}
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
                {splitMode === 'space' && type === 'expense'
                  ? 'Conta / Cartão (Opcional para Espaço)'
                  : 'Conta Bancária ou Cartão de Crédito'}
              </label>
              <select
                id="tx-account"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white"
              >
                {splitMode === 'space' && type === 'expense' && (
                  <option value="">Sem conta individual (Gerido no Espaço)</option>
                )}
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

          <div>
            <label
              htmlFor="tx-notes"
              className="block text-xs font-medium text-slate-300 mb-1"
            >
              Observações / Detalhes (Opcional)
            </label>
            <input
              id="tx-notes"
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anotações, número da nota, referência ou lembrete..."
              className="w-full px-3.5 py-2 bg-slate-900 border border-slate-700 rounded-xl text-xs sm:text-sm text-white"
            />
          </div>

          {showNewCatForm && (
            <div className="p-4 rounded-2xl bg-slate-900 border border-slate-700 space-y-3">
              <div className="text-xs font-semibold text-slate-200">
                Nova Categoria Customizada (Ícone & Cor)
              </div>
              <div className="space-y-3">
                <input
                  type="text"
                  value={newCatName}
                  onChange={(e) => setNewCatName(e.target.value)}
                  placeholder="Nome da categoria"
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white"
                />
                <IconGridPicker
                  label="Ícone da Categoria"
                  value={newCatIcon}
                  onChange={setNewCatIcon}
                  compact
                />
                <ColorPalettePicker
                  label="Cor da Categoria"
                  value={newCatColor}
                  onChange={setNewCatColor}
                  mode="token"
                />
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

            {recurrenceType === 'fixed' && !editingTransaction && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-slate-800">
                <div>
                  <label htmlFor="tx-fixed-nature" className="block text-[11px] text-slate-400 mb-1">
                    Natureza da Recorrência
                  </label>
                  <select
                    id="tx-fixed-nature"
                    value={fixedNature}
                    onChange={(e) => setFixedNature(e.target.value as 'fixed' | 'recurring')}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white"
                  >
                    <option value="fixed">Fixo Mensal (Aluguel, Salário, Escola)</option>
                    <option value="recurring">Recorrente / Assinatura (Streaming, Conta)</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="tx-frequency" className="block text-[11px] text-slate-400 mb-1">
                    Frequência de Geração
                  </label>
                  <select
                    id="tx-frequency"
                    value={frequency}
                    onChange={(e) => setFrequency(e.target.value as 'monthly' | 'weekly' | 'yearly')}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white"
                  >
                    <option value="monthly">Mensal</option>
                    <option value="weekly">Semanal</option>
                    <option value="yearly">Anual</option>
                  </select>
                </div>
              </div>
            )}

            {recurrenceType === 'installment' && !editingTransaction && (
              <div className="space-y-3 pt-2 border-t border-slate-800">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label htmlFor="tx-installments" className="text-xs text-slate-300">
                    Número Total de Parcelas (2x a 48x):
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

                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={installmentOngoing}
                    onChange={(e) => setInstallmentOngoing(e.target.checked)}
                    className="rounded border-slate-600 bg-slate-800 text-indigo-500 focus:ring-indigo-500"
                  />
                  <span>Parcelamento já está em andamento (parcela atual &gt; 1)</span>
                </label>

                {installmentOngoing && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 rounded-xl bg-slate-800/80 border border-slate-700/70">
                    <div>
                      <label htmlFor="tx-inst-current" className="block text-[11px] text-slate-400 mb-1">
                        Parcela atual (ex: 4)
                      </label>
                      <input
                        id="tx-inst-current"
                        type="number"
                        min={2}
                        max={Math.max(2, Number(installmentTotal) || 48)}
                        value={initialInstallmentNumber}
                        onChange={(e) => setInitialInstallmentNumber(e.target.value)}
                        className="w-full px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-xl text-xs text-white font-mono"
                      />
                    </div>
                    <div>
                      <label htmlFor="tx-inst-mode" className="block text-[11px] text-slate-400 mb-1">
                        O valor informado acima refere-se ao:
                      </label>
                      <select
                        id="tx-inst-mode"
                        value={installmentAmountMode}
                        onChange={(e) =>
                          setInstallmentAmountMode(e.target.value as 'remaining' | 'total')
                        }
                        className="w-full px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-xl text-xs text-white"
                      >
                        <option value="remaining">Saldo restante a pagar</option>
                        <option value="total">Valor total original da compra</option>
                      </select>
                    </div>
                  </div>
                )}

                <div className="text-[11px] text-slate-400 flex flex-wrap items-center justify-between gap-2">
                  <span>
                    Origem:{' '}
                    <strong className="text-slate-200">
                      {selectedAccount?.type === 'credit'
                        ? `Cartão de Crédito (${selectedAccount.name})`
                        : 'Empréstimo / Carnê / Débito'}
                    </strong>
                  </span>
                  {Number(amount) > 0 && Number(installmentTotal) >= 2 && (
                    <span className="font-mono text-indigo-300">
                      {installmentOngoing
                        ? `${Math.max(1, (Number(installmentTotal) || 2) - (Math.max(2, Number(initialInstallmentNumber) || 2)) + 1)} parcelas restantes (~${formatCurrency(
                            Number(amount) /
                              (installmentAmountMode === 'remaining'
                                ? Math.max(1, (Number(installmentTotal) || 2) - (Math.max(2, Number(initialInstallmentNumber) || 2)) + 1)
                                : Number(installmentTotal) || 2)
                          )}/mês)`
                        : `${Number(installmentTotal)}x de ${formatCurrency(
                            Number(amount) / (Number(installmentTotal) || 2)
                          )}`}
                    </span>
                  )}
                </div>
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

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="tx-space-responsible"
                      className="block text-xs text-slate-400 mb-1"
                    >
                      Responsável pela Validação
                    </label>
                    <select
                      id="tx-space-responsible"
                      value={responsibleUid}
                      onChange={(e) => setResponsibleUid(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white"
                    >
                      {(selectedSpace?.participants || []).map((p) => {
                        const val = p.uid || p.email.toLowerCase();
                        return (
                          <option key={val} value={val}>
                            {p.name} ({p.email})
                          </option>
                        );
                      })}
                    </select>
                  </div>
                  <div>
                    <label
                      htmlFor="tx-space-payer"
                      className="block text-xs text-slate-400 mb-1"
                    >
                      Pagador / Origem do Desembolso
                    </label>
                    <select
                      id="tx-space-payer"
                      value={payerUid}
                      onChange={(e) => setPayerUid(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white"
                    >
                      {(selectedSpace?.participants || []).map((p) => {
                        const val = p.uid || p.email.toLowerCase();
                        return (
                          <option key={val} value={val}>
                            {p.name} ({p.email})
                          </option>
                        );
                      })}
                    </select>
                  </div>
                </div>

                {selectedSpace && selectedSpace.participants.length > 0 && (
                  <div className="space-y-1.5">
                    <span className="block text-[11px] font-medium text-slate-400">
                      Participantes incluídos no rateio:
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {selectedSpace.participants.map((p) => {
                        const em = p.email.toLowerCase();
                        const checked = includedSpaceMemberEmails.includes(em);
                        return (
                          <label
                            key={em}
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs cursor-pointer transition-colors ${
                              checked
                                ? 'bg-indigo-600/20 border-indigo-500/60 text-indigo-200'
                                : 'bg-slate-800 border-slate-700 text-slate-400'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setIncludedSpaceMemberEmails((prev) =>
                                    Array.from(new Set([...prev, em]))
                                  );
                                } else if (includedSpaceMemberEmails.length > 1) {
                                  setIncludedSpaceMemberEmails((prev) =>
                                    prev.filter((item) => item !== em)
                                  );
                                }
                              }}
                              className="rounded border-slate-600 bg-slate-900 text-indigo-500"
                            />
                            <span>{p.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Regra de Rateio: Divisão Igual (Padrão), Por Percentual (%) ou Personalizado (R$) */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-1">
                  <span className="text-xs font-semibold text-slate-300">
                    Regra de Rateio entre os Participantes:
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5 bg-slate-800 p-1 rounded-xl border border-slate-700">
                    <button
                      type="button"
                      onClick={() => setSpaceAllocationMode('equal')}
                      className={`px-3 py-1 rounded-lg text-xs font-semibold cursor-pointer ${
                        spaceAllocationMode === 'equal'
                          ? 'bg-indigo-600 text-white'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      Divisão Igual
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
                    <button
                      type="button"
                      onClick={() => setSpaceAllocationMode('custom_value')}
                      className={`px-3 py-1 rounded-lg text-xs font-semibold cursor-pointer ${
                        spaceAllocationMode === 'custom_value'
                          ? 'bg-indigo-600 text-white'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      Personalizado (R$)
                    </button>
                  </div>
                </div>
              </div>
            )}

            {type === 'expense' && splitMode === 'adhoc' && (
              <div className="space-y-3">
                <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/25 text-[11px] text-amber-200 leading-relaxed">
                  <strong>Rateio avulso entre contas pessoais:</strong> os convidados recebem a obrigação no Inbox e no Extrato após confirmar. O aceite confirma apenas a cota-parte — não liquida nem marca a despesa como paga automaticamente.
                </div>
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
                      : splitMode === 'space' && spaceAllocationMode === 'custom_value'
                      ? 'Valor Fixo (R$) · Desembolso'
                      : 'Cota na Despesa (R$) · Desembolso Direto (R$)'}
                  </span>
                </div>
                {customSplits.map((sp, idx) => {
                  const emailKey = sp.email.toLowerCase();
                  const pctVal =
                    participantPercentages[emailKey] ??
                    Number((100 / Math.max(1, customSplits.length)).toFixed(2));
                  const customValStr = participantCustomValues[emailKey] ?? '';
                  const isCurrentOwner = sp.email.toLowerCase() === userEmail.toLowerCase();
                  return (
                    <div
                      key={sp.email}
                      className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-2.5 rounded-xl bg-slate-800/90 border border-slate-700/60 text-xs"
                    >
                      <div className="min-w-0">
                        <span className="font-semibold text-white">{sp.name}</span>
                        <span className="text-slate-400 ml-1.5 text-[11px] break-all">
                          ({sp.email})
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
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

                        {splitMode === 'space' && spaceAllocationMode === 'custom_value' && (
                          <>
                            <label className="text-[11px] text-amber-300 font-semibold">
                              Valor R$:
                            </label>
                            <input
                              type="number"
                              step="0.01"
                              min={0}
                              aria-label={`Valor personalizado de ${sp.name}`}
                              value={customValStr}
                              placeholder={String(sp.responsibility)}
                              onChange={(e) => {
                                const nextVal = e.target.value;
                                setParticipantCustomValues((prev) => ({
                                  ...prev,
                                  [emailKey]: nextVal,
                                }));
                              }}
                              className="w-24 px-2 py-1 bg-slate-900 border border-amber-500/50 rounded-lg text-xs text-amber-200 font-mono text-right"
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
                            const nextNum = Number(e.target.value) || 0;
                            if (splitMode === 'space' && spaceAllocationMode === 'custom_value') {
                              setParticipantCustomValues((prev) => ({
                                ...prev,
                                [emailKey]: e.target.value,
                              }));
                            }
                            const updated = [...customSplits];
                            updated[idx] = {
                              ...updated[idx],
                              responsibility: nextNum,
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
                        {splitMode === 'adhoc' && !isCurrentOwner && (
                          <button
                            type="button"
                            onClick={() => handleRemoveAdhocParticipant(sp.email)}
                            title={`Remover ${sp.name}`}
                            aria-label={`Remover ${sp.name}`}
                            className="p-1.5 rounded-lg bg-slate-900 hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 border border-slate-700 cursor-pointer"
                          >
                            <i className="ph-bold ph-trash text-xs"></i>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          </div>

          <div className="shrink-0 px-5 sm:px-6 md:px-8 py-3.5 pb-[calc(0.875rem+env(safe-area-inset-bottom))] border-t border-slate-700/80 bg-slate-800/95 flex items-center justify-end gap-3">
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
              className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white shadow-lg shadow-indigo-600/25 cursor-pointer disabled:opacity-60"
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
