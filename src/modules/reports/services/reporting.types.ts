export type ReportFormat = 'currency' | 'number' | 'percent' | 'minutes';
export interface ReportWarning { code: string; message?: string; count?: number; }
export interface ReportMeta {
    effectiveFilters: Record<string, unknown>;
    generatedAt: string;
    balanceAsOf?: string;
    dateBasis: string;
    comparisonPeriod?: {from: string; to: string} | null;
    warnings: Array<ReportWarning | string>;
}
export interface ReportSummaryItem {
    key: string; label: string; value: number | null; format: ReportFormat;
    description?: string; previousValue?: number | null; change?: number | null;
    drilldown?: {dataset: string; filters: Record<string, unknown>};
}
export interface ReportColumn {key: string; label: string; type?: 'currency' | 'number' | 'percent' | 'date' | 'datetime' | 'text';}
export interface ReportSeries {key: string; label: string; points: Array<{label: string; value: number}>;}
export interface ReportDatasetResponse {
    meta: ReportMeta;
    summary: ReportSummaryItem[];
    columns: ReportColumn[];
    rows: Array<Record<string, any>>;
    pagination: {total: number; page: number; size: number};
    series?: ReportSeries[];
}

export function paginateReport(rows: Array<Record<string, any>>, page: number, size: number, allRows = false) {
    return {rows: allRows ? rows : rows.slice((page - 1) * size, page * size),
        pagination: {total: rows.length, page: allRows ? 1 : page, size: allRows ? rows.length : size}};
}

/** The CSV includes every selected row, using the same column definitions as the screen. */
export function reportCsv(result: ReportDatasetResponse): string {
    const cell = (input: unknown): string => {
        let value = input == null ? '' : String(input);
        if (typeof input === 'string' && /^[\s]*[=+\-@]/.test(value)) value = `'${value}`;
        return `"${value.replace(/"/g, '""')}"`;
    };
    const metadata = [
        ['Report generato il', result.meta.generatedAt],
        ['Criterio temporale', result.meta.dateBasis],
        ['Dal', result.meta.effectiveFilters.from ?? ''], ['Al', result.meta.effectiveFilters.to ?? ''],
        ['Sedi', Array.isArray(result.meta.effectiveFilters.structureIds) ? result.meta.effectiveFilters.structureIds.join(', ') : result.meta.effectiveFilters.structureId ?? ''],
        ['Situazione aggiornata al', result.meta.balanceAsOf ?? result.meta.generatedAt],
        ['Filtri applicati', JSON.stringify(result.meta.effectiveFilters)],
        ...(result.meta.comparisonPeriod ? [['Confronto dal', result.meta.comparisonPeriod.from], ['Confronto al', result.meta.comparisonPeriod.to]] : []),
        ...result.meta.warnings.map(warning => ['Avvertenza', typeof warning === 'string' ? warning : warning.message ?? warning.code])
    ].map(row => row.map(cell).join(';'));
    const summary = [['Indicatore', 'Valore', 'Valore precedente', 'Unità', 'Descrizione'].map(cell).join(';'),
        ...result.summary.map(metric => [metric.label, metric.value, metric.previousValue ?? '', metric.format, metric.description ?? ''].map(cell).join(';'))];
    return '\uFEFF' + [...metadata, '', ...summary, '', result.columns.map(column => cell(column.label)).join(';'),
        ...result.rows.map(row => result.columns.map(column => cell(row[column.key])).join(';'))].join('\r\n');
}
