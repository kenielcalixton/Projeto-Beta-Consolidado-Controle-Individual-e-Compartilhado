import React, { useEffect, useState } from 'react';
import { CascadeMode, Space, Transaction } from '../types/finance';
import { formatCurrency, getTodayDateString } from '../utils/financeEngine';

interface ConfirmSettlementModalProps {
  isOpen: boolean;
  transaction: Transaction | null;
  space?: Space | null;
  userEmail: string;
  defaultSpaceMode?: 'space_cash' | 'member_direct';
  onClose: () => void;
  onConfirm: (params: {
    tx: Transaction;
    confirmedAmount: number;
    paymentDate: string;
    cascadeMode: CascadeMode;
    spaceSettleMode?: 'space_cash' | 'member_direct';
    payerEmail?: string;
  }) => Promise<void>;
}

export const ConfirmSettlementModal: React.FC<ConfirmSettlementModalProps> = ({
  isOpen,
  transaction,
  space,
  userEmail,
  defaultSpaceMode = 'space_cash',
  onClose,
  onConfirm,
}) => {
  const [confirmedAmountStr, setConfirmedAmountStr] = useState('');
  const [paymentDate, setPaymentDate] = useState(getTodayDateString());
  const [cascadeMode, setCascadeMode] = useState<CascadeMode>('only_this');
  const [spaceSettleMode, setSpaceSettleMode] = useState<
    'space_cash' | 'member_direct'
  >(defaultSpaceMode);
  const [payerEmail, setPayerEmail] = useState(userEmail);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !transaction) return;
    setConfirmedAmountStr(String(transaction.amount));
    setPaymentDate(transaction.paymentDate || getTodayDateString());
    setCascadeMode('only_this');
    setSpaceSettleMode(defaultSpaceMode);
    setPayerEmail(
      transaction.paidByEmail && transaction.paidByEmail !== 'space_cash'
        ? transaction.paidByEmail
        : userEmail
    );
    setErrorMsg(null);
  }, [isOpen, transaction, defaultSpaceMode, userEmail]);

  useEffect(() => {
    if (!isOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen]);

  if (!isOpen || !transaction) return null;

  const isIncome = transaction.type === 'income';
  const isSpaceTx = Boolean(transaction.spaceId && transaction.spaceId.trim());
  const isSeries = transaction.recurrenceType !== 'single';
  const numericAmount = Number(confirmedAmountStr);
  const amountChanged =
    Number.isFinite(numericAmount) &&
    Math.abs(numericAmount - transaction.amount) > 0.009;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setErrorMsg('Informe um valor válido maior que zero.');
      return;
    }
    if (!paymentDate.trim()) {
      setErrorMsg(
        isIncome
          ? 'Informe a data de efetivação da receita.'
          : 'Informe a data do pagamento da despesa.'
      );
      return;
    }

    setSubmitting(true);
    try {
      await onConfirm({
        tx: transaction,
        confirmedAmount: Number(numericAmount.toFixed(2)),
        paymentDate,
        cascadeMode,
        spaceSettleMode: isSpaceTx && !isIncome ? spaceSettleMode : undefined,
        payerEmail:
          isSpaceTx && !isIncome
            ? spaceSettleMode === 'space_cash'
              ? 'space_cash'
              : payerEmail
            : transaction.paidByEmail || userEmail,
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={
        isIncome
          ? `Validar e Efetivar Receita: ${transaction.description}`
          : `Validar e Registrar Pagamento: ${transaction.description}`
      }
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-slate-800 border border-slate-700 rounded-3xl p-6 shadow-2xl space-y-4 max-h-[92dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div
              className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 border ${
                isIncome
                  ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
                  : 'bg-indigo-500/15 border-indigo-500/30 text-indigo-400'
              }`}
            >
              <i
                className={`ph-fill ${
                  isIncome ? 'ph-hand-coins' : 'ph-check-circle'
                } text-2xl`}
              ></i>
            </div>
            <div>
              <span
                className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md ${
                  isIncome
                    ? 'bg-emerald-500/20 text-emerald-300'
                    : 'bg-indigo-500/20 text-indigo-300'
                }`}
              >
                {isIncome
                  ? 'Efetivação de Receita'
                  : 'Confirmação de Pagamento'}
              </span>
              <h3 className="text-base font-bold text-white mt-1">
                {transaction.description}
              </h3>
              <p className="text-xs text-slate-400">
                {transaction.spaceName
                  ? `Espaço: ${transaction.spaceName} (${transaction.invoiceMonth})`
                  : `Escopo Individual (${transaction.invoiceMonth})`}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar validação de valor"
            className="w-8 h-8 rounded-xl bg-slate-700/70 text-slate-400 hover:text-white flex items-center justify-center cursor-pointer shrink-0"
          >
            <i className="ph-bold ph-x"></i>
          </button>
        </div>

        <div className="p-3.5 rounded-2xl bg-slate-900/90 border border-slate-700/80 text-xs text-slate-300">
          {isIncome ? (
            <span>
              Confirme se o valor que entrou foi exatamente{' '}
              <strong className="text-emerald-300 font-mono">
                {formatCurrency(transaction.amount)}
              </strong>{' '}
              ou ajuste abaixo caso o valor efetivado tenha sido diferente.
            </span>
          ) : (
            <span>
              Confirme se o valor pago nesta despesa foi{' '}
              <strong className="text-white font-mono">
                {formatCurrency(transaction.amount)}
              </strong>{' '}
              ou ajuste o valor real pago antes de dar baixa.
            </span>
          )}
        </div>

        {errorMsg && (
          <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
            {errorMsg}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="confirm-settlement-amount"
                className="block text-xs font-semibold text-slate-200 mb-1"
              >
                {isIncome ? 'Valor Real Recebido (R$)' : 'Valor Real Pago (R$)'}
              </label>
              <input
                id="confirm-settlement-amount"
                type="number"
                step="0.01"
                value={confirmedAmountStr}
                onChange={(e) => setConfirmedAmountStr(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-slate-900 border border-emerald-500/50 rounded-xl text-sm text-white font-mono font-bold focus:outline-none focus:border-emerald-400"
              />
              {amountChanged && (
                <span className="text-[11px] text-amber-300 font-mono block mt-1">
                  Anterior: {formatCurrency(transaction.amount)} → Novo:{' '}
                  {formatCurrency(numericAmount)}
                </span>
              )}
            </div>

            <div>
              <label
                htmlFor="confirm-settlement-date"
                className="block text-xs font-semibold text-slate-200 mb-1"
              >
                {isIncome ? 'Data da Efetivação' : 'Data do Pagamento'}
              </label>
              <input
                id="confirm-settlement-date"
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-xs text-white font-mono"
              />
            </div>
          </div>

          {/* Se for Despesa em Espaço Compartilhado, permite escolher se foi paga pelo Caixa do Espaço ou por Membro */}
          {isSpaceTx && !isIncome && (
            <div className="p-3.5 rounded-2xl bg-slate-900/80 border border-slate-700/70 space-y-2.5">
              <label className="block text-xs font-semibold text-slate-200">
                Como esta despesa do espaço foi paga?
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setSpaceSettleMode('space_cash')}
                  className={`py-2 px-2.5 rounded-xl text-xs font-semibold border cursor-pointer flex items-center justify-center gap-1.5 ${
                    spaceSettleMode === 'space_cash'
                      ? 'bg-emerald-600/20 border-emerald-500 text-emerald-300'
                      : 'bg-slate-800 border-slate-700 text-slate-400'
                  }`}
                >
                  <i className="ph-bold ph-vault"></i>
                  <span>Caixa do Espaço</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSpaceSettleMode('member_direct')}
                  className={`py-2 px-2.5 rounded-xl text-xs font-semibold border cursor-pointer flex items-center justify-center gap-1.5 ${
                    spaceSettleMode === 'member_direct'
                      ? 'bg-indigo-600/20 border-indigo-500 text-indigo-300'
                      : 'bg-slate-800 border-slate-700 text-slate-400'
                  }`}
                >
                  <i className="ph-bold ph-user-check"></i>
                  <span>Pago por Membro</span>
                </button>
              </div>

              {spaceSettleMode === 'member_direct' && space && (
                <div className="pt-1">
                  <label
                    htmlFor="confirm-space-payer"
                    className="block text-[11px] text-slate-400 mb-1"
                  >
                    Qual participante pagou do próprio bolso?
                  </label>
                  <select
                    id="confirm-space-payer"
                    value={payerEmail}
                    onChange={(e) => setPayerEmail(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white"
                  >
                    {space.participants.map((p) => (
                      <option key={p.email} value={p.email}>
                        {p.name} ({p.email})
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {/* Se for lançamento Fixo ou Parcelado, pergunta se aplica apenas a este mês ou seguintes */}
          {isSeries && (
            <div className="p-3.5 rounded-2xl bg-slate-900/80 border border-indigo-500/30 space-y-2">
              <label
                htmlFor="confirm-cascade-mode"
                className="block text-xs font-semibold text-indigo-300"
              >
                Lançamento {transaction.recurrenceType === 'fixed' ? 'Fixo Mensal' : 'Parcelado'}: Onde aplicar?
              </label>
              <select
                id="confirm-cascade-mode"
                value={cascadeMode}
                onChange={(e) => setCascadeMode(e.target.value as CascadeMode)}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white"
              >
                <option value="only_this">
                  Somente neste mês ({transaction.invoiceMonth}) — não impacta outros meses
                </option>
                <option value="this_and_following">
                  Neste mês ({transaction.invoiceMonth}) e nos seguintes (apenas o valor; pagamento só neste mês)
                </option>
                <option value="all">
                  Em toda a série (apenas o valor; pagamento só neste mês)
                </option>
              </select>
            </div>
          )}

          <div className="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-200 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-bold text-white shadow-lg shadow-emerald-600/25 flex items-center gap-1.5 cursor-pointer"
            >
              <i className="ph-bold ph-check-circle text-sm"></i>
              <span>
                {isIncome
                  ? 'Confirmar Valor & Efetivar Receita'
                  : 'Confirmar Valor & Registrar Pagamento'}
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
