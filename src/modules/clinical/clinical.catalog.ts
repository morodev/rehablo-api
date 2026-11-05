import type {TemplateItem} from './clinical.types.js';
/** Structured collection choices, not validated diagnostic instruments or diagnostic rules. */
export const clinicalCatalog:TemplateItem[]=[
 ['pain','Dolore','SYMPTOMS'],['stiffness','Rigidità','SYMPTOMS'],['swelling','Gonfiore','SYMPTOMS'],['sensation','Sensibilità','SYMPTOMS'],['scar','Cicatrice e tessuti','SYMPTOMS'],['fatigue','Affaticamento','SYMPTOMS'],
 ['rom','Mobilità articolare','MOVEMENT'],['bed_mobility','Mobilità a letto','MOVEMENT'],['transfer','Trasferimenti','MOVEMENT'],['walking','Cammino','MOVEMENT'],
 ['manual_strength','Forza manuale','STRENGTH'],['dynamometry','Dinamometria','STRENGTH'],['muscular_endurance','Resistenza muscolare','STRENGTH'],
 ['balance','Equilibrio','CONTROL'],['coordination','Coordinazione','CONTROL'],['trunk_control','Controllo del tronco','CONTROL'],
 ['daily_activity','Attività quotidiane','FUNCTION'],['effort','Tolleranza allo sforzo','FUNCTION'],['sport','Gesto sportivo','FUNCTION'],
 ['questionnaire','Questionario','TESTS'],['clinical_test','Test clinico','TESTS'],['scale','Scala di valutazione','TESTS']
].map(([code,label,group],order)=>({code,label,group:group as TemplateItem['group'],visibility:['pain','stiffness','rom','walking','manual_strength','balance','daily_activity','clinical_test'].includes(code)?'PRIMARY':'CATALOG',order,fields:group==='SYMPTOMS'?['source','collectionState','intensity','scale','side','region','notes']:['source','collectionState','side','region','method','notes']}));
