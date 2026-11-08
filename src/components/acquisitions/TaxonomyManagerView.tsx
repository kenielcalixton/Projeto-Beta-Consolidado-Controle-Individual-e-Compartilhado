import React, { useState } from 'react';
import { TaxonomyGroup } from '../../types/acquisitions';
import { FolderPlus, Layers, Plus, Trash2, Edit3, Check } from 'lucide-react';

interface TaxonomyManagerViewProps {
  groups: TaxonomyGroup[];
  onAddGroup: (name: string, code: string, description: string) => void;
  onUpdateGroup: (groupId: string, name: string, code: string, description: string) => void;
  onDeleteGroup: (groupId: string) => void;
  onAddCategory: (groupId: string, categoryName: string) => void;
  onUpdateCategory: (groupId: string, categoryId: string, categoryName: string) => void;
  onDeleteCategory: (groupId: string, categoryId: string) => void;
  hidePageHeader?: boolean;
}

export const TaxonomyManagerView: React.FC<TaxonomyManagerViewProps> = ({
  groups,
  onAddGroup,
  onUpdateGroup,
  onDeleteGroup,
  onAddCategory,
  onUpdateCategory,
  onDeleteCategory,
  hidePageHeader = false,
}) => {
  const [groupName, setGroupName] = useState('');
  const [groupCode, setGroupCode] = useState('');
  const [groupDesc, setGroupDesc] = useState('');
  const [formError, setFormError] = useState('');

  // Per-group new subcategory inputs
  const [categoryInputs, setCategoryInputs] = useState<Record<string, string>>({});

  // Editing existing main category state
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editCode, setEditCode] = useState('');
  const [editDesc, setEditDesc] = useState('');

  // Editing existing subcategory state
  const [editingCatId, setEditingCatId] = useState<string | null>(null);
  const [editCatName, setEditCatName] = useState('');

  const handleCreateGroup = (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupName.trim()) {
      setFormError('Informe o nome da Categoria Principal.');
      return;
    }
    const cleanCode = (groupCode.trim() || groupName.slice(0, 3)).toUpperCase();
    onAddGroup(groupName.trim(), cleanCode, groupDesc.trim() || 'Categoria de compras e organização.');
    setGroupName('');
    setGroupCode('');
    setGroupDesc('');
    setFormError('');
  };

  const handleAddCat = (e: React.FormEvent, groupId: string) => {
    e.preventDefault();
    const val = categoryInputs[groupId]?.trim();
    if (!val) return;
    onAddCategory(groupId, val);
    setCategoryInputs((prev) => ({ ...prev, [groupId]: '' }));
  };

  const startEditingGroup = (grp: TaxonomyGroup) => {
    setEditingGroupId(grp.id);
    setEditName(grp.name);
    setEditCode(grp.code);
    setEditDesc(grp.description);
  };

  const saveEditedGroup = (groupId: string) => {
    if (!editName.trim()) return;
    onUpdateGroup(
      groupId,
      editName.trim(),
      editCode.trim().toUpperCase() || 'CAT',
      editDesc.trim()
    );
    setEditingGroupId(null);
  };

  const startEditingCategory = (catId: string, currentName: string) => {
    setEditingCatId(catId);
    setEditCatName(currentName);
  };

  const saveEditedCategory = (groupId: string, catId: string) => {
    if (!editCatName.trim()) return;
    onUpdateCategory(groupId, catId, editCatName.trim());
    setEditingCatId(null);
  };

  const totalSubcategories = groups.reduce((acc, g) => acc + g.categories.length, 0);

  return (
    <div className="space-y-8">
      {/* Section Header */}
      {!hidePageHeader ? (
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-6">
          <div>
            <p className="text-xs font-medium text-indigo-600 dark:text-indigo-400">
              Diretório de Organização de Compras
            </p>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100 font-display mt-1">
              Categorias e Subcategorias
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-400 mt-1 max-w-2xl">
              Organize suas Categorias Principais (ex: Supermercado, Casa, Lazer) e suas Subcategorias para manter suas listas sempre arrumadas.
            </p>
          </div>

          <div className="flex items-center gap-6 text-xs text-slate-600 dark:text-slate-400 shrink-0">
            <div>
              <span className="block text-slate-400 dark:text-slate-500">Categorias Principais</span>
              <span className="text-lg font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                {groups.length}
              </span>
            </div>
            <div className="h-8 w-px bg-slate-200 dark:bg-slate-800" />
            <div>
              <span className="block text-slate-400 dark:text-slate-500">Subcategorias</span>
              <span className="text-lg font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                {totalSubcategories}
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5">
          <div>
            <h2 className="text-base font-bold text-slate-900 dark:text-slate-100 font-display">
              Diretório de Categorias e Subcategorias
            </h2>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
              Cadastre setores principais (como Mercado, Casa ou Viagens) e adicione subcategorias dentro de cada um.
            </p>
          </div>
          <div className="flex items-center gap-5 text-xs text-slate-600 dark:text-slate-400 shrink-0">
            <div>
              <span className="block text-slate-400 dark:text-slate-500">Categorias</span>
              <span className="text-base font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                {groups.length}
              </span>
            </div>
            <div className="h-7 w-px bg-slate-200 dark:bg-slate-800" />
            <div>
              <span className="block text-slate-400 dark:text-slate-500">Subcategorias</span>
              <span className="text-base font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                {totalSubcategories}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Create Main Category Form */}
      <form
        onSubmit={handleCreateGroup}
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-100 font-display flex items-center gap-2">
            <FolderPlus className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <span>Nova Categoria Principal</span>
          </h2>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Ex: Supermercado, Casa, Saúde
          </span>
        </div>

        {formError && (
          <p className="text-xs font-medium text-rose-600 dark:text-rose-400">{formError}</p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
          <div className="md:col-span-4">
            <label
              htmlFor="tax-group-name"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
            >
              Nome da Categoria Principal
            </label>
            <input
              id="tax-group-name"
              type="text"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="Ex: Saúde & Farmácia"
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div className="md:col-span-2">
            <label
              htmlFor="tax-group-code"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
            >
              Abreviação (opcional)
            </label>
            <input
              id="tax-group-code"
              type="text"
              maxLength={5}
              value={groupCode}
              onChange={(e) => setGroupCode(e.target.value)}
              placeholder="SAU"
              className="w-full px-3.5 py-2.5 text-sm font-mono uppercase rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div className="md:col-span-4">
            <label
              htmlFor="tax-group-desc"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
            >
              O que entra aqui? (Descrição)
            </label>
            <input
              id="tax-group-desc"
              type="text"
              value={groupDesc}
              onChange={(e) => setGroupDesc(e.target.value)}
              placeholder="Medicamentos contínuos, suplementos e cuidados pessoais"
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div className="md:col-span-2 flex items-end">
            <button
              type="submit"
              className="w-full h-[42px] px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Criar Categoria</span>
            </button>
          </div>
        </div>
      </form>

      {/* Main Categories and Subcategories Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {groups.map((grp) => {
          const isEditing = editingGroupId === grp.id;

          return (
            <div
              key={grp.id}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 flex flex-col justify-between space-y-5"
            >
              <div className="space-y-4">
                {/* Main Category Header */}
                <div className="flex items-start justify-between gap-4 pb-4 border-b border-slate-100 dark:border-slate-800">
                  {isEditing ? (
                    <div className="flex-1 space-y-2">
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          aria-label="Editar nome da categoria principal"
                          className="flex-1 px-2.5 py-1.5 text-sm font-semibold rounded border border-indigo-400 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                        />
                        <input
                          type="text"
                          value={editCode}
                          maxLength={5}
                          onChange={(e) => setEditCode(e.target.value)}
                          aria-label="Editar abreviação da categoria"
                          className="w-20 px-2.5 py-1.5 text-xs font-mono uppercase rounded border border-indigo-400 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                        />
                      </div>
                      <input
                        type="text"
                        value={editDesc}
                        onChange={(e) => setEditDesc(e.target.value)}
                        aria-label="Editar descrição da categoria"
                        className="w-full px-2.5 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-700 dark:text-slate-300"
                      />
                      <div className="flex items-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => saveEditedGroup(grp.id)}
                          className="px-3 py-1.5 text-xs font-semibold bg-indigo-600 text-white rounded-md flex items-center gap-1 cursor-pointer"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>Salvar</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingGroupId(null)}
                          className="px-3 py-1.5 text-xs text-slate-600 dark:text-slate-400 cursor-pointer"
                        >
                          Cancelar
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                        <span className="font-mono font-semibold text-indigo-600 dark:text-indigo-400">
                          {grp.code}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">
                          {grp.categories.length} subcategoria(s)
                        </span>
                      </div>
                      <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100 font-display mt-0.5">
                        {grp.name}
                      </h3>
                      <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
                        {grp.description}
                      </p>
                    </div>
                  )}

                  {!isEditing && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => startEditingGroup(grp)}
                        aria-label={`Editar categoria principal ${grp.name}`}
                        className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                      >
                        <Edit3 className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteGroup(grp.id)}
                        aria-label={`Remover categoria principal ${grp.name}`}
                        className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg text-slate-500 hover:text-rose-600 hover:bg-rose-50 dark:text-slate-400 dark:hover:text-rose-400 dark:hover:bg-rose-950/40 transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>

                {/* Subcategories List */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
                    <span className="flex items-center gap-1.5">
                      <Layers className="w-3.5 h-3.5 text-indigo-500" />
                      Subcategorias
                    </span>
                  </div>

                  {grp.categories.length === 0 ? (
                    <p className="text-xs text-slate-400 dark:text-slate-500 py-3 italic">
                      Nenhuma subcategoria cadastrada nesta categoria ainda.
                    </p>
                  ) : (
                    <div className="divide-y divide-slate-100 dark:divide-slate-800/80 border-t border-b border-slate-100 dark:border-slate-800/80">
                      {grp.categories.map((cat) => {
                        const isCatEditing = editingCatId === cat.id;
                        return (
                          <div
                            key={cat.id}
                            className="py-2.5 flex items-center justify-between gap-3 text-sm group"
                          >
                            {isCatEditing ? (
                              <div className="flex-1 flex items-center gap-2">
                                <input
                                  type="text"
                                  value={editCatName}
                                  onChange={(e) => setEditCatName(e.target.value)}
                                  aria-label="Editar nome da subcategoria"
                                  className="flex-1 px-2.5 py-1 text-xs rounded border border-indigo-400 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                                />
                                <button
                                  type="button"
                                  onClick={() => saveEditedCategory(grp.id, cat.id)}
                                  className="px-2.5 py-1 text-xs font-semibold bg-indigo-600 text-white rounded cursor-pointer"
                                >
                                  Salvar
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingCatId(null)}
                                  className="px-2 py-1 text-xs text-slate-500 cursor-pointer"
                                >
                                  Cancelar
                                </button>
                              </div>
                            ) : (
                              <>
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="text-slate-800 dark:text-slate-200 font-medium truncate">
                                    {cat.name}
                                  </span>
                                  <span className="text-xs text-slate-400 dark:text-slate-500 font-mono">
                                    · {grp.code}
                                  </span>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  <button
                                    type="button"
                                    onClick={() => startEditingCategory(cat.id, cat.name)}
                                    aria-label={`Editar subcategoria ${cat.name}`}
                                    className="text-xs text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors px-1.5 py-1 rounded cursor-pointer"
                                  >
                                    Editar
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => onDeleteCategory(grp.id, cat.id)}
                                    aria-label={`Excluir subcategoria ${cat.name}`}
                                    className="text-xs text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 transition-colors px-1.5 py-1 rounded cursor-pointer"
                                  >
                                    Apagar
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* Add Subcategory Form */}
              <form
                onSubmit={(e) => handleAddCat(e, grp.id)}
                className="pt-2 flex items-center gap-2"
              >
                <input
                  type="text"
                  value={categoryInputs[grp.id] || ''}
                  onChange={(e) =>
                    setCategoryInputs((prev) => ({ ...prev, [grp.id]: e.target.value }))
                  }
                  placeholder={`Nova subcategoria em ${grp.name}...`}
                  aria-label={`Nova subcategoria em ${grp.name}`}
                  className="flex-1 px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <button
                  type="submit"
                  className="px-3.5 py-2 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  + Subcategoria
                </button>
              </form>
            </div>
          );
        })}
      </div>
    </div>
  );
};
