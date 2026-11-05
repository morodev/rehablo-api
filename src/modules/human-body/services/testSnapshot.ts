import type Test from '../models/catalog/test.model.js';

const fields=['id','name','description','note','positiveText','negativeText','patientText','operatorText','type','districts','isFullBody'] as const;
/** Server-owned textual definition: catalog edits must never rewrite the historical test. */
export function captureTestSnapshot(test:Test):Record<string,unknown>{
    const source=test.get({plain:true});
    const data=Object.fromEntries(fields.map(field=>[field,source[field]??null]));
    return JSON.parse(JSON.stringify({...data,snapshotVersion:1,capturedAt:new Date().toISOString()}));
}
export function testInstanceDto(instance:any):Record<string,any>{
    const plain=typeof instance?.get==='function'?instance.get({plain:true}):{...instance};
    if(plain.testSnapshot){
        plain.test={...plain.testSnapshot};
    }else if(plain.test?.image){
        plain.test={...plain.test,image:`data:image/jpeg;base64,${Buffer.from(plain.test.image).toString('base64')}`};
    }
    return plain;
}
