import React, { useState } from 'react';
import {
  AcquisitionItem,
  AcquisitionList,
  UserProfile,
  Workspace,
} from '../../types/acquisitions';
import {
  filterAcceptedWorkspaces,
  formatCurrencyBRL,
} from '../../utils/stateMachine';
import { ResponsiveSheetModal } from './ResponsiveSheetModal';
import {
  ArrowRight,
  Edit3,
  FolderKanban,
  Plus,
  Trash2,
  Users,
} from 'lucide-react';

interface HubDashboardViewProps {
  workspaces: Workspace[];
  lists: AcquisitionList[];
  items: AcquisitionItem[];
  currentUser: UserProfile;
  onUpdateUserName: (newName: string) => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: (
    name: string,
    description: string,
    type: 'Individual' | 'Compartilhado',
    budget: number,
    invitedEmails: string[],
    creatorName?: string
  ) => void;
  onUpdateWorkspace: (
    workspaceId: string,
    name: string,
    description: string,
    type: 'Individual' | 'Compartilhado',
    budget: number
  ) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
}

export const HubDashboardView: React.FC<HubDashboardViewProps> = ({
  workspaces,
  lists,
  items,
  currentUser,
  onUpdateUserName,
  onSelectWorkspace,
  onCreateWorkspace,
  onUpdateWorkspace,
  onDeleteWorkspace,
}) => {
  // Filter workspaces where user is accepted
  const acceptedWorkspaces = filterAcceptedWorkspaces(
    workspaces,
    currentUser.email,
    currentUser.uid
  );

  // Create Workspace Modal State
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [creatorNameInput, setCreatorNameInput] = useState(currentUser.displayName || '');
  const [wsName, setWsName] = useState('');
  const [wsDesc, setWsDesc] = useState('');
  const [wsType, setWsType] = useState<'Individual' | 'Compartilhado'>('Compartilhado');
  const [wsBudget, setWsBudget] = useState('3500');
  const [wsEmailsRaw, setWsEmailsRaw] = useState('');
  const [createError, setCreateError] = useState('');

  // Edit Workspace Modal State
  const [editingWs, setEditingWs] = useState<Workspace | null>(null);
  const [editWsName, setEditWsName] = useState('');
  const [editWsDesc, setEditWsDesc] = useState('');
  const [editWsType, setEditWsType] = useState<'Individual' | 'Compartilhado'>('Compartilhado');
  const [editWsBudget, setEditWsBudget] = useState('3500');

  // Delete Confirmation Modal State
  const [deletingWs, setDeletingWs] = useState<Workspace | null>(null);

  const openCreateModal = () => {
    setCreatorNameInput(currentUser.displayName || '');
    setIsCreateOpen(true);
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!creatorNameInput.trim()) {
      setCreateError('Informe o seu nome para identificar quem está criando o espaço.');
      return;
    }
    if (!wsName.trim()) {
      setCreateError('Informe um nome para o Espaço de Trabalho.');
      return;
    }

    const cleanCreatorName = creatorNameInput.trim();
    if (cleanCreatorName !== currentUser.displayName) {
      onUpdateUserName(cleanCreatorName);
    }

    const parsedEmails = wsEmailsRaw
      .split(/[,;\n]+/)
      .map((em) => em.trim().toLowerCase())
      .filter((em) => em.includes('@') && em !== currentUser.email.toLowerCase());

    onCreateWorkspace(
      wsName.trim(),
      wsDesc.trim() || 'Espaço colaborativo de compras e metas.',
      wsType,
      Number(wsBudget) || 0,
      parsedEmails,
      cleanCreatorName
    );

    setWsName('');
    setWsDesc('');
    setWsEmailsRaw('');
    setCreateError('');
    setIsCreateOpen(false);
  };

  const openEditModal = (ws: Workspace) => {
    setEditingWs(ws);
    setEditWsName(ws.name);
    setEditWsDesc(ws.description);
    setEditWsType(ws.type);
    setEditWsBudget(String(ws.monthlyBudget ?? 0));
  };

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingWs || !editWsName.trim()) return;
    onUpdateWorkspace(
      editingWs.id,
      editWsName.trim(),
      editWsDesc.trim(),
      editWsType,
      Number(editWsBudget) || 0
    );
    setEditingWs(null);
  };

  const handleConfirmDelete = () => {
    if (!deletingWs) return;
    onDeleteWorkspace(deletingWs.id);
    setDeletingWs(null);
  };

  const userDisplay = currentUser.displayName || currentUser.email.split('@')[0];

  return (
    <div className="space-y-8">
      {/* Header focado exclusivamente em Meus Espaços */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 border-b border-slate-200 dark:border-slate-800 pb-6">
        <div>
          <p className="text-xs font-medium text-indigo-600 dark:text-indigo-400">
            Ambientes de {userDisplay} · ({currentUser.email})
          </p>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100 font-display mt-1">
            Meus Espaços
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1 max-w-2xl">
            Acesse seus ambientes de aquisição para visualizar o quadro de listas, ou crie, edite e exclua espaços de trabalho.
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={openCreateModal}
            className="min-h-[44px] px-5 py-2.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-xl transition-colors flex items-center gap-2 whitespace-nowrap shadow-xs cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Novo Espaço</span>
          </button>
        </div>
      </div>

      {/* Active Workspaces Grid (ACL Accepted) */}
      <section aria-labelledby="workspaces-grid-heading" className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderKanban className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <h2
              id="workspaces-grid-heading"
              className="text-base font-bold text-slate-900 dark:text-slate-100 font-display"
            >
              Lista de Espaços de Trabalho
            </h2>
            <span className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
              ({acceptedWorkspaces.length})
            </span>
          </div>
        </div>

        {acceptedWorkspaces.length === 0 ? (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-10 text-center space-y-3">
            <p className="text-base font-bold text-slate-800 dark:text-slate-200 font-display">
              Nenhum espaço de trabalho encontrado
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
              Crie seu primeiro espaço individual ou compartilhado para começar a organizar suas listas recorrentes, objetivos e desejos.
            </p>
            <button
              type="button"
              onClick={() => setIsCreateOpen(true)}
              className="mt-2 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg inline-flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              <span>Criar Primeiro Espaço</span>
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {acceptedWorkspaces.map((ws) => {
              const wsLists = lists.filter((l) => l.workspaceId === ws.id);
              const wsItems = items.filter((i) => i.workspaceId === ws.id);
              const acceptedMembersCount = ws.members.filter(
                (m) => m.status === 'Aceito'
              ).length;
              const pendingMembersCount = ws.members.filter(
                (m) => m.status === 'Pendente'
              ).length;

              return (
                <div
                  key={ws.id}
                  className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-indigo-400 dark:hover:border-indigo-500 rounded-2xl p-6 flex flex-col justify-between transition-colors group"
                >
                  <div className="space-y-4">
                    {/* Metadata Line + Edit/Delete Actions */}
                    <div className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-indigo-600 dark:text-indigo-400">
                          {ws.type}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">{wsLists.length} listas</span>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">{wsItems.length} itens</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums text-slate-700 dark:text-slate-300">
                          Meta: {formatCurrencyBRL(ws.monthlyBudget)}
                        </span>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => openEditModal(ws)}
                          aria-label={`Editar espaço ${ws.name}`}
                          className="min-h-[34px] min-w-[34px] flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-900 hover:bg-slate-100 dark:hover:text-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                        >
                          <Edit3 className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeletingWs(ws)}
                          aria-label={`Apagar espaço ${ws.name}`}
                          className="min-h-[34px] min-w-[34px] flex items-center justify-center rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:text-rose-400 dark:hover:bg-rose-950/40 transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    <div>
                      <h3 className="text-xl font-bold text-slate-900 dark:text-slate-100 font-display group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                        {ws.name}
                      </h3>
                      <p className="text-xs text-slate-600 dark:text-slate-400 mt-1.5 leading-relaxed">
                        {ws.description}
                      </p>
                    </div>

                    {/* Lists preview inside workspace */}
                    <div className="pt-2 space-y-1.5">
                      {wsLists.slice(0, 3).map((l) => (
                        <div
                          key={l.id}
                          className="flex items-center justify-between text-xs py-1.5 border-b border-slate-100 dark:border-slate-800/70 last:border-b-0"
                        >
                          <span className="text-slate-700 dark:text-slate-300 font-medium truncate">
                            {l.name}
                          </span>
                          <span className="text-slate-400 dark:text-slate-500 capitalize shrink-0">
                            {l.type}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Card Footer */}
                  <div className="pt-5 mt-5 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <Users className="w-4 h-4 text-slate-400" />
                      <span className="tabular-nums">
                        {acceptedMembersCount} aceitos
                      </span>
                      {pendingMembersCount > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-amber-600 dark:text-amber-400 tabular-nums">
                            {pendingMembersCount} pendente(s)
                          </span>
                        </>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => onSelectWorkspace(ws.id)}
                      aria-label={`Abrir espaço ${ws.name}`}
                      className="min-h-[40px] px-4 py-2 text-xs font-semibold text-white bg-slate-900 dark:bg-indigo-600 hover:bg-indigo-600 dark:hover:bg-indigo-500 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                    >
                      <span>Acessar Espaço</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Modal: Create New Workspace */}
      <ResponsiveSheetModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        title="Criar Novo Espaço de Trabalho"
        subtitle="Configure um ambiente individual ou compartilhado e convide membros por e-mail."
      >
        <form onSubmit={handleCreateSubmit} className="space-y-4">
          {createError && (
            <p className="text-xs font-medium text-rose-600 dark:text-rose-400">
              {createError}
            </p>
          )}

          <div>
            <label
              htmlFor="ws-creator-name-input"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
            >
              Seu Nome (Responsável pelo Espaço)
            </label>
            <input
              id="ws-creator-name-input"
              type="text"
              required
              value={creatorNameInput}
              onChange={(e) => setCreatorNameInput(e.target.value)}
              placeholder="Como seu nome deve aparecer para os membros?"
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
          </div>

          <div>
            <label
              htmlFor="ws-name-input"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
            >
              Nome do Espaço
            </label>
            <input
              id="ws-name-input"
              type="text"
              required
              value={wsName}
              onChange={(e) => setWsName(e.target.value)}
              placeholder="Ex: Apartamento Praia & Amigos"
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Modalidade
              </span>
              <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
                {(['Compartilhado', 'Individual'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setWsType(t)}
                    className={`py-2 px-2 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                      wsType === t
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label
                htmlFor="ws-budget-input"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                Orçamento Mensal (R$)
              </label>
              <input
                id="ws-budget-input"
                type="number"
                step="50"
                value={wsBudget}
                onChange={(e) => setWsBudget(e.target.value)}
                className="w-full px-3.5 py-2.5 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="ws-desc-input"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
            >
              Descrição e Propósito
            </label>
            <textarea
              id="ws-desc-input"
              rows={2}
              value={wsDesc}
              onChange={(e) => setWsDesc(e.target.value)}
              placeholder="Descreva o objetivo das compras e planejamentos deste espaço..."
              className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
          </div>

          {wsType === 'Compartilhado' && (
            <div>
              <label
                htmlFor="ws-emails-input"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                Convidar Múltiplos E-mails (separados por vírgula ou linha)
              </label>
              <textarea
                id="ws-emails-input"
                rows={2}
                value={wsEmailsRaw}
                onChange={(e) => setWsEmailsRaw(e.target.value)}
                placeholder="maria@exemplo.com, joao@exemplo.com"
                className="w-full px-3.5 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>
          )}

          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setIsCreateOpen(false)}
              className="px-4 py-2 text-xs font-medium text-slate-600 dark:text-slate-400"
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="px-5 py-2.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors"
            >
              Criar Espaço
            </button>
          </div>
        </form>
      </ResponsiveSheetModal>

      {/* Modal: Edit Workspace */}
      <ResponsiveSheetModal
        isOpen={Boolean(editingWs)}
        onClose={() => setEditingWs(null)}
        title="Editar Espaço de Trabalho"
        subtitle="Altere o nome, modalidade, descrição ou orçamento mensal deste espaço."
      >
        <form onSubmit={handleEditSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="edit-ws-name"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
            >
              Nome do Espaço
            </label>
            <input
              id="edit-ws-name"
              type="text"
              required
              value={editWsName}
              onChange={(e) => setEditWsName(e.target.value)}
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Modalidade
              </span>
              <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
                {(['Compartilhado', 'Individual'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setEditWsType(t)}
                    className={`py-2 px-2 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                      editWsType === t
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label
                htmlFor="edit-ws-budget"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                Orçamento Mensal (R$)
              </label>
              <input
                id="edit-ws-budget"
                type="number"
                step="50"
                value={editWsBudget}
                onChange={(e) => setEditWsBudget(e.target.value)}
                className="w-full px-3.5 py-2.5 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="edit-ws-desc"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
            >
              Descrição
            </label>
            <textarea
              id="edit-ws-desc"
              rows={2}
              value={editWsDesc}
              onChange={(e) => setEditWsDesc(e.target.value)}
              className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
          </div>

          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditingWs(null)}
              className="px-4 py-2 text-xs font-medium text-slate-600 dark:text-slate-400"
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="px-5 py-2.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors"
            >
              Salvar Alterações
            </button>
          </div>
        </form>
      </ResponsiveSheetModal>

      {/* Modal: Delete Workspace Confirmation */}
      <ResponsiveSheetModal
        isOpen={Boolean(deletingWs)}
        onClose={() => setDeletingWs(null)}
        title="Apagar Espaço de Trabalho"
        subtitle={`Confirma a exclusão permanente do espaço "${deletingWs?.name || ''}" e suas listas vinculadas?`}
      >
        <div className="space-y-4">
          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
            Esta ação removerá o espaço de trabalho, suas listas e todos os itens associados.
          </p>
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setDeletingWs(null)}
              className="px-4 py-2 text-xs font-medium text-slate-600 dark:text-slate-400"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleConfirmDelete}
              className="px-5 py-2.5 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-lg transition-colors cursor-pointer"
            >
              Confirmar Exclusão
            </button>
          </div>
        </div>
      </ResponsiveSheetModal>
    </div>
  );
};
