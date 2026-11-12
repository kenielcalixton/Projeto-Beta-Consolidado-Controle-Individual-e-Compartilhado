/**
 * Serviço de Recorrências e Parcelamentos Desacoplados (Fase 9 - Arquitetura v3.1)
 *
 * Suporta modo Real (Firestore + Cloud Functions Admin SDK) e modo Demo (universalStorage + withDemoLock).
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from './firebase';
import {
  RecurrenceRule,
  RecurrenceRuleScope,
  RecurrenceRuleFrequency,
  RecurrenceRuleStatus,
  RecurrenceInstance,
  RecurrenceInstanceGenerationStatus,
  InstallmentContract,
  InstallmentContractScope,
  InstallmentContractFundingSource,
  InstallmentContractStatus,
  InstallmentOccurrence,
  InstallmentOccurrenceStatus,
  CentsInteger,
  CompetenceMonthString,
  DateString,
  ISO8601String,
} from '../types/financeV3';
import { validatePositiveCents } from '../utils/movementLedger';
import { universalStorage } from '../utils/universalStorage';
import { withDemoLock } from './ledgerService';

// ------------------------------------------------------------------------------
// CHAVES DE ARMAZENAMENTO DEMO
// ------------------------------------------------------------------------------
const DEMO_RECURRENCE_RULES_KEY = 'demo_recurrence_rules_v3';
const DEMO_RECURRENCE_INSTANCES_KEY = 'demo_recurrence_instances_v3';
const DEMO_INSTALLMENT_CONTRACTS_KEY = 'demo_installment_contracts_v3';
const DEMO_INSTALLMENT_OCCURRENCES_KEY = 'demo_installment_occurrences_v3';

// ------------------------------------------------------------------------------
// DEMO STORAGE LOADERS / SAVERS
// ------------------------------------------------------------------------------
function loadDemoRecurrenceRules(): RecurrenceRule[] {
  const raw = universalStorage.getItem(DEMO_RECURRENCE_RULES_KEY);
  return raw ? JSON.parse(raw) : [];
}

function saveDemoRecurrenceRules(data: RecurrenceRule[]): void {
  universalStorage.setItem(DEMO_RECURRENCE_RULES_KEY, JSON.stringify(data));
}

function loadDemoRecurrenceInstances(): RecurrenceInstance[] {
  const raw = universalStorage.getItem(DEMO_RECURRENCE_INSTANCES_KEY);
  return raw ? JSON.parse(raw) : [];
}

function saveDemoRecurrenceInstances(data: RecurrenceInstance[]): void {
  universalStorage.setItem(DEMO_RECURRENCE_INSTANCES_KEY, JSON.stringify(data));
}

function loadDemoInstallmentContracts(): InstallmentContract[] {
  const raw = universalStorage.getItem(DEMO_INSTALLMENT_CONTRACTS_KEY);
  return raw ? JSON.parse(raw) : [];
}

function saveDemoInstallmentContracts(data: InstallmentContract[]): void {
  universalStorage.setItem(DEMO_INSTALLMENT_CONTRACTS_KEY, JSON.stringify(data));
}

function loadDemoInstallmentOccurrences(): InstallmentOccurrence[] {
  const raw = universalStorage.getItem(DEMO_INSTALLMENT_OCCURRENCES_KEY);
  return raw ? JSON.parse(raw) : [];
}

function saveDemoInstallmentOccurrences(data: InstallmentOccurrence[]): void {
  universalStorage.setItem(DEMO_INSTALLMENT_OCCURRENCES_KEY, JSON.stringify(data));
}

// ------------------------------------------------------------------------------
// FUNÇÕES AUXILIARES DE HASH E ID DETERMINÍSTICO
// ------------------------------------------------------------------------------
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  const hex = (hash >>> 0).toString(16);
  return hex.padStart(8, '0');
}

export function generateRecurrenceRuleDocId(userId: string, idempotencyKey: string): string {
  const cleanUid = (userId || '').trim();
  const cleanKey = (idempotencyKey || '').trim();
  const cleanSlug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
  const hash = simpleHash(`rec_rule:${cleanUid}:${cleanKey}`);
  return `rec_${cleanSlug ? `${cleanSlug}_` : ''}${hash}`;
}

export function generateInstallmentContractDocId(userId: string, idempotencyKey: string): string {
  const cleanUid = (userId || '').trim();
  const cleanKey = (idempotencyKey || '').trim();
  const cleanSlug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
  const hash = simpleHash(`inst_contract:${cleanUid}:${cleanKey}`);
  return `inst_${cleanSlug ? `${cleanSlug}_` : ''}${hash}`;
}

function cleanUndefined<T extends Record<string, any>>(obj: T): T {
  const cleaned: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      cleaned[key] = value;
    }
  }
  return cleaned as T;
}

// ------------------------------------------------------------------------------
// INTERFACES DE PARÂMETROS
// ------------------------------------------------------------------------------

export interface CreateRecurrenceRuleParams {
  scope: RecurrenceRuleScope;
  userId: string;
  spaceId?: string;
  title: string;
  description?: string;
  amountCents: CentsInteger;
  frequency?: RecurrenceRuleFrequency;
  interval?: number;
  startCompetence: CompetenceMonthString;
  endCompetence?: CompetenceMonthString;
  dueDay: number;
  categoryId?: string;
  defaultAccountId?: string;
  idempotencyKey: string;
}

export interface GenerateRecurrenceInstanceParams {
  ruleId: string;
  competenceMonth: CompetenceMonthString;
}

export interface UpdateRecurrenceRuleStatusParams {
  ruleId: string;
  status: RecurrenceRuleStatus;
}

export interface CreateInstallmentContractParams {
  scope: InstallmentContractScope;
  userId: string;
  spaceId?: string;
  title: string;
  totalContractAmountCents: CentsInteger;
  totalInstallmentsCount: number;
  fundingSource?: InstallmentContractFundingSource;
  sourceCardAccountId?: string;
  startCompetenceMonth: CompetenceMonthString;
  dueDay?: number;
  idempotencyKey: string;
}

export interface CancelInstallmentContractParams {
  contractId: string;
  cancellationReason?: string;
}

// ------------------------------------------------------------------------------
// IMPLEMENTAÇÃO DE RECORRÊNCIAS
// ------------------------------------------------------------------------------

export async function createRecurrenceRule(
  params: CreateRecurrenceRuleParams,
  isDemo = false
): Promise<{ rule: RecurrenceRule; isIdempotentReplay: boolean }> {
  if (!validatePositiveCents(params.amountCents)) {
    throw new Error('amountCents deve ser um inteiro positivo em centavos.');
  }
  if (!params.title?.trim()) throw new Error('title é obrigatório.');
  if (!/^\d{4}-\d{2}$/.test(params.startCompetence)) {
    throw new Error('startCompetence deve estar no formato YYYY-MM.');
  }
  if (params.dueDay < 1 || params.dueDay > 31) {
    throw new Error('dueDay deve estar entre 1 e 31.');
  }
  if (!params.idempotencyKey?.trim()) {
    throw new Error('idempotencyKey é obrigatória.');
  }

  if (isDemo) {
    return await withDemoLock(async () => {
      const existingRules = loadDemoRecurrenceRules();
      const ruleId = generateRecurrenceRuleDocId(params.userId, params.idempotencyKey);

      const found = existingRules.find((r) => r.id === ruleId);
      if (found) {
        return { rule: found, isIdempotentReplay: true };
      }

      const now = new Date().toISOString();
      const newRule: RecurrenceRule = cleanUndefined({
        id: ruleId,
        scope: params.scope,
        userId: params.userId,
        spaceId: params.spaceId,
        title: params.title.trim(),
        description: params.description?.trim(),
        amountCents: params.amountCents,
        frequency: params.frequency || 'monthly',
        interval: params.interval || 1,
        startCompetence: params.startCompetence,
        endCompetence: params.endCompetence,
        dueDay: params.dueDay,
        categoryId: params.categoryId || 'cat_default',
        defaultAccountId: params.defaultAccountId,
        status: 'active',
        createdAt: now,
      });

      existingRules.push(newRule);
      saveDemoRecurrenceRules(existingRules);

      return { rule: newRule, isIdempotentReplay: false };
    });
  }

  const fn = httpsCallable(functions, 'createRecurrenceRuleOfficial');
  const result = await fn(params);
  return result.data as { rule: RecurrenceRule; isIdempotentReplay: boolean };
}

export async function generateRecurrenceInstance(
  params: GenerateRecurrenceInstanceParams,
  isDemo = false
): Promise<{ instance: RecurrenceInstance; isIdempotentReplay: boolean }> {
  if (!params.ruleId?.trim()) throw new Error('ruleId é obrigatório.');
  if (!/^\d{4}-\d{2}$/.test(params.competenceMonth)) {
    throw new Error('competenceMonth deve estar no formato YYYY-MM.');
  }

  if (isDemo) {
    return await withDemoLock(async () => {
      const rules = loadDemoRecurrenceRules();
      const rule = rules.find((r) => r.id === params.ruleId);
      if (!rule) throw new Error('Regra de recorrência não encontrada.');
      if (rule.status === 'cancelled') {
        throw new Error('Regra de recorrência está cancelada.');
      }

      const instances = loadDemoRecurrenceInstances();
      const found = instances.find(
        (i) => i.ruleId === params.ruleId && i.competenceMonth === params.competenceMonth
      );
      if (found) {
        return { instance: found, isIdempotentReplay: true };
      }

      const now = new Date().toISOString();
      const newInstance: RecurrenceInstance = cleanUndefined({
        id: params.competenceMonth,
        ruleId: params.ruleId,
        competenceMonth: params.competenceMonth,
        generationStatus: 'generated',
        actualAmountCents: rule.amountCents,
        generatedAt: now,
      });

      instances.push(newInstance);
      saveDemoRecurrenceInstances(instances);

      return { instance: newInstance, isIdempotentReplay: false };
    });
  }

  const fn = httpsCallable(functions, 'generateRecurrenceInstanceOfficial');
  const result = await fn(params);
  return result.data as { instance: RecurrenceInstance; isIdempotentReplay: boolean };
}

export async function updateRecurrenceRuleStatus(
  params: UpdateRecurrenceRuleStatusParams,
  isDemo = false
): Promise<{ rule: RecurrenceRule }> {
  if (!params.ruleId?.trim()) throw new Error('ruleId é obrigatório.');

  if (isDemo) {
    return await withDemoLock(async () => {
      const rules = loadDemoRecurrenceRules();
      const idx = rules.findIndex((r) => r.id === params.ruleId);
      if (idx === -1) throw new Error('Regra de recorrência não encontrada.');

      rules[idx] = { ...rules[idx], status: params.status };
      saveDemoRecurrenceRules(rules);

      return { rule: rules[idx] };
    });
  }

  const ruleRef = doc(db, 'recurrence_rules', params.ruleId);
  await updateDoc(ruleRef, { status: params.status });
  const snap = await getDoc(ruleRef);
  return { rule: snap.data() as RecurrenceRule };
}

export async function getRecurrenceRules(
  filters: { userId?: string; spaceId?: string; scope?: RecurrenceRuleScope },
  isDemo = false
): Promise<RecurrenceRule[]> {
  if (isDemo) {
    const rules = loadDemoRecurrenceRules();
    return rules.filter((r) => {
      if (filters.scope && r.scope !== filters.scope) return false;
      if (filters.userId && r.userId !== filters.userId) return false;
      if (filters.spaceId && r.spaceId !== filters.spaceId) return false;
      return true;
    });
  }

  const colRef = collection(db, 'recurrence_rules');
  const constraints: any[] = [];
  if (filters.scope) constraints.push(where('scope', '==', filters.scope));
  if (filters.userId) constraints.push(where('userId', '==', filters.userId));
  if (filters.spaceId) constraints.push(where('spaceId', '==', filters.spaceId));

  const q = query(colRef, ...constraints);
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as RecurrenceRule);
}

export async function getRecurrenceRuleById(
  ruleId: string,
  isDemo = false
): Promise<RecurrenceRule | null> {
  if (isDemo) {
    const rules = loadDemoRecurrenceRules();
    return rules.find((r) => r.id === ruleId) || null;
  }

  const snap = await getDoc(doc(db, 'recurrence_rules', ruleId));
  if (!snap.exists()) return null;
  return snap.data() as RecurrenceRule;
}

export async function getRecurrenceInstances(
  ruleId: string,
  isDemo = false
): Promise<RecurrenceInstance[]> {
  if (isDemo) {
    const instances = loadDemoRecurrenceInstances();
    return instances.filter((i) => i.ruleId === ruleId);
  }

  const colRef = collection(db, 'recurrence_rules', ruleId, 'instances');
  const snap = await getDocs(colRef);
  return snap.docs.map((d) => d.data() as RecurrenceInstance);
}

// ------------------------------------------------------------------------------
// IMPLEMENTAÇÃO DE PARCELAMENTOS
// ------------------------------------------------------------------------------

export async function createInstallmentContract(
  params: CreateInstallmentContractParams,
  isDemo = false
): Promise<{ contract: InstallmentContract; isIdempotentReplay: boolean }> {
  if (!validatePositiveCents(params.totalContractAmountCents)) {
    throw new Error('totalContractAmountCents deve ser um inteiro positivo em centavos.');
  }
  if (!params.title?.trim()) throw new Error('title é obrigatório.');
  if (
    !Number.isSafeInteger(params.totalInstallmentsCount) ||
    params.totalInstallmentsCount < 2
  ) {
    throw new Error('totalInstallmentsCount deve ser no mínimo 2 parcelas.');
  }
  if (!/^\d{4}-\d{2}$/.test(params.startCompetenceMonth)) {
    throw new Error('startCompetenceMonth deve estar no formato YYYY-MM.');
  }
  if (!params.idempotencyKey?.trim()) {
    throw new Error('idempotencyKey é obrigatória.');
  }

  const dueDay = params.dueDay || 10;

  if (isDemo) {
    return await withDemoLock(async () => {
      const contracts = loadDemoInstallmentContracts();
      const contractId = generateInstallmentContractDocId(
        params.userId,
        params.idempotencyKey
      );

      const found = contracts.find((c) => c.id === contractId);
      if (found) {
        return { contract: found, isIdempotentReplay: true };
      }

      const now = new Date().toISOString();
      const newContract: InstallmentContract = cleanUndefined({
        id: contractId,
        scope: params.scope,
        userId: params.userId,
        spaceId: params.spaceId,
        title: params.title.trim(),
        totalContractAmountCents: params.totalContractAmountCents,
        totalInstallmentsCount: params.totalInstallmentsCount,
        fundingSource: params.fundingSource || 'credit_card',
        sourceCardAccountId: params.sourceCardAccountId,
        startCompetenceMonth: params.startCompetenceMonth,
        status: 'active',
        createdAt: now,
      });

      contracts.push(newContract);
      saveDemoInstallmentContracts(contracts);

      // Divisão estrita com conservação contábil
      const baseInstallment = Math.floor(
        params.totalContractAmountCents / params.totalInstallmentsCount
      );
      const remainder =
        params.totalContractAmountCents -
        baseInstallment * params.totalInstallmentsCount;

      const occurrences = loadDemoInstallmentOccurrences();

      const [startYearStr, startMonthStr] = params.startCompetenceMonth.split('-');
      let curYear = parseInt(startYearStr, 10);
      let curMonth = parseInt(startMonthStr, 10);

      for (let i = 1; i <= params.totalInstallmentsCount; i++) {
        const monthPadded = String(curMonth).padStart(2, '0');
        const compMonth = `${curYear}-${monthPadded}`;
        const dayPadded = String(dueDay).padStart(2, '0');
        const dueDate = `${compMonth}-${dayPadded}`;
        const occId = String(i).padStart(2, '0');

        const principalAmountCents =
          i === 1 ? baseInstallment + remainder : baseInstallment;

        const occurrenceDoc: InstallmentOccurrence = cleanUndefined({
          id: occId,
          contractId,
          installmentNumber: i,
          competenceMonth: compMonth,
          principalAmountCents,
          interestAmountCents: 0,
          totalInstallmentAmountCents: principalAmountCents,
          status: 'scheduled',
          dueDate,
        });

        occurrences.push(occurrenceDoc);

        curMonth++;
        if (curMonth > 12) {
          curMonth = 1;
          curYear++;
        }
      }

      saveDemoInstallmentOccurrences(occurrences);

      return { contract: newContract, isIdempotentReplay: false };
    });
  }

  const fn = httpsCallable(functions, 'createInstallmentContractOfficial');
  const result = await fn(params);
  return result.data as { contract: InstallmentContract; isIdempotentReplay: boolean };
}

export async function cancelInstallmentContract(
  params: CancelInstallmentContractParams,
  isDemo = false
): Promise<{
  contract: InstallmentContract;
  cancelledCount: number;
  isIdempotentReplay: boolean;
}> {
  if (!params.contractId?.trim()) throw new Error('contractId é obrigatório.');

  if (isDemo) {
    return await withDemoLock(async () => {
      const contracts = loadDemoInstallmentContracts();
      const idx = contracts.findIndex((c) => c.id === params.contractId);
      if (idx === -1) throw new Error('Contrato de parcelamento não encontrado.');

      const contract = contracts[idx];
      const cancellationReason = params.cancellationReason || 'Cancelamento antecipado';

      const updatedContract: InstallmentContract = {
        ...contract,
        status: 'cancelled_early',
        cancellationReason,
      };
      contracts[idx] = updatedContract;
      saveDemoInstallmentContracts(contracts);

      const occurrences = loadDemoInstallmentOccurrences();

      let cancelledCount = 0;
      for (let i = 0; i < occurrences.length; i++) {
        if (
          occurrences[i].contractId === params.contractId &&
          occurrences[i].status === 'scheduled'
        ) {
          occurrences[i] = { ...occurrences[i], status: 'cancelled' };
          cancelledCount++;
        }
      }

      saveDemoInstallmentOccurrences(occurrences);

      return {
        contract: updatedContract,
        cancelledCount,
        isIdempotentReplay: false,
      };
    });
  }

  const fn = httpsCallable(functions, 'cancelInstallmentContractOfficial');
  const result = await fn(params);
  return result.data as {
    contract: InstallmentContract;
    cancelledCount: number;
    isIdempotentReplay: boolean;
  };
}

export async function getInstallmentContracts(
  filters: { userId?: string; spaceId?: string; scope?: InstallmentContractScope },
  isDemo = false
): Promise<InstallmentContract[]> {
  if (isDemo) {
    const contracts = loadDemoInstallmentContracts();
    return contracts.filter((c) => {
      if (filters.scope && c.scope !== filters.scope) return false;
      if (filters.userId && c.userId !== filters.userId) return false;
      if (filters.spaceId && c.spaceId !== filters.spaceId) return false;
      return true;
    });
  }

  const colRef = collection(db, 'installment_contracts');
  const constraints: any[] = [];
  if (filters.scope) constraints.push(where('scope', '==', filters.scope));
  if (filters.userId) constraints.push(where('userId', '==', filters.userId));
  if (filters.spaceId) constraints.push(where('spaceId', '==', filters.spaceId));

  const q = query(colRef, ...constraints);
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as InstallmentContract);
}

export async function getInstallmentContractById(
  contractId: string,
  isDemo = false
): Promise<InstallmentContract | null> {
  if (isDemo) {
    const contracts = loadDemoInstallmentContracts();
    return contracts.find((c) => c.id === contractId) || null;
  }

  const snap = await getDoc(doc(db, 'installment_contracts', contractId));
  if (!snap.exists()) return null;
  return snap.data() as InstallmentContract;
}

export async function getInstallmentOccurrences(
  contractId: string,
  isDemo = false
): Promise<InstallmentOccurrence[]> {
  if (isDemo) {
    const occurrences = loadDemoInstallmentOccurrences();
    return occurrences
      .filter((o) => o.contractId === contractId)
      .sort((a, b) => a.installmentNumber - b.installmentNumber);
  }

  const colRef = collection(db, 'installment_contracts', contractId, 'occurrences');
  const snap = await getDocs(colRef);
  return snap.docs
    .map((d) => d.data() as InstallmentOccurrence)
    .sort((a, b) => a.installmentNumber - b.installmentNumber);
}
