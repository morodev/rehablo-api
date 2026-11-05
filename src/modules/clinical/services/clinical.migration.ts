import type {Sequelize,Transaction} from 'sequelize';
import {quoteTenantSchema} from '../../../database/migrationTypes.js';
/** Additive schema only; existing clinical records and defaults are not rewritten. */
export async function migrateClinicalTenant(database:Sequelize,schema:string,transaction:Transaction):Promise<void>{
 const p=quoteTenantSchema(schema);const run=(sql:string)=>database.query(sql,{transaction});
 await run(`ALTER TYPE ${p}.enum_observations_side ADD VALUE IF NOT EXISTS 'UNSPECIFIED'`);
 const timestamps='"createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()';
 await run(`CREATE TABLE IF NOT EXISTS ${p}.care_paths (
 id UUID PRIMARY KEY,"patientId" UUID NOT NULL REFERENCES ${p}.patients(id),"structureId" UUID NOT NULL,"ownerUserId" UUID NOT NULL,
 title VARCHAR(240) NOT NULL,kind VARCHAR(20) NOT NULL CHECK (kind IN ('REHAB','TRAINING')),status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','COMPLETED')),version INTEGER NOT NULL DEFAULT 1,${timestamps})`);
 await run(`CREATE INDEX IF NOT EXISTS care_paths_patient_structure ON ${p}.care_paths("patientId","structureId")`);
 await run(`CREATE TABLE IF NOT EXISTS ${p}.care_path_members (
 "carePathId" UUID NOT NULL REFERENCES ${p}.care_paths(id),"userId" UUID NOT NULL,level VARCHAR(20) NOT NULL CHECK (level IN ('CLINICAL','OPERATIONAL')),
 "assignedByUserId" UUID NOT NULL,"revokedAt" TIMESTAMPTZ,${timestamps},PRIMARY KEY ("carePathId","userId"))`);
 await run(`CREATE TABLE IF NOT EXISTS ${p}.clinical_evaluation_templates (
 id UUID PRIMARY KEY,"structureId" UUID NOT NULL,"ownerUserId" UUID NOT NULL,name VARCHAR(240) NOT NULL,scope VARCHAR(20) NOT NULL DEFAULT 'PERSONAL',
 status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',version INTEGER NOT NULL DEFAULT 1,"parentId" UUID REFERENCES ${p}.clinical_evaluation_templates(id),data JSONB NOT NULL DEFAULT '{"items":[]}',${timestamps})`);
 await run(`CREATE TABLE IF NOT EXISTS ${p}.clinical_evaluation_preferences (
 "userId" UUID NOT NULL,"structureId" UUID NOT NULL,"templateId" UUID REFERENCES ${p}.clinical_evaluation_templates(id),version INTEGER NOT NULL DEFAULT 1,data JSONB NOT NULL DEFAULT '{"items":[]}',${timestamps},PRIMARY KEY ("userId","structureId"))`);
 await run(`ALTER TABLE ${p}.evaluations ADD COLUMN IF NOT EXISTS "carePathId" UUID REFERENCES ${p}.care_paths(id), ADD COLUMN IF NOT EXISTS "templateVersionId" UUID REFERENCES ${p}.clinical_evaluation_templates(id), ADD COLUMN IF NOT EXISTS "configurationSnapshot" JSONB, ADD COLUMN IF NOT EXISTS "clinicalVisibility" VARCHAR(16)`);
 await run(`CREATE TABLE IF NOT EXISTS ${p}.clinical_records (
 id UUID PRIMARY KEY,"carePathId" UUID NOT NULL REFERENCES ${p}.care_paths(id),"patientId" UUID NOT NULL REFERENCES ${p}.patients(id),"structureId" UUID NOT NULL,"authorUserId" UUID NOT NULL,
 kind VARCHAR(30) NOT NULL CHECK (kind IN ('PROBLEM','GOAL','FINDING','PROGRAM','SESSION','VISIT','DIAGNOSIS','PRESCRIPTION','REPORT','DOCUMENT')),
 title VARCHAR(240) NOT NULL,status VARCHAR(20) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','CONFIRMED','ARCHIVED','CANCELLED')),
 visibility VARCHAR(20) NOT NULL DEFAULT 'CLINICAL' CHECK (visibility IN ('CLINICAL','OPERATIONAL')),version INTEGER NOT NULL DEFAULT 1,
 "evaluationId" UUID REFERENCES ${p}.evaluations(id),"parentId" UUID REFERENCES ${p}.clinical_records(id),data JSONB NOT NULL DEFAULT '{}',${timestamps})`);
 await run(`CREATE INDEX IF NOT EXISTS clinical_records_path_kind ON ${p}.clinical_records("carePathId",kind)`);
 await run(`CREATE INDEX IF NOT EXISTS clinical_records_evaluation ON ${p}.clinical_records("evaluationId")`);
 await run(`CREATE TABLE IF NOT EXISTS ${p}.clinical_operations (
 "operationId" UUID NOT NULL,"userId" UUID NOT NULL,fingerprint VARCHAR(64) NOT NULL,result JSONB NOT NULL,${timestamps},PRIMARY KEY ("operationId","userId"))`);
 await run(`CREATE TABLE IF NOT EXISTS ${p}.clinical_audit (
 id UUID PRIMARY KEY,"carePathId" UUID REFERENCES ${p}.care_paths(id),"recordId" UUID,"actorUserId" UUID NOT NULL,action VARCHAR(80) NOT NULL,version INTEGER,"createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
 await run(`CREATE INDEX IF NOT EXISTS clinical_audit_path_date ON ${p}.clinical_audit("carePathId","createdAt")`);
 await run(`CREATE TABLE IF NOT EXISTS ${p}.clinical_publications (
 id UUID PRIMARY KEY,"recordId" UUID NOT NULL UNIQUE REFERENCES ${p}.clinical_records(id),"patientId" UUID NOT NULL REFERENCES ${p}.patients(id),"carePathId" UUID NOT NULL REFERENCES ${p}.care_paths(id),
 "structureId" UUID NOT NULL,"publishedBy" UUID NOT NULL,"publishedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),"revokedAt" TIMESTAMPTZ,"sourceVersion" INTEGER NOT NULL,${timestamps})`);
 await run(`CREATE TABLE IF NOT EXISTS ${p}.clinical_home_feedback (
 id UUID PRIMARY KEY,"publicationId" UUID NOT NULL REFERENCES ${p}.clinical_publications(id),"recordId" UUID NOT NULL REFERENCES ${p}.clinical_records(id),
 "patientId" UUID NOT NULL REFERENCES ${p}.patients(id),"carePathId" UUID NOT NULL REFERENCES ${p}.care_paths(id),"actorUserId" UUID NOT NULL,"operationId" UUID NOT NULL,data JSONB NOT NULL,${timestamps},UNIQUE("actorUserId","operationId"))`);
 await run(`ALTER TABLE ${p}.human_body_areas ADD COLUMN IF NOT EXISTS "evaluationId" UUID REFERENCES ${p}.evaluations(id), ADD COLUMN IF NOT EXISTS symptom JSONB`);
 await run(`ALTER TABLE ${p}.user_scale_instances ADD COLUMN IF NOT EXISTS "humanBodyPointId" UUID REFERENCES ${p}.human_body_points(id)`);
 await run(`ALTER TABLE ${p}.test_instances ADD COLUMN IF NOT EXISTS "humanBodyPointId" UUID REFERENCES ${p}.human_body_points(id), ADD COLUMN IF NOT EXISTS "testSnapshot" JSONB`);
 // Nullable severity enables "not collected"; historical values are unchanged.
 await run(`ALTER TABLE ${p}.human_body_symptoms ALTER COLUMN value DROP NOT NULL`);
}
