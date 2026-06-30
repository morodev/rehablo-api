import { TestType } from '../models/catalog/test.model.js';

export interface InitialTestData {
    name: string;
    description: string;
    imageFile?: string;
    note: string;
    isPositive: boolean | null;
    positiveText: string;
    negativeText: string;
    patientText: string;
    operatorText: string;
    districts: string[] | null;
    isFullBody: boolean;
    type: TestType;
}

export const initialTests: InitialTestData[] = [
    {
        name: 'Adson test o test dello scaleno (Sindrome dello stretto toracico)',
        description: '',
        imageFile: 'test-image.jpg',
        note: '',
        isPositive: null,
        positiveText: 'Se il polso radiale diminuisce',
        negativeText: 'Se il polso radiale resta invariato',
        patientText: 'Il paziente iperestende il collo e ruota la testa verso il lato affetto',
        operatorText:
            "l'operatore invita il paziente a trattenere il respiro controllando se sono presenti alterazioni del polso radiale.",
        districts: null,
        isFullBody: true,
        type: 'orthopedic'
    },
    {
        name: 'test clinico 1',
        description: '',
        imageFile: 'test-image.jpg',
        note: '',
        isPositive: null,
        positiveText: 'Se il polso radiale diminuisce',
        negativeText: 'Se il polso radiale resta invariato',
        patientText: 'Il paziente iperestende il collo e ruota la testa verso il lato affetto',
        operatorText:
            "l'operatore invita il paziente a trattenere il respiro controllando se sono presenti alterazioni del polso radiale.",
        districts: null,
        isFullBody: true,
        type: 'clinic'
    }
];

