import HumanBodyPoint from '../models/humanBodyPoint.model.js';

/**
 * Many human-body sub-resources (symptom/articularity/strength) can either be attached to an
 * existing point (`humanBodyPointId`) or create a brand new one on the fly (`pointToCreate`),
 * exactly like the legacy microservice did inline in every controller.
 */
export async function resolveHumanBodyPointId(schema: string, body: Record<string, unknown>): Promise<string | null> {
    const humanBodyPointId = body.humanBodyPointId as string | undefined;

    if (humanBodyPointId) {
        const point = await HumanBodyPoint.schema(schema).findByPk(humanBodyPointId);
        return point ? (point.get('id') as string) : null;
    }

    const pointToCreate = body.pointToCreate as Record<string, unknown> | undefined;
    if (!pointToCreate) {
        return null;
    }

    const point = await HumanBodyPoint.schema(schema).create(pointToCreate as any);
    return point.get('id') as string;
}


