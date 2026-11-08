import React from 'react';

interface AppErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  AppErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = {
      hasError: false,
      errorMessage: '',
    };
  }

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    const msg =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
        ? error
        : 'Erro inesperado ao renderizar o aplicativo.';
    return {
      hasError: true,
      errorMessage: msg,
    };
  }

  componentDidCatch(error: unknown, errorInfo: React.ErrorInfo) {
    console.warn('Aviso capturado pelo AppErrorBoundary:', error, errorInfo);
  }

  handleReloadAndClearCache = () => {
    try {
      localStorage.removeItem('mpf_active_demo_profile');
    } catch {
      // ignore storage errors
    }
    window.location.href = window.location.pathname;
  };

  handleOpenDemoMode = () => {
    window.location.href = `${window.location.pathname}?autostart=1`;
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-4">
        <div className="w-full max-w-lg bg-slate-800 border border-slate-700 rounded-3xl p-6 sm:p-8 shadow-2xl space-y-5">
          <div className="flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-2xl bg-amber-500/15 border border-amber-500/30 text-amber-400 flex items-center justify-center shrink-0">
              <i className="ph-fill ph-warning-circle text-2xl"></i>
            </div>
            <div>
              <span className="text-[11px] font-bold uppercase tracking-wider text-amber-300">
                Proteção contra Tela Branca
              </span>
              <h1 className="text-lg font-bold text-white">
                Meu Painel Financeiro encontrou um aviso na inicialização
              </h1>
            </div>
          </div>

          <p className="text-xs text-slate-300 leading-relaxed">
            O aplicativo interceptou uma falha de execução para evitar que a página ficasse em branco. Isso costuma ocorrer quando há cache antigo no navegador ou permissão pendente no domínio publicado.
          </p>

          <div className="p-3.5 rounded-2xl bg-slate-900 border border-slate-700/80 text-[11px] font-mono text-rose-300 break-words max-h-40 overflow-y-auto">
            {this.state.errorMessage}
          </div>

          <div className="flex flex-wrap items-center gap-2.5 pt-2">
            <button
              type="button"
              onClick={this.handleReloadAndClearCache}
              className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold cursor-pointer flex items-center gap-1.5"
            >
              <i className="ph-bold ph-arrows-clockwise"></i>
              <span>Recarregar Painel</span>
            </button>

            <button
              type="button"
              onClick={this.handleOpenDemoMode}
              className="px-4 py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-100 text-xs font-semibold cursor-pointer flex items-center gap-1.5"
            >
              <i className="ph-bold ph-play-circle"></i>
              <span>Abrir em Modo Demonstração</span>
            </button>
          </div>
        </div>
      </div>
    );
  }
}
