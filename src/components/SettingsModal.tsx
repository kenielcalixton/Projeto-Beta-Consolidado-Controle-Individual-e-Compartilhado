import React, { useState } from 'react';
import { Category } from '../types/finance';
import { TaxonomyGroup } from '../types/acquisitions';
import { TaxonomyManagerView } from './acquisitions/TaxonomyManagerView';

export type SettingsTab = 'account' | 'finance_categories' | 'product_categories';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: SettingsTab;
  currentUser: {
    uid: string;
    name: string;
    email: string;
    isDemo: boolean;
  };
  userIsAdmin?: boolean;
  onUpdateUserName: (newName: string) => void;
  // Categorias de Finanças
  categories: Category[];
  onCreateCategory: (
    cat: Omit<Category, 'id' | 'userId' | 'createdAt'>
  ) => Promise<Category>;
  onDeleteCategory?: (id: string) => Promise<void>;
  // Categorias de Produtos (Aquisições)
  taxonomyGroups: TaxonomyGroup[];
  onAddTaxonomyGroup: (name: string, code: string, description: string) => void;
  onUpdateTaxonomyGroup: (
    groupId: string,
    name: string,
    code: string,
    description: string
  ) => void;
  onDeleteTaxonomyGroup: (groupId: string) => void;
  onAddTaxonomyCategory: (groupId: string, categoryName: string) => void;
  onUpdateTaxonomyCategory: (
    groupId: string,
    categoryId: string,
    categoryName: string
  ) => void;
  onDeleteTaxonomyCategory: (groupId: string, categoryId: string) => void;
  onNotifyToast: (msg: string) => void;
}

const FINANCE_ICONS = [
  { icon: 'ph-house-line', label: 'Moradia' },
  { icon: 'ph-fork-knife', label: 'Alimentação' },
  { icon: 'ph-car', label: 'Transporte' },
  { icon: 'ph-heartbeat', label: 'Saúde' },
  { icon: 'ph-graduation-cap', label: 'Educação' },
  { icon: 'ph-film-slate', label: 'Lazer' },
  { icon: 'ph-shopping-bag', label: 'Compras' },
  { icon: 'ph-money', label: 'Salário' },
  { icon: 'ph-chart-line-up', label: 'Investimentos' },
  { icon: 'ph-hand-coins', label: 'Renda Extra' },
  { icon: 'ph-lightning', label: 'Contas' },
  { icon: 'ph-tag', label: 'Geral' },
];

const FINANCE_COLORS = [
  'indigo',
  'emerald',
  'rose',
  'amber',
  'purple',
  'sky',
  'teal',
];

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  initialTab = 'account',
  currentUser,
  userIsAdmin,
  onUpdateUserName,
  categories,
  onCreateCategory,
  onDeleteCategory,
  taxonomyGroups,
  onAddTaxonomyGroup,
  onUpdateTaxonomyGroup,
  onDeleteTaxonomyGroup,
  onAddTaxonomyCategory,
  onUpdateTaxonomyCategory,
  onDeleteTaxonomyCategory,
  onNotifyToast,
}) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);

  // Aba Minha Conta
  const [editingName, setEditingName] = useState(currentUser.name || '');
  const [nameSavedSuccess, setNameSavedSuccess] = useState(false);

  // Aba Nova Categoria Financeira
  const [newCatName, setNewCatName] = useState('');
  const [newCatType, setNewCatType] = useState<'income' | 'expense' | 'both'>('expense');
  const [newCatIcon, setNewCatIcon] = useState('ph-tag');
  const [newCatColor, setNewCatColor] = useState('indigo');
  const [isSubmittingCat, setIsSubmittingCat] = useState(false);

  if (!isOpen) return null;

  const handleSaveName = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = editingName.trim();
    if (!clean) {
      onNotifyToast('Informe um nome válido.');
      return;
    }
    onUpdateUserName(clean);
    setNameSavedSuccess(true);
    setTimeout(() => setNameSavedSuccess(false), 3000);
    onNotifyToast('Nome do perfil atualizado com sucesso!');
  };

  const handleCreateFinanceCat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCatName.trim()) {
      onNotifyToast('Informe o nome da categoria.');
      return;
    }

    setIsSubmittingCat(true);
    try {
      await onCreateCategory({
        name: newCatName.trim(),
        type: newCatType,
        icon: newCatIcon,
        color: newCatColor,
      });
      setNewCatName('');
      onNotifyToast(`Categoria "${newCatName.trim()}" criada com sucesso!`);
    } catch {
      onNotifyToast('Erro ao criar categoria.');
    } finally {
      setIsSubmittingCat(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-label="Configurações do Sistema"
    >
      <div className="bg-slate-900 border border-slate-700/80 rounded-3xl w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Cabeçalho do Modal */}
        <div className="p-4 sm:p-6 border-b border-slate-800 flex items-center justify-between gap-3 bg-slate-900/95 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 text-indigo-400 flex items-center justify-center shrink-0">
              <i className="ph-fill ph-gear text-xl"></i>
            </div>
            <div>
              <h3 className="text-base sm:text-lg font-bold text-white leading-tight">
                Configurações do Sistema
              </h3>
              <p className="text-xs text-slate-400">
                Gerencie seu perfil e as categorias de finanças e produtos
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar configurações"
            className="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center cursor-pointer transition-colors"
          >
            <i className="ph-bold ph-x text-base"></i>
          </button>
        </div>

        {/* Abas Superiores do Modal */}
        <div className="px-4 sm:px-6 pt-3 border-b border-slate-800 bg-slate-900/60 shrink-0">
          <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none">
            <button
              type="button"
              onClick={() => setActiveTab('account')}
              className={`px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 cursor-pointer transition-colors whitespace-nowrap ${
                activeTab === 'account'
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
            >
              <i className="ph-fill ph-user text-sm"></i>
              <span>Minha Conta</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('finance_categories')}
              className={`px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 cursor-pointer transition-colors whitespace-nowrap ${
                activeTab === 'finance_categories'
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
            >
              <i className="ph-fill ph-tag text-sm"></i>
              <span>Categorias de Finanças ({categories.length})</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('product_categories')}
              className={`px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 cursor-pointer transition-colors whitespace-nowrap ${
                activeTab === 'product_categories'
                  ? 'bg-amber-500 text-slate-950 font-bold shadow'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
            >
              <i className="ph-fill ph-shopping-cart text-sm"></i>
              <span>Categorias de Produtos ({taxonomyGroups.length})</span>
            </button>
          </div>
        </div>

        {/* Conteúdo com Rolagem Única */}
        <div className="p-4 sm:p-6 overflow-y-auto flex-1 overscroll-contain">
          {/* 1. ABA MINHA CONTA */}
          {activeTab === 'account' && (
            <div className="space-y-6 max-w-xl">
              <div className="p-4 rounded-2xl bg-slate-800/80 border border-slate-700/80 flex items-center gap-4">
                <div className="w-14 h-14 rounded-2xl bg-indigo-600 flex items-center justify-center text-white font-bold text-xl uppercase shadow-md shadow-indigo-600/30 shrink-0">
                  {currentUser.name ? currentUser.name.slice(0, 2) : 'MP'}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold text-white truncate">
                      {currentUser.name}
                    </span>
                    {userIsAdmin ? (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 border border-amber-500/40 text-amber-300">
                        Administrador Geral
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-700 text-slate-300">
                        Membro
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-slate-400 block truncate mt-0.5">
                    {currentUser.email}
                  </span>
                </div>
              </div>

              <form onSubmit={handleSaveName} className="space-y-4">
                <div>
                  <label
                    htmlFor="edit-user-name"
                    className="block text-xs font-semibold text-slate-300 mb-1"
                  >
                    Nome de Exibição
                  </label>
                  <input
                    id="edit-user-name"
                    type="text"
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    placeholder="Seu nome completo ou apelido"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-800 border border-slate-700 text-sm text-white focus:outline-none focus:border-indigo-500"
                  />
                  <p className="text-[11px] text-slate-400 mt-1">
                    Este nome é compartilhado entre o controle financeiro e as listas de compras.
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="submit"
                    className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-md shadow-indigo-600/20 cursor-pointer flex items-center gap-2"
                  >
                    <i className="ph-bold ph-check"></i>
                    <span>Salvar Alterações</span>
                  </button>
                  {nameSavedSuccess && (
                    <span className="text-xs text-emerald-400 font-semibold flex items-center gap-1">
                      <i className="ph-bold ph-check-circle"></i>
                      <span>Atualizado com sucesso!</span>
                    </span>
                  )}
                </div>
              </form>

              <div className="pt-4 border-t border-slate-800">
                <h4 className="text-xs font-bold text-slate-300 mb-2">
                  Dados Técnicos da Sessão
                </h4>
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 font-mono text-[11px] text-slate-400 space-y-1">
                  <div>
                    <span className="text-slate-500">ID de Usuário: </span>
                    <span className="text-slate-300">{currentUser.uid}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Modo de Acesso: </span>
                    <span className="text-emerald-400 font-bold">
                      {currentUser.isDemo ? 'Demonstração Local' : 'Autenticado Firebase'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 2. ABA CATEGORIAS DE FINANÇAS */}
          {activeTab === 'finance_categories' && (
            <div className="space-y-6">
              {/* Formulário para Nova Categoria Financeira */}
              <form
                onSubmit={handleCreateFinanceCat}
                className="p-4 rounded-2xl bg-slate-800/80 border border-slate-700/80 space-y-3"
              >
                <h4 className="text-xs font-bold text-white flex items-center gap-2">
                  <i className="ph-bold ph-plus-circle text-indigo-400"></i>
                  <span>Nova Categoria de Finanças</span>
                </h4>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="cat-name-input"
                      className="block text-[11px] font-semibold text-slate-300 mb-1"
                    >
                      Nome da Categoria
                    </label>
                    <input
                      id="cat-name-input"
                      type="text"
                      value={newCatName}
                      onChange={(e) => setNewCatName(e.target.value)}
                      placeholder="Ex: Farmácia, Pet, Freelance..."
                      className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-xs text-white"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="cat-type-select"
                      className="block text-[11px] font-semibold text-slate-300 mb-1"
                    >
                      Tipo de Lançamento
                    </label>
                    <select
                      id="cat-type-select"
                      value={newCatType}
                      onChange={(e) =>
                        setNewCatType(e.target.value as 'income' | 'expense' | 'both')
                      }
                      className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-xs text-white"
                    >
                      <option value="expense">Despesa</option>
                      <option value="income">Receita</option>
                      <option value="both">Ambos (Receita & Despesa)</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                  <div>
                    <label
                      htmlFor="cat-icon-select"
                      className="block text-[11px] font-semibold text-slate-300 mb-1"
                    >
                      Ícone
                    </label>
                    <select
                      id="cat-icon-select"
                      value={newCatIcon}
                      onChange={(e) => setNewCatIcon(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-xs text-white"
                    >
                      {FINANCE_ICONS.map((ic) => (
                        <option key={ic.icon} value={ic.icon}>
                          {ic.label} ({ic.icon})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="cat-color-select"
                      className="block text-[11px] font-semibold text-slate-300 mb-1"
                    >
                      Cor
                    </label>
                    <select
                      id="cat-color-select"
                      value={newCatColor}
                      onChange={(e) => setNewCatColor(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-xs text-white"
                    >
                      {FINANCE_COLORS.map((col) => (
                        <option key={col} value={col}>
                          {col.charAt(0).toUpperCase() + col.slice(1)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={isSubmittingCat}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold cursor-pointer flex items-center gap-1.5 transition-colors"
                >
                  <i className="ph-bold ph-plus"></i>
                  <span>Adicionar Categoria</span>
                </button>
              </form>

              {/* Lista de Categorias Financeiras Existentes */}
              <div>
                <h4 className="text-xs font-bold text-slate-300 mb-2">
                  Categorias Ativas ({categories.length})
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {categories.map((cat) => (
                    <div
                      key={cat.id}
                      className="p-3 rounded-xl bg-slate-800 border border-slate-700/80 flex items-center justify-between gap-3"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-8 h-8 rounded-lg bg-indigo-500/20 text-indigo-400 flex items-center justify-center shrink-0">
                          <i className={`ph-fill ${cat.icon || 'ph-tag'} text-base`}></i>
                        </div>
                        <div className="min-w-0">
                          <span className="text-xs font-bold text-white block truncate">
                            {cat.name}
                          </span>
                          <span className="text-[10px] text-slate-400 uppercase font-mono">
                            {cat.type === 'expense'
                              ? 'Despesa'
                              : cat.type === 'income'
                              ? 'Receita'
                              : 'Receita & Despesa'}
                          </span>
                        </div>
                      </div>

                      {onDeleteCategory && (
                        <button
                          type="button"
                          onClick={() => onDeleteCategory(cat.id)}
                          aria-label={`Excluir categoria ${cat.name}`}
                          className="w-7 h-7 rounded-lg hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 flex items-center justify-center transition-colors cursor-pointer"
                        >
                          <i className="ph-bold ph-trash text-xs"></i>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* 3. ABA CATEGORIAS DE PRODUTOS (AQUISIÇÕES TAXONOMIA) */}
          {activeTab === 'product_categories' && (
            <div>
              <TaxonomyManagerView
                groups={taxonomyGroups}
                onAddGroup={onAddTaxonomyGroup}
                onUpdateGroup={onUpdateTaxonomyGroup}
                onDeleteGroup={onDeleteTaxonomyGroup}
                onAddCategory={onAddTaxonomyCategory}
                onUpdateCategory={onUpdateTaxonomyCategory}
                onDeleteCategory={onDeleteTaxonomyCategory}
                hidePageHeader={true}
              />
            </div>
          )}
        </div>

        {/* Rodapé do Modal */}
        <div className="p-4 sm:px-6 border-t border-slate-800 bg-slate-900 flex items-center justify-end shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold cursor-pointer"
          >
            Fechar Configurações
          </button>
        </div>
      </div>
    </div>
  );
};
