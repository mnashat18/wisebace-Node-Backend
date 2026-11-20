import express from 'express';
import { Readable } from 'node:stream';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME=new Set(['image/jpeg','image/png','image/webp','image/gif']);
const fail=(res,status,code,message)=>res.status(status).json({error:{code,message}});
function config(env){const base=String(env.DIRECTUS_URL??'').trim().replace(/\/$/,'');const token=String(env.DIRECTUS_STATIC_TOKEN??'').trim();return base&&token?{base,token}:null;}
function parseMultipart(req,buffer){
 const type=String(req.headers['content-type']??''),match=/^multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(type);
 if(!match)throw Object.assign(new Error('Avatar upload must use multipart form data.'),{status:400});
 const boundary=Buffer.from('--'+(match[1]||match[2]).trim()),sep=Buffer.from('\r\n\r\n');
 let start=buffer.indexOf(boundary);if(start<0)throw Object.assign(new Error('Malformed multipart body.'),{status:400});
 start+=boundary.length;if(buffer.subarray(start,start+2).toString()==='--')throw Object.assign(new Error('Avatar file is required.'),{status:400});
 if(buffer.subarray(start,start+2).toString()==='\r\n')start+=2;
 const headerEnd=buffer.indexOf(sep,start);if(headerEnd<0)throw Object.assign(new Error('Malformed multipart headers.'),{status:400});
 const headers=buffer.subarray(start,headerEnd).toString('latin1');
 if(!/content-disposition:\s*form-data;\s*name="file"(?:;\s*filename="[^"]*")?/i.test(headers))
  throw Object.assign(new Error('A single file field named file is required.'),{status:400});
 const mime=(/content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]??'application/octet-stream').trim().toLowerCase();
 const dataStart=headerEnd+sep.length,marker=Buffer.concat([Buffer.from('\r\n'),boundary]);
 const dataEnd=buffer.indexOf(marker,dataStart);if(dataEnd<0)throw Object.assign(new Error('Malformed multipart file.'),{status:400});
 const tail=buffer.subarray(dataEnd+marker.length);
 if(tail.subarray(0,2).toString()!=='--'||tail.subarray(2).toString().trim()!=='')
  throw Object.assign(new Error('Only one avatar file and no extra fields are allowed.'),{status:400});
 const filename=(/content-disposition:[^\r\n]*filename="([^"]*)"/i.exec(headers)?.[1]??'avatar').replace(/[\\/\0-\x1f]/g,'_').slice(0,120);
 return {buffer:buffer.subarray(dataStart,dataEnd),mime,filename};
}
function validImage(file){
 const b=file.buffer;
 if(file.mime==='image/jpeg')return b.length>3&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff;
 if(file.mime==='image/png')return b.length>8&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 if(file.mime==='image/gif')return b.length>6&&['GIF87a','GIF89a'].includes(b.subarray(0,6).toString());
 if(file.mime==='image/webp')return b.length>12&&b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP';
 return false;
}
async function directus(fetchImpl,cfg,path,options={}){
 const response=await fetchImpl(cfg.base+path,{...options,headers:{Authorization:'Bearer '+cfg.token,...options.headers}});
 return response;
}
async function exists(fetchImpl,cfg,path){
 const r=await directus(fetchImpl,cfg,path);if(!r.ok)return false;
 const body=await r.json();return Array.isArray(body.data)&&body.data.length>0;
}
export function createProtectedFilesRouter({env=process.env,fetchImpl=fetch,db}={}){
 const router=express.Router();
 router.post('/avatar',async(req,res)=>{
  const cfg=config(env);if(!cfg)return fail(res,503,'CONFIGURATION_ERROR','File storage is not configured.');
  let chunks=[],size=0;
  try{
   for await(const chunk of req){size+=chunk.length;if(size>2*1024*1024+16384)return fail(res,400,'BAD_REQUEST','Avatar file is too large.');chunks.push(chunk);}
   const file=parseMultipart(req,Buffer.concat(chunks));
   if(file.buffer.length>2*1024*1024)return fail(res,400,'BAD_REQUEST','Avatar file is too large.');
   if(!MIME.has(file.mime)||!validImage(file))return fail(res,400,'BAD_REQUEST','Avatar file type is not supported.');
   const form=new FormData();form.append('file',new Blob([file.buffer],{type:file.mime}),file.filename);
   const uploaded=await directus(fetchImpl,cfg,'/files',{method:'POST',body:form});
   if(!uploaded.ok)return fail(res,502,'FILE_STORAGE_ERROR','Avatar upload could not be completed.');
   const uploadBody=await uploaded.json(),fileId=uploadBody?.data?.id;
   if(!UUID.test(String(fileId??'')))return fail(res,502,'FILE_STORAGE_ERROR','Avatar upload could not be verified.');
   const oldResponse=await directus(fetchImpl,cfg,'/users/'+encodeURIComponent(req.auth.userId)+'?fields=id,avatar');
   if(!oldResponse.ok)return fail(res,502,'USER_PROFILE_ERROR','The user profile could not be verified.');
   const oldBody=await oldResponse.json(),oldAvatar=oldBody?.data?.avatar??null;
   const updated=await directus(fetchImpl,cfg,'/users/'+encodeURIComponent(req.auth.userId),{
    method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({avatar:fileId})});
   if(!updated.ok)return fail(res,502,'USER_PROFILE_ERROR','The avatar was uploaded but could not be linked to the account.');
   const verify=await directus(fetchImpl,cfg,'/users/'+encodeURIComponent(req.auth.userId)+'?fields=id,avatar');
   const verified=verify.ok?await verify.json():null;
   if(String(verified?.data?.avatar??'')!==String(fileId)){
    await directus(fetchImpl,cfg,'/users/'+encodeURIComponent(req.auth.userId),{
     method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({avatar:oldAvatar})}).catch(()=>{});
    return fail(res,502,'USER_PROFILE_ERROR','Avatar persistence could not be verified.');
   }
   return res.status(200).json({data:{id:String(fileId)}});
  }catch(error){
   if(error.status===400)return fail(res,400,'BAD_REQUEST',error.message);
   req.log?.error?.({errorName:error.name},'[wisepace] avatar upload failed');
   return fail(res,502,'FILE_STORAGE_ERROR','Avatar upload could not be completed.');
  }
 });
 router.get('/files/:fileId',async(req,res)=>{
  const id=String(req.params.fileId??'');if(!UUID.test(id))return fail(res,404,'NOT_FOUND','File not found.');
  const cfg=config(env);if(!cfg)return fail(res,503,'CONFIGURATION_ERROR','File storage is not configured.');
  try{
   const userId=encodeURIComponent(req.auth.userId),fileId=encodeURIComponent(id);
   const ownAvatar=await exists(fetchImpl,cfg,'/users?filter[id][_eq]='+userId+'&filter[avatar][_eq]='+fileId+'&fields=id&limit=1');
   let memberAvatar=false;
   if(db){
    const user=await db('directus_users').select('active_business_profile').where({id:req.auth.userId}).first();
    if(user?.active_business_profile){
     const workspace=encodeURIComponent(String(user.active_business_profile));
     memberAvatar=await exists(fetchImpl,cfg,'/business_profile_members?filter[business_profile][_eq]='+workspace+
      '&filter[user][avatar][_eq]='+fileId+'&fields=id&limit=1');
    }
   }
   // Report exports and scan media are intentionally denied until their ownership
   // and tenant-scoping rules can be reproduced from the source schema.
   if(!ownAvatar&&!memberAvatar)return fail(res,404,'NOT_FOUND','File not found.');
   const range=String(req.headers.range??'').trim();
   if(range&&!/^bytes=(\d*)-(\d*)$/.test(range))return res.status(416).end();
   const asset=await directus(fetchImpl,cfg,'/assets/'+fileId+(range?'?range='+encodeURIComponent(range):''),{
    headers:range?{Range:range}:{}
   });
   if(!asset.ok)return fail(res,404,'NOT_FOUND','File not found.');
   const contentType=String(asset.headers.get('content-type')??'application/octet-stream').toLowerCase();
   const allowed=(ownAvatar||memberAvatar)&&MIME.has(contentType)?{type:contentType,attachment:false}:null;
   if(!allowed)return fail(res,404,'NOT_FOUND','File not found.');
   res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','private, no-store');
   res.setHeader('Accept-Ranges','bytes');res.setHeader('Content-Type',allowed.type);
   if(allowed.attachment)res.setHeader('Content-Disposition','attachment');
   for(const h of ['content-length','content-range']){const v=asset.headers.get(h);if(v)res.setHeader(h,v);}
   res.status(asset.status===206?206:200);
   if(!asset.body)return res.end();
   Readable.fromWeb(asset.body).on('error',()=>res.destroy()).pipe(res);
  }catch(error){
   req.log?.error?.({errorName:error.name},'[wisepace] protected file delivery failed');
   return fail(res,404,'NOT_FOUND','File not found.');
  }
 });
 return router;
}
