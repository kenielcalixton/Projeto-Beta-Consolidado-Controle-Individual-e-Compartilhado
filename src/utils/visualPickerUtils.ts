/**
 * ==============================================================================
 * UTILITÁRIOS DE SELEÇÃO VISUAL DE ÍCONES E CORES (v3.1)
 * ==============================================================================
 * Mantém compatibilidade bidirecional entre:
 * - Ícones Phosphor (`ph-*`)
 * - Nomes legados sem prefixo usados em DEFAULT_SUGGESTED_CATEGORIES
 * - Nomes de cor legados (`indigo`, `emerald`, etc.) e códigos hex (`#RRGGBB`)
 */

export interface VisualIconOption {
  id: string;
  label: string;
  phosphorClass: string;
}

export interface VisualColorOption {
  id: string;
  label: string;
  hex: string;
}

export const VISUAL_ICON_OPTIONS: VisualIconOption[] = [
  { id: 'ph-tag', label: 'Etiqueta / Geral', phosphorClass: 'ph-tag' },
  { id: 'ph-fork-knife', label: 'Alimentação', phosphorClass: 'ph-fork-knife' },
  { id: 'ph-shopping-cart', label: 'Mercado', phosphorClass: 'ph-shopping-cart' },
  { id: 'ph-shopping-bag', label: 'Compras', phosphorClass: 'ph-shopping-bag' },
  { id: 'ph-house-line', label: 'Moradia', phosphorClass: 'ph-house-line' },
  { id: 'ph-car', label: 'Transporte', phosphorClass: 'ph-car' },
  { id: 'ph-airplane-tilt', label: 'Viagem', phosphorClass: 'ph-airplane-tilt' },
  { id: 'ph-heartbeat', label: 'Saúde', phosphorClass: 'ph-heartbeat' },
  { id: 'ph-film-strip', label: 'Lazer', phosphorClass: 'ph-film-strip' },
  { id: 'ph-graduation-cap', label: 'Educação', phosphorClass: 'ph-graduation-cap' },
  { id: 'ph-laptop', label: 'Tecnologia', phosphorClass: 'ph-laptop' },
  { id: 'ph-briefcase', label: 'Trabalho', phosphorClass: 'ph-briefcase' },
  { id: 'ph-repeat', label: 'Assinaturas', phosphorClass: 'ph-repeat' },
  { id: 'ph-receipt', label: 'Contas / Taxas', phosphorClass: 'ph-receipt' },
  { id: 'ph-trend-up', label: 'Investimentos', phosphorClass: 'ph-trend-up' },
  { id: 'ph-wallet', label: 'Carteira / Saldo', phosphorClass: 'ph-wallet' },
  { id: 'ph-percent', label: 'Vendas / Extras', phosphorClass: 'ph-percent' },
  { id: 'ph-arrow-counter-clockwise', label: 'Reembolsos', phosphorClass: 'ph-arrow-counter-clockwise' },
  { id: 'ph-lightbulb', label: 'Energia / Utilidades', phosphorClass: 'ph-lightbulb' },
  { id: 'ph-paw-print', label: 'Pets', phosphorClass: 'ph-paw-print' },
  { id: 'ph-gift', label: 'Presentes', phosphorClass: 'ph-gift' },
  { id: 'ph-coins', label: 'Economias', phosphorClass: 'ph-coins' },
  { id: 'ph-users-three', label: 'Grupo / Espaço', phosphorClass: 'ph-users-three' },
  { id: 'ph-heart', label: 'Casal / Família', phosphorClass: 'ph-heart' },
];

export const SPACE_ICON_OPTIONS: VisualIconOption[] = [
  { id: 'ph-users-three', label: 'Grupo / Pessoas', phosphorClass: 'ph-users-three' },
  { id: 'ph-house-line', label: 'Moradia / República', phosphorClass: 'ph-house-line' },
  { id: 'ph-airplane-tilt', label: 'Viagem', phosphorClass: 'ph-airplane-tilt' },
  { id: 'ph-heart', label: 'Casal / Parceria', phosphorClass: 'ph-heart' },
  { id: 'ph-briefcase', label: 'Projeto', phosphorClass: 'ph-briefcase' },
  { id: 'ph-shopping-cart', label: 'Compras da Casa', phosphorClass: 'ph-shopping-cart' },
  { id: 'ph-coins', label: 'Fundo Comum', phosphorClass: 'ph-coins' },
  { id: 'ph-calendar-check', label: 'Evento', phosphorClass: 'ph-calendar-check' },
];

export const CURATED_COLOR_PALETTE: VisualColorOption[] = [
  { id: 'indigo', label: 'Índigo', hex: '#4F46E5' },
  { id: 'blue', label: 'Azul', hex: '#2563EB' },
  { id: 'sky', label: 'Celeste', hex: '#0284C7' },
  { id: 'teal', label: 'Turquesa', hex: '#0D9488' },
  { id: 'emerald', label: 'Esmeralda', hex: '#10B981' },
  { id: 'amber', label: 'Âmbar', hex: '#D97706' },
  { id: 'orange', label: 'Laranja', hex: '#EA580C' },
  { id: 'rose', label: 'Rosa / Vermelho', hex: '#E11D48' },
  { id: 'purple', label: 'Roxo', hex: '#7C3AED' },
  { id: 'pink', label: 'Magenta', hex: '#DB2777' },
  { id: 'slate', label: 'Ardósia', hex: '#475569' },
  { id: 'lime', label: 'Lima', hex: '#65A30D' },
];

const UNPREFIXED_TO_PHOSPHOR: Record<string, string> = {
  utensils: 'ph-fork-knife',
  home: 'ph-house-line',
  car: 'ph-car',
  'heart-pulse': 'ph-heartbeat',
  film: 'ph-film-strip',
  'graduation-cap': 'ph-graduation-cap',
  'shopping-bag': 'ph-shopping-bag',
  repeat: 'ph-repeat',
  receipt: 'ph-receipt',
  'circle-dot': 'ph-dots-three-circle',
  briefcase: 'ph-briefcase',
  'trending-up': 'ph-trend-up',
  'badge-percent': 'ph-percent',
  'rotate-ccw': 'ph-arrow-counter-clockwise',
  wallet: 'ph-wallet',
  tag: 'ph-tag',
  'users-three': 'ph-users-three',
  'house-line': 'ph-house-line',
  'airplane-tilt': 'ph-airplane-tilt',
  heart: 'ph-heart',
  coins: 'ph-coins',
};

const COLOR_TOKEN_TO_HEX: Record<string, string> = {
  indigo: '#4F46E5',
  blue: '#2563EB',
  sky: '#0284C7',
  teal: '#0D9488',
  emerald: '#10B981',
  amber: '#D97706',
  orange: '#EA580C',
  rose: '#E11D48',
  purple: '#7C3AED',
  pink: '#DB2777',
  slate: '#475569',
  lime: '#65A30D',
};

export function resolvePhosphorCategoryIcon(rawIcon?: string | null): string {
  const clean = (rawIcon || '').trim();
  if (!clean) return 'ph-tag';
  if (clean.startsWith('ph-')) return clean;
  return UNPREFIXED_TO_PHOSPHOR[clean] || `ph-${clean}`;
}

export function resolveHexColor(colorOrToken?: string | null, fallback = '#4F46E5'): string {
  const clean = (colorOrToken || '').trim();
  if (!clean) return fallback;
  if (/^#[0-9A-Fa-f]{6}$/.test(clean)) return clean.toUpperCase();
  if (/^#[0-9A-Fa-f]{3}$/.test(clean)) {
    const r = clean[1];
    const g = clean[2];
    const b = clean[3];
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  const byToken = COLOR_TOKEN_TO_HEX[clean.toLowerCase()];
  return byToken || fallback;
}

export function resolveColorTokenFromValue(colorOrToken?: string | null): string {
  const hex = resolveHexColor(colorOrToken);
  const found = CURATED_COLOR_PALETTE.find(
    (c) => c.hex.toUpperCase() === hex.toUpperCase()
  );
  return found ? found.id : hex;
}
