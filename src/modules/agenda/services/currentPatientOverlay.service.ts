type PlainRecord = Record<string, any>;

function objectRecord(value: unknown): PlainRecord | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as PlainRecord
        : null;
}

/**
 * Espone nel feed agenda l'anagrafica corrente senza modificare lo snapshot salvato
 * nell'appuntamento. Lo snapshot resta il fallback per pazienti rimossi o record legacy.
 */
export function overlayCurrentPatients(
    events: PlainRecord[],
    currentPatients: PlainRecord[]
): PlainRecord[] {
    const currentPatientById = new Map(
        currentPatients
            .filter((patient) => typeof patient?.id === 'string')
            .map((patient) => [String(patient.id), patient] as const)
    );

    return events.map((event) => {
        const snapshot = objectRecord(event.patient);
        const patientId = event.patientId ?? snapshot?.id;
        if (typeof patientId !== 'string') return event;

        const currentPatient = currentPatientById.get(patientId);
        if (!currentPatient) return event;

        return {
            ...event,
            patient: {
                ...(snapshot ?? {}),
                ...currentPatient
            }
        };
    });
}