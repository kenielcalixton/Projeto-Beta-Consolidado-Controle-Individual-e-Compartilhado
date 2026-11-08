import React, { useState } from 'react';
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  updateProfile,
} from 'firebase/auth';
import {
  auth,
  googleProvider,
} from '../services/firebase';

interface AuthScreenProps {
  onEnterDemoMode?: (profile: { uid: string; name: string; email: string }) => void;
}

type AuthMode = 'login' | 'register' | 'reset';

export const AuthScreen: React.FC<AuthScreenProps> = ({ onEnterDemoMode }) => {
  const [mode, setMode] = useState<AuthMode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setInfoMsg(null);

    const normalizedEmail = email.trim().toLowerCase();

    if (mode === 'reset') {
      if (!normalizedEmail || !normalizedEmail.includes('@')) {
        setErrorMsg('Informe um endereço de e-mail válido para recuperar sua senha.');
        return;
      }
      setLoading(true);
      try {
        await sendPasswordResetEmail(auth, normalizedEmail);
        setInfoMsg(
          `E-mail de redefinição de senha enviado para ${normalizedEmail}. Verifique sua caixa de entrada e spam.`
        );
      } catch (err: any) {
        const code = String(err?.code || '');
        if (code.includes('user-not-found')) {
          setErrorMsg('Nenhuma conta encontrada com este endereço de e-mail.');
        } else {
          setErrorMsg(
            err?.message || 'Não foi possível enviar o e-mail de redefinição.'
          );
        }
      } finally {
        setLoading(false);
      }
      return;
    }

    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      setErrorMsg('Por favor, insira um endereço de e-mail válido.');
      return;
    }

    if (password.length < 6) {
      setErrorMsg('A senha deve possuir no mínimo 6 caracteres.');
      return;
    }

    if (mode === 'register') {
      if (!name.trim()) {
        setErrorMsg('Por favor, informe seu nome completo para o cadastro.');
        return;
      }
      if (password !== confirmPassword) {
        setErrorMsg('A confirmação de senha não confere com a senha digitada.');
        return;
      }
    }

    setLoading(true);
    try {
      await setPersistence(auth, browserLocalPersistence);

      if (mode === 'register') {
        const cleanName = name.trim().slice(0, 100);
        sessionStorage.setItem('mpf_pending_signup_name', cleanName);
        const cred = await createUserWithEmailAndPassword(
          auth,
          normalizedEmail,
          password
        );
        await updateProfile(cred.user, { displayName: cleanName });
      } else {
        await signInWithEmailAndPassword(
          auth,
          normalizedEmail,
          password
        );
      }
    } catch (err: any) {
      const code = String(err?.code || '');
      if (
        code.includes('invalid-credential') ||
        code.includes('wrong-password') ||
        code.includes('user-not-found')
      ) {
        setErrorMsg(
          'E-mail ou senha incorretos. Verifique suas credenciais ou clique em "Criar Cadastro".'
        );
      } else if (code.includes('email-already-in-use')) {
        setErrorMsg(
          'Este e-mail já está cadastrado no Firebase. Alterne para a aba "Entrar na Conta".'
        );
      } else if (code.includes('too-many-requests')) {
        setErrorMsg(
          'Muitas tentativas seguidas. Aguarde alguns instantes ou redefina sua senha.'
        );
      } else {
        setErrorMsg(
          err?.message || 'Não foi possível autenticar no Firebase. Tente novamente.'
        );
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setErrorMsg(null);
    setLoading(true);
    try {
      await setPersistence(auth, browserLocalPersistence);
      await signInWithPopup(auth, googleProvider);
    } catch {
      setErrorMsg(
        'Janela de login do Google fechada ou bloqueada. Utilize o formulário de E-mail e Senha acima.'
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col justify-center items-center p-4 md:p-8">
      <div className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-12 bg-slate-800/90 border border-slate-700/80 rounded-3xl overflow-hidden shadow-2xl">
        {/* Coluna Institucional / Apresentação */}
        <div className="lg:col-span-6 p-8 md:p-10 bg-slate-800 flex flex-col justify-between border-b lg:border-b-0 lg:border-r border-slate-700/80">
          <div>
            <div className="flex items-center gap-3 mb-8">
              <div className="w-11 h-11 rounded-2xl bg-indigo-600 flex items-center justify-center text-white shadow-lg shadow-indigo-600/30">
                <i className="ph-fill ph-wallet text-2xl"></i>
              </div>
              <span className="text-xl font-bold tracking-tight text-white">
                Meu Painel Financeiro
              </span>
            </div>

            <h1 className="text-2xl md:text-3xl font-bold text-white leading-tight mb-4">
              Controle financeiro inteligente com Livro-Razão colaborativo.
            </h1>
            <p className="text-slate-400 text-sm md:text-base leading-relaxed mb-8">
              Gerencie contas bancárias, projete faturas de cartão de crédito por data de corte e audite despesas compartilhadas em grupo com transparência total.
            </p>

            <div className="space-y-4">
              <div className="flex items-start gap-3.5">
                <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0 mt-0.5">
                  <i className="ph-fill ph-arrows-split text-lg"></i>
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-slate-100">
                    Livro-Razão Estilo Splitwise
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Cálculo automático de Responsabilidade vs. Valor já pago para equilibrar quem deve a quem.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3.5">
                <div className="w-9 h-9 rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-400 flex items-center justify-center shrink-0 mt-0.5">
                  <i className="ph-fill ph-credit-card text-lg"></i>
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-slate-100">
                    Motor de Faturas & Recorrência em Cascata
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Projeção automática de compras conforme fechamento e vencimento, com edição em cascata.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3.5">
                <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center shrink-0 mt-0.5">
                  <i className="ph-fill ph-scales text-lg"></i>
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-slate-100">
                    Caixa de Entrada e Disputa de Rateios
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Aceite, recuse, conteste ou proponha novo valor antes de efetivar rateios compartilhados.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-8 pt-6 border-t border-slate-700/60 flex items-center justify-between text-xs text-slate-400">
            <span>Isolamento Firestore RBAC</span>
            <span aria-hidden="true">·</span>
            <span>Sincronização em Tempo Real</span>
          </div>
        </div>

        {/* Coluna Formulário de Autenticação */}
        <div className="lg:col-span-6 p-8 md:p-10 bg-slate-900/60 flex flex-col justify-center">
          {/* Alternância Login / Cadastro */}
          <div className="flex items-center p-1 bg-slate-800 border border-slate-700/80 rounded-2xl mb-6">
            <button
              type="button"
              onClick={() => {
                setMode('login');
                setErrorMsg(null);
                setInfoMsg(null);
              }}
              className={`flex-1 py-2.5 px-4 rounded-xl text-xs font-semibold transition-all whitespace-nowrap ${
                mode === 'login'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Entrar na Conta
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('register');
                setErrorMsg(null);
                setInfoMsg(null);
              }}
              className={`flex-1 py-2.5 px-4 rounded-xl text-xs font-semibold transition-all whitespace-nowrap ${
                mode === 'register'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Criar Cadastro
            </button>
          </div>

          <div className="mb-6">
            <h2 className="text-xl font-bold text-white">
              {mode === 'login'
                ? 'Bem-vindo de volta'
                : mode === 'register'
                ? 'Crie sua conta colaborativa'
                : 'Recuperação de Senha'}
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              {mode === 'login'
                ? 'Acesse suas contas, cartões e espaços compartilhados.'
                : mode === 'register'
                ? 'Preencha seus dados para iniciar seu controle financeiro.'
                : 'Informe seu e-mail cadastrado para receber as instruções de redefinição.'}
            </p>
          </div>

          {errorMsg && (
            <div
              role="alert"
              className="mb-4 p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2.5"
            >
              <i className="ph-fill ph-warning-circle text-base shrink-0 mt-0.5"></i>
              <span>{errorMsg}</span>
            </div>
          )}

          {infoMsg && (
            <div
              role="status"
              className="mb-4 p-3.5 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-start gap-2.5"
            >
              <i className="ph-fill ph-check-circle text-base shrink-0 mt-0.5"></i>
              <span>{infoMsg}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'register' && (
              <div>
                <label
                  htmlFor="auth-name"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  Nome Completo
                </label>
                <div className="relative">
                  <i className="ph ph-user absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"></i>
                  <input
                    id="auth-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ex: Keniel Calixto"
                    maxLength={100}
                    className="w-full pl-10 pr-4 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>
            )}

            <div>
              <label
                htmlFor="auth-email"
                className="block text-xs font-medium text-slate-300 mb-1.5"
              >
                E-mail
              </label>
              <div className="relative">
                <i className="ph ph-envelope-simple absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"></i>
                <input
                  id="auth-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="seu.email@exemplo.com"
                  maxLength={160}
                  className="w-full pl-10 pr-4 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            {mode !== 'reset' && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label
                    htmlFor="auth-password"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Senha
                  </label>
                  {mode === 'login' && (
                    <button
                      type="button"
                      onClick={() => {
                        setMode('reset');
                        setErrorMsg(null);
                        setInfoMsg(null);
                      }}
                      className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                    >
                      Esqueci a senha
                    </button>
                  )}
                </div>
                <div className="relative">
                  <i className="ph ph-lock-key absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"></i>
                  <input
                    id="auth-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Mínimo 6 caracteres"
                    className="w-full pl-10 pr-4 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>
            )}

            {mode === 'register' && (
              <div>
                <label
                  htmlFor="auth-confirm-password"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  Confirmação de Senha
                </label>
                <div className="relative">
                  <i className="ph ph-check-square-offset absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"></i>
                  <input
                    id="auth-confirm-password"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Repita a senha escolhida"
                    className="w-full pl-10 pr-4 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 px-4 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-semibold text-sm rounded-xl shadow-lg shadow-indigo-600/25 transition-all flex items-center justify-center gap-2 cursor-pointer"
            >
              {loading ? (
                <span>Processando...</span>
              ) : mode === 'login' ? (
                <>
                  <i className="ph-bold ph-sign-in"></i>
                  <span>Entrar no Painel</span>
                </>
              ) : mode === 'register' ? (
                <>
                  <i className="ph-bold ph-user-plus"></i>
                  <span>Concluir Cadastro</span>
                </>
              ) : (
                <>
                  <i className="ph-bold ph-paper-plane-tilt"></i>
                  <span>Enviar Link de Recuperação</span>
                </>
              )}
            </button>

            {mode === 'reset' && (
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setErrorMsg(null);
                  setInfoMsg(null);
                }}
                className="w-full py-2 text-xs font-medium text-slate-400 hover:text-white transition-colors"
              >
                Voltar para o Login
              </button>
            )}
          </form>

          <div className="my-5 flex items-center gap-3">
            <div className="h-px bg-slate-700/80 flex-1"></div>
            <span className="text-xs text-slate-400">ou continue com</span>
            <div className="h-px bg-slate-700/80 flex-1"></div>
          </div>

          <button
            type="button"
            onClick={handleGoogleLogin}
            disabled={loading}
            className="w-full py-2.5 px-4 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl text-xs font-semibold text-slate-200 transition-colors flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap"
          >
            <i className="ph-bold ph-google-logo text-indigo-400 text-base"></i>
            <span>Entrar com Google</span>
          </button>

          {onEnterDemoMode && (
            <button
              type="button"
              onClick={() =>
                onEnterDemoMode({
                  uid: 'demo_user_default',
                  name: 'Usuário Demonstração',
                  email: 'demo@meupainel.com',
                })
              }
              className="mt-3 w-full py-2.5 px-4 bg-slate-900/60 hover:bg-slate-800 border border-slate-700 hover:border-slate-600 rounded-xl text-xs font-medium text-slate-300 transition-colors flex items-center justify-center gap-2 cursor-pointer"
            >
              <i className="ph-bold ph-lightning text-amber-400"></i>
              <span>Acessar Modo Demonstração Rápido</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

