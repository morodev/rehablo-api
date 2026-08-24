import { Request } from 'express';
import AuditLog from './auditLog.model.js';

export interface AuditEventInput {
    schema: string;
    tenantId: string;
    actorId?: string | null;
    action: string;
    resource: string;
    resourceId?: string | null;
    patientId?: string | null;
    metadata?: Record<string, unknown> | null;
    req?: Request;
}

export async function recordAuditEvent(input: AuditEventInput): Promise<void> {
    try {
        await AuditLog.schema(input.schema).create({
            tenantId: input.tenantId,
            actorId: input.actorId ?? null,
            action: input.action,
            resource: input.resource,
            resourceId: input.resourceId ?? null,
            patientId: input.patientId ?? null,
            metadata: input.metadata ?? null,
            ipAddress: (input.req?.ip ?? input.req?.socket?.remoteAddress ?? null)?.slice(0, 45) ?? null,
            userAgent: input.req?.get('user-agent')?.slice(0, 255) ?? null
        });
    } catch (err) {
        console.error('[audit] impossibile registrare evento', {
            action: input.action,
            resource: input.resource,
            resourceId: input.resourceId,
            error: (err as Error).message
        });
    }
}
