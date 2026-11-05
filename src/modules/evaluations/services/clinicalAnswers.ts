import type { Transaction } from 'sequelize';
import { clinicalInputError } from './clinicalWriteGuard.js';

/** Validate catalog ownership before inserting answers, preserving genuinely unanswered items. */
export async function validateClinicalAnswers(
    answers: Array<{questionId:string;answerId?:string|null;customAnswer?:string|null}>,
    catalogId: string,
    questionModel: any,
    answerModel: any,
    catalogField: string,
    questionField: string,
    transaction: Transaction
): Promise<void> {
    if(!Array.isArray(answers)||answers.length>1000) throw clinicalInputError('Risposte non valide');
    for(const response of answers){
        if(!response || typeof response.questionId!=='string') throw clinicalInputError('Domanda non valida');
        const question=await questionModel.findOne({where:{id:response.questionId,[catalogField]:catalogId},transaction});
        if(!question) throw clinicalInputError('La domanda non appartiene allo strumento selezionato');
        if(response.answerId!=null){
            const answer=await answerModel.findOne({where:{id:response.answerId,[questionField]:response.questionId},transaction});
            if(!answer) throw clinicalInputError('La risposta non appartiene alla domanda');
        }
    }
}
