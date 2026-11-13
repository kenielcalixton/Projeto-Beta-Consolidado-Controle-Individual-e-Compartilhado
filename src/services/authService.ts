import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  User as FirebaseUser,
} from 'firebase/auth';
import { auth, googleProvider } from './firebase';

/**
 * ==============================================================================
 * SERVIÇO CANÔNICO DE AUTENTICAÇÃO E IDENTIDADE (FIREBASE AUTH) — FASE 2
 * ==============================================================================
 * Responsável pelo isolamento de chamadas ao Firebase Auth, validações de entrada,
 * mapeamento de erros amigáveis em português e extração do UID canônico.
 */

export interface CanonicalAuthUser {
  /** UID canônico e imutável fornecido pelo Firebase Authentication (request.auth.uid) */
  uid: string;
  /** Nome de exibição público do usuário */
  displayName: string | null;
  /** Endereço de e-mail normalizado */
  email: string;
  /** Status de confirmação do e-mail no Firebase */
  emailVerified: boolean;
  /** Se a conta é anônima */
  isAnonymous: boolean;
  /** URL do avatar se provido pelo provedor */
  photoURL: string | null;
  /** Flag para identificar sessões de demonstração locais */
  isDemo?: boolean;
}

/**
 * Normaliza um objeto User nativo do Firebase para a interface CanonicalAuthUser.
 */
export function mapFirebaseUser(user: FirebaseUser, isDemo = false): CanonicalAuthUser {
  return {
    uid: user.uid,
    displayName: user.displayName || user.email?.split('@')[0] || 'Usuário',
    email: (user.email || '').toLowerCase().trim(),
    emailVerified: user.emailVerified,
    isAnonymous: user.isAnonymous,
    photoURL: user.photoURL,
    isDemo,
  };
}

/**
 * Validação de endereço de e-mail segundo padrão RFC simplificado.
 */
export function validateEmail(email: string): { isValid: boolean; error?: string } {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) {
    return { isValid: false, error: 'O endereço de e-mail é obrigatório.' };
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(trimmed)) {
    return { isValid: false, error: 'Informe um endereço de e-mail válido (ex: seu.nome@exemplo.com).' };
  }
  return { isValid: true };
}

/**
 * Validação de segurança mínima de senha.
 */
export function validatePassword(password: string): { isValid: boolean; error?: string } {
  if (!password) {
    return { isValid: false, error: 'A senha é obrigatória.' };
  }
  if (password.length < 6) {
    return { isValid: false, error: 'A senha deve possuir no mínimo 6 caracteres.' };
  }
  return { isValid: true };
}

/**
 * Validação completa do formulário de cadastro.
 */
export function validateRegistration(
  name: string,
  email: string,
  password: string,
  confirmPassword?: string
): { isValid: boolean; error?: string } {
  const cleanName = name.trim();
  if (!cleanName) {
    return { isValid: false, error: 'Informe seu nome completo para o cadastro.' };
  }
  if (cleanName.length < 2) {
    return { isValid: false, error: 'O nome deve conter pelo menos 2 caracteres.' };
  }

  const emailVal = validateEmail(email);
  if (!emailVal.isValid) return emailVal;

  const passVal = validatePassword(password);
  if (!passVal.isValid) return passVal;

  if (confirmPassword !== undefined && password !== confirmPassword) {
    return { isValid: false, error: 'A confirmação de senha não confere com a senha digitada.' };
  }

  return { isValid: true };
}

/**
 * Mapeia códigos de erro do Firebase Auth para mensagens claras em português.
 */
export function formatAuthError(error: unknown): string {
  if (!error) return 'Ocorreu um erro inesperado na autenticação.';

  const errObj = error as { code?: string; message?: string };
  const code = (errObj.code || '').toLowerCase();
  const rawMsg = errObj.message || String(error);

  if (
    code.includes('invalid-credential') ||
    code.includes('wrong-password') ||
    code.includes('user-not-found')
  ) {
    return 'E-mail ou senha incorretos. Verifique suas credenciais e tente novamente.';
  }
  if (code.includes('email-already-in-use')) {
    return 'Este endereço de e-mail já está cadastrado. Alterne para a opção "Entrar na Conta" ou recupere sua senha.';
  }
  if (code.includes('weak-password')) {
    return 'A senha escolhida é muito fraca. Utilize pelo menos 6 caracteres com combinação de letras e números.';
  }
  if (code.includes('invalid-email')) {
    return 'O formato do e-mail informado é inválido.';
  }
  if (code.includes('user-disabled')) {
    return 'Esta conta foi desativada pelo administrador do sistema.';
  }
  if (code.includes('too-many-requests')) {
    return 'Muitas tentativas sem sucesso. Por segurança, aguarde alguns minutos antes de tentar novamente.';
  }
  if (code.includes('network-request-failed')) {
    return 'Falha de conexão com os servidores de autenticação. Verifique sua conexão com a internet.';
  }
  if (code.includes('popup-closed-by-user')) {
    return 'A janela de autenticação com o Google foi fechada antes da conclusão do login.';
  }
  if (code.includes('popup-blocked')) {
    return 'A janela pop-up foi bloqueada pelo navegador. Permita pop-ups para autenticar com o Google.';
  }
  if (code.includes('requires-recent-login')) {
    return 'Esta operação requer autenticação recente. Faça login novamente para prosseguir.';
  }

  return rawMsg || 'Não foi possível completar a operação de autenticação no Firebase.';
}

/**
 * Realiza o cadastro de um novo usuário com e-mail e senha.
 */
export async function registerWithEmailPassword(
  name: string,
  email: string,
  password: string
): Promise<CanonicalAuthUser> {
  const validation = validateRegistration(name, email, password);
  if (!validation.isValid) {
    throw new Error(validation.error);
  }

  const normalizedEmail = email.trim().toLowerCase();
  const cleanName = name.trim().slice(0, 100);

  // Garante persistência local no navegador
  await setPersistence(auth, browserLocalPersistence);

  const credential = await createUserWithEmailAndPassword(auth, normalizedEmail, password);

  // Atualiza nome no perfil do Firebase Authentication
  if (cleanName) {
    try {
      await updateProfile(credential.user, { displayName: cleanName });
    } catch (profileErr) {
      console.warn('[AuthService] Aviso ao sincronizar displayName:', profileErr);
    }
  }

  return mapFirebaseUser({
    ...credential.user,
    displayName: cleanName,
  });
}

/**
 * Realiza o login com e-mail e senha.
 */
export async function loginWithEmailPassword(
  email: string,
  password: string
): Promise<CanonicalAuthUser> {
  const emailVal = validateEmail(email);
  if (!emailVal.isValid) {
    throw new Error(emailVal.error);
  }
  if (!password) {
    throw new Error('Informe sua senha de acesso.');
  }

  const normalizedEmail = email.trim().toLowerCase();

  await setPersistence(auth, browserLocalPersistence);
  const credential = await signInWithEmailAndPassword(auth, normalizedEmail, password);

  return mapFirebaseUser(credential.user);
}

/**
 * Dispara e-mail de recuperação e redefinição de senha.
 */
export async function sendPasswordReset(email: string): Promise<void> {
  const emailVal = validateEmail(email);
  if (!emailVal.isValid) {
    throw new Error(emailVal.error);
  }

  const normalizedEmail = email.trim().toLowerCase();
  await sendPasswordResetEmail(auth, normalizedEmail);
}

/**
 * Realiza autenticação via pop-up com conta Google.
 */
export async function loginWithGoogle(): Promise<CanonicalAuthUser> {
  await setPersistence(auth, browserLocalPersistence);
  const credential = await signInWithPopup(auth, googleProvider);
  return mapFirebaseUser(credential.user);
}

/**
 * Encerra a sessão ativa do usuário no Firebase Authentication.
 */
export async function logoutUser(): Promise<void> {
  await signOut(auth);
}

/**
 * Atualiza o nome de exibição do usuário autenticado no Firebase Auth e em users/{uid}.
 * Não mascara falhas de persistência: se o Auth ou o Firestore rejeitar a gravação, lança erro explícito.
 */
export async function updateUserDisplayName(newName: string): Promise<string> {
  const cleanName = newName.trim().slice(0, 100);
  if (cleanName.length < 2) {
    throw new Error('O nome de exibição deve conter pelo menos 2 caracteres.');
  }

  const firebaseUser = auth.currentUser;
  if (!firebaseUser) {
    throw new Error('Nenhuma sessão autenticada no Firebase para atualizar o perfil.');
  }

  await updateProfile(firebaseUser, { displayName: cleanName });

  const { doc, setDoc } = await import('firebase/firestore');
  const { db } = await import('./firebase');

  await setDoc(
    doc(db, 'users', firebaseUser.uid),
    {
      uid: firebaseUser.uid,
      name: cleanName,
      displayName: cleanName,
      email: (firebaseUser.email || '').toLowerCase(),
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );

  return cleanName;
}

