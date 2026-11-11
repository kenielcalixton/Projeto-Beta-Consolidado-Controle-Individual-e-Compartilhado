import {
  CentsInteger,
  ExpenseLiabilitySplitMethod,
} from '../types/financeV3';
import { formatCentsToBRL } from './movementLedger';

/**
 * ==============================================================================
 * MOTOR MATEMÁTICO DE RATEIO DE DESPESAS (SPLIT ENGINE) — ARQUITETURA v3.1
 * ==============================================================================
 * Garante conservação estrita de centavos inteiros (CentsInteger) com desvio zero
 * (zero drift) utilizando o algoritmo determinístico de Maior Resto
 * (Largest Remainder Method / Hamilton / Hare-Niemeyer).
 */

export interface SplitParticipant {
  uid: string;
  name: string;
}

export interface SplitCalculationParams {
  totalAmountCents: CentsInteger;
  splitMethod: ExpenseLiabilitySplitMethod;
  participants: SplitParticipant[];
  percentages?: Record<string, number>;
  customValues?: Record<string, CentsInteger>;
}

export interface SplitLiabilityResult {
  memberUid: string;
  memberName: string;
  assignedShareAmountCents: CentsInteger;
  adjustedShareAmountCents: CentsInteger;
  splitMethod: ExpenseLiabilitySplitMethod;
  splitRatio?: number;
  roundingRemainderRank?: number;
}

/**
 * Calcula a divisão exata de uma despesa coletiva em centavos inteiros,
 * prevenindo qualquer perda, duplicação ou divergência de centavos fracionários.
 */
export function calculateExpenseSplit(params: SplitCalculationParams): SplitLiabilityResult[] {
  const { totalAmountCents, splitMethod, participants, percentages, customValues } = params;

  if (
    typeof totalAmountCents !== 'number' ||
    !Number.isSafeInteger(totalAmountCents) ||
    totalAmountCents <= 0
  ) {
    throw new Error(
      `Montante total inválido para rateio: ${totalAmountCents}. Deve ser um centavo inteiro estritamente positivo.`
    );
  }

  if (!Array.isArray(participants) || participants.length === 0) {
    throw new Error('O rateio exige ao menos 1 participante.');
  }

  // Verifica participantes duplicados
  const uidSet = new Set<string>();
  for (const p of participants) {
    if (!p.uid || !p.uid.trim()) {
      throw new Error('Todos os participantes do rateio devem possuir UID válido.');
    }
    if (uidSet.has(p.uid)) {
      throw new Error(`Participante duplicado no rateio: "${p.uid}".`);
    }
    uidSet.add(p.uid);
  }

  // Ordenação canônica determinística para desempates estáveis
  const sortedParticipants = [...participants].sort((a, b) => a.uid.localeCompare(b.uid));
  const n = sortedParticipants.length;

  // ----------------------------------------------------------------------------
  // 1. RATEIO IGUAL (EQUAL)
  // ----------------------------------------------------------------------------
  if (splitMethod === 'equal') {
    const baseShare = Math.floor(totalAmountCents / n);
    const remainderCents = totalAmountCents % n;

    const results: SplitLiabilityResult[] = sortedParticipants.map((p, index) => {
      // Os primeiros 'remainderCents' participantes recebem +1 centavo
      const hasBonusCent = index < remainderCents;
      const share = hasBonusCent ? baseShare + 1 : baseShare;

      return {
        memberUid: p.uid,
        memberName: p.name,
        assignedShareAmountCents: share,
        adjustedShareAmountCents: share,
        splitMethod: 'equal',
        splitRatio: 1 / n,
        roundingRemainderRank: hasBonusCent ? index + 1 : undefined,
      };
    });

    assertConservation(results, totalAmountCents);
    return results;
  }

  // ----------------------------------------------------------------------------
  // 2. RATEIO POR PERCENTUAL (PERCENTAGE)
  // ----------------------------------------------------------------------------
  if (splitMethod === 'percentage') {
    if (!percentages || typeof percentages !== 'object') {
      throw new Error('Mapeamento de percentuais é obrigatório para a modalidade "percentage".');
    }

    let sumPct = 0;
    for (const p of sortedParticipants) {
      const pct = percentages[p.uid];
      if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0) {
        throw new Error(
          `Percentual inválido para o participante "${p.name}" (${p.uid}): ${pct}. Deve ser um número >= 0.`
        );
      }
      sumPct += pct;
    }

    // Permite tolerância minúscula de ponto flutuante na soma (ex: 33.33 + 33.33 + 33.34 = 100)
    if (Math.abs(sumPct - 100) > 0.05) {
      throw new Error(
        `A soma dos percentuais informados é ${sumPct.toFixed(2)}%, mas deve ser exatamente 100%.`
      );
    }

    // Algoritmo de Maior Resto (Largest Remainder Method)
    interface FractionalCalc {
      participant: SplitParticipant;
      pct: number;
      floorCents: number;
      fraction: number;
    }

    const calcs: FractionalCalc[] = sortedParticipants.map((p) => {
      const pct = percentages[p.uid] || 0;
      const exactCents = (totalAmountCents * pct) / 100;
      const floorCents = Math.floor(exactCents);
      const fraction = exactCents - floorCents;
      return { participant: p, pct, floorCents, fraction };
    });

    const sumFloorCents = calcs.reduce((acc, c) => acc + c.floorCents, 0);
    const remainderCents = totalAmountCents - sumFloorCents;

    // Ordena descrescente pela fração residual, com desempate determinístico por UID
    const ranked = [...calcs].sort((a, b) => {
      if (Math.abs(b.fraction - a.fraction) > 1e-9) {
        return b.fraction - a.fraction;
      }
      return a.participant.uid.localeCompare(b.participant.uid);
    });

    const bonusUids = new Set<string>();
    const bonusRanks = new Map<string, number>();
    for (let i = 0; i < remainderCents; i++) {
      const lucky = ranked[i].participant.uid;
      bonusUids.add(lucky);
      bonusRanks.set(lucky, i + 1);
    }

    const results: SplitLiabilityResult[] = sortedParticipants.map((p) => {
      const calc = calcs.find((c) => c.participant.uid === p.uid)!;
      const hasBonus = bonusUids.has(p.uid);
      const finalCents = calc.floorCents + (hasBonus ? 1 : 0);

      return {
        memberUid: p.uid,
        memberName: p.name,
        assignedShareAmountCents: finalCents,
        adjustedShareAmountCents: finalCents,
        splitMethod: 'percentage',
        splitRatio: calc.pct / 100,
        roundingRemainderRank: bonusRanks.get(p.uid),
      };
    });

    assertConservation(results, totalAmountCents);
    return results;
  }

  // ----------------------------------------------------------------------------
  // 3. RATEIO POR VALORES PERSONALIZADOS (CUSTOM_VALUE)
  // ----------------------------------------------------------------------------
  if (splitMethod === 'custom_value') {
    if (!customValues || typeof customValues !== 'object') {
      throw new Error(
        'Mapeamento de valores em centavos é obrigatório para a modalidade "custom_value".'
      );
    }

    let sumCustomCents = 0;
    const results: SplitLiabilityResult[] = sortedParticipants.map((p) => {
      const val = customValues[p.uid];
      if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < 0) {
        throw new Error(
          `Valor em centavos inválido para o participante "${p.name}" (${p.uid}): ${val}. Deve ser um centavo inteiro >= 0.`
        );
      }
      sumCustomCents += val;

      return {
        memberUid: p.uid,
        memberName: p.name,
        assignedShareAmountCents: val,
        adjustedShareAmountCents: val,
        splitMethod: 'custom_value',
        splitRatio: totalAmountCents > 0 ? val / totalAmountCents : 0,
      };
    });

    if (sumCustomCents !== totalAmountCents) {
      const diff = totalAmountCents - sumCustomCents;
      const diffFormatted = formatCentsToBRL(Math.abs(diff));
      const direction = diff > 0 ? 'faltando' : 'excedendo';
      throw new Error(
        `A soma dos valores individuais (${formatCentsToBRL(sumCustomCents)}) não confere com o total da despesa (${formatCentsToBRL(totalAmountCents)}). Diferença de ${diffFormatted} ${direction}.`
      );
    }

    assertConservation(results, totalAmountCents);
    return results;
  }

  throw new Error(`Método de rateio desconhecido: "${splitMethod}".`);
}

/**
 * Invariante Contábil: Garante que a soma das cotas alocadas é estritamente igual
 * ao montante total da despesa, sem 1 único centavo de desvio.
 */
function assertConservation(results: SplitLiabilityResult[], totalCents: CentsInteger): void {
  const sum = results.reduce((acc, r) => acc + r.assignedShareAmountCents, 0);
  if (sum !== totalCents) {
    throw new Error(
      `Violação de conservação contábil no rateio: Soma calculada = ${sum} centavos, Total esperado = ${totalCents} centavos.`
    );
  }
}
