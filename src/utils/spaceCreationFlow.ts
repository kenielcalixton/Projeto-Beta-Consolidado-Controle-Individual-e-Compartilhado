import { Space, SpaceMember, SpaceModuleType } from '../types/financeV3';

export interface SpaceCreationFormSnapshot {
  name: string;
  description: string;
  color: string;
  icon: string;
  enabledModules: SpaceModuleType[];
  monthlyBudgetCents: number;
}

export interface SpaceCreationResult {
  space: Space;
  member: SpaceMember;
  isIdempotentReplay?: boolean;
}

export interface SpaceCreationControllerState {
  isModalOpen: boolean;
  isSubmitting: boolean;
  modalError: string | null;
  feedbackMessage: { type: 'success' | 'error'; text: string } | null;
  attemptKey: string;
  form: SpaceCreationFormSnapshot;
  spaces: Space[];
  selectedSpace: Space | null;
  spaceFilter: 'active' | 'historical' | 'all';
}

/**
 * Gera uma chave de idempotência por tentativa de criação no formulário.
 * Nunca utiliza o nome do espaço, permitindo que o usuário crie múltiplos
 * espaços distintos (inclusive com nomes semelhantes ou repetidos se desejar).
 */
export function createSpaceAttemptKey(): string {
  const randomUuid =
    typeof globalThis !== 'undefined' &&
    globalThis.crypto &&
    typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return `attempt_${randomUuid}`;
}

/**
 * Insere ou atualiza um espaço na listagem local sem duplicação por `id`
 * e preservando ordenação alfabética consistente com `getUserSpaces`.
 */
export function mergeSpaceListItem(spaces: Space[], createdSpace: Space): Space[] {
  const map = new Map<string, Space>();
  for (const s of spaces) {
    if (s && s.id) map.set(s.id, s);
  }
  map.set(createdSpace.id, createdSpace);
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function extractFriendlySpaceCreationError(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const raw = String((err as { message?: unknown }).message || '').trim();
    if (raw) {
      // Remove prefixos técnicos comuns de Firebase Functions quando presentes
      return raw.replace(/^FirebaseError:\s*/i, '').trim();
    }
  }
  return 'Não foi possível criar o espaço compartilhado. Verifique sua conexão e tente novamente.';
}

export interface ExecuteSpaceCreationArgs {
  inFlightRef: { current: boolean };
  isSubmittingState: boolean;
  attemptKey: string;
  form: SpaceCreationFormSnapshot;
  submitFn: (resolvedAttemptKey: string) => Promise<SpaceCreationResult>;
  onStart: (resolvedAttemptKey: string) => void;
  onSuccess: (result: SpaceCreationResult) => Promise<void> | void;
  onError: (friendlyMessage: string) => void;
  onFinish: () => void;
}

/**
 * Executa a submissão do formulário de criação de espaço com trava síncrona contra
 * duplo clique, aguarda confirmação real do backend antes de fechar o modal,
 * e garante preservação integral dos campos + `attemptKey` em caso de erro.
 */
export async function executeSpaceCreationSubmission(
  args: ExecuteSpaceCreationArgs
): Promise<{ status: 'ignored_in_flight' | 'validation_error' | 'succeeded' | 'failed'; error?: string }> {
  const {
    inFlightRef,
    isSubmittingState,
    attemptKey,
    form,
    submitFn,
    onStart,
    onSuccess,
    onError,
    onFinish,
  } = args;

  // Bloqueio síncrono imediato antes do próximo render do React
  if (inFlightRef.current || isSubmittingState) {
    return { status: 'ignored_in_flight' };
  }

  if (!form.name.trim()) {
    const msg = 'Informe o nome do espaço compartilhado.';
    onError(msg);
    return { status: 'validation_error', error: msg };
  }

  if (!Array.isArray(form.enabledModules) || form.enabledModules.length === 0) {
    const msg = 'Selecione ao menos um módulo para o espaço compartilhado.';
    onError(msg);
    return { status: 'validation_error', error: msg };
  }

  const resolvedAttemptKey = attemptKey.trim() || createSpaceAttemptKey();
  inFlightRef.current = true;
  onStart(resolvedAttemptKey);

  try {
    const result = await submitFn(resolvedAttemptKey);
    await onSuccess(result);
    return { status: 'succeeded' };
  } catch (err: unknown) {
    const msg = extractFriendlySpaceCreationError(err);
    onError(msg);
    return { status: 'failed', error: msg };
  } finally {
    inFlightRef.current = false;
    onFinish();
  }
}
