import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from './firebase';
import { PersonalCategory, PersonalCategoryType } from '../types/financeV3';
import { universalStorage } from '../utils/universalStorage';

/**
 * ==============================================================================
 * SERVIÇO DE CATEGORIAS INDIVIDUAIS (v3.1)
 * ==============================================================================
 * Caminho Canônico: users/{userId}/categories/{categoryId}
 * Regras:
 * 1. Categorias pertencem estritamente ao usuário autenticado (isolamento físico).
 * 2. Categorias arquivadas não podem ser usadas em novos lançamentos.
 * 3. Não são excluídas fisicamente quando referenciadas no histórico contábil.
 */

const DEMO_CATEGORIES_STORAGE_KEY = 'mpf_v3_demo_categories';

export const DEFAULT_SUGGESTED_CATEGORIES: Omit<PersonalCategory, 'id' | 'userId' | 'createdAt' | 'updatedAt'>[] = [
  // Despesas
  { name: 'Alimentação & Supermercado', type: 'expense', color: '#EF4444', icon: 'utensils', isArchived: false },
  { name: 'Moradia & Contas', type: 'expense', color: '#F97316', icon: 'home', isArchived: false },
  { name: 'Transporte & Combustível', type: 'expense', color: '#EAB308', icon: 'car', isArchived: false },
  { name: 'Saúde & Farmácia', type: 'expense', color: '#EC4899', icon: 'heart-pulse', isArchived: false },
  { name: 'Lazer & Entretenimento', type: 'expense', color: '#8B5CF6', icon: 'film', isArchived: false },
  { name: 'Educação & Cursos', type: 'expense', color: '#3B82F6', icon: 'graduation-cap', isArchived: false },
  { name: 'Compras & Vestuário', type: 'expense', color: '#6366F1', icon: 'shopping-bag', isArchived: false },
  { name: 'Assinaturas & Serviços', type: 'expense', color: '#14B8A6', icon: 'repeat', isArchived: false },
  { name: 'Impostos & Taxas', type: 'expense', color: '#64748B', icon: 'receipt', isArchived: false },
  { name: 'Outras Despesas', type: 'expense', color: '#94A3B8', icon: 'circle-dot', isArchived: false },
  // Receitas
  { name: 'Salário & Remuneração', type: 'income', color: '#10B981', icon: 'briefcase', isArchived: false },
  { name: 'Rendimentos & Investimentos', type: 'income', color: '#059669', icon: 'trending-up', isArchived: false },
  { name: 'Vendas & Serviços Extras', type: 'income', color: '#047857', icon: 'badge-percent', isArchived: false },
  { name: 'Reembolsos & Devoluções', type: 'income', color: '#0D9488', icon: 'rotate-ccw', isArchived: false },
  { name: 'Outras Receitas', type: 'income', color: '#065F46', icon: 'wallet', isArchived: false },
];

function loadDemoCategories(): PersonalCategory[] {
  try {
    const raw = universalStorage.getItem(DEMO_CATEGORIES_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDemoCategories(cats: PersonalCategory[]): void {
  try {
    universalStorage.setItem(DEMO_CATEGORIES_STORAGE_KEY, JSON.stringify(cats));
  } catch (err) {
    console.warn('[DemoCategories] Erro ao salvar categorias:', err);
  }
}

export interface CreateCategoryInput {
  name: string;
  type: PersonalCategoryType;
  color?: string;
  icon?: string;
}

export interface UpdateCategoryInput {
  name?: string;
  type?: PersonalCategoryType;
  color?: string;
  icon?: string;
}

/**
 * Inicializa categorias padrão para um usuário caso ele não possua nenhuma.
 */
export async function ensureDefaultCategories(
  userId: string,
  isDemo = false
): Promise<PersonalCategory[]> {
  const existing = await getUserCategories(userId, true, isDemo);
  if (existing.length > 0) return existing;

  const now = new Date().toISOString();
  const created: PersonalCategory[] = [];

  for (let i = 0; i < DEFAULT_SUGGESTED_CATEGORIES.length; i++) {
    const def = DEFAULT_SUGGESTED_CATEGORIES[i];
    const cat: PersonalCategory = {
      id: `cat_${userId.slice(0, 8)}_${i + 1}_${def.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)}`,
      userId,
      name: def.name,
      type: def.type,
      color: def.color,
      icon: def.icon,
      isArchived: false,
      createdAt: now,
      updatedAt: now,
    };

    if (isDemo) {
      created.push(cat);
    } else {
      const catRef = doc(db, 'users', userId, 'categories', cat.id);
      await setDoc(catRef, cat);
      created.push(cat);
    }
  }

  if (isDemo) {
    const demo = loadDemoCategories();
    saveDemoCategories([...demo, ...created]);
  }

  return created;
}

/**
 * Consulta categorias de um usuário.
 */
export async function getUserCategories(
  userId: string,
  includeArchived = false,
  isDemo = false
): Promise<PersonalCategory[]> {
  if (!userId) return [];

  if (isDemo) {
    const all = loadDemoCategories().filter((c) => c.userId === userId);
    const filtered = includeArchived ? all : all.filter((c) => !c.isArchived);
    return filtered.sort((a, b) => a.name.localeCompare(b.name));
  }

  const collRef = collection(db, 'users', userId, 'categories');
  const q = includeArchived
    ? query(collRef)
    : query(collRef, where('isArchived', '==', false));

  const snap = await getDocs(q);
  const result: PersonalCategory[] = [];
  snap.forEach((d) => result.push({ ...(d.data() as PersonalCategory), id: d.id }));

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Cria nova categoria individual.
 */
export async function createCategory(
  userId: string,
  input: CreateCategoryInput,
  isDemo = false
): Promise<PersonalCategory> {
  const cleanName = input.name?.trim();
  if (!cleanName) {
    throw new Error('O nome da categoria é obrigatório.');
  }

  const now = new Date().toISOString();
  const id = `cat_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  const category: PersonalCategory = {
    id,
    userId,
    name: cleanName,
    type: input.type,
    color: input.color || '#2563EB',
    icon: input.icon || 'tag',
    isArchived: false,
    createdAt: now,
    updatedAt: now,
  };

  if (isDemo) {
    const demo = loadDemoCategories();
    demo.push(category);
    saveDemoCategories(demo);
    return category;
  }

  const catRef = doc(db, 'users', userId, 'categories', id);
  await setDoc(catRef, category);
  return category;
}

/**
 * Atualiza categoria individual.
 */
export async function updateCategory(
  categoryId: string,
  userId: string,
  input: UpdateCategoryInput,
  isDemo = false
): Promise<PersonalCategory> {
  const now = new Date().toISOString();

  if (isDemo) {
    const demo = loadDemoCategories();
    const idx = demo.findIndex((c) => c.id === categoryId && c.userId === userId);
    if (idx === -1) {
      throw new Error(`Categoria "${categoryId}" não encontrada.`);
    }

    const updated: PersonalCategory = {
      ...demo[idx],
      name: input.name !== undefined ? input.name.trim() : demo[idx].name,
      type: input.type !== undefined ? input.type : demo[idx].type,
      color: input.color !== undefined ? input.color : demo[idx].color,
      icon: input.icon !== undefined ? input.icon : demo[idx].icon,
      updatedAt: now,
    };

    demo[idx] = updated;
    saveDemoCategories(demo);
    return updated;
  }

  const catRef = doc(db, 'users', userId, 'categories', categoryId);
  const snap = await getDoc(catRef);
  if (!snap.exists()) {
    throw new Error(`Categoria "${categoryId}" não encontrada.`);
  }

  const existing = snap.data() as PersonalCategory;
  if (existing.userId !== userId) {
    throw new Error('Permissão negada para alterar esta categoria.');
  }

  const patch: Partial<PersonalCategory> = {
    updatedAt: now,
  };
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.type !== undefined) patch.type = input.type;
  if (input.color !== undefined) patch.color = input.color;
  if (input.icon !== undefined) patch.icon = input.icon;

  await updateDoc(catRef, patch);
  return { ...existing, ...patch };
}

/**
 * Arquiva ou desarquiva uma categoria.
 * Não exclui fisicamente para preservar integridade histórica de transações antigas.
 */
export async function archiveCategory(
  categoryId: string,
  userId: string,
  isArchived: boolean,
  isDemo = false
): Promise<PersonalCategory> {
  const now = new Date().toISOString();

  if (isDemo) {
    const demo = loadDemoCategories();
    const idx = demo.findIndex((c) => c.id === categoryId && c.userId === userId);
    if (idx === -1) {
      throw new Error(`Categoria "${categoryId}" não encontrada.`);
    }

    demo[idx].isArchived = isArchived;
    demo[idx].updatedAt = now;
    saveDemoCategories(demo);
    return demo[idx];
  }

  const catRef = doc(db, 'users', userId, 'categories', categoryId);
  const snap = await getDoc(catRef);
  if (!snap.exists()) {
    throw new Error(`Categoria "${categoryId}" não encontrada.`);
  }

  const existing = snap.data() as PersonalCategory;
  if (existing.userId !== userId) {
    throw new Error('Permissão negada para alterar esta categoria.');
  }

  await updateDoc(catRef, { isArchived, updatedAt: now });
  return { ...existing, isArchived, updatedAt: now };
}
