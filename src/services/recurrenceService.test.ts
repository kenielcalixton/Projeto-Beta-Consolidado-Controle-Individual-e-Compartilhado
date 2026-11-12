import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRecurrenceRule,
  generateRecurrenceInstance,
  updateRecurrenceRuleStatus,
  getRecurrenceRules,
  getRecurrenceRuleById,
  getRecurrenceInstances,
  createInstallmentContract,
  cancelInstallmentContract,
  getInstallmentContracts,
  getInstallmentContractById,
  getInstallmentOccurrences,
} from './recurrenceService';
import { universalStorage } from '../utils/universalStorage';
import { InstallmentOccurrence } from '../types/financeV3';

describe('RecurrenceService (Fase 9 - Recorrências e Parcelamentos Desacoplados)', () => {
  beforeEach(() => {
    universalStorage.clear();
  });

  describe('Recurrence Rules & Instances', () => {
    it('cria regra de recorrência com sucesso em modo demo', async () => {
      const res = await createRecurrenceRule(
        {
          scope: 'personal',
          userId: 'user_rec_1',
          title: 'Assinatura Streaming',
          amountCents: 3990,
          frequency: 'monthly',
          startCompetence: '2026-01',
          dueDay: 15,
          idempotencyKey: 'idem_rec_rule_01',
        },
        true
      );

      assert.equal(res.isIdempotentReplay, false);
      assert.ok(res.rule.id.includes('rec_idem_rec_rule_01'));
      assert.equal(res.rule.title, 'Assinatura Streaming');
      assert.equal(res.rule.amountCents, 3990);
      assert.equal(res.rule.dueDay, 15);
      assert.equal(res.rule.status, 'active');
    });

    it('reproduz idempotência ao tentar recriar a mesma regra de recorrência', async () => {
      const res1 = await createRecurrenceRule(
        {
          scope: 'personal',
          userId: 'user_rec_1',
          title: 'Internet Fibra',
          amountCents: 12000,
          startCompetence: '2026-01',
          dueDay: 10,
          idempotencyKey: 'idem_rec_rule_dup',
        },
        true
      );
      assert.equal(res1.isIdempotentReplay, false);

      const res2 = await createRecurrenceRule(
        {
          scope: 'personal',
          userId: 'user_rec_1',
          title: 'Internet Fibra',
          amountCents: 12000,
          startCompetence: '2026-01',
          dueDay: 10,
          idempotencyKey: 'idem_rec_rule_dup',
        },
        true
      );
      assert.equal(res2.isIdempotentReplay, true);
      assert.equal(res2.rule.id, res1.rule.id);
    });

    it('gera instâncias de recorrência por competência com idempotência', async () => {
      const { rule } = await createRecurrenceRule(
        {
          scope: 'personal',
          userId: 'user_rec_2',
          title: 'Plano Academia',
          amountCents: 9900,
          startCompetence: '2026-01',
          dueDay: 5,
          idempotencyKey: 'idem_rec_rule_gym',
        },
        true
      );

      const gen1 = await generateRecurrenceInstance(
        {
          ruleId: rule.id,
          competenceMonth: '2026-01',
        },
        true
      );
      assert.equal(gen1.isIdempotentReplay, false);
      assert.equal(gen1.instance.competenceMonth, '2026-01');
      assert.equal(gen1.instance.actualAmountCents, 9900);
      assert.equal(gen1.instance.generationStatus, 'generated');

      // Idempotência para a mesma competência
      const gen2 = await generateRecurrenceInstance(
        {
          ruleId: rule.id,
          competenceMonth: '2026-01',
        },
        true
      );
      assert.equal(gen2.isIdempotentReplay, true);
      assert.equal(gen2.instance.id, gen1.instance.id);

      // Nova competência
      const genFeb = await generateRecurrenceInstance(
        {
          ruleId: rule.id,
          competenceMonth: '2026-02',
        },
        true
      );
      assert.equal(genFeb.isIdempotentReplay, false);
      assert.equal(genFeb.instance.competenceMonth, '2026-02');

      const allInstances = await getRecurrenceInstances(rule.id, true);
      assert.equal(allInstances.length, 2);
    });

    it('impede geração de instâncias para regra de recorrência cancelada', async () => {
      const { rule } = await createRecurrenceRule(
        {
          scope: 'personal',
          userId: 'user_rec_3',
          title: 'Serviço Cancelado',
          amountCents: 5000,
          startCompetence: '2026-01',
          dueDay: 20,
          idempotencyKey: 'idem_rec_rule_cancel',
        },
        true
      );

      await updateRecurrenceRuleStatus({ ruleId: rule.id, status: 'cancelled' }, true);

      await assert.rejects(
        async () => {
          await generateRecurrenceInstance(
            {
              ruleId: rule.id,
              competenceMonth: '2026-03',
            },
            true
          );
        },
        {
          message: 'Regra de recorrência está cancelada.',
        }
      );
    });
  });

  describe('Installment Contracts & Strict Cent-Conservation', () => {
    it('divide o valor total do contrato em parcelas preservando estritamente os centavos (resto na 1ª parcela)', async () => {
      // R$ 100,00 (10.000 centavos) divididos em 3 parcelas
      // 10000 / 3 = 3333 centavos. Resto = 1 centavo.
      // Parcela 1: 3334 centavos
      // Parcela 2: 3333 centavos
      // Parcela 3: 3333 centavos
      const res = await createInstallmentContract(
        {
          scope: 'personal',
          userId: 'user_inst_1',
          title: 'Smartphone Novo',
          totalContractAmountCents: 10000,
          totalInstallmentsCount: 3,
          startCompetenceMonth: '2026-03',
          dueDay: 10,
          idempotencyKey: 'idem_inst_contract_01',
        },
        true
      );

      assert.equal(res.isIdempotentReplay, false);
      assert.ok(res.contract.id.startsWith('inst_idem_inst_contract'));
      assert.equal(res.contract.totalContractAmountCents, 10000);
      assert.equal(res.contract.status, 'active');

      const occurrences = await getInstallmentOccurrences(res.contract.id, true);
      assert.equal(occurrences.length, 3);

      assert.equal(occurrences[0].installmentNumber, 1);
      assert.equal(occurrences[0].competenceMonth, '2026-03');
      assert.equal(occurrences[0].dueDate, '2026-03-10');
      assert.equal(occurrences[0].principalAmountCents, 3334);
      assert.equal(occurrences[0].totalInstallmentAmountCents, 3334);
      assert.equal(occurrences[0].status, 'scheduled');

      assert.equal(occurrences[1].installmentNumber, 2);
      assert.equal(occurrences[1].competenceMonth, '2026-04');
      assert.equal(occurrences[1].dueDate, '2026-04-10');
      assert.equal(occurrences[1].principalAmountCents, 3333);
      assert.equal(occurrences[1].totalInstallmentAmountCents, 3333);
      assert.equal(occurrences[1].status, 'scheduled');

      assert.equal(occurrences[2].installmentNumber, 3);
      assert.equal(occurrences[2].competenceMonth, '2026-05');
      assert.equal(occurrences[2].dueDate, '2026-05-10');
      assert.equal(occurrences[2].principalAmountCents, 3333);
      assert.equal(occurrences[2].totalInstallmentAmountCents, 3333);
      assert.equal(occurrences[2].status, 'scheduled');

      // Conservação contábil exata da soma dos centavos
      const sumCents = occurrences.reduce((acc, o) => acc + o.principalAmountCents, 0);
      assert.equal(sumCents, 10000);
    });

    it('cancela antecipadamente o contrato de parcelamento preservando parcelas já faturadas ou pagas', async () => {
      const res = await createInstallmentContract(
        {
          scope: 'personal',
          userId: 'user_inst_2',
          title: 'Notebook Trabalho',
          totalContractAmountCents: 300000,
          totalInstallmentsCount: 3,
          startCompetenceMonth: '2026-01',
          dueDay: 15,
          idempotencyKey: 'idem_inst_contract_cancel',
        },
        true
      );

      // Simula que a parcela 1 foi paga e a parcela 2 foi faturada (billed)
      const raw = universalStorage.getItem('demo_installment_occurrences_v3');
      const occs: InstallmentOccurrence[] = raw ? JSON.parse(raw) : [];
      const idx1 = occs.findIndex((o) => o.contractId === res.contract.id && o.installmentNumber === 1);
      const idx2 = occs.findIndex((o) => o.contractId === res.contract.id && o.installmentNumber === 2);
      occs[idx1].status = 'paid';
      occs[idx2].status = 'billed';
      universalStorage.setItem('demo_installment_occurrences_v3', JSON.stringify(occs));

      // Executa o cancelamento antecipado
      const cancelRes = await cancelInstallmentContract(
        {
          contractId: res.contract.id,
          cancellationReason: 'Devolução parcial negociada com lojista',
        },
        true
      );

      assert.equal(cancelRes.contract.status, 'cancelled_early');
      assert.equal(cancelRes.contract.cancellationReason, 'Devolução parcial negociada com lojista');
      assert.equal(cancelRes.cancelledCount, 1); // Apenas a parcela 3 (scheduled) foi cancelada

      const occurrencesAfter = await getInstallmentOccurrences(res.contract.id, true);
      assert.equal(occurrencesAfter[0].status, 'paid'); // Intacta
      assert.equal(occurrencesAfter[1].status, 'billed'); // Intacta
      assert.equal(occurrencesAfter[2].status, 'cancelled'); // Cancelada
    });
  });
});
