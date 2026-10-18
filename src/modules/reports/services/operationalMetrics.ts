export type Interval = [number, number];
export function mergeIntervals(values: Interval[]): Interval[] {
    const result: Interval[] = [];
    for (const [start, end] of values.filter(([a, b]) => Number.isFinite(a) && b > a).sort((a, b) => a[0] - b[0])) {
        const last = result[result.length - 1];
        if (last && start <= last[1]) last[1] = Math.max(last[1], end);
        else result.push([start, end]);
    }
    return result;
}
export function subtractIntervals(source: Interval[], blocked: Interval[]): Interval[] {
    let result = mergeIntervals(source);
    for (const [a, b] of mergeIntervals(blocked)) result = result.flatMap(([start, end]): Interval[] =>
        b <= start || a >= end ? [[start, end]] : [[start, Math.min(a, end)], [Math.max(b, start), end]].filter(([x, y]) => y > x) as Interval[]);
    return result;
}
export function intervalMinutes(values: Interval[]): number { return values.reduce((sum, [a, b]) => sum + (b - a) / 60000, 0); }
export function capacityValues(availability: Interval[], absences: Interval[], bookings: Interval[]) {
    const freeSchedule = subtractIntervals(availability, absences);
    const unionBookings = mergeIntervals(bookings);
    const intersected = unionBookings.flatMap(([a, b]) => freeSchedule.map(([c, d]): Interval => [Math.max(a, c), Math.min(b, d)]).filter(([x, y]) => y > x));
    const availableMinutes = intervalMinutes(freeSchedule), occupiedMinutes = intervalMinutes(intersected);
    const bookedMinutes = intervalMinutes(bookings), uniqueBookedMinutes = intervalMinutes(unionBookings);
    return {availableMinutes, occupiedMinutes, freeMinutes: Math.max(availableMinutes - occupiedMinutes, 0),
        overlapMinutes: Math.max(bookedMinutes - uniqueBookedMinutes, 0), outsideMinutes: Math.max(uniqueBookedMinutes - occupiedMinutes, 0),
        utilizationRate: availableMinutes ? Math.round(occupiedMinutes / availableMinutes * 10000) / 100 : null};
}
export function followupEligible(lastDate: string, today: string, thresholdDays: number, nextDate: string | null): boolean {
    return !nextDate && Math.round((Date.parse(today + 'T12:00:00Z') - Date.parse(lastDate + 'T12:00:00Z')) / 86400000) >= thresholdDays;
}
