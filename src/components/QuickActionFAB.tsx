import React, { useState, useEffect, useRef } from 'react';

interface QuickActionFABProps {
  onOpenNewTransaction: () => void;
  onOpenNewList: () => void;
  onOpenNewSpace: () => void;
}

export const QuickActionFAB: React.FC<QuickActionFABProps> = ({
  onOpenNewTransaction,
  onOpenNewList,
  onOpenNewSpace,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fecha o menu ao clicar fora
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  return (
    <div
      ref={containerRef}
      className="fixed bottom-20 sm:bottom-6 right-4 sm:right-7 z-40 flex flex-col items-end gap-2.5"
    >
      {/* Menu Rápido Aberto (Speed Dial) */}
      {isOpen && (
        <div className="flex flex-col items-end gap-2 animate-in fade-in slide-in-from-bottom-3 duration-150">
          <button
            type="button"
            onClick={() => {
              setIsOpen(false);
              onOpenNewTransaction();
            }}
            className="flex items-center gap-2.5 px-3.5 py-2 rounded-2xl bg-slate-900/95 hover:bg-slate-800 border border-slate-700/90 text-white shadow-xl cursor-pointer transition-all hover:scale-102 group"
          >
            <span className="text-xs font-semibold text-slate-200 group-hover:text-white whitespace-nowrap">
              Novo Lançamento Financeiro
            </span>
            <div className="w-8 h-8 rounded-xl bg-indigo-600 text-white flex items-center justify-center shrink-0 shadow-md shadow-indigo-600/30">
              <i className="ph-bold ph-plus text-sm"></i>
            </div>
          </button>

          <button
            type="button"
            onClick={() => {
              setIsOpen(false);
              onOpenNewList();
            }}
            className="flex items-center gap-2.5 px-3.5 py-2 rounded-2xl bg-slate-900/95 hover:bg-slate-800 border border-slate-700/90 text-white shadow-xl cursor-pointer transition-all hover:scale-102 group"
          >
            <span className="text-xs font-semibold text-slate-200 group-hover:text-white whitespace-nowrap">
              Nova Lista de Compras
            </span>
            <div className="w-8 h-8 rounded-xl bg-amber-500 text-slate-950 flex items-center justify-center shrink-0 shadow-md shadow-amber-500/30">
              <i className="ph-fill ph-shopping-cart text-sm"></i>
            </div>
          </button>

          <button
            type="button"
            onClick={() => {
              setIsOpen(false);
              onOpenNewSpace();
            }}
            className="flex items-center gap-2.5 px-3.5 py-2 rounded-2xl bg-slate-900/95 hover:bg-slate-800 border border-slate-700/90 text-white shadow-xl cursor-pointer transition-all hover:scale-102 group"
          >
            <span className="text-xs font-semibold text-slate-200 group-hover:text-white whitespace-nowrap">
              Novo Espaço (Finanças / Listas)
            </span>
            <div className="w-8 h-8 rounded-xl bg-emerald-600 text-white flex items-center justify-center shrink-0 shadow-md shadow-emerald-600/30">
              <i className="ph-fill ph-users-three text-sm"></i>
            </div>
          </button>
        </div>
      )}

      {/* Botão Principal Flutuante (+) */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-label={isOpen ? 'Fechar ações rápidas' : 'Ações rápidas'}
        title="Ações Rápidas (+)"
        className={`w-13 h-13 rounded-2xl flex items-center justify-center text-white shadow-2xl cursor-pointer transition-all duration-200 active:scale-95 ${
          isOpen
            ? 'bg-slate-800 rotate-45 border border-slate-600'
            : 'bg-indigo-600 hover:bg-indigo-500 border border-indigo-400/40 shadow-indigo-600/40'
        }`}
      >
        <i className="ph-bold ph-plus text-2xl"></i>
      </button>
    </div>
  );
};
