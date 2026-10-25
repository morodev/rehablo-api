import {Request} from 'express';
import {Op, Transaction} from 'sequelize';
import {getCurrentTenantId} from '../../../middleware/auth.js';
import {getGrantedPermissions, getSelectedStructureId} from '../../../middleware/rbac.js';
import {Action, Resource, resolveGrantedScope} from '../../auth/rbac/permissions.js';
import {Structure, Tenant} from '../../auth/models/index.js';
import Patient from '../models/patient.model.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import {CarePackage, PatientCredit} from '../../administration/models/index.js';
import {packagePatient, packageSelectedStructure, packageToday, packageUuid} from '../../administration/services/carePackage.service.js';
import {treasuryError} from '../../administration/services/treasuryValidation.service.js';
import {verifiedPatientCredits} from '../../administration/services/patientCreditBacking.service.js';
import {paymentMoney} from '../../invoice/services/appointmentPayment.service.js';

type Plain = Record<string, any>;
type Domain = 'catalog' | 'legacy' | 'credits';
export interface CoveragePackage {
    id: string; quoteId: string | null; templateId: string | null; patientId: string; name: string; status: string;
    purchasedUnits: number; remainingUnits: number; totalPrice: number; expiresAt: string | null;
    serviceId: string | null; serviceName: string | null; reservedUnits: number; availableUnits: number;
    includedInSummary: boolean; canOpen: boolean;
}
export interface CoverageCredit {
    id: string; patientId: string; amount: number; remainingAmount: number; status: string;
    sourceType: string | null; sourceId: string | null; expiresAt: string | null;
    backed: boolean; availableAmount: number; canUse: boolean; canRefund: boolean;
}
export interface CoveragePosition {
    patientId: string; structureId: string;
    catalog: CoveragePackage[] | null; legacy: CoveragePackage[] | null; credits: CoverageCredit[] | null;
    packagesSummary: {activeCount: number; remainingUnits: number; availableUnits: number; reservedUnits: number; legacyRemainingUnits: number} | null;
    creditsSummary: {verifiedRemaining: number; unverifiedCount: number} | null;
    errors: Partial<Record<Domain, string>>;
}
export interface CoverageContext {patientId: string; structureId: string; patient: Plain;}

function grantedScope(req: Request, resource: Resource, action: Action) {
    return req.user?.isSuperAdmin ? 'tenant' as const : resolveGrantedScope(getGrantedPermissions(req), resource, action);
}

/** Credit ownership is unchanged: only tenant and selected-site grants support patient credit records. */
function creditAccess(req: Request, context: CoverageContext, resource: Resource, action: Action): boolean {
    const scope = grantedScope(req, resource, action);
    return scope === 'tenant' || (scope === 'structure' && getSelectedStructureId(req) === context.structureId);
}

export async function resolvePatientCoverageContext(req: Request, transaction?: Transaction): Promise<CoverageContext> {
    if (req.query.structureId !== undefined) packageUuid(req.query.structureId, 'Sede');
    const patientId = packageUuid(req.params.patientId, 'Paziente'), structureId = packageSelectedStructure(req);
    if (!await Structure.findOne({where: {id: structureId, tenantId: getCurrentTenantId(req)}, transaction})) {
        treasuryError('Sede non disponibile', 404);
    }
    const model = await Patient.schema(req.tenantSchema!).findOne({where: {id: patientId, structureId}, transaction});
    if (!model) treasuryError('Paziente non disponibile nella sede', 404);
    return {patientId, structureId, patient: model!.get({plain: true})};
}

function projectPackage(row: Plain, legacy: boolean, reservedUnits: number, today: string): CoveragePackage {
    const remainingUnits = Math.max(0, Number(row.remainingUnits) || 0);
    const expiresAt = row.expiresAt ? String(row.expiresAt).slice(0, 10) : null;
    const includedInSummary = row.status === 'ACTIVE' && remainingUnits > 0 && (!expiresAt || expiresAt >= today);
    const validToday = includedInSummary && (!row.purchasedAt || String(row.purchasedAt).slice(0, 10) <= today);
    return {id: row.id, quoteId: row.quoteId ?? null, templateId: row.templateId ?? null, patientId: row.patientId,
        name: row.name, status: row.status === 'ACTIVE' && expiresAt && expiresAt < today ? 'EXPIRED' : row.status,
        purchasedUnits: Number(row.purchasedUnits) || 0, remainingUnits, totalPrice: Number(row.totalPrice) || 0, expiresAt,
        serviceId: row.serviceId ?? null, serviceName: row.serviceName ?? null,
        reservedUnits: legacy ? 0 : reservedUnits,
        availableUnits: !legacy && validToday ? Math.max(0, remainingUnits - reservedUnits) : 0,
        includedInSummary, canOpen: !legacy};
}

/** One canonical, unpaginated snapshot supplies both the coverage list and its totals. */
export async function patientCoveragePosition(req: Request, context: CoverageContext,
    options: {transaction?: Transaction; administrationEnabled?: boolean; catalogAuthorized?: boolean} = {}): Promise<CoveragePosition> {
    const result: CoveragePosition = {patientId: context.patientId, structureId: context.structureId,
        catalog: null, legacy: null, credits: null, packagesSummary: null, creditsSummary: null, errors: {}};
    const enabled = options.administrationEnabled ?? ((await Tenant.findByPk(getCurrentTenantId(req),
        {attributes: ['featureFlags'], transaction: options.transaction}))?.get('featureFlags') as {administration?: boolean} | undefined)?.administration === true;
    if (!enabled || getSelectedStructureId(req) !== context.structureId || context.patient.structureId !== context.structureId) return result;
    const schema = req.tenantSchema!, transaction = options.transaction, today = packageToday();
    const unavailable = (domain: Domain) => {result.errors[domain] = ({catalog: 'Non è stato possibile caricare i pacchetti.',
        legacy: 'Non è stato possibile caricare i pacchetti precedenti.', credits: 'Non è stato possibile caricare i crediti.'})[domain];};
    const authorizePackages = async (resource: 'care_package' | 'quote'): Promise<boolean> => {
        if (!grantedScope(req, resource, 'read')) return false;
        try {
            const patient = await packagePatient(req, context.patientId, resource, 'read', transaction);
            return patient.get('id') === context.patientId && patient.get('structureId') === context.structureId;
        } catch (error) {
            if ([403, 404].includes((error as {statusCode?: number}).statusCode ?? 0)) return false;
            throw error;
        }
    };
    const loadPackages = async (domain: 'catalog' | 'legacy') => {
        try {
            const legacy = domain === 'legacy';
            const authorized = !legacy && options.catalogAuthorized !== undefined ? options.catalogAuthorized
                : await authorizePackages(legacy ? 'quote' : 'care_package');
            if (!authorized) return;
            const packages = (await CarePackage.schema(schema).findAll({where: {patientId: context.patientId,
                structureId: context.structureId, templateId: legacy ? null : {[Op.ne]: null}},
                order: [['createdAt', 'DESC'], ['id', 'ASC']], transaction})).map(model => model.get({plain: true}) as Plain);
            const ids = packages.map(pkg => pkg.id);
            const reservations = !legacy && ids.length ? await AgendaEvent.schema(schema).findAll({where: {
                carePackageId: {[Op.in]: ids},
                packageReservationStatus: 'RESERVED'}, attributes: ['carePackageId'], transaction}) : [];
            const counts = new Map<string, number>();
            for (const event of reservations) {const id = String(event.get('carePackageId')); counts.set(id, (counts.get(id) ?? 0) + 1);}
            result[domain] = packages.map(pkg => projectPackage(pkg, legacy, counts.get(String(pkg.id)) ?? 0, today));
        } catch (error) {
            if (transaction) throw error;
            unavailable(domain);
        }
    };
    const loadCredits = async () => {
        if (!creditAccess(req, context, 'quote', 'read')) return;
        try {
            const credits = (await PatientCredit.schema(schema).findAll({where: {patientId: context.patientId,
                structureId: context.structureId}, order: [['createdAt', 'DESC'], ['id', 'ASC']], transaction}))
                .map(model => model.get({plain: true}) as Plain);
            const verified = await verifiedPatientCredits(schema, credits, transaction);
            result.credits = credits.map(credit => {
                const backed = verified.get(String(credit.id)) === true;
                const availableAmount = credit.status === 'ACTIVE' && backed ? paymentMoney(Math.max(0, Number(credit.remainingAmount))) : 0;
                return {id: credit.id, patientId: credit.patientId, amount: Number(credit.amount), remainingAmount: Number(credit.remainingAmount),
                    status: credit.status, sourceType: credit.sourceType ?? null, sourceId: credit.sourceId ?? null,
                    expiresAt: credit.expiresAt ? String(credit.expiresAt).slice(0, 10) : null, backed, availableAmount,
                    canUse: availableAmount > 0 && creditAccess(req, context, 'quote', 'update'),
                    canRefund: availableAmount > 0 && creditAccess(req, context, 'treasury', 'create')};
            });
            result.creditsSummary = {verifiedRemaining: paymentMoney(result.credits.reduce((sum, credit) => sum + credit.availableAmount, 0)),
                unverifiedCount: result.credits.filter(credit => credit.status === 'ACTIVE' && credit.remainingAmount > 0 && !credit.backed).length};
        } catch (error) {
            if (transaction) throw error;
            unavailable('credits');
        }
    };
    // A transaction uses one database connection; keep its reads sequential.
    if (transaction) {await loadPackages('catalog'); await loadPackages('legacy'); await loadCredits();}
    else await Promise.all([loadPackages('catalog'), loadPackages('legacy'), loadCredits()]);
    // Never publish a partial total when one authorized package domain failed.
    if (!result.errors.catalog && !result.errors.legacy && (result.catalog !== null || result.legacy !== null)) {
        const catalog = (result.catalog ?? []).filter(pkg => pkg.includedInSummary);
        const legacy = (result.legacy ?? []).filter(pkg => pkg.includedInSummary);
        result.packagesSummary = {activeCount: catalog.length + legacy.length,
            remainingUnits: [...catalog, ...legacy].reduce((sum, pkg) => sum + pkg.remainingUnits, 0),
            availableUnits: catalog.reduce((sum, pkg) => sum + pkg.availableUnits, 0),
            reservedUnits: catalog.reduce((sum, pkg) => sum + pkg.reservedUnits, 0),
            legacyRemainingUnits: legacy.reduce((sum, pkg) => sum + pkg.remainingUnits, 0)};
    }
    return result;
}
