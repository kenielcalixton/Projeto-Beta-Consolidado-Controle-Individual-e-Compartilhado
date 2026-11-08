import React, { useEffect, useState } from 'react';
import {
  AcquisitionItem,
  AcquisitionList,
  UserProfile,
  Workspace,
} from '../../types/acquisitions';
import {
  filterAcceptedWorkspaces,
  filterPendingInvitations,
  formatCurrencyBRL,
  isStockCritical,
} from '../../utils/stateMachine';
import { ResponsiveSheetModal } from './ResponsiveSheetModal';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Edit3,
  FolderKanban,
  MailOpen,
  ShoppingCart,
  Target,
  User,
  X,
} from 'lucide-react';

interface DashboardOverviewViewProps {
  workspaces: Workspace[];
  lists: AcquisitionList[];
  items: AcquisitionItem[];
  currentUser: UserProfile;
  onUpdateUserName: (newName: string) => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onNavigateToWorkspaces: () => void;
  onAcceptInvitation: (workspaceId: string) => void;
  onRejectInvitation: (workspaceId: string, reason: string, note: string) => void;
}

const REJECTION_REASONS = [
  'Orçamento separado neste período',
  'Não participarei deste projeto / evento',
  'Convite duplicado ou e-mail incorreto',
  'Priorizando outras metas financeiras',
  'Outro motivo específico',
];

export const DashboardOverviewView: React.FC<DashboardOverviewViewProps> = ({
  workspaces,
  lists,
  items,
  currentUser,
  onUpdateUserName,
  onSelectWorkspace,
  onNavigateToWorkspaces,
  onAcceptInvitation,
  onRejectInvitation,
}) => {
  const acceptedWorkspaces = filterAcceptedWorkspaces(
    workspaces,
    currentUser.email,
    currentUser.uid
  );
  const pendingInvitations = filterPendingInvitations(workspaces, currentUser.email);

  // Quick User Name Edit State
  const emailPrefix = currentUser.email.split('@')[0];
  const hasCustomName =
    Boolean(currentUser.displayName?.trim()) &&
    currentUser.displayName.trim().toLowerCase() !== emailPrefix.toLowerCase();

  const [isEditingName, setIsEditingName] = useState<boolean>(!currentUser.displayName?.trim());
  const [nameInput, setNameInput] = useState<string>(currentUser.displayName || '');

  useEffect(() => {
    setNameInput(currentUser.displayName || '');
  }, [currentUser.displayName]);

  const handleSaveName = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = nameInput.trim();
    if (!cleaned) return;
    onUpdateUserName(cleaned);
    setIsEditingName(false);
  };

  // Reject Invitation Modal State
  const [rejectingWs, setRejectingWs] = useState<Workspace | null>(null);
  const [selectedReason, setSelectedReason] = useState(REJECTION_REASONS[0]);
  const [rejectionNote, setRejectionNote] = useState('');

  const handleConfirmReject = (e: React.FormEvent) => {
    e.preventDefault();
    if (!rejectingWs) return;
    onRejectInvitation(rejectingWs.id, selectedReason, rejectionNote.trim());
    setRejectingWs(null);
    setRejectionNote('');
  };

  // Global KPIs for Accepted Workspaces
  const acceptedWsIds = new Set(acceptedWorkspaces.map((w) => w.id));
  const accessibleItems = items.filter((i) => acceptedWsIds.has(i.workspaceId));

  const criticalStockItems = accessibleItems.filter(
    (i) => i.listType === 'recorrente' && i.stage === 'estoque' && isStockCritical(i)
  );

  const activeCartItems = accessibleItems.filter(
    (i) => i.listType === 'recorrente' && i.stage === 'carrinho'
  );
  const activeCartTotal = activeCartItems.reduce(
    (sum, i) => sum + (i.cartDraft?.unitPrice ?? 0) * (i.cartDraft?.quantity ?? 1),
    0
  );

  const goalItems = accessibleItems.filter((i) => i.listType === 'objetivo');
  const totalGoalSaved = goalItems.reduce((sum, i) => sum + (i.savedAmount ?? 0), 0);

  return (
    <div className="space-y-10">
      {/* Header with User Greeting & Quick Name Edit */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 border-b border-slate-200 dark:border-slate-800 pb-6">
        <div className="space-y-2">
          {/* User Identity / Greeting Bar */}
          {isEditingName ? (
            <form
              onSubmit={handleSaveName}
              className="flex flex-wrap items-center gap-2 bg-indigo-50/70 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800/70 rounded-xl px-3.5 py-2 max-w-xl"
            >
              <User className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
              <label htmlFor="dashboard-user-name" className="text-xs font-medium text-slate-700 dark:text-slate-300">
                Seu nome:
              </label>
              <input
                id="dashboard-user-name"
                type="text"
                required
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder="Como você prefere ser chamado?"
                className="flex-1 min-w-[180px] px-2.5 py-1 text-xs rounded-lg border border-indigo-300 dark:border-indigo-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <button
                type="submit"
                className="px-3 py-1 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors flex items-center gap-1 cursor-pointer"
              >
                <Check className="w-3.5 h-3.5" />
                <span>Salvar</span>
              </button>
              {Boolean(currentUser.displayName?.trim()) && (
                <button
                  type="button"
                  onClick={() => {
                    setNameInput(currentUser.displayName);
                    setIsEditingName(false);
                  }}
                  className="px-2 py-1 text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer"
                >
                  Cancelar
                </button>
              )}
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
              <span className="font-semibold text-indigo-600 dark:text-indigo-400 flex items-center gap-1.5">
                <User className="w-3.5 h-3.5" />
                <span>
                  Olá, {currentUser.displayName || emailPrefix}
                </span>
              </span>
              <span aria-hidden="true">·</span>
              <span>{currentUser.email}</span>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={() => setIsEditingName(true)}
                className="text-indigo-600 dark:text-indigo-400 hover:underline font-medium inline-flex items-center gap-1 cursor-pointer"
              >
                <Edit3 className="w-3 h-3" />
                <span>{hasCustomName ? 'Editar nome' : 'Definir meu nome'}</span>
              </button>
            </div>
          )}

          <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100 font-display">
            Dashboard de Aquisições
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 max-w-2xl">
            Acompanhe alertas de estoque baixo, valores no carrinho, progresso das metas financeiras e convites recebidos.
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onNavigateToWorkspaces}
            className="min-h-[44px] px-5 py-2.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-xl transition-colors flex items-center gap-2 whitespace-nowrap shadow-xs cursor-pointer"
          >
            <FolderKanban className="w-4 h-4" />
            <span>Ver Meus Espaços ({acceptedWorkspaces.length})</span>
          </button>
        </div>
      </div>

      {/* KPI Strip (Alertas, Carrinho e Poupança) */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 flex items-center justify-between">
          <div>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Alertas de Estoque Mínimo
            </span>
            <p className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-1">
              {criticalStockItems.length}{' '}
              <span className="text-xs font-normal text-rose-600 dark:text-rose-400">
                itens em falta
              </span>
            </p>
          </div>
          <div className="w-10 h-10 rounded-xl bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 flex items-center justify-between">
          <div>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Em Carrinho de Compras
            </span>
            <p className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-1">
              {formatCurrencyBRL(activeCartTotal)}
            </p>
          </div>
          <div className="w-10 h-10 rounded-xl bg-amber-50 dark:bg-amber-950/50 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
            <ShoppingCart className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 flex items-center justify-between">
          <div>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Total Guardado em Objetivos
            </span>
            <p className="text-2xl font-bold font-mono tabular-nums text-emerald-600 dark:text-emerald-400 mt-1">
              {formatCurrencyBRL(totalGoalSaved)}
            </p>
          </div>
          <div className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
            <Target className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Pending Invitations Management Section */}
      <section aria-labelledby="invitations-heading" className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MailOpen className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <h2
              id="invitations-heading"
              className="text-base font-bold text-slate-900 dark:text-slate-100 font-display"
            >
              Convites Recebidos Pendentes
            </h2>
            <span className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
              ({pendingInvitations.length})
            </span>
          </div>
        </div>

        {pendingInvitations.length === 0 ? (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 text-xs text-slate-500 dark:text-slate-400 flex items-center justify-between">
            <span>
              Você não possui convites pendentes para outros espaços no momento.
            </span>
            <span className="text-slate-400">Convites em dia</span>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {pendingInvitations.map((invWs) => (
              <div
                key={invWs.id}
                className="bg-white dark:bg-slate-900 border border-indigo-200 dark:border-indigo-900/60 rounded-2xl p-5 flex flex-col justify-between gap-4"
              >
                <div>
                  <div className="flex items-center gap-2 text-xs text-indigo-600 dark:text-indigo-400 font-medium">
                    <span>Convite para Espaço Compartilhado</span>
                    <span aria-hidden="true">·</span>
                    <span>Enviado por {invWs.ownerEmail}</span>
                  </div>
                  <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 font-display mt-1">
                    {invWs.name}
                  </h3>
                  <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
                    {invWs.description}
                  </p>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-100 dark:border-slate-800">
                  <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                    Orçamento estimado: {formatCurrencyBRL(invWs.monthlyBudget)}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setRejectingWs(invWs)}
                      aria-label={`Recusar convite para ${invWs.name}`}
                      className="min-h-[40px] px-3.5 py-2 text-xs font-medium text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/50 hover:bg-rose-100 dark:hover:bg-rose-900/60 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                      <span>Recusar</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onAcceptInvitation(invWs.id)}
                      aria-label={`Aceitar convite para ${invWs.name}`}
                      className="min-h-[40px] px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>Aceitar Convite</span>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Critical Stock & Active Goals Quick Access */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Critical Stock Items Card */}
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-slate-900 dark:text-slate-100 font-display flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400" />
              <span>Itens com Alerta de Estoque Mínimo</span>
            </h2>
            <span className="text-xs font-mono text-slate-500">
              {criticalStockItems.length} item(ns)
            </span>
          </div>

          {criticalStockItems.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400 py-4">
              Todos os itens recorrentes estão com estoque acima da mínima configurada.
            </p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {criticalStockItems.map((item) => {
                const ws = workspaces.find((w) => w.id === item.workspaceId);
                const lst = lists.find((l) => l.id === item.listId);
                return (
                  <div
                    key={item.id}
                    className="py-3 flex items-center justify-between gap-4 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                        {item.name}
                      </p>
                      <p className="text-slate-500 dark:text-slate-400 truncate">
                        {ws?.name} · {lst?.name}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="font-mono font-semibold text-rose-600 dark:text-rose-400 tabular-nums">
                        {item.currentStock ?? 0} / mín. {item.minStock ?? 1} {item.unit || 'un'}
                      </span>
                      <button
                        type="button"
                        onClick={() => onSelectWorkspace(item.workspaceId)}
                        className="px-3 py-1.5 font-semibold rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-indigo-600 hover:text-white text-slate-700 dark:text-slate-200 transition-colors flex items-center gap-1 whitespace-nowrap cursor-pointer"
                      >
                        <span>Abrir</span>
                        <ArrowRight className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Active Goals Summary */}
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-slate-900 dark:text-slate-100 font-display flex items-center gap-2">
              <Target className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              <span>Metas & Objetivos em Andamento</span>
            </h2>
            <span className="text-xs font-mono text-slate-500">
              {goalItems.length} meta(s)
            </span>
          </div>

          {goalItems.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400 py-4">
              Nenhum objetivo financeiro cadastrado nos seus espaços.
            </p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {goalItems.slice(0, 4).map((item) => {
                const ws = workspaces.find((w) => w.id === item.workspaceId);
                return (
                  <div
                    key={item.id}
                    className="py-3 flex items-center justify-between gap-4 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                        {item.name}
                      </p>
                      <p className="text-slate-500 dark:text-slate-400 truncate">
                        {ws?.name} · Etapa: <span className="capitalize">{item.stage}</span>
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">
                        {formatCurrencyBRL(item.savedAmount)} / {formatCurrencyBRL(item.targetAmount)}
                      </span>
                      <button
                        type="button"
                        onClick={() => onSelectWorkspace(item.workspaceId)}
                        className="px-3 py-1.5 font-semibold rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-indigo-600 hover:text-white text-slate-700 dark:text-slate-200 transition-colors flex items-center gap-1 whitespace-nowrap cursor-pointer"
                      >
                        <span>Abrir</span>
                        <ArrowRight className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* Modal: Reject Invitation with Reason and Observation */}
      <ResponsiveSheetModal
        isOpen={Boolean(rejectingWs)}
        onClose={() => setRejectingWs(null)}
        title="Recusar Convite de Espaço"
        subtitle={
          rejectingWs
            ? `Informe o motivo e uma observação para recusar "${rejectingWs.name}".`
            : ''
        }
      >
        <form onSubmit={handleConfirmReject} className="space-y-4">
          <div>
            <label
              htmlFor="reject-reason-select"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
            >
              Motivo da Recusa
            </label>
            <select
              id="reject-reason-select"
              value={selectedReason}
              onChange={(e) => setSelectedReason(e.target.value)}
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            >
              {REJECTION_REASONS.map((reason) => (
                <option key={reason} value={reason}>
                  {reason}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="reject-note-textarea"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
            >
              Observação Adicional (visível para quem convidou)
            </label>
            <textarea
              id="reject-note-textarea"
              rows={3}
              required
              value={rejectionNote}
              onChange={(e) => setRejectionNote(e.target.value)}
              placeholder="Ex: Neste mês estou focado na reserva de emergência pessoal, obrigado pelo convite!"
              className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
          </div>

          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setRejectingWs(null)}
              className="px-4 py-2 text-xs font-medium text-slate-600 dark:text-slate-400"
            >
              Voltar
            </button>
            <button
              type="submit"
              className="px-5 py-2.5 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-lg transition-colors"
            >
              Confirmar Recusa
            </button>
          </div>
        </form>
      </ResponsiveSheetModal>
    </div>
  );
};
