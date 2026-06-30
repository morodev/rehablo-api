export const initialScales = [
    {
        name: 'OMPQ – Orebro Musculoskeletal Pain Questionnaire',
        description:
            'Strumento di screening per il rischio di cronicizzazione del dolore muscoloscheletrico, utile in fase precoce.',
        isFullBody: true,
        districts: ['Dolore', 'Muscoloscheletrico', 'Psicosociale', 'Cognitivo-comportamentale'],
        category: 'Screening per dolore muscoloscheletrico persistente',
        sections: [
            {
                sectionName: 'OMPQ – Dolore e disabilità',
                questions: [
                    {
                        description: "Indica l'intensità media del dolore negli ultimi giorni (0 = nessun dolore, 10 = dolore massimo).",
                        type: 'multi-single',
                        answers: Array.from({ length: 11 }, (_, i) => ({ description: String(i), value: i }))
                    },
                    {
                        description: 'Quanto il dolore interferisce con il sonno? (0 = per nulla, 10 = totalmente)',
                        type: 'multi-single',
                        answers: Array.from({ length: 11 }, (_, i) => ({ description: String(i), value: i }))
                    },
                    {
                        description: 'Quanto il dolore interferisce con le attività quotidiane? (0 = per nulla, 10 = totalmente)',
                        type: 'multi-single',
                        answers: Array.from({ length: 11 }, (_, i) => ({ description: String(i), value: i }))
                    },
                    {
                        description: 'Quanto il dolore interferisce con il tempo libero o le attività sociali? (0 = per nulla, 10 = totalmente)',
                        type: 'multi-single',
                        answers: Array.from({ length: 11 }, (_, i) => ({ description: String(i), value: i }))
                    }
                ]
            },
            {
                sectionName: 'OMPQ – Cognizioni e convinzioni',
                questions: [
                    {
                        description: 'Ho paura che il mio dolore non migliorerà.',
                        type: 'multi-single',
                        answers: Array.from({ length: 11 }, (_, i) => ({ description: String(i), value: i }))
                    },
                    {
                        description: 'Mi sento teso o ansioso a causa del mio dolore.',
                        type: 'multi-single',
                        answers: Array.from({ length: 11 }, (_, i) => ({ description: String(i), value: i }))
                    },
                    {
                        description: 'Il mio dolore mi rende depresso.',
                        type: 'multi-single',
                        answers: Array.from({ length: 11 }, (_, i) => ({ description: String(i), value: i }))
                    },
                    {
                        description: 'Quando provo dolore tendo a ritirarmi dalle attività.',
                        type: 'multi-single',
                        answers: Array.from({ length: 11 }, (_, i) => ({ description: String(i), value: i }))
                    }
                ]
            },
            {
                sectionName: 'OMPQ – Lavoro e assenteismo',
                questions: [
                    {
                        description: "Quante volte sei stato assente dal lavoro a causa del dolore nell'ultimo anno? (in giorni)",
                        type: 'multi-single',
                        answers: Array.from({ length: 11 }, (_, i) => ({ description: String(i), value: i }))
                    },
                    {
                        description:
                            'Pensi che il tuo dolore potrebbe causare difficoltà a svolgere il lavoro nei prossimi mesi? (0 = per nulla, 10 = sicuramente)',
                        type: 'multi-single',
                        answers: Array.from({ length: 11 }, (_, i) => ({ description: String(i), value: i }))
                    }
                ]
            }
        ],
        score: {
            formula: 'Somma dei punteggi di tutti gli item (versione breve: 10–100).',
            range: '0–100',
            unit: 'punteggio OMPQ'
        },
        interpretation: {
            'valore maggiore': 'Alto rischio di cronicizzazione e disabilità',
            'valore minore': 'Basso rischio di persistenza del dolore',
            note: 'Cut-off clinico ≥ 50 indica rischio elevato'
        }
    }
];

