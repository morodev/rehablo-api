import {Request} from 'express';
import {getGrantedPermissions, getSelectedStructureId, getUserId} from '../../../middleware/rbac.js';
import {Action, hasPermission, Resource, resolveGrantedScope} from '../../auth/rbac/permissions.js';

/** Monetary rights are independent from editing attendance and appointment details. */
export function canAccessAppointmentFinance(req: Request, event: Record<string, any>, resource: Resource, action: Action): boolean {
    if (req.user?.actor === 'patient') return false;
    const scope = req.user?.isSuperAdmin ? 'tenant' : resolveGrantedScope(getGrantedPermissions(req), resource, action);
    if (!scope) return false;
    if (scope === 'tenant') return true;
    const selected = getSelectedStructureId(req);
    if (!selected || event.structureId !== selected) return false;
    return scope === 'structure' || event.calendarId === getUserId(req);
}

/** A reusable appointment type can set future prices across a site, never an own-calendar right. */
export function canChangeEventTypePricing(req: Request, source: Record<string, any>, current?: Record<string, any>): boolean {
    const normalized = (field: string, value: unknown) => value === null || value === undefined || value === ''
        ? null : field === 'price' ? Number(value) : String(value);
    const changesPricing = ['price', 'linkedServiceId'].some(field => Object.prototype.hasOwnProperty.call(source, field)
        && normalized(field, source[field]) !== normalized(field, current?.[field]));
    return !changesPricing || (!!req.user && req.user.actor !== 'patient' && (!!req.user.isSuperAdmin
        || hasPermission(getGrantedPermissions(req), 'appointment_pricing', 'update', 'structure')));
}
