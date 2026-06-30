import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Scale from './scale.model.js';
import SectionScale from './sectionScale.model.js';
import QuestionScale from './questionScale.model.js';
import AnswerScale from './answerScale.model.js';
import Test from './test.model.js';
import { initialScales } from '../../data/initialScales.js';
import { initialTests } from '../../data/initialTests.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Centralised associations for the human-body catalog (public schema, shared by every tenant). */
export function registerCatalogAssociations(): void {
    Scale.hasMany(SectionScale);
    SectionScale.belongsTo(Scale);

    Scale.hasMany(QuestionScale);
    QuestionScale.belongsTo(Scale);

    SectionScale.hasMany(QuestionScale);
    QuestionScale.belongsTo(SectionScale);

    QuestionScale.hasMany(AnswerScale);
    AnswerScale.belongsTo(QuestionScale);
}

export async function syncCatalogModels(): Promise<void> {
    await Scale.sync({ alter: true });
    await SectionScale.sync({ alter: true });
    await QuestionScale.sync({ alter: true });
    await AnswerScale.sync({ alter: true });
    await Test.sync({ alter: true });
}

function getImageBuffer(filename: string): Buffer | null {
    try {
        return fs.readFileSync(path.join(__dirname, '../../../../assets/images/test', filename));
    } catch (error) {
        console.error(`[human-body] could not load seed image ${filename}:`, error);
        return null;
    }
}

/**
 * Seeds the catalog with the standardized scales/tests, exactly once at boot, using `findOrCreate`
 * so it's idempotent across restarts. The former microservice ran this seeding logic on every
 * single GET request (`getAllScales`, `searchScales`, ...) — moved here to avoid the overhead.
 */
export async function seedCatalogData(): Promise<void> {
    for (const scaleData of initialScales) {
        const [scale] = await Scale.findOrCreate({
            where: { name: scaleData.name },
            defaults: {
                description: scaleData.description,
                isFullBody: scaleData.isFullBody,
                districts: scaleData.districts,
                category: scaleData.category,
                score: scaleData.score,
                interpretation: scaleData.interpretation
            } as any
        });

        for (const sectionData of scaleData.sections) {
            const [section] = await SectionScale.findOrCreate({
                where: { sectionName: sectionData.sectionName, scaleId: scale.get('id') as string },
                defaults: { sectionName: sectionData.sectionName, scaleId: scale.get('id') as string }
            });

            for (const questionData of sectionData.questions) {
                const [question] = await QuestionScale.findOrCreate({
                    where: { description: questionData.description, scaleId: scale.get('id') as string },
                    defaults: {
                        description: questionData.description,
                        type: questionData.type,
                        scaleId: scale.get('id') as string,
                        sectionId: section.get('id') as string
                    }
                });

                for (const answerData of questionData.answers) {
                    await AnswerScale.findOrCreate({
                        where: { description: answerData.description, questionScaleId: question.get('id') as string },
                        defaults: {
                            description: answerData.description,
                            value: answerData.value,
                            questionScaleId: question.get('id') as string
                        }
                    });
                }
            }
        }
    }

    for (const testData of initialTests) {
        const imageBuffer = testData.imageFile ? getImageBuffer(testData.imageFile) : null;

        await Test.findOrCreate({
            where: { name: testData.name },
            defaults: {
                name: testData.name,
                description: testData.description,
                image: imageBuffer,
                note: testData.note,
                isPositive: testData.isPositive,
                positiveText: testData.positiveText,
                negativeText: testData.negativeText,
                patientText: testData.patientText,
                operatorText: testData.operatorText,
                districts: testData.districts,
                isFullBody: testData.isFullBody,
                type: testData.type
            } as any
        });
    }

    console.log('[human-body] catalog seed completed');
}

export { Scale, SectionScale, QuestionScale, AnswerScale, Test };

