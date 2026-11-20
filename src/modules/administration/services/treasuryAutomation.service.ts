import {createHash} from 'node:crypto';
import type {Request} from 'express';
import {Op, Transaction} from 'sequelize';
import {sequelize} from '../../../config/database.js';
import {getGrantedPermissions, getSelectedStructureId, getUserId, patientScopeWhere} from '../../../middleware/rbac.js';
import {Resource, resolveGrantedScope} from '../../auth/rbac/permissions.js';
import {quoteTenantSchema} from '../../../database/migrationTypes.js';
import {canAccessAppointmentFinance} from '../../agenda/services/appointmentFinancialAccess.service.js';
import {evalTotalsDetailed} from '../../invoice/utils/evalTotals.js';
import {getTaxRegime} from '../../invoice/utils/fiscalRegime.js';
import {TreasuryCategory, TreasuryCategoryDefault, TreasuryCategorySnapshot, TreasuryClassification, TreasuryMovementTag, TreasuryTag} from '../models/treasuryClassification.model.js';
import {treasuryError, TREASURY_UUID} from './treasuryValidation.service.js';
import {allocateTreasuryAmount, allocateTreasuryIncrement, AUTOMATION_OPERATIONS, choiceShares, classificationCategory, groupTreasuryShares, normalizeTreasuryClassificationChoice, normalizeTreasurySource, TreasuryClassificationChoice, TreasuryShare, TreasurySource, TreasurySourceKind, TreasuryWeight} from './treasuryAutomation.policy.js';

type Row = Record<string, any>;
const plain = (value: any): Row => typeof value?.get === 'function' ? value.get({plain:true}) : value;
const tableByKind: Partial<Record<TreasurySourceKind,string>> = {SERVICE:'services',PRODUCT:'products',EVENT_TYPE:'event_types',PACKAGE_TEMPLATE:'package_templates',APPOINTMENT:'agenda_events',INVOICE:'invoices',PACKAGE:'care_packages',EXPENSE:'expenses'};
const configurable = ['SERVICE','PRODUCT','EVENT_TYPE','PACKAGE_TEMPLATE','EXPENSE','OPERATION'];
const scope = (req:Request, resource:Resource, action:'read'|'update'|'create') => req.user?.isSuperAdmin ? 'tenant' : resolveGrantedScope(getGrantedPermissions(req),resource,action);
export const canManageTreasuryDefaults = (req:Request) => scope(req,'tenant','update') === 'tenant';
function assertScope(req:Request, resource:Resource, action:'read'|'update'|'create', structureId?:unknown, ownerId?:unknown): void {
    const allowed = scope(req,resource,action);
    if (!allowed || (allowed !== 'tenant' && structureId && structureId !== (getSelectedStructureId(req) ?? req.access?.structureId)) || (allowed === 'own' && ownerId !== getUserId(req))) treasuryError('Non sei autorizzato a questa classificazione',403);
}
export function assertTreasuryClassificationChoice(req:Request,value:unknown,structureId:string):TreasuryClassificationChoice|undefined {
    const choice = normalizeTreasuryClassificationChoice(value);
    if (choice !== undefined) assertScope(req,'treasury','update',structureId,getUserId(req));
    return choice;
}
async function select(schema:string,sql:string,replacements:Row={},transaction?:Transaction):Promise<Row[]> {
    const [rows] = await sequelize.query(sql.replaceAll('$SCHEMA',quoteTenantSchema(schema)),{replacements,transaction});
    return rows as Row[];
}
async function sourceRow(schema:string,source:TreasurySource,transaction?:Transaction):Promise<Row|null> {
    if(source.kind==='OPERATION')return {id:source.id,name:operationLabel(source.id)};
    const rows=await select(schema,`SELECT * FROM $SCHEMA."${tableByKind[source.kind]}" WHERE "id"=:id`,{id:source.id},transaction);
    return rows[0]??null;
}
function operationLabel(id:string):string {return ({PATIENT_ADVANCE:'Anticipi pazienti',PATIENT_REFUND:'Rimborsi pazienti',MANUAL_IN:'Entrate manuali',MANUAL_OUT:'Uscite manuali',INVOICE_PAYMENT:'Incassi',SUPPLIER_PAYMENT:'Pagamenti fornitori'} as Row)[id]??id;}
function sourceDirection(kind:TreasurySourceKind,id:string):'IN'|'OUT' {return kind==='EXPENSE'||kind==='OPERATION'&&['PATIENT_REFUND','SUPPLIER_PAYMENT','MANUAL_OUT'].includes(id)?'OUT':'IN';}
async function category(schema:string,id:string|null,direction:'IN'|'OUT',transaction?:Transaction,allowArchived=false):Promise<Row|null> {
    if(!id)return null;
    const record=await TreasuryCategory.schema(schema).findByPk(id,{transaction,...(transaction?{lock:transaction.LOCK.UPDATE}:{})});
    const row=record&&plain(record);
    return row&&row.direction===direction&&(allowArchived||row.isActive!==false)?row:null;
}
export async function saveSourceTreasuryDefault(req:Request,kind:TreasurySourceKind,id:string,businessCategoryId:unknown,transaction:Transaction,_structureId?:string):Promise<void> {
    if(businessCategoryId===undefined)return;
    if(!canManageTreasuryDefaults(req))treasuryError('Solo il responsabile può configurare le categorie automatiche',403);
    const source=normalizeTreasurySource({kind,id});
    if(!configurable.includes(kind))treasuryError('Origine non configurabile',422);
    const selected=classificationCategory(businessCategoryId);
    if(selected&&kind==='EVENT_TYPE'&&(await sourceRow(req.tenantSchema!,source,transaction))?.linkedServiceId)treasuryError('La categoria di questo tipo appuntamento deriva dal servizio collegato',422);
    if(selected&&!await category(req.tenantSchema!,selected,sourceDirection(kind,id),transaction))treasuryError('Categoria non disponibile per questa origine',422);
    const where={sourceKind:source.kind,sourceId:source.id};
    // Null removes the override, allowing linked service inheritance again.
    if(selected===null){await TreasuryCategoryDefault.schema(req.tenantSchema!).destroy({where,transaction});return;}
    await TreasuryCategoryDefault.schema(req.tenantSchema!).upsert({...where,businessCategoryId:selected,updatedByUserId:getUserId(req)},{transaction});
}
async function sourceDefault(schema:string,source:TreasurySource,direction:'IN'|'OUT',transaction?:Transaction):Promise<string|null> {
    const entry=await TreasuryCategoryDefault.schema(schema).findOne({where:{sourceKind:source.kind,sourceId:source.id},transaction});
    const id=entry?.get('businessCategoryId') as string|null|undefined;
    return id&&await category(schema,id,direction,transaction)?id:null;
}
async function sourceWeights(schema:string,source:TreasurySource,direction:'IN'|'OUT',transaction?:Transaction,depth=0):Promise<TreasuryWeight[]> {
    if(depth>4)return [{businessCategoryId:null,weight:1}];
    const own=await sourceDefault(schema,source,direction,transaction);
    const row=await sourceRow(schema,source,transaction);
    if(!row)return [{businessCategoryId:null,weight:1}];
    const inherit=async(kind:TreasurySourceKind,id:string)=>(await resolvedWeights(schema,{kind,id},direction,transaction,false,depth+1)).weights;
    if(source.kind==='EVENT_TYPE'&&row.linkedServiceId)return inherit('SERVICE',row.linkedServiceId);
    if(own)return [{businessCategoryId:own,weight:Number(row.totalPrice??row.amount??row.invoiceNet??1)||1}];
    if(source.kind==='APPOINTMENT'&&row.eventTypeId)return inherit('EVENT_TYPE',row.eventTypeId);
    if(source.kind==='PACKAGE_TEMPLATE'&&row.serviceId)return inherit('SERVICE',row.serviceId);
    if(source.kind==='PACKAGE'){
        if(row.templateId){const configured=await sourceDefault(schema,{kind:'PACKAGE_TEMPLATE',id:row.templateId},direction,transaction);if(configured)return [{businessCategoryId:configured,weight:Number(row.totalPrice)||1}];}
        if(row.serviceId)return inherit('SERVICE',row.serviceId);
        const result:TreasuryWeight[]=[];
        for(const line of Array.isArray(row.purchaseSnapshot?.quote?.lines)?row.purchaseSnapshot.quote.lines:Array.isArray(row.lines)?row.lines:[]){
            const kind:TreasurySourceKind=line.itemType==='PRODUCT'?'PRODUCT':'SERVICE';
            const id=['SERVICE','PRODUCT'].includes(line.itemType)?line.itemId??line.serviceId??line.productId:null;
            const categoryId=id?await sourceDefault(schema,{kind,id},direction,transaction):null;
            const weight=Number(line.total??line.totalPrice??line.lineTotal??Number(line.unitPrice??line.price??0)*Number(line.quantity??1));
            result.push({businessCategoryId:categoryId,weight:Number.isFinite(weight)&&weight>0?weight:0});
        }
        return result.length?result:[{businessCategoryId:null,weight:1}];
    }
    if(source.kind==='INVOICE'){
        if(row.carePackageId)return inherit('PACKAGE',row.carePackageId);
        const [services,products,links]=await Promise.all([
            select(schema,'SELECT * FROM $SCHEMA."invoice_services" WHERE "InvoiceId"=:id ORDER BY "id"',{id:source.id},transaction),
            select(schema,'SELECT * FROM $SCHEMA."invoice_products" WHERE "InvoiceId"=:id ORDER BY "id"',{id:source.id},transaction),
            select(schema,'SELECT * FROM $SCHEMA."invoice_agenda_events" WHERE "invoiceId"=:id AND "releasedAt" IS NULL ORDER BY "id"',{id:source.id},transaction),
        ]);
        if(row.agendaEventId&&!links.some(link=>link.agendaEventId===row.agendaEventId))links.push({agendaEventId:row.agendaEventId,serviceId:services[0]?.ServiceId??null});
        const result:TreasuryWeight[]=[];
        const fiscalAmounts=invoiceTreasuryLineAmounts(row,services,products);
        const fiscalTotal=fiscalAmounts.reduce((sum,amount)=>sum+amount,0);
        const invoiceDue=Math.max(0,Number(row.invoiceNet??row.invoiceTotal??fiscalTotal));
        // Include document-level charges before removing cash/coverage already assigned to
        // linked visits. Their original cash keeps its category, including manual overrides.
        const amounts=fiscalAmounts.map(amount=>fiscalTotal>0?amount*invoiceDue/fiscalTotal:0);
        const coverage=links.length?await select(schema,'SELECT * FROM $SCHEMA."invoice_payments" WHERE "invoiceId"=:id AND "agendaEventId" IS NOT NULL AND "status"=\'POSTED\'',{id:source.id},transaction):[];
        for(const [index,line] of products.entries())result.push({businessCategoryId:line.ProductId?await sourceDefault(schema,{kind:'PRODUCT',id:line.ProductId},direction,transaction):null,weight:amounts[index]??0});
        // Association rows identify the service, not a particular invoice line. Resolve a
        // service group together so ordering UUIDs cannot attach a receipt to another visit.
        const undiscounted=invoiceTreasuryLineAmounts({...row,discountAmount:0,taxWithholding:0},services,products);
        for(const serviceId of new Set(services.map(line=>line.ServiceId??null))){
            const indexes=services.map((line,index)=>({line,index:index+products.length})).filter(item=>(item.line.ServiceId??null)===serviceId);
            const total=indexes.reduce((sum,item)=>sum+(amounts[item.index]??0),0);
            const gross=indexes.reduce((sum,item)=>sum+(undiscounted[item.index]??0),0);
            const quantity=indexes.reduce((sum,item)=>sum+Number(item.line.quantity??1),0);
            const appointments=links.filter(link=>(link.serviceId??null)===serviceId);
            const linked:Array<{weights:TreasuryWeight[];amount:number;paid:number}>=[];
            for(const link of appointments){
                const appointment=await sourceRow(schema,{kind:'APPOINTMENT',id:link.agendaEventId},transaction);
                if(appointment)linked.push({weights:await inherit('APPOINTMENT',link.agendaEventId),amount:Math.max(0,Number(appointment.appointmentExpectedAmount)||0),paid:coverage.filter(payment=>payment.agendaEventId===link.agendaEventId&&payment.status==='POSTED').reduce((sum,payment)=>sum+Number(payment.amount),0)});
            }
            const linkedGross=linked.reduce((sum,item)=>sum+item.amount,0);
            const allLinked=linked.length>0&&quantity===linked.length;
            const linkedTotal=allLinked?total:gross>0?Math.min(total,total*linkedGross/gross):0;
            for(const item of linked){
                const part=Math.max(0,linkedTotal*(linkedGross>0?item.amount/linkedGross:1/linked.length)-item.paid);
                const weightTotal=item.weights.reduce((sum,weight)=>sum+weight.weight,0);
                result.push(...item.weights.map(weight=>({businessCategoryId:weight.businessCategoryId,weight:weightTotal>0?part*weight.weight/weightTotal:0})));
            }
            if(!allLinked)result.push({businessCategoryId:serviceId?await sourceDefault(schema,{kind:'SERVICE',id:serviceId},direction,transaction):null,weight:total-linkedTotal});
        }
        if(!result.length&&row.agendaEventId)return inherit('APPOINTMENT',row.agendaEventId);
        return result.length?result:[{businessCategoryId:null,weight:1}];
    }
    const fallback=source.kind==='EXPENSE'?'SUPPLIER_PAYMENT':['INVOICE','APPOINTMENT','PACKAGE','SERVICE','PRODUCT','EVENT_TYPE','PACKAGE_TEMPLATE'].includes(source.kind)?'INVOICE_PAYMENT':null;
    return [{businessCategoryId:fallback?await sourceDefault(schema,{kind:'OPERATION',id:fallback},direction,transaction):null,weight:1}];
}
/** Uses the same fiscal calculator and frozen issuer/line values as the document, never today's catalogue. */
export function invoiceTreasuryLineAmounts(invoice:Row,services:Row[],products:Row[]):number[] {
    const line=(item:Row,kind:'SERVICE'|'PRODUCT')=>({sellingPrice:Number(kind==='SERVICE'?item.servicePrice:item.productPrice),quantity:Number(item.quantity??1),productVat:kind==='SERVICE'?item.serviceVat:item.productVat,socialSecurity:item.socialSecurity??null});
    const snapshotPolicy=invoice.socialSecuritySnapshot?.policy;
    const result=evalTotalsDetailed({...invoice,products:products.map(item=>line(item,'PRODUCT')),services:services.map(item=>line(item,'SERVICE')),
        appliesVat:invoice.issuer?.taxRegime?getTaxRegime(invoice.issuer.taxRegime).appliesVat:Number(invoice.invoiceVAT)>0,
        ...(snapshotPolicy?{socialSecurityPricingMode:snapshotPolicy.mode,socialSecurityFund:snapshotPolicy.fund,rivals:Number(snapshotPolicy.rate)}:{}),
        discountAmount:Number(invoice.discountAmount??0),taxWithholding:Number(invoice.taxWithholding??0),stampAmount:Number(invoice.stampAmount??0)});
    const amounts=result.lines.map(item=>Math.max(0,item.discountedPrice+item.vatAmount+item.rivalsAmount));
    // Withholding is retained by the payer and must not be attributed as cash from products.
    const withholding=Number(result.totals.taxWithholdingAmount??0);
    const serviceTotal=amounts.slice(products.length).reduce((a,b)=>a+b,0);
    if(withholding>0&&serviceTotal>0)for(let i=products.length;i<amounts.length;i++)amounts[i]=Math.max(0,amounts[i]-withholding*amounts[i]/serviceTotal);
    return amounts;
}
async function resolvedWeights(schema:string,source:TreasurySource,direction:'IN'|'OUT',transaction?:Transaction,freeze=false,depth=0):Promise<{weights:TreasuryWeight[];origin:string}> {
    const snapshotKinds=['APPOINTMENT','INVOICE','PACKAGE','EXPENSE'];
    if(snapshotKinds.includes(source.kind)){
        if(freeze&&transaction)await select(schema,'SELECT pg_advisory_xact_lock(hashtextextended(:key,0))',{key:`${schema}:treasury-classification:${source.kind}:${source.id}`},transaction);
        const snapshot=await TreasuryCategorySnapshot.schema(schema).findOne({where:{sourceKind:source.kind,sourceId:source.id},transaction});
        if(snapshot)return {weights:snapshot.get('weights') as TreasuryWeight[],origin:'SNAPSHOT'};
    }
    let weights=await sourceWeights(schema,source,direction,transaction,depth);
    if(direction==='IN'&&source.kind!=='OPERATION'&&weights.some(item=>!item.businessCategoryId)){
        const fallback=await sourceDefault(schema,{kind:'OPERATION',id:'INVOICE_PAYMENT'},direction,transaction);
        if(fallback)weights=weights.map(item=>({...item,businessCategoryId:item.businessCategoryId??fallback}));
    }
    if(freeze&&snapshotKinds.includes(source.kind)&&weights.some(item=>item.businessCategoryId))await TreasuryCategorySnapshot.schema(schema).create({sourceKind:source.kind,sourceId:source.id,weights},{transaction});
    return {weights,origin:'AUTOMATIC'};
}
export interface TreasuryClassificationInput {schema:string;movementId:string;amount:number;direction:'IN'|'OUT';actorId:string|null;source?:TreasurySource;classification?:TreasuryClassificationChoice;}
export async function classifyTreasuryMovement(input:TreasuryClassificationInput,transaction:Transaction):Promise<void> {
    if(!transaction)treasuryError('La classificazione richiede la transazione del movimento',500);
    const {schema,movementId,amount,direction,source,actorId}=input;
    if(await TreasuryClassification.schema(schema).findByPk(movementId,{transaction}))return;
    const choice=normalizeTreasuryClassificationChoice(input.classification);
    const tags=choice?.tagIds??[];
    let shares:TreasuryShare[],origin='MANUAL';
    if(choice&&(choice.businessCategoryId!==undefined||choice.allocations!==undefined)){
        shares=choiceShares(amount,choice);
        for(const share of shares)if(share.businessCategoryId&&!await category(schema,share.businessCategoryId,direction,transaction))treasuryError('Categoria non disponibile per questo movimento',422);
    }else{
        const resolved=source?await resolvedWeights(schema,source,direction,transaction,true):{weights:[{businessCategoryId:null,weight:1}],origin:'AUTOMATIC'};
        const previous=source?await previousTreasuryShares(schema,source,direction,transaction):[];
        shares=allocateTreasuryIncrement(amount,resolved.weights,previous);origin=resolved.origin;
        if(!shares.some(item=>item.businessCategoryId)&&!tags.length)return;
    }
    const only=shares.length===1?shares[0].businessCategoryId:null;
    await TreasuryClassification.schema(schema).create({movementId,businessCategoryId:only,allocations:shares,origin,sourceKind:source?.kind??null,sourceId:source?.id??null,updatedByUserId:actorId},{transaction});
    for(const id of tags){const tag=await TreasuryTag.schema(schema).findByPk(id,{transaction,lock:transaction.LOCK.UPDATE});if(!tag||tag.get('isActive')===false)treasuryError('Tag non disponibile',422);}
    if(tags.length)await TreasuryMovementTag.schema(schema).bulkCreate(tags.map(tagId=>({movementId,tagId})),{transaction});
}
async function previousTreasuryShares(schema:string,source:TreasurySource,direction:'IN'|'OUT',transaction?:Transaction):Promise<TreasuryShare[]> {
    if(['SERVICE','PRODUCT','EVENT_TYPE','PACKAGE_TEMPLATE','OPERATION'].includes(source.kind))return [];
    const rows=await select(schema,`SELECT c."allocations",c."businessCategoryId",m."amount" FROM $SCHEMA."treasury_classifications" c
        JOIN $SCHEMA."treasury_movements" m ON m."id"=c."movementId"
        WHERE c."sourceKind"=:kind AND c."sourceId"=:id AND c."origin" IN ('AUTOMATIC','SNAPSHOT') AND m."direction"=:direction AND m."status"='POSTED'
        AND NOT EXISTS (SELECT 1 FROM $SCHEMA."treasury_movements" r WHERE r."reversalOfId"=m."id" AND r."status"='POSTED'
            AND r."accountId"=m."accountId" AND r."direction"<>m."direction" AND r."amount"=m."amount")`,{kind:source.kind,id:source.id,direction},transaction);
    return rows.flatMap(row=>Array.isArray(row.allocations)?row.allocations:[{businessCategoryId:row.businessCategoryId??null,amount:Number(row.amount)}]);
}
export async function copyTreasuryClassification(schema:string,fromId:string,toId:string,actorId:string|null,transaction:Transaction):Promise<void> {
    const original=await TreasuryClassification.schema(schema).findByPk(fromId,{transaction});
    if(!original||await TreasuryClassification.schema(schema).findByPk(toId,{transaction}))return;
    const data=plain(original);delete data.createdAt;delete data.updatedAt;
    await TreasuryClassification.schema(schema).create({...data,movementId:toId,updatedByUserId:actorId??data.updatedByUserId},{transaction});
    const tags=await TreasuryMovementTag.schema(schema).findAll({where:{movementId:fromId},transaction});
    if(tags.length)await TreasuryMovementTag.schema(schema).bulkCreate(tags.map(row=>({movementId:toId,tagId:row.get('tagId')})),{transaction});
}

async function assertSourceAccess(req:Request,source:TreasurySource,transaction?:Transaction):Promise<Row> {
    const row=await sourceRow(req.tenantSchema!,source,transaction);if(!row)treasuryError('Origine non disponibile',404);
    if(canManageTreasuryDefaults(req))return row!;
    const catalog=['SERVICE','PRODUCT','EVENT_TYPE','PACKAGE_TEMPLATE'].includes(source.kind);
    if(catalog){
        const resource:Resource=source.kind==='PACKAGE_TEMPLATE'?'care_package':source.kind==='EVENT_TYPE'?'agenda':'product';
        if(!scope(req,resource,'read')&&!scope(req,'payment','create'))treasuryError('Origine non disponibile',403);
        if(row!.structureId&&scope(req,resource,'read')!=='tenant'&&scope(req,'payment','create')!=='tenant'&&row!.structureId!==(getSelectedStructureId(req)??req.access?.structureId))treasuryError('Origine non disponibile',403);
    }else if(source.kind==='OPERATION'){
        if(!scope(req,'payment','create')&&!scope(req,'treasury','create'))treasuryError('Operazione non disponibile',403);
    }else if(source.kind==='EXPENSE')assertScope(req,'expense','update',row!.structureId,row!.createdByUserId);
    else if(source.kind==='APPOINTMENT') {
        if(!canAccessAppointmentFinance(req,row!,'payment','create'))treasuryError('Appuntamento non disponibile',403);
    }else if(source.kind==='PACKAGE') {
        const {packagePatient}=await import('./carePackage.service.js');
        await packagePatient(req,row!.patientId,'payment','create',transaction);
        if(scope(req,'payment','create')!=='tenant'&&row!.structureId!==getSelectedStructureId(req))treasuryError('Pacchetto non disponibile',403);
    }else {
        const paymentScope=scope(req,'payment','create');
        if(!paymentScope)treasuryError('Fattura non disponibile',403);
        const paymentReq=Object.assign(Object.create(req),{access:{resource:'payment',action:'create',scope:paymentScope,userId:getUserId(req),structureId:getSelectedStructureId(req)}});
        const {default:Invoice}=await import('../../invoice/models/invoice.model.js');
        const accessible=await Invoice.schema(req.tenantSchema!).findOne({where:{id:source.id,...patientScopeWhere(paymentReq,req.tenantSchema!,'patientID')},transaction});
        if(!accessible)treasuryError('Fattura non disponibile',403);
    }
    return row!;
}
export async function treasuryCategoryOptions(req:Request,direction?:unknown):Promise<Row> {
    if(direction!==undefined&&!['IN','OUT'].includes(String(direction)))treasuryError('Direzione non valida',422);
    if(!canManageTreasuryDefaults(req)&&!['payment','treasury','product','expense','care_package'].some(resource=>scope(req,resource as Resource,'create')||scope(req,resource as Resource,'read')||scope(req,resource as Resource,'update')))treasuryError('Categorie non disponibili',403);
    const rows=await TreasuryCategory.schema(req.tenantSchema!).findAll({where:{isActive:true,...(direction?{direction}:{})},order:[['name','ASC']]});
    return {categories:rows.map(row=>{const value=plain(row);return {id:value.id,name:value.name,color:value.color,direction:value.direction,isActive:value.isActive};}),canOverride:!!scope(req,'treasury','update')};
}
export async function previewPaymentClassification(req:Request):Promise<Row> {
    const {direction,sources,amount,allocationMode}=req.body??{};
    if(!['IN','OUT'].includes(direction)||!Array.isArray(sources)||sources.length>100||allocationMode!==undefined&&allocationMode!=='WEIGHTED')treasuryError('Anteprima non valida',422);
    const weighted=allocationMode==='WEIGHTED';
    if(weighted&&(typeof amount!=='number'||!Number.isFinite(amount)||amount<0||Math.abs(amount*100-Math.round(amount*100))>1e-6))treasuryError('Importo non valido',422);
    const result:TreasuryShare[]=[],weights:TreasuryWeight[]=[];let canOverride=!!scope(req,'treasury','update');
    for(const raw of sources){
        const source=normalizeTreasurySource(raw),part=Number(raw.amount);
        if(!Number.isFinite(part)||part<0)treasuryError('Importo non valido',422);
        const row=await assertSourceAccess(req,source);
        if(scope(req,'treasury','update')!=='tenant'&&row.structureId&&row.structureId!==(getSelectedStructureId(req)??req.access?.structureId))canOverride=false;
        const resolved=await resolvedWeights(req.tenantSchema!,source,direction);
        if(weighted){
            const sum=resolved.weights.reduce((total,item)=>total+item.weight,0);
            if(sum>0)weights.push(...resolved.weights.map(item=>({businessCategoryId:item.businessCategoryId,weight:part*item.weight/sum})));
            else weights.push({businessCategoryId:null,weight:part});
        }else result.push(...allocateTreasuryIncrement(part,resolved.weights,await previousTreasuryShares(req.tenantSchema!,source,direction)));
    }
    const total=sources.reduce((sum:number,item:Row)=>sum+Math.round(Number(item.amount)*100),0);
    if(!weighted&&amount!==undefined&&(!Number.isFinite(Number(amount))||Math.round(Number(amount)*100)!==total))treasuryError('Il totale non coincide con le quote dell’incasso',422);
    const options=await treasuryCategoryOptions(req,direction),allocations=weighted?allocateTreasuryAmount(amount,weights):groupTreasuryShares(result);
    const categories=await TreasuryCategory.schema(req.tenantSchema!).findAll({where:{id:{[Op.in]:allocations.map(item=>item.businessCategoryId).filter(Boolean)}}});
    const names=new Map(categories.map(row=>[String(row.get('id')),String(row.get('name'))]));
    const sourceLabel=sources.every((item:Row)=>item.kind==='OPERATION')?'Dalle impostazioni':sources.every((item:Row)=>item.kind==='EXPENSE')?'Dalla spesa':'Dalle prestazioni';
    return {...options,canOverride,allocations:allocations.map(item=>({...item,name:item.businessCategoryId?names.get(item.businessCategoryId)??'Categoria archiviata':'Da classificare'})),sourceLabel};
}
export async function readTreasuryDefaults(req:Request):Promise<Row> {
    const kind=String(req.query.kind??'') as TreasurySourceKind;
    if(!configurable.includes(kind))treasuryError('Origine non configurabile',422);
    const canManage=canManageTreasuryDefaults(req);
    if(req.query.sourceId){
        const source=normalizeTreasurySource({kind,id:req.query.sourceId});await assertSourceAccess(req,source);
        const record=await TreasuryCategoryDefault.schema(req.tenantSchema!).findOne({where:{sourceKind:kind,sourceId:source.id}});
        const weights=await sourceWeights(req.tenantSchema!,source,sourceDirection(kind,source.id));
        const row=await sourceRow(req.tenantSchema!,source);
        const categoryId=source.kind==='EVENT_TYPE'&&row?.linkedServiceId?null:record?.get('businessCategoryId') as string|null??null;
        const inheritedId=!categoryId&&weights.length===1?weights[0].businessCategoryId:null;
        const selected=categoryId??inheritedId;
        const item=selected?await TreasuryCategory.schema(req.tenantSchema!).findByPk(selected):null;
        return {businessCategoryId:categoryId,category:item?plain(item):null,inherited:!!inheritedId,canManage};
    }
    if(!canManage)treasuryError('Non sei autorizzato a configurare le categorie',403);
    const rows=kind==='OPERATION'?AUTOMATION_OPERATIONS.map(id=>({id,name:operationLabel(id)})):await select(req.tenantSchema!,`SELECT * FROM $SCHEMA."${tableByKind[kind]}" ${kind==='EVENT_TYPE'?'WHERE "linkedServiceId" IS NULL':''} ORDER BY "id"`);
    const defaults=await TreasuryCategoryDefault.schema(req.tenantSchema!).findAll({where:{sourceKind:kind}});
    const ids=new Map(defaults.map(row=>[String(row.get('sourceId')),row.get('businessCategoryId')]));
    const categories=await TreasuryCategory.schema(req.tenantSchema!).findAll();
    const byId=new Map(categories.map(row=>[String(row.get('id')),plain(row)]));
    if(req.query.direction!==undefined&&!['IN','OUT'].includes(String(req.query.direction)))treasuryError('Direzione non valida',422);
    return {items:rows.map(row=>({id:row.id,name:row.name??row.title??row.description??row.id,direction:sourceDirection(kind,row.id),businessCategoryId:ids.get(row.id)??null,category:byId.get(String(ids.get(row.id)))??null})).filter(row=>!req.query.direction||row.direction===req.query.direction),canManage};
}
export async function updateTreasuryDefaults(req:Request):Promise<Row> {
    if(!canManageTreasuryDefaults(req))treasuryError('Non sei autorizzato a configurare le categorie',403);
    const sources=req.params.kind?[{kind:req.params.kind,id:req.params.sourceId}]:req.body?.sources;
    if(!Array.isArray(sources)||!sources.length||sources.length>500)treasuryError('Seleziona le origini da configurare',422);
    const selected=classificationCategory(req.body?.businessCategoryId);
    await sequelize.transaction(async transaction=>{
        for(const raw of sources){const source=normalizeTreasurySource(raw);await assertSourceAccess(req,source,transaction);await saveSourceTreasuryDefault(req,source.kind,source.id,selected,transaction);}
    });
    return {updated:sources.length,businessCategoryId:selected};
}

function historyToken(row:Row,shares:TreasuryShare[]):string {return createHash('sha256').update(JSON.stringify([row.id,row.amount,row.direction,row.sourceType,row.sourceId,row.updatedAt,shares])).digest('hex');}
async function historyProposal(req:Request,id:string,transaction?:Transaction):Promise<Row> {
    if(!TREASURY_UUID.test(id))treasuryError('Movimento non valido',422);
    const rows=await select(req.tenantSchema!,'SELECT * FROM $SCHEMA."treasury_movements" WHERE "id"=:id'+(transaction?' FOR UPDATE':''),{id},transaction);
    const row=rows[0];if(!row)return {movementId:id,reason:'Movimento non disponibile'};
    assertScope(req,'treasury','update',row.structureId,row.createdByUserId);
    if(row.reversalOfId||row.status!=='POSTED'||await TreasuryClassification.schema(req.tenantSchema!).findByPk(id,{transaction}))return {movementId:id,reason:'Classificazione già presente o movimento non modificabile'};
    let source:TreasurySource|undefined;
    if(['INVOICE_PAYMENT','INVOICE_PAYMENT_CORRECTION'].includes(row.sourceType)){
        const payments=await select(req.tenantSchema!,'SELECT * FROM $SCHEMA."invoice_payments" WHERE "id"=:id',{id:row.sourceId},transaction);const payment=payments[0];
        if(payment?.carePackageId)source={kind:'PACKAGE',id:payment.carePackageId};
        else if(payment?.agendaEventId)source={kind:'APPOINTMENT',id:payment.agendaEventId};
        else if(payment?.invoiceId)source={kind:'INVOICE',id:payment.invoiceId};
    }else if(row.expenseId)source={kind:'EXPENSE',id:row.expenseId};
    // Historical advances/refunds/manual entries have no deterministic service origin.
    if(!source)return {movementId:id,reason:'Origine non determinabile'};
    const weights=await resolvedWeights(req.tenantSchema!,source,row.direction,transaction);
    const allocations=allocateTreasuryAmount(Number(row.amount),weights.weights);
    if(!allocations.some(item=>item.businessCategoryId))return {movementId:id,reason:'Nessuna categoria configurata'};
    return {movementId:id,allocations,evidenceToken:historyToken(row,allocations),source,row};
}
export async function previewTreasuryHistory(req:Request):Promise<Row> {
    const ids=req.body?.movementIds;
    if(!Array.isArray(ids)||!ids.length||ids.length>100)treasuryError('Seleziona fino a 100 movimenti',422);
    const proposals:Row[]=[],skipped:Row[]=[];
    for(const id of [...new Set(ids)]){
        const proposal=await historyProposal(req,String(id));
        if(proposal.reason)skipped.push(proposal);else{delete proposal.row;delete proposal.source;proposals.push(proposal);}
    }
    const categories=await TreasuryCategory.schema(req.tenantSchema!).findAll({where:{id:{[Op.in]:proposals.flatMap(proposal=>proposal.allocations.map((part:TreasuryShare)=>part.businessCategoryId).filter(Boolean))}}});
    const names=new Map(categories.map(row=>[String(row.get('id')),String(row.get('name'))]));
    return {proposals:proposals.map(proposal=>({...proposal,allocations:proposal.allocations.map((part:TreasuryShare)=>({...part,name:part.businessCategoryId?names.get(part.businessCategoryId)??'Categoria archiviata':'Da classificare'}))})),skipped};
}
export async function applyTreasuryHistory(req:Request):Promise<Row> {
    const proposals=req.body?.proposals;
    if(!Array.isArray(proposals)||!proposals.length||proposals.length>100)treasuryError('Proposte non valide',422);
    return sequelize.transaction(async transaction=>{
        const appliedIds:string[]=[],skipped:Row[]=[];
        for(const selected of proposals){
            const proposal=await historyProposal(req,String(selected.movementId),transaction);
            if(proposal.reason){skipped.push(proposal);continue;}
            if(proposal.evidenceToken!==selected.evidenceToken)treasuryError('I dati sono cambiati: aggiorna l’anteprima',409);
            await classifyTreasuryMovement({schema:req.tenantSchema!,movementId:proposal.movementId,amount:Number(proposal.row.amount),direction:proposal.row.direction,actorId:getUserId(req),source:proposal.source,classification:{businessCategoryId:null,allocations:proposal.allocations}},transaction);
            appliedIds.push(proposal.movementId);
        }
        return {appliedIds,skipped};
    });
}
